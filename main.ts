// Steady Pulse — a Sharpe-focused paper bot for the pump.fun replay.
//
// Idea: buy only small, early, buyer-led momentum on fresh curves, then exit
// quickly on a fixed take-profit, a fixed stop-loss, a trailing stop once a
// position is in profit, or a staleness timeout. No leverage, no shorts, one
// round trip per mint, at most five open positions. Every decision is a pure
// function of the harness state (no clock, no environment, no randomness), so
// two executions of the same replay produce identical action logs.
//
// Variant under test: buy early, hold long. The house equal-weight baseline
// (buy as soon as the size cap allows, never sell) is near breakeven on dev
// (-0.019 SOL), while every active-selling variant lost -0.5..-1.1 SOL: the
// exits were realizing losses and paying fees on hundreds of round trips.
// The no-stale version (-0.024 SOL) was near breakeven but only 15 round
// trips: the 5 slots stayed occupied for hours. Adding a 3000-slot stale
// exit was far worse (-2.55 SOL, 704 trips): it forced selling into the
// early bleed. This tune keeps no stale exit and no fixed take-profit, but
// cuts losers earlier (disaster stop -10% instead of -25%) so dead coins
// free their slots while winners ride to completion or the trailing stop.
//
// Sizing: each buy spends 0.05 SOL unless the per-mint size cap
// (1% of the mint's real SOL reserve) is smaller, in which case it spends
// the cap — but never less than 0.02 SOL, so every round trip clears the
// 0.01 SOL minimum with room for fees.
//
// Entry filter (a mint is decided once, on the first batch where it qualifies):
//   - at least 1 trade seen; no direction or rise band — buy as soon as the
//     size cap allows a >= 0.01 SOL buy
//   - at least 1 SOL of real SOL reserve
//   - a position slot and enough free cash are available
//
// Exit (sell the whole position):
//   - no fixed take-profit
//   - disaster stop at -12% of cost
//   - trailing stop: once the position peaked at +8% or better, sell if it
//     falls 8% below that peak
//   - no stale exit; completions and the end-of-data flatten close the rest

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
const MIN_REAL_RESERVE_LAMPORTS = LAMPORTS_PER_SOL; // 1 SOL of real reserve
const MIN_TRADES = 1;
const MIN_RISE = 0.98; // no real band: buy as soon as the cap allows
const MAX_RISE = 10; // effectively no upper band
const TAKE_PROFIT = 100; // no fixed take-profit: never triggers
const STOP_LOSS = 0.88; // disaster stop at -12%: between the -15% version (16 trips, +0.018 SOL) and the -10% version (101 trips, -0.228 SOL)
const TRAIL_ARM = 1.08; // trailing stop arms once peak value is +8%
const TRAIL_DROP = 0.92; // sell at 8% below the peak value
const MAX_HOLD_SLOTS = 1000000000; // no stale exit
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
