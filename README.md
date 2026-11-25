[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/wenwijaya/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/wenwijaya/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Steady Pulse — Pump.fun Sharpe Sprint paper bot

A paper-trading bot for make.fun's **Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins** bounty. It trades paper SOL on a 6-hour pump.fun forward replay in the `agent-fun/replay/v2` protocol, starting from 10 SOL. Places go by hourly Sharpe ratio, so the bot is built for steady, controlled gains — not moonshots.

## Strategy

Buy small, buy early, exit fast. One round trip per mint, at most 5 open positions.

**Entry** — a mint is bought once, on the first batch where all of these hold:

- at least 3 trades seen, and the latest trade was a buy (buyer-led flow)
- price up 3%–70% versus the first price seen for the mint (real momentum, not a vertical blow-off)
- at least 1 SOL of real SOL reserve (real buyers have arrived)
- the per-mint size cap (1% of real SOL reserve) allows a buy of at least 0.02 SOL

**Size** — 0.05 SOL per buy, or the size cap when it is smaller (never under 0.02 SOL, so every round trip clears the 0.01 SOL minimum with room for fees).

**Exit** — the whole position is sold when any trigger fires:

- take profit at +12% of cost (fees included in cost)
- stop loss at −8% of cost
- trailing stop: once the position peaked at +6% or better, sell at 7% below that peak
- stale: sell after 2,500 slots held without another trigger, freeing the slot for a fresher coin

Deterministic, standard library only, no network, no wall clock, no randomness: two runs on the same replay produce byte-identical action logs.

## Files

- `main.ts` — the bot (erasable-only TypeScript, run by the grader as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored byte-identical from the competition kit
- `.makefun/owner.json` — the payout wallet for this entry
- `prompt.txt` — the build brief for this entry

## Dev-window result (kit `grade-local`, process driver)

<!-- filled in after the local trial; see RUN_LOG.md in the build workspace -->

## License

MIT — see `LICENSE`.
