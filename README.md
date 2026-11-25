[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/wenwijaya/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/wenwijaya/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Steady Pulse — Pump.fun Sharpe Sprint paper bot

A paper-trading bot for make.fun's **Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins** bounty. It trades paper SOL on a 6-hour pump.fun forward replay in the `agent-fun/replay/v2` protocol, starting from 10 SOL. Places go by hourly Sharpe ratio, so the bot is built for steady, controlled gains — not moonshots.

## Strategy

Buy early, hold long. One round trip per mint, at most 5 open positions.

**Entry** — a mint is bought once, on the first batch where the per-mint size cap (1% of its real SOL reserve) allows a buy of at least 0.01 SOL, with at least 1 trade seen and at least 1 SOL of real SOL reserve. No direction or momentum band: fresh curves are bought as soon as the cap allows.

**Size** — 0.05 SOL per buy, or the size cap when it is smaller (never under 0.01 SOL, so every round trip clears the 0.01 SOL minimum).

**Exit** — the whole position is sold when any trigger fires:

- disaster stop at −12% of cost (fees included in cost): cut dead coins so the slot frees up
- trailing stop: once the position peaked at +8% or better, sell at 8% below that peak
- no fixed take-profit and no stale exit — winners ride to curve completion or the end-of-data flatten

Why this shape: on the dev window, active selling (tight take-profits, stop-losses, stale exits) lost −0.5 to −2.5 SOL across hundreds of round trips — exits realized losses and paid fees on every trade — while buying early and holding was near breakeven. The disaster stop is tuned so turnover clears the 20-coin guardrail (39 round trips) at the smallest measured cost.

Deterministic, standard library only, no network, no wall clock, no randomness: two runs on the same replay produce byte-identical action logs.

## Files

- `main.ts` — the bot (erasable-only TypeScript, run by the grader as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored byte-identical from the competition kit
- `.makefun/owner.json` — the payout wallet for this entry
- `prompt.txt` — the build brief for this entry

## Dev-window result (kit `grade-local`, process driver)

Commit `f50748fcde3a428fcabdcf7957b9ce6e3e8efb1b` (SL −12% variant):

- status: finished; L1 regrade reproduced byte for byte
- net PnL: −0.058154503 SOL (return −0.58%; 90% interval −0.21 .. +0.087 SOL)
- trading: 73 fills over 39 coins, 39 round trips, win rate 28.2%, max drawdown 0.95%, 0 rejected, 3 failed
- fees: 0.036252153 SOL curve + 0.008505000 SOL tx
- guardrails: met (39 coins hold a round trip of at least 0.01 SOL; drawdown ok)
- action_log_sha256: `090a0816b8143b76cbaad0b44775fa6fa335ecfee8d13f5bf198a1036192a99d`

Note: the dev window is one small sample and the final window is a different 6 hours, so this is a smoke test of the guardrails and determinism, not a forecast. The bot is slightly below holding cash on dev; its Sharpe on the final window is what ranks it.

## License

MIT — see `LICENSE`.
