// v3 odds candidates: Risk Curators confounding + unknown-date age imputation.
//
//   node scripts/eval-odds-v3.mjs --input <snapshot.json>
//
// Tests the two audit findings against the v2 shipped odds model using the
// entry's own logistic machinery (lib/odds.ts), with the same validation the
// v2 selection used: leave-one-out Brier AND walk-forward Brier, on the same
// 733 odds rows (the 25 value-model hold-out test slugs stay excluded).
// A candidate is adopted only if it does not degrade either Brier score
// versus the v2 baseline. This script changes nothing in the entry; it only
// reports. The adopted variant is then wired into lib/odds.ts.
//
// Candidates:
//   A  v2 baseline: spec [logtvl, age, age_missing, change, cats]
//   B  A minus the Risk Curators dummy (RC rows get no category term)
//   C  A minus ALL category dummies
//   D  A with unknown age imputed at 4.0y and NO age_missing indicator
//   E  B + D (drop RC dummy, impute unknown age at 4.0y)
//   F  drop-one-dummy-at-a-time (which category dummies carry real signal?)
//   G  imputation sensitivity: 3.0y / 5.0y (with RC dropped; LOO only —
//      walk-forward excludes unknown-date rows, so it cannot see imputation)
import { readFileSync } from 'node:fs';
import { parseSnapshot, ageDays } from '../lib/model.ts';
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

const cloneCtx = (over) => ({ ...baseCtx, ...over });
const specA = ['logtvl', 'age', 'age_missing', 'change', 'cats'];
const specNoCats = ['logtvl', 'age', 'age_missing', 'change'];
const specNoInd = ['logtvl', 'age', 'change', 'cats'];

function evalVariant(label, spec, ctx) {
  const loo = looBrier(rows, spec, ctx, asOf).brier;
  const wf = walkForwardBrier(rows, spec, ctx, asOf).brier;
  return { label, loo, wf };
}

// --- Per-category diagnostics: which dummies might be age proxies? ---
console.log('Per-category diagnostics (odds rows only; dummy categories have >=30 rows)');
console.log('category'.padEnd(18) + ' n    token%  medianAgeY  listed>=2025-05  coef(v2 fit)');
const fullFit = (() => {
  const X = rows.map((p) => oddsFeatures(p, specA, baseCtx, asOf));
  const y = rows.map((p) => (hasToken(p) ? 1 : 0));
  return fitLogistic(X, y);
})();
const catIndex = new Map(baseCtx.catDummies.map((c, i) => [c, 5 + i])); // intercept,logtvl,age,age_missing,change,then cats
for (const c of baseCtx.catDummies) {
  const members = rows.filter((p) => (p.category ?? 'null') === c);
  const ages = members
    .map((p) => ageDays(asOf, p.listed_at))
    .filter((a) => a !== null)
    .sort((a, b) => a - b);
  const medAge = ages.length ? ages[Math.floor(ages.length / 2)] / 365 : NaN;
  const tok = members.filter(hasToken).length;
  const young = members.filter((p) => p.listed_at !== null && p.listed_at >= '2025-05-01').length;
  console.log(
    c.padEnd(18) +
      ` ${String(members.length).padEnd(4)} ${(100 * (tok / members.length)).toFixed(1).padStart(6)}%  ${medAge.toFixed(2).padStart(9)}  ${String(young).padStart(15)}  ${(fullFit.beta[catIndex.get(c)] >= 0 ? '+' : '') + fullFit.beta[catIndex.get(c)].toFixed(4)}`,
  );
}
const rc = rows.filter((p) => p.category === 'Risk Curators');
console.log(`\nRisk Curators: ${rc.length} rows, ${rc.filter(hasToken).length} with tokens.`);
console.log('  RC positives (listed_at):', rc.filter(hasToken).map((p) => `${p.slug}@${p.listed_at}`).join(', '));
console.log('  RC rows listed after the walk-forward cutoff 2025-10-03:', rc.filter((p) => p.listed_at !== null && p.listed_at > '2025-10-03').length);

// --- Candidate table ---
console.log('\nCandidate table (Brier, lower is better; v2 baseline A: LOO 0.1915 / WF 0.2102)');
const t0 = Date.now();
const results = [];
results.push(evalVariant('A  v2 baseline', specA, baseCtx));
results.push(evalVariant('B  drop Risk Curators dummy', specA, cloneCtx({ catDummies: baseCtx.catDummies.filter((c) => c !== 'Risk Curators') })));
results.push(evalVariant('C  drop ALL category dummies', specNoCats, baseCtx));
results.push(evalVariant('D  impute unknown age 4.0y, no indicator', specNoInd, cloneCtx({ unknownAgeYears: 4.0, useAgeMissing: false })));
results.push(evalVariant('E  B + D (drop RC dummy + impute 4.0y)', specNoInd, cloneCtx({ unknownAgeYears: 4.0, useAgeMissing: false, catDummies: baseCtx.catDummies.filter((c) => c !== 'Risk Curators') })));
for (const r of results) {
  console.log(`${r.label.padEnd(46)} LOO ${r.loo.toFixed(4)}  WF ${r.wf.toFixed(4)}`);
}

// --- F: drop one dummy at a time ---
console.log('\nF  Drop one category dummy at a time (full v2 spec otherwise):');
for (const c of baseCtx.catDummies) {
  const r = evalVariant(`   minus ${c}`, specA, cloneCtx({ catDummies: baseCtx.catDummies.filter((x) => x !== c) }));
  console.log(`${r.label.padEnd(46)} LOO ${r.loo.toFixed(4)}  WF ${r.wf.toFixed(4)}`);
}

// --- G: imputation sensitivity (LOO only) ---
console.log('\nG  Imputation sensitivity, RC dummy dropped, no indicator (LOO only):');
for (const yrs of [3.0, 4.0, 5.0]) {
  const loo = looBrier(rows, specNoInd, cloneCtx({ unknownAgeYears: yrs, useAgeMissing: false, catDummies: baseCtx.catDummies.filter((c) => c !== 'Risk Curators') }), asOf).brier;
  console.log(`   impute ${yrs.toFixed(1)}y`.padEnd(46) + ` LOO ${loo.toFixed(4)}`);
}
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
