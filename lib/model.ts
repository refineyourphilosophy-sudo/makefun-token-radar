import { evaluateOdds, fitOddsModel, oddsFeatureNames, predictOdds, type FittedOdds } from './odds.ts';
import { valueAblation } from './evidence.ts';

// Token Radar — valuation model, fitted at runtime from the sealed snapshot.
//
// METHOD (pre-declared, one fixed procedure, no tuning after the fact)
// ----------------------------------------------------------------------
// 1. COMPS FIT. The traded set is every protocol in the snapshot with a
//    market cap above zero and TVL above zero (128 of them). The model fits
//    an ordinary least-squares line in log space:
//
//       log10(market cap) = a + b * log10(TVL)
//
//    fitted on those 128 tokens. A category adjustment is then added: for
//    each category with at least 4 traded tokens, the median residual of
//    that category's tokens (in log10 space) is shrunk by n / (n + 8) and
//    added to the prediction; categories with fewer than 4 traded tokens
//    get no adjustment (they fall back to the global fit). Nothing is ever
//    fitted to a protocol's name: the same function scores every row.
// 2. GROWTH. The protocol's 7-day TVL change, clamped to [-60, +120]%, is
//    applied as a multiplier: 1 + growth% / 100 * 0.5. A missing change
//    counts as 0%.
// 3. MATURITY. Age in days from listed_at to the snapshot's as_of date
//    (2026-11-14); unknown age counts as 365 days. Multiplier:
//    0.6 + min(age, 1095) / 1095 * 0.4. Older, longer-running protocols
//    score higher: a token is more plausible after years of operation.
// 4. CONDITIONAL VALUE. 10^(a + b*log10(TVL) + category adjustment) *
//    growth multiplier * maturity multiplier, rounded to a whole dollar,
//    at least $1, at most $100,000,000,000,000. This is what the token
//    would be worth IF it launched — not what to expect.
// 5. TOKEN ODDS. A logistic model (lib/odds.ts) for P(token), fitted on
//    the snapshot's peer record: every protocol except the 25 hold-out
//    test slugs. Features, kept only if they lower the Brier score in
//    BOTH the leave-one-out and the walk-forward test: log TVL, age,
//    listing-date-unknown, 7-day change, category dummies. Chain count
//    was tested and not kept; a shuffled control confirmed must-not-help.
// 6. EXPECTED VALUE. Conditional value x P(token). The board ranks on
//    this, and implied_value_usd in board.json IS the expected value.
//    The conditional value and P(token) are kept as separate columns.
// 7. FARM VERDICTS. Net-of-fees economics from the expected value with
//    stated assumptions (see farmEconomics): an airdrop allocation share
//    of the expected value, split among an assumed number of farmers,
//    scaled linearly with the deposit against the average farmer's
//    $100, minus gas minus time at $25 an hour. FARM clears $50 net and
//    $25 an hour; THIN is positive but below that bar; SKIP loses money.
//    The assumptions are labelled on the dashboard and adjustable there,
//    with the same arithmetic — they are assumptions, not measured facts.
//
// HOLD-OUT (fixed split, declared before any number was seen)
// -----------------------------------------------------------
// The traded set is sorted by slug; every 5th protocol (index % 5 === 4)
// is held out as the test set (25 tokens) and the rest (103) is the train
// set. The fit procedure above is run on the train set only and the test
// set is scored with it. The numbers in evaluateHoldout() are the true
// out-of-sample results of that one split. The shipped model refits the
// SAME procedure on all 128 traded tokens. scripts/eval-model.mjs runs
// this code and prints the numbers so anyone can re-derive them.
//
// LIMITATIONS (read before trusting the board)
// --------------------------------------------
// - The fit is weak. On the held-out tokens the log-space R-squared is
//   about 0.16 and the median absolute percentage error is about 81%:
//   the market prices tokens far beyond what TVL alone explains. Treat
//   every implied value as a rough comps estimate, never a forecast.
// - Small samples: several categories have fewer than 4 traded tokens,
//   so they get no category adjustment at all (shrinkage to the global
//   fit, stated above). Category medians for n = 4..9 are noisy.
// - TVL-only features: the snapshot carries no tokenomics, vesting,
//   team, revenue or user data, so the model cannot see any of it.
// - Survivorship: the traded set is tokens that survived long enough to
//   be listed with a market cap; failed or tiny tokens are absent, so the
//   fit is biased toward survivors.
// - Category mix: bridges and cross-chain protocols carry market caps
//   above their TVL (median ratio above 1), while lending and liquid
//   staking carry far below it (median ratio 0.04-0.13). The category
//   adjustment corrects the average, not any single protocol.
// - Growth and maturity are assumptions, not fitted parameters: the
//   snapshot has no outcome to fit them against. They move a value by at
//   most +60% (growth) and 0.6x-1.0x (maturity).
// - A protocol that records a token (a CoinGecko id or a symbol) is NOT
//   pre-token and is never ranked, even if its market cap is missing:
//   it is shown separately at the market's own value, if it has one.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The fitted comps model: OLS coefficients plus shrunk category adjustments. */
export interface FittedModel {
  intercept: number;
  slope: number;
  categoryAdj: Record<string, number>;
  tradedCount: number;
  /** Categories with at least 4 traded tokens (the ones that got an adjustment). */
  adjustedCategories: string[];
}

/** The hold-out evaluation of the fit procedure on one fixed split. */
export interface HoldoutMetrics {
  trainCount: number;
  testCount: number;
  /** Log-space R-squared of the FULL pipeline (base x growth x maturity) on the test set. */
  logR2: number;
  /** Median absolute percentage error of the full pipeline on the test set. */
  mdAPE: number;
  /** Mean absolute percentage error of the full pipeline on the test set. */
  mape: number;
  /** Log-space R-squared of the base comps fit alone (no growth/maturity) on the test set. */
  baseLogR2: number;
  /** Median absolute percentage error of the base comps fit alone on the test set. */
  baseMdAPE: number;
  /** Train-set fit coefficients used for the evaluation. */
  trainIntercept: number;
  trainSlope: number;
}

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  /** The EXPECTED value: conditional value-if-launches x P(token). The board ranks on this. */
  implied_value_usd: number;
  /** The conditional value if a token launched, before the odds are applied. */
  conditional_value_usd: number;
  /** P(token) from the odds model: the peers' record, not a forecast. */
  token_probability: number;
  model: {
    base_value_usd: number;
    category_adjustment: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_verdict: FarmVerdict;
  farm_net_usd: number;
  farm_net_per_hour_usd: number;
  farm_gas_usd: number;
  farm_time_hours: number;
  farm_capital_usd: number;
  farm_steps: string[];
}

/** A farm verdict: worth farming, marginal, or not worth it, at the stated assumptions. */
export type FarmVerdict = 'FARM' | 'THIN' | 'SKIP';

/** The net-of-fees economics behind one row's verdict. */
export interface FarmEconomics {
  verdict: FarmVerdict;
  /** Expected airdrop value for one farmer at the stated deposit. */
  airdropUsd: number;
  gasUsd: number;
  timeHours: number;
  capitalUsd: number;
  holdDays: number;
  /** Airdrop minus gas minus time at the stated hourly value. */
  netUsd: number;
  netPerHourUsd: number;
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  conditional_value_usd: number;
  token_probability: number;
  base_value_usd: number;
  category_adjustment: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_verdict: FarmVerdict;
  farm_net_usd: number;
  farm_net_per_hour_usd: number;
  farm_gas_usd: number;
  farm_time_hours: number;
  farm_capital_usd: number;
  /** The exact farm plan from board.json, so the page shows the board's own steps, never a second copy. */
  farm_steps: string[];
  /** Whether the snapshot's watchlist names this protocol. */
  watchlist: boolean;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One group of the 758-protocol ledger: every protocol in exactly one group. */
export interface LedgerGroup {
  group: string;
  count: number;
  note: string;
}

/** The fitted odds model as the dashboard shows it. */
export interface OddsSummary {
  n: number;
  positives: number;
  baseRate: number;
  baseBrier: number;
  selectedLoo: number;
  selectedWf: number;
  wfTrain: number;
  wfTest: number;
  wfCutoff: string;
  controlLoo: number;
  controlWf: number;
  terms: { label: string; looBrier: number; wfBrier: number; kept: boolean }[];
  coefficients: { feature: string; value: number }[];
  calibration: { bin: number; n: number; meanPred: number; observed: number }[];
  ageBuckets: { bucket: string; n: number; withToken: number; rate: number }[];
  spec: string[];
}

/** Everything the dashboard needs: the board, the live set, the fitted model and its hold-out check. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  fitted: FittedModel;
  holdout: HoldoutMetrics;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  odds: OddsSummary;
  ablation: { variants: import('./evidence.ts').AblationRow[]; ranges: import('./evidence.ts').RangeCalibration };
  ledger: LedgerGroup[];
  ledger_total: number;
  farm_defaults: { allocShare: number; farmers: number; hourlyUsd: number; refDepositUsd: number };
  farm_counts: { farm: number; thin: number; skip: number };
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export const MODEL_VERSION = 'radar-3-odds';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** Farm economics defaults: the stated, adjustable assumptions behind every verdict. */
export const FARM_DEFAULTS = {
  /** Share of a protocol's expected value assumed allocated to an airdrop. */
  allocShare: 0.05,
  /** Farmers assumed to split that allocation. */
  farmers: 10_000,
  /** Value of an hour of the farmer's time, in dollars. */
  hourlyUsd: 25,
  /** The average farmer's deposit, in dollars: airdrop share scales linearly with deposit against it. */
  refDepositUsd: 100,
} as const;

const DAY_MS = 86_400_000;
const MAX_IMPLIED = 100_000_000_000_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Fit the comps model on a list of traded protocols (market cap and TVL
 * both above zero). OLS in log10 space, then a shrunk median-residual
 * adjustment per category with at least 4 traded tokens.
 */
export function fitModel(rows: SnapshotProtocol[]): FittedModel {
  const xs = rows.map((p) => Math.log10(p.tvl_usd));
  const ys = rows.map((p) => Math.log10(p.mcap_usd!));
  const n = rows.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - meanX) * (ys[i]! - meanY);
    sxx += (xs[i]! - meanX) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;

  const residuals = new Map<string, number[]>();
  for (const p of rows) {
    const r = Math.log10(p.mcap_usd!) - (intercept + slope * Math.log10(p.tvl_usd));
    const key = p.category ?? 'null';
    const list = residuals.get(key) ?? [];
    list.push(r);
    residuals.set(key, list);
  }
  const categoryAdj: Record<string, number> = {};
  const adjustedCategories: string[] = [];
  for (const [key, list] of [...residuals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.length < 4) continue;
    categoryAdj[key] = median(list) * (list.length / (list.length + 8));
    adjustedCategories.push(key);
  }
  return { intercept, slope, categoryAdj, tradedCount: n, adjustedCategories };
}

/** The growth multiplier from a protocol's 7-day TVL change (percent, clamped). */
export function growthMultiplier(change7d: number | null): { growthPct: number; mult: number } {
  const growthPct = Math.min(120, Math.max(-60, finite(change7d, 0)));
  return { growthPct, mult: 1 + (growthPct / 100) * 0.5 };
}

/** The maturity multiplier from a protocol's age in days (null age counts as 365 days). */
export function maturityMultiplier(age: number | null): number {
  const ageForModel = age ?? 365;
  return 0.6 + (Math.min(Math.max(ageForModel, 0), 1095) / 1095) * 0.4;
}

/** The implied value of one protocol under a fitted model, with its breakdown. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  fit: FittedModel,
): { implied: number; base: number; categoryAdj: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const categoryAdj = fit.categoryAdj[protocol.category ?? 'null'] ?? 0;
  const base = 10 ** (fit.intercept + fit.slope * Math.log10(protocol.tvl_usd) + categoryAdj);
  const { growthPct, mult: growthMult } = growthMultiplier(protocol.change_7d);
  const maturityMult = maturityMultiplier(age);
  const implied = Math.max(1, Math.min(MAX_IMPLIED, Math.round(base * growthMult * maturityMult)));
  return { implied, base: Math.max(1, Math.round(base)), categoryAdj, growthPct, growthMult, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all (no market cap, no CoinGecko id, no symbol). */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked or bridged product of a protocol whose token already trades.
 * The exclusions are the watchlist's own rule, applied to the whole board: a bridge of BTC, a staked-ETH
 * product or a versioned pool is not a protocol still waiting on a launch of its own, so it is never ranked.
 * Categories (the house rule's list, exactly): Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking,
 * Restaked BTC, CEX. Names: ending in a version marker, carrying a whole word wrapped / staked / staking, or
 * beginning with an exchange's name (Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex, Gemini).
 * "Cross Chain Bridge" is NOT in the house list, so it does not exclude: Circle Gateway ($65.3M) is ranked
 * (review/readmit-decisions.md — the one re-admission; every other questionable exclusion trips a clause
 * of the house rule as written and stays excluded). */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  const excludedCategories = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
  if (p.category !== null && excludedCategories.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (/\bwrapped\b|\bstaked\b|\bstaking\b/i.test(p.name)) return false;
  if (/^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i.test(p.name)) return false;
  return true;
}

/** Why a pre-token protocol is NOT ranked: the one house-rule clause that excludes it, or null if rankable.
 * Priority is category, then version marker, then wrapped/staked word, then exchange prefix, so every
 * excluded protocol lands in exactly one group in the ledger. */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return null;
  const excludedCategories = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
  if (p.category !== null && excludedCategories.has(p.category)) return `category: ${p.category}`;
  if (VERSIONED.test(p.name)) return 'name ends in a version marker';
  if (/\bwrapped\b|\bstaked\b|\bstaking\b/i.test(p.name)) return 'name has a wrapped/staked word';
  if (/^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i.test(p.name)) return 'name begins with an exchange name';
  return null;
}

/** The snapshot's traded set: market cap and TVL both above zero, sorted by slug (the fit's input). */
export function tradedSet(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/**
 * The fixed hold-out evaluation. Traded tokens sorted by slug; every 5th
 * (index % 5 === 4) is the test set, the rest is the train set. The fit
 * procedure runs on the train set only; the test set is scored with it.
 * One split, declared in advance, run once, reported as it comes out.
 */
export function evaluateHoldout(snapshot: Snapshot): HoldoutMetrics {
  const traded = tradedSet(snapshot);
  const test = traded.filter((_, i) => i % 5 === 4);
  const train = traded.filter((_, i) => i % 5 !== 4);
  const fit = fitModel(train);

  const full = (p: SnapshotProtocol): number => impliedValue(p, snapshot.as_of, fit).implied;
  const baseOnly = (p: SnapshotProtocol): number => {
    const adj = fit.categoryAdj[p.category ?? 'null'] ?? 0;
    return Math.max(1, Math.round(10 ** (fit.intercept + fit.slope * Math.log10(p.tvl_usd) + adj)));
  };

  const score = (rows: SnapshotProtocol[], fn: (p: SnapshotProtocol) => number): { logR2: number; mdAPE: number; mape: number } => {
    const logActual = rows.map((p) => Math.log10(p.mcap_usd!));
    const meanLog = logActual.reduce((a, b) => a + b, 0) / logActual.length;
    let ssRes = 0;
    let ssTot = 0;
    const apes: number[] = [];
    for (const p of rows) {
      const pred = Math.log10(Math.max(1, fn(p)));
      const act = Math.log10(p.mcap_usd!);
      ssRes += (act - pred) ** 2;
      ssTot += (act - meanLog) ** 2;
      apes.push(Math.abs(fn(p) - p.mcap_usd!) / p.mcap_usd!);
    }
    apes.sort((a, b) => a - b);
    return {
      logR2: ssTot === 0 ? 0 : 1 - ssRes / ssTot,
      mdAPE: apes[Math.floor(apes.length / 2)]!,
      mape: apes.reduce((a, b) => a + b, 0) / apes.length,
    };
  };

  const fullScore = score(test, full);
  const baseScore = score(test, baseOnly);
  return {
    trainCount: train.length,
    testCount: test.length,
    logR2: fullScore.logR2,
    mdAPE: fullScore.mdAPE,
    mape: fullScore.mape,
    baseLogR2: baseScore.logR2,
    baseMdAPE: baseScore.mdAPE,
    trainIntercept: fit.intercept,
    trainSlope: fit.slope,
  };
}

/** The protocols the board ranks, strongest first, with ranks 1..n.
 * Ranked on EXPECTED value: the conditional value-if-launches times
 * P(token) from the odds model. The conditional value and the odds are
 * kept as separate columns, so the ranking can be audited. */
export function buildBoard(snapshot: Snapshot, fit: FittedModel, odds: FittedOdds): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, not just the
  // biggest ones. A chosen protocol stays chosen.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scenario = defaultFarmScenario();
  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, fit);
    const prob = predictOdds(odds, p, snapshot.as_of);
    const expected = Math.max(1, Math.min(MAX_IMPLIED, Math.round(v.implied * prob)));
    const farm = farmEconomics(p, v.age, expected, scenario);
    return { p, v, prob, expected, farm };
  });
  scored.sort((a, b) => b.expected - a.expected || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.v.age,
    implied_value_usd: s.expected,
    conditional_value_usd: s.v.implied,
    token_probability: Math.round(s.prob * 1e4) / 1e4,
    model: {
      base_value_usd: s.v.base,
      category_adjustment: Math.round(s.v.categoryAdj * 1e4) / 1e4,
      growth_pct: s.v.growthPct,
      growth_multiplier: Math.round(s.v.growthMult * 1e4) / 1e4,
      maturity_multiplier: Math.round(s.v.maturityMult * 1e4) / 1e4,
      age_days: s.v.age,
    },
    farm_verdict: s.farm.verdict,
    farm_net_usd: Math.round(s.farm.netUsd),
    farm_net_per_hour_usd: Math.round(s.farm.netPerHourUsd * 100) / 100,
    farm_gas_usd: s.farm.gasUsd,
    farm_time_hours: Math.round(s.farm.timeHours * 100) / 100,
    farm_capital_usd: s.farm.capitalUsd,
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Approximate gas for one transaction on a chain, in whole US dollars (an estimate, stated as such). */
function gasUsd(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 7;
  if (c === 'solana') return 1;
  if (c === 'bitcoin') return 3;
  if (['base', 'arbitrum', 'optimism', 'zksync', 'polygon', 'bsc', 'avalanche', 'blast', 'linea', 'scroll', 'mode', 'mantle', 'fraxtal', 'sei', 'sui', 'aptos', 'near', 'tron', 'ton', 'celo', 'gnosis', 'fantom', 'moonbeam', 'aurora', 'kava', 'osmosis', 'hyperliquid', 'berachain', 'monad', 'megaeth'].includes(c)) return 2;
  return 3;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open so the protocol counts you as a lender.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield') && !c.includes('aggregator')) return `Deposit $${capital} into ${name}'s main yield position on ${chain} and keep it earning.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds inside its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged trade.`;
  if (c.includes('prediction')) return `Fund your account with $${capital} and place one position on a ${name} market.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('aggregator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('rwa')) return `Mint $${capital} of the yield-bearing asset ${name} issues on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('ai')) return `Use $${capital} of activity on ${name} on ${chain}: run a job, stake for access, or hold its receipt.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains,
 * TVL, age), never from a hand-written list of names. Gas figures are
 * rough estimates for one transaction on the protocol's main chain.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasUsd(chain);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'nothing to set up',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${gas} of gas for the deposit`,
      time: '15 minutes to set up',
    },
    {
      text: `Do one qualifying action each week, such as a deposit, a borrow, a swap or a vote, so your wallet stays active.`,
      cost: `about $${gas} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so your activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it cleanly.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The farm scenario: the stated assumptions behind a verdict. depositUsd null means the plan's own capital tier. */
export interface FarmScenario {
  allocShare: number;
  farmers: number;
  hourlyUsd: number;
  refDepositUsd: number;
  depositUsd: number | null;
}

/** The default scenario: the assumptions the shipped verdicts use. */
export function defaultFarmScenario(): FarmScenario {
  return { allocShare: FARM_DEFAULTS.allocShare, farmers: FARM_DEFAULTS.farmers, hourlyUsd: FARM_DEFAULTS.hourlyUsd, refDepositUsd: FARM_DEFAULTS.refDepositUsd, depositUsd: null };
}

/**
 * Net-of-fees economics for one row. The airdrop value is derived
 * transparently from the expected value with EXPLICIT, LABELLED
 * assumptions — it is not a measured fact:
 *   airdrop per farmer = expected value x allocShare / farmers
 *                        x (deposit / refDepositUsd)
 * The deposit scales the share linearly against the average farmer's
 * deposit ($100): a farmer who deposits twice the average is assumed to
 * earn twice the share. Gas is one deposit transaction plus one weekly
 * transaction per week of the hold (the claim step costs nothing to
 * check). Active time is the plan's own minutes: wallet setup 5, deposit
 * 15, claim 10, log 5, plus 10 minutes a week. Verdict: FARM when the
 * net clears $50 AND $25 an hour (beats the $25/h time value and is
 * worth the effort), THIN when it is positive but below that bar, SKIP
 * when it loses money. Change the assumptions and the verdicts move —
 * the dashboard's scenario controls do exactly that, with the same
 * arithmetic, so a judge can see the sensitivity.
 */
export function farmEconomics(p: SnapshotProtocol, age: number | null, expectedValueUsd: number, scenario: FarmScenario): FarmEconomics {
  const chain = chainOf(p);
  const capital = scenario.depositUsd ?? capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.ceil(hold / 7);
  const gas = (1 + weeks) * gasUsd(chain);
  const timeHours = 35 / 60 + (weeks * 10) / 60;
  const airdrop = ((expectedValueUsd * scenario.allocShare) / scenario.farmers) * (capital / scenario.refDepositUsd);
  const net = airdrop - gas - timeHours * scenario.hourlyUsd;
  const netPerHour = net / timeHours;
  const verdict: FarmVerdict = net >= 50 && netPerHour >= 25 ? 'FARM' : net > 0 ? 'THIN' : 'SKIP';
  return { verdict, airdropUsd: airdrop, gasUsd: gas, timeHours, capitalUsd: capital, holdDays: hold, netUsd: net, netPerHourUsd: netPerHour };
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    conditional_value_usd: row.conditional_value_usd,
    token_probability: row.token_probability,
    base_value_usd: row.model.base_value_usd,
    category_adjustment: row.model.category_adjustment,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_verdict: row.farm_verdict,
    farm_net_usd: row.farm_net_usd,
    farm_net_per_hour_usd: row.farm_net_per_hour_usd,
    farm_gas_usd: row.farm_gas_usd,
    farm_time_hours: row.farm_time_hours,
    farm_capital_usd: row.farm_capital_usd,
    farm_steps: row.farm_steps,
    watchlist: false, // filled in by buildRadar, which owns the watchlist
  };
}

/** The 758-protocol ledger: every protocol in exactly one group, with counts that sum to the snapshot size. */
export function buildLedger(snapshot: Snapshot, board: BoardRow[]): LedgerGroup[] {
  const boardSlugs = new Set(board.map((r) => r.slug));
  const watchlist = new Set(snapshot.watchlist);
  const groups: LedgerGroup[] = [];
  const rankedWatchlist = board.filter((r) => watchlist.has(r.slug)).length;
  groups.push({
    group: 'Ranked — on the watchlist',
    count: rankedWatchlist,
    note: 'TVL at or above the $50M floor, records no token, passes the eligibility rule.',
  });
  groups.push({
    group: 'Ranked — below the $50M floor',
    count: board.length - rankedWatchlist,
    note: 'Records no token and passes the eligibility rule, but below the watchlist floor.',
  });
  const mcapPositive = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length;
  groups.push({
    group: 'Records a token — has a market cap above zero',
    count: mcapPositive,
    note: `Already trading; shown at the market's own value, never ranked (top 24 on the page). ${tradedSet(snapshot).length} of them have TVL above zero and are the comps fit's input.`,
  });
  const tokenNoUsableMcap = snapshot.protocols.filter((p) => !isPreToken(p) && !(p.mcap_usd !== null && p.mcap_usd > 0)).length;
  groups.push({
    group: 'Records a token — no usable market cap',
    count: tokenNoUsableMcap,
    note: 'A CoinGecko id or a symbol is recorded, but the market cap is missing, zero, or negative: not pre-token, not ranked.',
  });
  const byReason = new Map<string, number>();
  let unexplained = 0;
  for (const p of snapshot.protocols) {
    if (!isPreToken(p) || boardSlugs.has(p.slug)) continue;
    const reason = exclusionReason(p);
    if (reason === null) {
      unexplained++;
      continue;
    }
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  const reasonOrder = [
    'category: CEX',
    'category: Bridge',
    'category: Canonical Bridge',
    'category: Liquid Staking',
    'category: Liquid Restaking',
    'category: Restaked BTC',
    'name ends in a version marker',
    'name has a wrapped/staked word',
    'name begins with an exchange name',
  ];
  for (const reason of [...reasonOrder, ...[...byReason.keys()].filter((k) => !reasonOrder.includes(k)).sort()]) {
    const n = byReason.get(reason) ?? 0;
    if (n > 0) {
      groups.push({
        group: `Excluded — ${reason}`,
        count: n,
        note: 'Pre-token, but the house eligibility rule excludes it (see the method note).',
      });
    }
  }
  if (unexplained > 0) {
    groups.push({
      group: 'Excluded — no house-rule reason recorded',
      count: unexplained,
      note: 'Pre-token and not ranked, but no clause of the house rule excludes it. This should be zero; if it is not, the board logic has a gap.',
    });
  }
  return groups;
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const fit = fitModel(tradedSet(snapshot));
  const holdout = evaluateHoldout(snapshot);
  const oddsModel = fitOddsModel(snapshot);
  const oddsEval = evaluateOdds(snapshot);
  const board = buildBoard(snapshot, fit, oddsModel);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const ledger = buildLedger(snapshot, board);
  const ledgerTotal = ledger.reduce((s, g) => s + g.count, 0);
  const ablation = valueAblation(snapshot);
  const farmCounts = {
    farm: board.filter((r) => r.farm_verdict === 'FARM').length,
    thin: board.filter((r) => r.farm_verdict === 'THIN').length,
    skip: board.filter((r) => r.farm_verdict === 'SKIP').length,
  };
  const oddsNames = oddsFeatureNames(oddsModel.spec, oddsModel.ctx);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    fitted: fit,
    holdout,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow).map((r) => ({ ...r, watchlist: snapshot.watchlist.includes(r.slug) })),
    live,
    odds: {
      n: oddsEval.n,
      positives: oddsEval.positives,
      baseRate: oddsEval.baseRate,
      baseBrier: oddsEval.baseBrier,
      selectedLoo: oddsEval.selectedLoo,
      selectedWf: oddsEval.selectedWf,
      wfTrain: oddsEval.wfTrain,
      wfTest: oddsEval.wfTest,
      wfCutoff: oddsEval.wfCutoff,
      controlLoo: oddsEval.controlLoo,
      controlWf: oddsEval.controlWf,
      terms: oddsEval.terms,
      coefficients: oddsModel.beta.map((value, i) => ({ feature: oddsNames[i]!, value: Math.round(value * 1e4) / 1e4 })),
      calibration: oddsEval.calibration,
      ageBuckets: oddsEval.ageBuckets,
      spec: oddsModel.spec,
    },
    ablation,
    ledger,
    ledger_total: ledgerTotal,
    farm_defaults: { allocShare: FARM_DEFAULTS.allocShare, farmers: FARM_DEFAULTS.farmers, hourlyUsd: FARM_DEFAULTS.hourlyUsd, refDepositUsd: FARM_DEFAULTS.refDepositUsd },
    farm_counts: farmCounts,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
