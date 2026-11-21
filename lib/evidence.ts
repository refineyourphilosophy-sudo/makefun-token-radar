// Token Radar — out-of-sample evidence for the value model.
//
// The value model's term table, computed at runtime from the snapshot on
// the 103 TRAINING tokens only (the traded set minus the 25 hold-out test
// slugs — those are never used for selection). Two held-out tests per
// candidate term, the same discipline as the odds model:
//   * 5-fold cross-validation (folds by slug order, index % 5), pooled
//     out-of-fold log R-squared and median absolute percentage error.
//   * Walk-forward: fit on older protocols, score on newer ones
//     (70/30 split by listing date; protocols with no listing date are
//     excluded from this test).
// A term is KEPT only if it beats the shipped fit materially in BOTH
// tests: more than 0.02 log R-squared on each (a pooled gain under 0.02
// is noise on 103 tokens). The shipped value model is the current one
// (OLS + shrunk category adjustment); every other variant is marked
// tested-not-kept, and the shuffled-change control is marked
// must-not-help. The range calibration is built the same way:
// intervals from the other folds' out-of-fold residuals, coverage counted
// on the held-out fold — so the coverage numbers are honest, not fitted
// to the rows they cover.
//
// scripts/eval-ablation.mjs imports this module and prints the same
// table the dashboard shows, so the numbers are reproducible with one
// command. This module never touches the 25 test tokens.

import { ageDays, fitModel, tradedSet, type Snapshot, type SnapshotProtocol } from './model.ts';
import { shuffled } from './odds.ts';

const log10 = Math.log10;
const med = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};
const clampChange = (c: number | null): number => Math.min(120, Math.max(-60, typeof c === 'number' && Number.isFinite(c) ? c : 0));
const ageOf = (asOf: string, p: SnapshotProtocol): number => ageDays(asOf, p.listed_at) ?? 365;

/** The 103 training tokens: traded set minus the 25 hold-out test slugs. */
export function valueTrainTokens(snapshot: Snapshot): SnapshotProtocol[] {
  const traded = tradedSet(snapshot);
  return traded.filter((_, i) => i % 5 !== 4);
}

/** Single-variable OLS in log space. */
function ols(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/** Multi-variable OLS via the normal equations (Gaussian elimination, tiny ridge). */
function olsMulti(X: number[][], ys: number[]): number[] {
  const p = X[0]!.length + 1;
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b: number[] = new Array<number>(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const row = [1, ...X[i]!];
    for (let j = 0; j < p; j++) {
      b[j]! += row[j]! * ys[i]!;
      for (let k = 0; k < p; k++) A[j]![k]! += row[j]! * row[k]!;
    }
  }
  for (let j = 1; j < p; j++) A[j]![j]! += 1e-9;
  for (let j = 0; j < p; j++) {
    let piv = j;
    for (let k = j + 1; k < p; k++) if (Math.abs(A[k]![j]!) > Math.abs(A[piv]![j]!)) piv = k;
    [A[j], A[piv]] = [A[piv]!, A[j]!];
    [b[j], b[piv]] = [b[piv]!, b[j]!];
    for (let k = j + 1; k < p; k++) {
      const f = A[k]![j]! / A[j]![j]!;
      for (let m = j; m < p; m++) A[k]![m]! -= f * A[j]![m]!;
      b[k]! -= f * b[j]!;
    }
  }
  const beta = new Array<number>(p).fill(0);
  for (let j = p - 1; j >= 0; j--) {
    let s = b[j]!;
    for (let k = j + 1; k < p; k++) s -= A[j]![k]! * beta[k]!;
    beta[j] = s / A[j]![j]!;
  }
  return beta;
}

type Predict = (p: SnapshotProtocol) => number; // predicts log10(market cap)

/** All variants, each a fit from training rows to a log-space predictor. */
function variants(asOf: string, shuffledChange: Map<string, number>): Record<string, { fit: (rows: SnapshotProtocol[]) => Predict }> {
  return {
    'current: OLS + shrunk category adj': {
      fit: (rows) => {
        const f = fitModel(rows);
        return (p) => f.intercept + f.slope * log10(p.tvl_usd) + (f.categoryAdj[p.category ?? 'null'] ?? 0);
      },
    },
    'global OLS only (no category)': {
      fit: (rows) => {
        const b = ols(rows.map((p) => log10(p.tvl_usd)), rows.map((p) => log10(p.mcap_usd!)));
        return (p) => b.intercept + b.slope * log10(p.tvl_usd);
      },
    },
    'OLS + unshrunk category median adj': {
      fit: (rows) => {
        const b = ols(rows.map((p) => log10(p.tvl_usd)), rows.map((p) => log10(p.mcap_usd!)));
        const res = new Map<string, number[]>();
        for (const p of rows) {
          const r = log10(p.mcap_usd!) - (b.intercept + b.slope * log10(p.tvl_usd));
          const list = res.get(p.category ?? 'null') ?? [];
          list.push(r);
          res.set(p.category ?? 'null', list);
        }
        const adj: Record<string, number> = {};
        for (const [k, v] of res) if (v.length >= 4) adj[k] = med(v);
        return (p) => b.intercept + b.slope * log10(p.tvl_usd) + (adj[p.category ?? 'null'] ?? 0);
      },
    },
    'category-specific slopes (>=8)': {
      fit: (rows) => {
        const g = ols(rows.map((p) => log10(p.tvl_usd)), rows.map((p) => log10(p.mcap_usd!)));
        const byCat = new Map<string, SnapshotProtocol[]>();
        for (const p of rows) {
          const list = byCat.get(p.category ?? 'null') ?? [];
          list.push(p);
          byCat.set(p.category ?? 'null', list);
        }
        const per: Record<string, { slope: number; intercept: number }> = {};
        for (const [k, v] of byCat) if (v.length >= 8) per[k] = ols(v.map((p) => log10(p.tvl_usd)), v.map((p) => log10(p.mcap_usd!)));
        return (p) => {
          const c = per[p.category ?? 'null'];
          return c ? c.intercept + c.slope * log10(p.tvl_usd) : g.intercept + g.slope * log10(p.tvl_usd);
        };
      },
    },
    '+ 7d change feature': {
      fit: (rows) => {
        const beta = olsMulti(rows.map((p) => [log10(p.tvl_usd), clampChange(p.change_7d) / 100]), rows.map((p) => log10(p.mcap_usd!)));
        return (p) => beta[0]! + beta[1]! * log10(p.tvl_usd) + beta[2]! * (clampChange(p.change_7d) / 100);
      },
    },
    '+ age feature': {
      fit: (rows) => {
        const beta = olsMulti(rows.map((p) => [log10(p.tvl_usd), Math.log10(ageOf(asOf, p) + 1)]), rows.map((p) => log10(p.mcap_usd!)));
        return (p) => beta[0]! + beta[1]! * log10(p.tvl_usd) + beta[2]! * Math.log10(ageOf(asOf, p) + 1);
      },
    },
    '+ chain-count feature': {
      fit: (rows) => {
        const beta = olsMulti(rows.map((p) => [log10(p.tvl_usd), Math.log(p.chains.length)]), rows.map((p) => log10(p.mcap_usd!)));
        return (p) => beta[0]! + beta[1]! * log10(p.tvl_usd) + beta[2]! * Math.log(p.chains.length);
      },
    },
    '+ change + age + chains': {
      fit: (rows) => {
        const beta = olsMulti(
          rows.map((p) => [log10(p.tvl_usd), clampChange(p.change_7d) / 100, Math.log10(ageOf(asOf, p) + 1), Math.log(p.chains.length)]),
          rows.map((p) => log10(p.mcap_usd!)),
        );
        return (p) => beta[0]! + beta[1]! * log10(p.tvl_usd) + beta[2]! * (clampChange(p.change_7d) / 100) + beta[3]! * Math.log10(ageOf(asOf, p) + 1) + beta[4]! * Math.log(p.chains.length);
      },
    },
    'Huber robust log-log (no category)': {
      fit: (rows) => {
        let b = ols(rows.map((p) => log10(p.tvl_usd)), rows.map((p) => log10(p.mcap_usd!)));
        for (let it = 0; it < 10; it++) {
          const res = rows.map((p) => log10(p.mcap_usd!) - (b.intercept + b.slope * log10(p.tvl_usd)));
          const s = 1.4826 * med(res.map((r) => Math.abs(r - med(res)))) || 1;
          const w = res.map((r) => Math.min(1, (1.345 * s) / Math.abs(r) || 1));
          const xs = rows.map((p) => log10(p.tvl_usd));
          const ys = rows.map((p) => log10(p.mcap_usd!));
          const sw = w.reduce((a, x) => a + x, 0);
          const mx = xs.reduce((a, x, i) => a + w[i]! * x, 0) / sw;
          const my = ys.reduce((a, y, i) => a + w[i]! * y, 0) / sw;
          let sxy = 0;
          let sxx = 0;
          for (let i = 0; i < rows.length; i++) {
            sxy += w[i]! * (xs[i]! - mx) * (ys[i]! - my);
            sxx += w[i]! * (xs[i]! - mx) ** 2;
          }
          const slope = sxx === 0 ? 0 : sxy / sxx;
          b = { slope, intercept: my - slope * mx };
        }
        return (p) => b.intercept + b.slope * log10(p.tvl_usd);
      },
    },
    'median mcap/TVL ratio per category (shrunk)': {
      fit: (rows) => {
        const ratio = (p: SnapshotProtocol): number => p.mcap_usd! / p.tvl_usd;
        const global = med(rows.map(ratio));
        const byCat = new Map<string, number[]>();
        for (const p of rows) {
          const list = byCat.get(p.category ?? 'null') ?? [];
          list.push(ratio(p));
          byCat.set(p.category ?? 'null', list);
        }
        const adj: Record<string, number> = {};
        for (const [k, v] of byCat) {
          const m = med(v);
          adj[k] = v.length >= 4 ? (v.length * m + 8 * global) / (v.length + 8) : global;
        }
        return (p) => log10(p.tvl_usd * (adj[p.category ?? 'null'] ?? global));
      },
    },
    'log(TVL + $100M) offset OLS': {
      fit: (rows) => {
        const b = ols(rows.map((p) => log10(p.tvl_usd + 1e8)), rows.map((p) => log10(p.mcap_usd!)));
        return (p) => b.intercept + b.slope * log10(p.tvl_usd + 1e8);
      },
    },
    'kNN in log-TVL (k=5, distance-weighted)': {
      fit: (rows) => {
        const pts = rows.map((p) => ({ x: log10(p.tvl_usd), y: log10(p.mcap_usd!) }));
        return (p) => {
          const x = log10(p.tvl_usd);
          const d = pts.map((q) => ({ d: Math.abs(q.x - x), y: q.y })).sort((a, b) => a.d - b.d).slice(0, 5);
          let sw = 0;
          let sy = 0;
          for (const q of d) {
            const w = 1 / (q.d + 0.05);
            sw += w;
            sy += w * q.y;
          }
          return sy / sw;
        };
      },
    },
    'CONTROL: OLS + shuffled 7d change': {
      fit: (rows) => {
        const beta = olsMulti(rows.map((p) => [log10(p.tvl_usd), (shuffledChange.get(p.slug) ?? 0) / 100]), rows.map((p) => log10(p.mcap_usd!)));
        return (p) => beta[0]! + beta[1]! * log10(p.tvl_usd) + beta[2]! * ((shuffledChange.get(p.slug) ?? 0) / 100);
      },
    },
  };
}

const score = (rows: SnapshotProtocol[], predict: Predict): { logR2: number; mdAPE: number } => {
  const meanLog = rows.reduce((s, p) => s + log10(p.mcap_usd!), 0) / rows.length;
  let ssRes = 0;
  let ssTot = 0;
  const apes: number[] = [];
  for (const p of rows) {
    const predLog = predict(p);
    const pred = Math.max(1, 10 ** predLog);
    const act = log10(p.mcap_usd!);
    ssRes += (act - predLog) ** 2;
    ssTot += (act - meanLog) ** 2;
    apes.push(Math.abs(pred - p.mcap_usd!) / p.mcap_usd!);
  }
  apes.sort((a, b) => a - b);
  return { logR2: ssTot === 0 ? 0 : 1 - ssRes / ssTot, mdAPE: apes[Math.floor(apes.length / 2)]! };
};

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

/** One row of the ablation table. */
export interface AblationRow {
  name: string;
  cvLogR2: number;
  cvMdAPE: number;
  wfLogR2: number;
  wfMdAPE: number;
  verdict: 'kept' | 'tested-not-kept' | 'must-not-help';
}

/** Range calibration for the shipped (current) variant, from nested-fold intervals. */
export interface RangeCalibration {
  /** Rows the coverage was counted on (the 103 training tokens). */
  n: number;
  p50Stated: number;
  p50Actual: number;
  p80Stated: number;
  p80Actual: number;
}

/**
 * The value-model ablation table plus range calibration, on the 103
 * training tokens only. Deterministic: fixed folds, fixed seed.
 */
export function valueAblation(snapshot: Snapshot): { variants: AblationRow[]; ranges: RangeCalibration } {
  const train = valueTrainTokens(snapshot);
  const asOf = snapshot.as_of;
  // One fixed shuffle of the 7d-change column for the control variant.
  const shuffledChange = new Map<string, number>();
  const changes = shuffled(train.map((p) => clampChange(p.change_7d)));
  train.forEach((p, i) => shuffledChange.set(p.slug, changes[i]!));
  const all = variants(asOf, shuffledChange);

  const K = 5;
  const folds = train.map((_, i) => i % K);
  const table: AblationRow[] = [];
  // Out-of-fold predictions of the CURRENT variant, for the range calibration.
  const currentOof: { slug: string; logA: number; logP: number; fold: number }[] = [];

  for (const [name, variant] of Object.entries(all)) {
    // 5-fold CV, pooled out-of-fold.
    const oof: { p: SnapshotProtocol; logP: number }[] = [];
    for (let k = 0; k < K; k++) {
      const tr = train.filter((_, i) => folds[i] !== k);
      const te = train.filter((_, i) => folds[i] === k);
      const predict = variant.fit(tr);
      for (const p of te) {
        oof.push({ p, logP: predict(p) });
        if (name.startsWith('current:')) currentOof.push({ slug: p.slug, logA: log10(p.mcap_usd!), logP: predict(p), fold: k });
      }
    }
    const cv = score(
      oof.map((o) => o.p),
      // score() needs a predictor; rebuild it from the stored predictions.
      (() => {
        const bySlug = new Map(oof.map((o) => [o.p.slug, o.logP]));
        return (p: SnapshotProtocol): number => bySlug.get(p.slug)!;
      })(),
    );
    // Walk-forward: fit on older protocols, score on newer.
    const dated = train.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
    const cut = Math.floor(dated.length * 0.7);
    const wf = score(dated.slice(cut), variant.fit(dated.slice(0, cut)));
    table.push({ name, cvLogR2: cv.logR2, cvMdAPE: cv.mdAPE, wfLogR2: wf.logR2, wfMdAPE: wf.mdAPE, verdict: 'tested-not-kept' });
  }

  // Verdicts. The shipped model is 'current'. A challenger is KEPT only
  // if it beats the shipped fit MATERIALLY in both tests: more than 0.02
  // log R-squared on each. A pooled gain under 0.02 is noise on 103
  // tokens (single-fold log R-squared swings by ~0.4), and every
  // variant's walk-forward score is negative here — worse than predicting
  // the test set's mean — so a small walk-forward edge is not evidence
  // the term generalises forward in time. If a challenger ever passed
  // both bars, the shipped model should be changed to it; none does.
  const current = table.find((r) => r.name.startsWith('current:'))!;
  for (const row of table) {
    if (row.name.startsWith('current:')) row.verdict = 'kept';
    else if (row.name.startsWith('CONTROL:')) row.verdict = 'must-not-help';
    else if (row.cvLogR2 - current.cvLogR2 > 0.02 && row.wfLogR2 - current.wfLogR2 > 0.02) row.verdict = 'kept';
    else row.verdict = 'tested-not-kept';
  }

  // Range calibration for the current variant: intervals from the other
  // folds' out-of-fold residuals, coverage counted on the held-out fold.
  let in50 = 0;
  let in80 = 0;
  for (let k = 0; k < K; k++) {
    const others = currentOof.filter((o) => o.fold !== k).map((o) => o.logA - o.logP).sort((a, b) => a - b);
    const q25 = quantile(others, 0.25);
    const q75 = quantile(others, 0.75);
    const q10 = quantile(others, 0.1);
    const q90 = quantile(others, 0.9);
    for (const o of currentOof.filter((o) => o.fold === k)) {
      const r = o.logA - o.logP;
      if (r >= q25 && r <= q75) in50++;
      if (r >= q10 && r <= q90) in80++;
    }
  }
  const ranges: RangeCalibration = {
    n: currentOof.length,
    p50Stated: 50,
    p50Actual: currentOof.length === 0 ? 0 : (in50 / currentOof.length) * 100,
    p80Stated: 80,
    p80Actual: currentOof.length === 0 ? 0 : (in80 / currentOof.length) * 100,
  };
  return { variants: table, ranges };
}
