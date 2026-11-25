// Steady Pulse — a Sharpe-focused paper bot for the pump.fun replay.
//
// Idea: buy only small, early, buyer-led momentum on fresh curves, then exit
// quickly on a fixed take-profit, a fixed stop-loss, a trailing stop once a
// position is in profit, or a staleness timeout. No leverage, no shorts, one
// round trip per mint, at most five open positions. Every decision is a pure
// function of the harness state (no clock, no environment, no randomness), so
// two executions of the same replay produce identical action logs.
//
// Variant under test: dip-buy. Most fresh curves dump after the first wave,
// so instead of chasing the rise, buy the dip — a coin that fell 5–30% from
// its first-seen price while the latest trade is a buy (sellers exhausted,
// buyers stepping back in) — and scalp the bounce.
//
// Sizing: each buy spends 0.05 SOL unless the per-mint size cap
// (1% of the mint's real SOL reserve) is smaller, in which case it spends
// the cap — but never less than 0.02 SOL, so every round trip clears the
// 0.01 SOL minimum with room for fees.
//
// Entry filter (a mint is decided once, on the first batch where it qualifies):
//   - at least 5 trades seen, and the latest trade was a buy (buyers returning)
//   - price down 5%..30% versus the first price seen for the mint (the dip)
//   - at least 1 SOL of real SOL reserve (real buyers have arrived)
//   - the size cap allows a >= 0.02 SOL buy
//   - a position slot and enough free cash are available
//
// Exit (sell the whole position):
//   - take profit at +8% of cost (fees included in cost)
//   - stop loss at -5% of cost
//   - trailing stop: once the position peaked at +4% or better, sell if it
//     falls 4% below that peak
//   - stale: sell after 1500 slots held without an exit trigger, freeing the
//     slot for a fresher coin

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL
const MIN_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 100n; // 0.02 SOL
const MIN_REAL_RESERVE_LAMPORTS = LAMPORTS_PER_SOL; // 1 SOL of real reserve
const MIN_TRADES = 5;
const MIN_RISE = 0.7; // -30% vs first-seen price: the dip
const MAX_RISE = 0.95; // -5% vs first-seen price: not yet bounced back
const TAKE_PROFIT = 1.08;
const STOP_LOSS = 0.95;
const TRAIL_ARM = 1.04; // trailing stop arms once peak value is +4%
const TRAIL_DROP = 0.96; // sell at 4% below the peak value
const MAX_HOLD_SLOTS = 1500;
const MAX_SLIPPAGE_BPS = 5000;

interface CoinMemory {
  firstPrice: number; // SOL per token at first sight (virtual reserves ratio)
  lastTradeBuy: boolean;
  decided: boolean; // a buy was placed (or the coin was skipped for good)
}

interface HeldMemory {
  peakValue: number; // highest mark value (lamports) seen while holding
  enteredSlot: number;
}

const coins = new Map<string, CoinMemory>();
const held = new Map<string, HeldMemory>();

function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

function markValueLamports(tokens: bigint, vQuote: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  return (Number(tokens) * Number(vQuote)) / Number(vToken);
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: Array<BuyInput | SellInput> = [];
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // Refresh per-mint memory from this batch's events.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            firstPrice: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
            lastTradeBuy: false,
            decided: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const mem = coins.get(e.mint);
        if (mem !== undefined) mem.lastTradeBuy = e.is_buy;
      } else if (e.event === 'CompleteEvent') {
        const mem = coins.get(e.mint);
        if (mem !== undefined) mem.decided = true;
        held.delete(e.mint);
      }
    }

    // Exits first: sell whole positions that hit a trigger.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = markValueLamports(
        holding.token_amount,
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
      );
      const cost = Number(holding.cost_lamports);
      if (cost <= 0 || value <= 0) continue;
      const mem = held.get(mint);
      if (mem === undefined) {
        held.set(mint, { peakValue: value, enteredSlot: state.slot });
        continue;
      }
      if (value > mem.peakValue) mem.peakValue = value;
      const ratio = value / cost;
      const peakRatio = mem.peakValue / cost;
      const stale = state.slot - mem.enteredSlot > MAX_HOLD_SLOTS;
      const takeProfit = ratio >= TAKE_PROFIT;
      const stopLoss = ratio <= STOP_LOSS;
      const trailing = peakRatio >= TRAIL_ARM && value <= mem.peakValue * TRAIL_DROP;
      if (takeProfit || stopLoss || trailing || stale) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        held.delete(mint);
      }
    }

    // Entries: one buy per mint, in first-seen order, while slots last.
    for (const [mint, mem] of coins) {
      if (mem.decided) continue;
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        mem.decided = true;
        continue;
      }
      if (curve.trades < MIN_TRADES) continue;
      if (!mem.lastTradeBuy) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (mem.firstPrice <= 0 || now <= 0) {
        mem.decided = true;
        continue;
      }
      const rise = now / mem.firstPrice;
      // A coin outside the band is NOT decided: it is re-checked on later
      // batches, so a coin that cools back into the band can still be bought.
      if (rise < MIN_RISE || rise > MAX_RISE) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      mem.decided = true;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      free -= amount + tx;
      slots -= 1;
    }

    // Drop memory for positions that are gone (flattened/closed by the harness).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    return orders;
  },
});
