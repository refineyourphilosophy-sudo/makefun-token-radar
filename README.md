# makefun-token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/refineyourphilosophy-sudo/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/refineyourphilosophy-sudo/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar: every protocol in the sealed snapshot that records no token, ranked by what its token would be worth if it launched one, with a costed farm plan for each. The implied value comes from a comps model fitted on the snapshot's own traded tokens — log10(market cap) = 3.0247 + 0.5223 × log10(TVL), plus a shrunk category adjustment — times a growth multiplier from the 7-day TVL change and a maturity multiplier from the protocol's age. The model is refitted from the snapshot on every run; no protocol name is ever special-cased.

Honest check: on a fixed hold-out (traded tokens sorted by slug, every 5th held out: 103 train, 25 test), the full pipeline scores log R² 0.158 with a median error of 84.8% and a mean error of 216.5%. The fit is weak — TVL alone explains little of a token's market cap — so treat every implied value as a rough comps estimate, not a forecast. Run `node scripts/eval-model.mjs --input <snapshot.json>` to reproduce these numbers from the snapshot. Wrapped, staked and bridged products of tokens that already trade (WBTC, Binance staked ETH, USDT0 and the like) are never ranked; protocols that already trade are shown separately at the market's own value.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to the kit's input/snapshot.json>
```

Node.js 22.18 or later. The program reads the sealed snapshot, writes `out/board.json` (197 rows, all 40 watchlist protocols covered), `out/data.js`, copies `dashboard/` and `screenshots/` to `out/`, and writes `out/dossier.json`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
