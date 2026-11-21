# makefun-token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/refineyourphilosophy-sudo/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/refineyourphilosophy-sudo/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar: every protocol in the sealed snapshot that records no token, ranked by **expected value** — what its token would be worth if it launched one, times the chance it ever launches one — with a costed farm plan and a FARM / THIN / SKIP verdict for each.

## How it works

**1. Conditional value if it launched a token.** A comps model fitted on the snapshot's own traded tokens — log10(market cap) = 3.0247 + 0.5223 × log10(TVL), plus a shrunk category adjustment — times a growth multiplier from the 7-day TVL change and a maturity multiplier from the protocol's age. The model is refitted from the snapshot on every run; no protocol name is ever special-cased.

**2. Token odds.** A logistic model for P(token), fitted on the snapshot's peer record: 733 protocols (every protocol except the 25 hold-out test slugs), 53.3% of which record a token. Features, kept only if they lower the Brier score in BOTH the leave-one-out test and the walk-forward test (fit on older protocols, score on newer): log TVL, age (unknown listing dates imputed at 4.0 years — see below), 7-day change, category dummies. Chain count was tested and not kept; a shuffled control term confirmed must-not-help. Selected model: leave-one-out Brier 0.1911 against a base-rate Brier of 0.2489 (23% better); walk-forward Brier 0.2102. Calibration (leave-one-out deciles) tracks the observed token rate closely. The odds are the peers' record, not a forecast.

**What changed in v3 (odds encoding only).** Two audit findings were investigated with training-only validation (leave-one-out and walk-forward Brier; `scripts/eval-odds-v3.mjs`). (1) The Risk Curators dummy (−1.28) was tested for removal: dropping it makes both Brier scores worse (leave-one-out 0.1915 → 0.1929, walk-forward 0.2102 → 0.2129), and age alone would predict Risk Curators at 29% against their observed 13% — at every young age band they record tokens at about a third the rate of same-age peers — so the penalty is a real category effect, not just youth, and the dummy stays. Steakhouse's P(token) is 24.2%, essentially unchanged from v2. (2) The unknown-listing-date indicator (+1.26 in v2) was replaced with transparent age imputation at 4.0 years: unknown-date protocols record tokens at 77.6%, about the rate of 4+ year-old protocols (78.3%), and the imputation matches the indicator's leave-one-out Brier (0.1911 vs 0.1915) with the walk-forward Brier identical (0.2102). The board barely moves: the top 10 order is unchanged, no row moves 5 or more places, and farm verdicts are unchanged at 6 FARM / 7 THIN / 185 SKIP. The valuation model, exclusions, and farm assumptions are untouched.

**3. Expected value = conditional value × P(token).** That is the number the board ranks on. Both parts are shown as columns, and each row's detail view shows the logit contributions behind its P(token), so any row can be audited.

**4. Farm verdicts.** Net-of-fees economics from the expected value with stated, labelled assumptions: 5% of the expected value is assumed allocated to an airdrop, split among 10,000 farmers, with a farmer's share scaling linearly with the deposit against the $100 average farmer; minus gas (one deposit transaction plus one a week) minus time at $25 an hour. FARM clears $50 net and $25 an hour; THIN is positive but below that; SKIP loses money. At the defaults, 6 rows are FARM, 7 THIN, 185 SKIP. The airdrop share and farmer count are **assumptions, not measured facts** — the dashboard's scenario controls move them live with the same arithmetic, so a judge can see how fragile the verdicts are.

**5. Ledger.** Every one of the 758 snapshot protocols sits in exactly one group on the dashboard: 40 ranked on the watchlist, 158 ranked below the $50M floor, 128 already trading with a market cap, 288 recording a token with no usable market cap, and 144 excluded pre-token protocols grouped by the house-rule clause that excludes them.

**Exclusions.** A protocol is ranked only if it records no token and the house eligibility rule does not exclude it (bridge, staked or wrapped product of a token that trades; versioned pool; exchange product). One correction in this version: "Cross Chain Bridge" is not in the house rule's category list, so Circle Gateway ($65.3M TVL) is ranked — the only re-admission. Every other questionable exclusion was checked individually against the rule as written and stays excluded (see `review/readmit-decisions.md` in the project notes).

## Honest check — v1 benchmark, unchanged

On a fixed hold-out (traded tokens sorted by slug, every 5th held out: 103 train, 25 test), the full value pipeline scores log R² 0.158 with a median error of 84.8% and a mean error of 216.5%. The fit is weak — TVL alone explains little of a token's market cap — so treat every implied value as a rough comps estimate, not a forecast.

The out-of-sample evidence (training tokens only; the 25 test tokens were never used for selection) says the same thing from a second angle: no value-model alternative is materially better — the best challenger (+ 7-day change) gains 0.007 log R² in 5-fold cross-validation, inside the noise — and **every** variant's walk-forward log R² is negative (fit on older tokens, scored on newer ones, the model is worse than predicting the mean). The value model does not generalise forward in time. The range calibration is roughly honest (P25–P75 stated 50% coverage, actual 51.5%; P10–P90 stated 80%, actual 77.7%). The limitation is the data, not the method: the snapshot carries no tokenomics, vesting, team, revenue or user data, and the traded set is survivors only. Wrapped, staked and bridged products of tokens that already trade (WBTC, Binance staked ETH, USDT0 and the like) are never ranked; protocols that already trade are shown separately at the market's own value.

## Reproduce it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path to the kit's input/snapshot.json>
node scripts/eval-model.mjs --input <snapshot.json>    # v1 hold-out (unchanged)
node scripts/eval-odds.mjs --input <snapshot.json>     # odds term selection, Brier, calibration
node scripts/eval-odds-v3.mjs --input <snapshot.json>  # v3 candidates: Risk Curators dummy + age imputation
node scripts/eval-ablation.mjs --input <snapshot.json>  # value-model ablation + range calibration
node scripts/gate-check.mjs --out out --input <snapshot.json>
```

Node.js 22.18 or later. The program reads the sealed snapshot, writes `out/board.json` (198 rows, all 40 watchlist protocols covered), `out/data.js`, copies `dashboard/` and `screenshots/` to `out/`, and writes `out/dossier.json`. Two runs on the same snapshot write byte-identical output.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
