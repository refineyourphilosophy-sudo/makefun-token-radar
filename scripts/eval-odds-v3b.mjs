// v3 follow-up: is the Risk Curators degradation real or noise, and what does
// the dummy actually do? Plus imputation sensitivity under the adopted spec.
//
//   node scripts/eval-odds-v3b.mjs --input <snapshot.json>
//
// 1. Paired standard errors for the LOO Brier differences A-vs-B and A-vs-E
//    (same rows, same estimator — the paired SE is the honest noise bar).
// 2. Walk-forward paired difference, re-implemented with the library's own
//    fitLogistic/oddsFeatures on the same 70/30 dated split.
// 3. Calibration of the Risk Curators rows: mean predicted P with vs without
//    the dummy, against the observed 12.8% token rate — does the dummy do
//    real work, or does age alone already predict the low rate?
// 4. Imputation sensitivity with the RC dummy KEPT (the adopted combination).
import { readFileSync } from 'node:fs';
import { parseSnapshot } from '../lib/model.ts';
import {
  fitLogistic,
  hasToken,
  looBrier,
  oddsContext,
  oddsFeatures,
  oddsRows,
  walkForwardBrier,
} from '../lib/odds.ts';

const args = process.argv.slice(2);
const get = (n, fb) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fb;
};
const snapshot = parseSnapshot(readFileSync(get('input', '/home/hatch/workspace/makefun-test/token-radar-01-kit/input/snapshot.json'), 'utf8'));
const rows = oddsRows(snapshot);
const baseCtx = oddsContext(rows, snapshot.as_of);
const asOf = snapshot.as_of;
const ys = rows.map((p) => (hasToken(p) ? 1 : 0));
const cloneCtx = (over) => ({ ...baseCtx, ...over });
const specA = ['logtvl', 'age', 'age_missing', 'change', 'cats'];
const specNoInd = ['logtvl', 'age', 'change', 'cats'];
const ctxNoRC = cloneCtx({ catDummies: baseCtx.catDummies.filter((c) => c !== 'Risk Curators') });

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sePaired = (d) => {
  const m = mean(d);
  const sd = Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / (d.length - 1));
  return sd / Math.sqrt(d.length);
};

// 1. Paired LOO differences.
const looA = looBrier(rows, specA, baseCtx, asOf);
const looB = looBrier(rows, specA, ctxNoRC, asOf);
const looE = looBrier(rows, specNoInd, cloneCtx({ unknownAgeYears: 4.0, useAgeMissing: false, catDummies: baseCtx.catDummies.filter((c) => c !== 'Risk Curators') }), asOf);
const diffB = looB.preds.map((p, i) => (p - ys[i]) ** 2 - (looA.preds[i] - ys[i]) ** 2);
const diffE = looE.preds.map((p, i) => (p - ys[i]) ** 2 - (looA.preds[i] - ys[i]) ** 2);
console.log('Paired LOO Brier differences vs v2 baseline A (positive = worse):');
console.log(`  B (drop RC dummy):     mean +${mean(diffB).toFixed(4)}  SE ${sePaired(diffB).toFixed(4)}  (${(mean(diffB) / sePaired(diffB)).toFixed(2)} SE)`);
console.log(`  E (drop RC + impute):  mean +${mean(diffE).toFixed(4)}  SE ${sePaired(diffE).toFixed(4)}  (${(mean(diffE) / sePaired(diffE)).toFixed(2)} SE)`);

// 2. Walk-forward paired difference (same 70/30 dated split as lib/odds.ts).
function wfPreds(spec, ctx) {
  const dated = rows.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at < b.listed_at ? -1 : a.listed_at > b.listed_at ? 1 : a.slug < b.slug ? -1 : 1));
  const cut = Math.floor(dated.length * 0.7);
  const train = dated.slice(0, cut);
  const test = dated.slice(cut);
  const Xtr = train.map((p) => oddsFeatures(p, spec, ctx, asOf));
  const ytr = train.map((p) => (hasToken(p) ? 1 : 0));
  const fit = fitLogistic(Xtr, ytr);
  const sig = (eta) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, eta))));
  return {
    preds: test.map((p) => sig(oddsFeatures(p, spec, ctx, asOf).reduce((s, v, j) => s + v * fit.beta[j], 0))),
    ys: test.map((p) => (hasToken(p) ? 1 : 0)),
    test,
  };
}
const wfA = wfPreds(specA, baseCtx);
const wfB = wfPreds(specA, ctxNoRC);
const diffWf = wfB.preds.map((p, i) => (p - wfA.ys[i]) ** 2 - (wfA.preds[i] - wfA.ys[i]) ** 2);
console.log('Paired walk-forward Brier difference vs A:');
console.log(`  B (drop RC dummy):     mean +${mean(diffWf).toFixed(4)}  SE ${sePaired(diffWf).toFixed(4)}  (${(mean(diffWf) / sePaired(diffWf)).toFixed(2)} SE)  nTest=${wfA.test.length}`);
console.log(`  check: WF Brier A=${wfA.preds.reduce((s, p, i) => s + (p - wfA.ys[i]) ** 2, 0) / wfA.test.length} (lib reports ${walkForwardBrier(rows, specA, baseCtx, asOf).brier})`);

// 3. RC calibration: full fits, mean predicted P for RC rows with vs without the dummy.
function fullPreds(spec, ctx) {
  const X = rows.map((p) => oddsFeatures(p, spec, ctx, asOf));
  const fit = fitLogistic(X, ys);
  const sig = (eta) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, eta))));
  return rows.map((p) => sig(oddsFeatures(p, spec, ctx, asOf).reduce((s, v, j) => s + v * fit.beta[j], 0)));
}
const predA = fullPreds(specA, baseCtx);
const predB = fullPreds(specA, ctxNoRC);
const rcIdx = rows.map((p, i) => (p.category === 'Risk Curators' ? i : -1)).filter((i) => i >= 0);
console.log(`\nRisk Curators rows: n=${rcIdx.length}, observed token rate ${(100 * mean(rcIdx.map((i) => ys[i]))).toFixed(1)}%`);
console.log(`  mean predicted P with dummy (A):    ${(100 * mean(rcIdx.map((i) => predA[i]))).toFixed(1)}%`);
console.log(`  mean predicted P without dummy (B): ${(100 * mean(rcIdx.map((i) => predB[i]))).toFixed(1)}%`);
const rcTestIdx = wfA.test.map((p, i) => (p.category === 'Risk Curators' ? i : -1)).filter((i) => i >= 0);
console.log(`  WF test RC rows: n=${rcTestIdx.length}, observed ${(100 * mean(rcTestIdx.map((i) => wfA.ys[i]))).toFixed(1)}%`);
console.log(`  WF test RC mean predicted P with dummy:    ${(100 * mean(rcTestIdx.map((i) => wfA.preds[i]))).toFixed(1)}%`);
console.log(`  WF test RC mean predicted P without dummy: ${(100 * mean(rcTestIdx.map((i) => wfB.preds[i]))).toFixed(1)}%`);

// 4. Imputation sensitivity with the RC dummy KEPT.
console.log('\nImputation sensitivity, RC dummy KEPT, no indicator (LOO):');
for (const yrs of [3.0, 4.0, 5.0]) {
  const loo = looBrier(rows, specNoInd, cloneCtx({ unknownAgeYears: yrs, useAgeMissing: false }), asOf).brier;
  console.log(`  impute ${yrs.toFixed(1)}y  LOO ${loo.toFixed(4)}`);
}
console.log('  (v2 baseline A: LOO 0.1915; D at 4.0y was 0.1911)');
