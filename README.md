# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/5337631/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/5337631/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar is a token launch radar for the make.fun `token-radar-01` bounty. Its program reads a sealed DefiLlama snapshot of 758 protocols, learns what the market pays for locked value from the protocols that already trade (a median market-cap / TVL ratio per category, shrunk toward the global median), and ranks 300 protocols that record no token yet by implied value: TVL × category ratio × momentum (seven-day TVL change) × seasoning (how long the protocol has run tokenless) × reach (chains served). Every one of the snapshot's 40 watchlist protocols is covered, the rest are early finds scored in from below the watchlist floor, and protocols whose token already trades are never ranked — they are shown separately at market value as the comparison set the ratios were learned from. The dashboard it writes is sortable and filterable, opens a detail view per protocol with the value broken down factor by factor, and gives every protocol a concrete seven-step farm plan with costs and times, generated from its own category, chains, TVL, age and momentum. No name is ever special-cased, so the same program scores a future snapshot — with protocols that do not exist yet — unchanged. It runs offline, with Node's standard library only, and is deterministic: the same snapshot always produces the same bytes.

## The model in brief

- **Category ratio** — for each category, the median market-cap / TVL of its live-token protocols in the snapshot, shrunk toward the global median (×0.169 here) by three phantom peers and clamped to 0.02–1.20. Categories with no traded peers fall back to the global median.
- **Momentum** — 1 + clamp(seven-day TVL change, −50%…+100%) × 0.9.
- **Seasoning** — 0.75 rising to 1.10 over 1,095 days with no token recorded (unknown listing date counts as 365 days).
- **Reach** — +2% per additional chain, up to ten.
- **Farm plans** — seven steps per protocol, generated from its category, primary and secondary chains, TVL-sized capital, age-based holding period, and a risk step that reacts to its seven-day TVL move; every step states its cost and its time.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

This writes `out/board.json` (the ranked board), `out/data.js` (the dashboard's data), `out/dashboard/` and `out/screenshots/` (copies of the page and its captures), and `out/dossier.json` (the judge's dossier, built with the vendored make.fun library). In the grader's container the input is the sealed `/input/snapshot.json` and the output is `/output`, with no flags needed.

---
<sub>Entered on [make.fun](https://make.fun/?ref=jp8xc64w&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
