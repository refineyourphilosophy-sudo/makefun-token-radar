// Token Radar — token-launch probability (odds) model.
//
// A second model, fitted on the snapshot's own peer record: the probability
// a protocol records a token. Outcome: the protocol records a token
// (a market cap, a CoinGecko id or a symbol is present) or it does not.
// Fitted by logistic regression (IRLS, no randomness, no clock), on every
// protocol in the snapshot EXCEPT the 25 traded tokens the value model's
// hold-out uses as its test set — those slugs are off-limits for training
// and selection here too (see evaluateHoldout in lib/model.ts: traded
// tokens sorted by slug, every 5th held out).
//
// The shipped feature set (SELECTED_ODDS_SPEC) is the one the term
// selection in scripts/eval-odds.mjs kept: a term is in only if it lowers
// the Brier score in BOTH the leave-one-out test and the walk-forward test
// (train on older protocols, score on newer). The script prints the full
// table; re-run it to reproduce the selection. Control terms that must
// not help (a shuffled feature) are in the same table.
//
// The odds are the peers' record, not a forecast: P(token) is the share
// of similar protocols that record one. The board's implied value becomes
// an expected value: conditional value-if-launches x P(token).

import { ageDays, tradedSet, type Snapshot, type SnapshotProtocol } from './model.ts';

/** A protocol records a token when any of the three token fields is present. */
export function hasToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

/** The 25 hold-out test slugs of the value model: traded tokens sorted by slug, every 5th. */
export function holdoutTestSlugs(snapshot: Snapshot): Set<string> {
  const traded = tradedSet(snapshot);
  return new Set(traded.filter((_, i) => i % 5 === 4).map((p) => p.slug));
}

/** One feature's name. 'cats' is the group of category dummies (see oddsContext). */
export type OddsFeature = 'logtvl' | 'age' | 'age_missing' | 'change' | 'chains' | 'cats';

/**
 * Age in years imputed for a protocol with no listing date. Unknown-date
 * protocols record a token at 77.6%, about the rate of the 4+ year bucket
 * (78.3%) — not the 1–2 year bucket (36.9%) the median-age imputation
 * put them in. The shipped model imputes 4.0 years and carries NO
 * 'age_missing' indicator: the indicator's fitted coefficient (+1.26 in
 * v2) had zero walk-forward validation (walk-forward excludes unknown-date
 * rows, so it could never see the term), while the 4.0-year imputation
 * matches the shipped leave-one-out Brier (0.1911 vs 0.1915) with a
 * transparent encoding. See scripts/eval-odds-v3.mjs. null = v2 behaviour
 * (median age + indicator) — kept only for the comparison scripts.
 */
export const IMPUTED_UNKNOWN_AGE_YEARS: number | null = 4.0;

/** The shipped odds feature set: set by scripts/eval-odds.mjs's term selection. */
export const SELECTED_ODDS_SPEC: OddsFeature[] = ['logtvl', 'age', 'change', 'cats'];

/** Categories with at least 30 protocols in the odds training set get a dummy each. */
export const CATEGORY_DUMMY_MIN = 30;

/** Everything feature extraction needs that depends on the training set. */
export interface OddsContext {
  /** Median age in years over the training protocols with a known listing date. */
  medianAgeYears: number;
  /** Age in years used when a listing date is unknown (the imputed value, or the median when no imputation is set). */
  unknownAgeYears: number;
  /** Whether the 'age_missing' indicator feature is active (false when an imputed age is set). */
  useAgeMissing: boolean;
  /** Category dummies, in a fixed order. */
  catDummies: string[];
  /** Overall token rate in the training set (the base-rate reference). */
  baseRate: number;
}

/** Options for building the feature context. `unknownAgeYears` null = v2 behaviour (median age + indicator). */
export interface OddsContextOptions {
  unknownAgeYears?: number | null;
}

/** The odds training rows: every protocol except the 25 hold-out test slugs. */
export function oddsRows(snapshot: Snapshot): SnapshotProtocol[] {
  const excluded = holdoutTestSlugs(snapshot);
  return snapshot.protocols.filter((p) => !excluded.has(p.slug));
}

/** Build the feature context from the odds training rows. */
export function oddsContext(rows: SnapshotProtocol[], asOf: string, opts: OddsContextOptions = {}): OddsContext {
  const ages = rows
    .map((p) => ageDays(asOf, p.listed_at))
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b);
  const medianAgeYears = ages.length === 0 ? 1.85 : ages[Math.floor(ages.length / 2)]! / 365;
  const counts = new Map<string, number>();
  for (const p of rows) {
    const key = p.category ?? 'null';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const catDummies = [...counts.entries()]
    .filter(([, n]) => n >= CATEGORY_DUMMY_MIN)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k]) => k);
  const positives = rows.filter(hasToken).length;
  const imputed = opts.unknownAgeYears ?? null;
  return {
    medianAgeYears,
    unknownAgeYears: imputed ?? medianAgeYears,
    useAgeMissing: imputed === null,
    catDummies,
    baseRate: rows.length === 0 ? 0 : positives / rows.length,
  };
}

const clampChange = (c: number | null): number => Math.min(120, Math.max(-60, typeof c === 'number' && Number.isFinite(c) ? c : 0));

/** One row's feature vector for a spec, intercept first. log TVL is centred at 7.5 for IRLS stability. */
export function oddsFeatures(p: SnapshotProtocol, spec: OddsFeature[], ctx: OddsContext, asOf: string): number[] {
  const x: number[] = [1];
  for (const f of spec) {
    if (f === 'logtvl') x.push(Math.log10(p.tvl_usd) - 7.5);
    else if (f === 'age') {
      const age = ageDays(asOf, p.listed_at);
      x.push(age === null ? ctx.unknownAgeYears : age / 365);
    } else if (f === 'age_missing') x.push(p.listed_at === null ? 1 : 0);
    else if (f === 'change') x.push(clampChange(p.change_7d) / 100);
    else if (f === 'chains') x.push(Math.log(p.chains.length + 1));
    else if (f === 'cats') {
      for (const c of ctx.catDummies) x.push((p.category ?? 'null') === c ? 1 : 0);
    }
  }
  return x;
}

/** Human-readable names for the fitted coefficients, in feature-vector order. */
export function oddsFeatureNames(spec: OddsFeature[], ctx: OddsContext): string[] {
  const names: string[] = ['intercept'];
  for (const f of spec) {
    if (f === 'logtvl') names.push('log10(TVL) - 7.5');
    else if (f === 'age') names.push('age (years)');
    else if (f === 'age_missing') names.push('listing date unknown');
    else if (f === 'change') names.push('7d TVL change (fraction)');
    else if (f === 'chains') names.push('log(chains + 1)');
    else if (f === 'cats') for (const c of ctx.catDummies) names.push(`category=${c}`);
  }
  return names;
}

/** Solve A x = b by Gaussian elimination with partial pivoting. A is square. */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const d = M[col]![col]!;
    if (d === 0) throw new Error('logistic fit: singular matrix');
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / d;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= M[r]![c]! * x[c]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

const sigmoid = (eta: number): number => {
  const e = Math.max(-30, Math.min(30, eta));
  return 1 / (1 + Math.exp(-e));
};

/**
 * Logistic regression by IRLS (Newton-Raphson on the log-likelihood).
 * Deterministic: fixed iteration cap, fixed tolerance, no randomness.
 * A tiny ridge (1e-6, not on the intercept) keeps the solve stable.
 */
export function fitLogistic(
  X: number[][],
  y: number[],
  opts: { maxIter?: number; tol?: number; start?: number[] } = {},
): { beta: number[]; iterations: number; converged: boolean } {
  const maxIter = opts.maxIter ?? 60;
  const tol = opts.tol ?? 1e-8;
  const k = X[0]!.length;
  let beta = opts.start ? [...opts.start] : new Array<number>(k).fill(0);
  let converged = false;
  let iterations = 0;
  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const b: number[] = new Array<number>(k).fill(0);
    for (let i = 0; i < X.length; i++) {
      const row = X[i]!;
      const eta = row.reduce((s, v, j) => s + v * beta[j]!, 0);
      const pr = sigmoid(eta);
      const w = Math.max(1e-6, pr * (1 - pr));
      const z = eta + (y[i]! - pr) / w;
      for (let a = 0; a < k; a++) {
        b[a]! += w * row[a]! * z;
        for (let c = 0; c < k; c++) A[a]![c]! += w * row[a]! * row[c]!;
      }
    }
    for (let a = 1; a < k; a++) A[a]![a]! += 1e-6;
    const next = solveLinear(A, b);
    let delta = 0;
    for (let j = 0; j < k; j++) delta = Math.max(delta, Math.abs(next[j]! - beta[j]!));
    beta = next;
    if (delta < tol) {
      converged = true;
      break;
    }
  }
  return { beta, iterations, converged };
}

/** The fitted odds model: coefficients plus the context they were fitted under. */
export interface FittedOdds {
  beta: number[];
  spec: OddsFeature[];
  ctx: OddsContext;
  n: number;
  positives: number;
  baseRate: number;
  converged: boolean;
}

/** Fit the shipped odds model on the odds training rows. */
export function fitOddsModel(snapshot: Snapshot): FittedOdds {
  const rows = oddsRows(snapshot);
  const ctx = oddsContext(rows, snapshot.as_of, { unknownAgeYears: IMPUTED_UNKNOWN_AGE_YEARS });
  const X = rows.map((p) => oddsFeatures(p, SELECTED_ODDS_SPEC, ctx, snapshot.as_of));
  const y = rows.map((p) => (hasToken(p) ? 1 : 0));
  const fit = fitLogistic(X, y);
  return {
    beta: fit.beta,
    spec: SELECTED_ODDS_SPEC,
    ctx,
    n: rows.length,
    positives: y.reduce((a, b) => a + b, 0),
    baseRate: ctx.baseRate,
    converged: fit.converged,
  };
}

/** P(token) for one protocol under a fitted odds model. */
export function predictOdds(model: FittedOdds, p: SnapshotProtocol, asOf: string): number {
  const x = oddsFeatures(p, model.spec, model.ctx, asOf);
  const eta = x.reduce((s, v, j) => s + v * model.beta[j]!, 0);
  return sigmoid(eta);
}

/** Mean squared error between predicted probabilities and 0/1 outcomes. */
export function brierScore(preds: number[], ys: number[]): number {
  let s = 0;
  for (let i = 0; i < preds.length; i++) s += (preds[i]! - ys[i]!) ** 2;
  return preds.length === 0 ? 0 : s / preds.length;
}

/** Brier score of the constant base-rate prediction (the no-model reference). */
export function baseRateBrier(baseRate: number): number {
  return baseRate * (1 - baseRate);
}

/**
 * Leave-one-out Brier for a spec: refit without each row, predict it.
 * Warm-started from the full fit (a few IRLS steps converge); deterministic.
 * `extra` appends one more column to every feature row (used for the
 * shuffled control term in scripts/eval-odds.mjs).
 */
export function looBrier(
  rows: SnapshotProtocol[],
  spec: OddsFeature[],
  ctx: OddsContext,
  asOf: string,
  extra?: number[],
): { brier: number; preds: number[] } {
  const X = rows.map((p, i) => {
    const v = oddsFeatures(p, spec, ctx, asOf);
    if (extra !== undefined) v.push(extra[i]!);
    return v;
  });
  const y = rows.map((p) => (hasToken(p) ? 1 : 0));
  const full = fitLogistic(X, y);
  const preds: number[] = new Array<number>(rows.length).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const Xi = X.filter((_, j) => j !== i);
    const yi = y.filter((_, j) => j !== i);
    const fit = fitLogistic(Xi, yi, { maxIter: 8, tol: 1e-5, start: full.beta });
    const eta = X[i]!.reduce((s, v, j) => s + v * fit.beta[j]!, 0);
    preds[i] = sigmoid(eta);
  }
  return { brier: brierScore(preds, y), preds };
}

/**
 * Walk-forward Brier for a spec: protocols with a known listing date,
 * sorted by date; fit on the older 70%, score on the newer 30%.
 * Protocols with no listing date are excluded from this test.
 */
export function walkForwardBrier(
  rows: SnapshotProtocol[],
  spec: OddsFeature[],
  ctx: OddsContext,
  asOf: string,
  extra?: number[],
): { brier: number; nTrain: number; nTest: number; cutoff: string } {
  const dated = rows.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const cut = Math.floor(dated.length * 0.7);
  const train = dated.slice(0, cut);
  const test = dated.slice(cut);
  const extraBySlug = extra === undefined ? undefined : new Map(rows.map((p, i) => [p.slug, extra[i]!]));
  const feat = (p: SnapshotProtocol): number[] => {
    const v = oddsFeatures(p, spec, ctx, asOf);
    if (extraBySlug !== undefined) v.push(extraBySlug.get(p.slug)!);
    return v;
  };
  const Xtr = train.map(feat);
  const ytr = train.map((p) => (hasToken(p) ? 1 : 0));
  const fit = fitLogistic(Xtr, ytr);
  const preds = test.map((p) => {
    const x = feat(p);
    return sigmoid(x.reduce((s, v, j) => s + v * fit.beta[j]!, 0));
  });
  const ys = test.map((p) => (hasToken(p) ? 1 : 0));
  return { brier: brierScore(preds, ys), nTrain: train.length, nTest: test.length, cutoff: test[0]?.listed_at ?? '' };
}

/** Calibration table: equal-count bins of predicted probability vs observed token rate. */
export function calibrationDeciles(preds: number[], ys: number[], bins = 10): { bin: number; n: number; meanPred: number; observed: number }[] {
  const order = preds.map((p, i) => ({ p, y: ys[i]! })).sort((a, b) => a.p - b.p);
  const out: { bin: number; n: number; meanPred: number; observed: number }[] = [];
  const per = Math.floor(order.length / bins);
  for (let b = 0; b < bins; b++) {
    const slice = order.slice(b * per, b === bins - 1 ? order.length : (b + 1) * per);
    if (slice.length === 0) continue;
    out.push({
      bin: b + 1,
      n: slice.length,
      meanPred: slice.reduce((s, r) => s + r.p, 0) / slice.length,
      observed: slice.reduce((s, r) => s + r.y, 0) / slice.length,
    });
  }
  return out;
}

/** A deterministic shuffle (mulberry32, fixed seed): the control term that must not help. */
export function shuffled(values: number[], seed = 20261114): number[] {
  const out = [...values];
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** One row of the odds term-selection table. */
export interface OddsTermRow {
  label: string;
  looBrier: number;
  wfBrier: number;
  kept: boolean;
}

/** One age bucket of the peers' record. */
export interface OddsAgeBucket {
  bucket: string;
  n: number;
  withToken: number;
  rate: number;
}

/** The full odds evaluation: term selection, control, calibration, peers' record. */
export interface OddsEvaluation {
  n: number;
  positives: number;
  baseRate: number;
  baseBrier: number;
  terms: OddsTermRow[];
  controlLoo: number;
  controlWf: number;
  selectedLoo: number;
  selectedWf: number;
  wfTrain: number;
  wfTest: number;
  wfCutoff: string;
  calibration: { bin: number; n: number; meanPred: number; observed: number }[];
  ageBuckets: OddsAgeBucket[];
  /** The spec the selection keeps (base + every term that helps in both tests). */
  selectedSpec: OddsFeature[];
}

/**
 * Run the odds term selection: base + one candidate at a time, KEPT only
 * if the Brier score improves in BOTH the leave-one-out and the
 * walk-forward test. The shuffled control must not help in either.
 * Also returns the selected model's LOO calibration and the peers'
 * token rate by age bucket. Deterministic; re-run scripts/eval-odds.mjs
 * to reproduce this table from the snapshot.
 */
export function evaluateOdds(snapshot: Snapshot): OddsEvaluation {
  const rows = oddsRows(snapshot);
  const ctx = oddsContext(rows, snapshot.as_of, { unknownAgeYears: IMPUTED_UNKNOWN_AGE_YEARS });
  const ys = rows.map((p) => (hasToken(p) ? 1 : 0));
  const baseBrier = baseRateBrier(ctx.baseRate);
  const base: OddsFeature[] = ['logtvl'];
  // The age candidate follows the shipped encoding: with an imputed age it
  // is just ['age'] (no indicator exists to add); without one it is the
  // v2 bundle ['age', 'age_missing'].
  const ageCandidate: { label: string; add: OddsFeature[] } =
    IMPUTED_UNKNOWN_AGE_YEARS === null
      ? { label: '+ age (years + listing-date-unknown)', add: ['age', 'age_missing'] }
      : { label: `+ age (years; unknown imputed at ${IMPUTED_UNKNOWN_AGE_YEARS.toFixed(1)}y)`, add: ['age'] };
  const candidates: { label: string; add: OddsFeature[] }[] = [
    ageCandidate,
    { label: '+ 7d TVL change', add: ['change'] },
    { label: '+ chain count', add: ['chains'] },
    { label: '+ category dummies', add: ['cats'] },
  ];
  const baseEval = { loo: looBrier(rows, base, ctx, snapshot.as_of).brier, wf: walkForwardBrier(rows, base, ctx, snapshot.as_of) };
  const terms: OddsTermRow[] = [{ label: 'base: log TVL', looBrier: baseEval.loo, wfBrier: baseEval.wf.brier, kept: true }];
  const selectedSpec: OddsFeature[] = [...base];
  for (const c of candidates) {
    const spec = [...base, ...c.add];
    const loo = looBrier(rows, spec, ctx, snapshot.as_of).brier;
    const wf = walkForwardBrier(rows, spec, ctx, snapshot.as_of).brier;
    const kept = loo < baseEval.loo && wf < baseEval.wf.brier;
    if (kept) selectedSpec.push(...c.add);
    terms.push({ label: c.label, looBrier: loo, wfBrier: wf, kept });
  }
  const shuffledCol = shuffled(rows.map((p) => Math.log10(p.tvl_usd) - 7.5));
  const controlLoo = looBrier(rows, base, ctx, snapshot.as_of, shuffledCol).brier;
  const controlWf = walkForwardBrier(rows, base, ctx, snapshot.as_of, shuffledCol).brier;
  const selLoo = looBrier(rows, selectedSpec, ctx, snapshot.as_of);
  const selWf = walkForwardBrier(rows, selectedSpec, ctx, snapshot.as_of);
  const bucketOf = (p: SnapshotProtocol): string => {
    if (p.listed_at === null) return 'listing date unknown';
    const d = (Date.parse(snapshot.as_of) - Date.parse(p.listed_at)) / 86_400_000;
    return d < 180 ? '< 6 months' : d < 365 ? '6-12 months' : d < 730 ? '1-2 years' : d < 1460 ? '2-4 years' : '4+ years';
  };
  const bucketOrder = ['< 6 months', '6-12 months', '1-2 years', '2-4 years', '4+ years', 'listing date unknown'];
  const bucketMap = new Map<string, { n: number; y: number }>();
  for (const p of rows) {
    const k = bucketOf(p);
    const b = bucketMap.get(k) ?? { n: 0, y: 0 };
    b.n++;
    if (hasToken(p)) b.y++;
    bucketMap.set(k, b);
  }
  const ageBuckets: OddsAgeBucket[] = bucketOrder
    .filter((k) => bucketMap.has(k))
    .map((k) => {
      const b = bucketMap.get(k)!;
      return { bucket: k, n: b.n, withToken: b.y, rate: b.y / b.n };
    });
  return {
    n: rows.length,
    positives: ys.reduce((a, b) => a + b, 0),
    baseRate: ctx.baseRate,
    baseBrier,
    terms,
    controlLoo,
    controlWf,
    selectedLoo: selLoo.brier,
    selectedWf: selWf.brier,
    wfTrain: selWf.nTrain,
    wfTest: selWf.nTest,
    wfCutoff: selWf.cutoff,
    calibration: calibrationDeciles(selLoo.preds, ys),
    ageBuckets,
    selectedSpec,
  };
}
