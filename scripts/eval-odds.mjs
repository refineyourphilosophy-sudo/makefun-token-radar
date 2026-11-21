// Token-launch odds: term selection and validation.
//
//   node scripts/eval-odds.mjs --input <snapshot.json>
//
// Fits a logistic P(token) on the snapshot's peer record (every protocol
// except the 25 hold-out test slugs of the value model — those are
// off-limits for training and selection here too). A term is KEPT only if
// it lowers the Brier score in BOTH tests: leave-one-out AND walk-forward
// (fit on older protocols, score on newer). The control term (a shuffled
// feature) must not help in either. The selected spec in lib/odds.ts
// (SELECTED_ODDS_SPEC) is the one this table keeps; the shipped program
// refits that spec on the same rows at runtime. Re-run this script to
// reproduce the table, the Brier scores, the calibration and the
// coefficients printed here.
import { readFileSync } from 'node:fs';
import { parseSnapshot } from '../lib/model.ts';
import {
  SELECTED_ODDS_SPEC,
  baseRateBrier,
  calibrationDeciles,
  fitOddsModel,
  hasToken,
  looBrier,
  oddsContext,
  oddsFeatureNames,
  oddsRows,
  shuffled,
  walkForwardBrier,
} from '../lib/odds.ts';

const args = process.argv.slice(2);
const get = (n, fb) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fb;
};
const snapshot = parseSnapshot(readFileSync(get('input', '/home/hatch/workspace/makefun-test/token-radar-01-kit/input/snapshot.json'), 'utf8'));
const rows = oddsRows(snapshot);
const ctx = oddsContext(rows, snapshot.as_of);
const ys = rows.map((p) => (hasToken(p) ? 1 : 0));
const baseBrier = baseRateBrier(ctx.baseRate);

console.log('Token Radar — token-launch odds (logistic P(token) from the peers\' record)');
console.log(`Snapshot: ${snapshot.as_of}, ${snapshot.protocols.length} protocols`);
console.log(`Odds training rows: ${rows.length} (all protocols except the 25 value-model hold-out test slugs)`);
console.log(`Token rate (base rate): ${(ctx.baseRate * 100).toFixed(1)}% (${ys.reduce((a, b) => a + b, 0)} of ${rows.length} record a token)`);
console.log(`Base-rate Brier (constant prediction): ${baseBrier.toFixed(4)}`);
console.log(`Category dummies (>=${30} protocols): ${ctx.catDummies.join(', ')}`);
console.log(`Median age (known listing dates): ${ctx.medianAgeYears.toFixed(2)} years; protocols with no listing date: ${rows.filter((p) => p.listed_at === null).length}`);

// Term selection: base + one candidate at a time. KEPT only if Brier improves in BOTH tests.
const base = ['logtvl'];
const candidates = [
  { label: '+ age (years + listing-date-unknown)', add: ['age', 'age_missing'] },
  { label: '+ 7d TVL change', add: ['change'] },
  { label: '+ chain count', add: ['chains'] },
  { label: '+ category dummies', add: ['cats'] },
];
const t0 = Date.now();
const evalSpec = (spec) => {
  const loo = looBrier(rows, spec, ctx, snapshot.as_of);
  const wf = walkForwardBrier(rows, spec, ctx, snapshot.as_of);
  return { loo: loo.brier, wf: wf.brier, wfTrain: wf.nTrain, wfTest: wf.nTest, cutoff: wf.cutoff };
};
console.log('\nTerm selection (Brier, lower is better; base rate = ' + baseBrier.toFixed(4) + ')');
console.log('spec'.padEnd(44) + ' LOO     walk-forward  kept?');
const baseEval = evalSpec(base);
console.log('base: log TVL'.padEnd(44) + ` ${baseEval.loo.toFixed(4)}  ${baseEval.wf.toFixed(4)}     (base)`);
const kept = [...base];
for (const c of candidates) {
  const spec = [...base, ...c.add];
  const e = evalSpec(spec);
  const helps = e.loo < baseEval.loo && e.wf < baseEval.wf;
  if (helps) kept.push(...c.add);
  console.log(c.label.padEnd(44) + ` ${e.loo.toFixed(4)}  ${e.wf.toFixed(4)}     ${helps ? 'KEPT (helps in both)' : 'not kept'}`);
}
// Control: base + a shuffled log-TVL column. It must not help in either test.
const shuffledCol = shuffled(rows.map((p) => Math.log10(p.tvl_usd) - 7.5));
const looControl = looBrier(rows, base, ctx, snapshot.as_of, shuffledCol);
const wfControl = walkForwardBrier(rows, base, ctx, snapshot.as_of, shuffledCol);
console.log(
  'CONTROL: base + shuffled log TVL'.padEnd(44) +
    ` ${looControl.brier.toFixed(4)}  ${wfControl.brier.toFixed(4)}     ${looControl.brier < baseEval.loo || wfControl.brier < baseEval.wf ? 'HELPED — selection is suspect' : 'must-not-help: confirmed'}`,
);
console.log(`\nSelection keeps: ${kept.join(' + ') || '(base only)'}`);
console.log(`Shipped spec in lib/odds.ts: ${SELECTED_ODDS_SPEC.join(' + ')}`);
console.log(
  kept.join(',') === SELECTED_ODDS_SPEC.join(',')
    ? 'MATCH: the shipped spec is the selected spec.'
    : 'MISMATCH: update SELECTED_ODDS_SPEC in lib/odds.ts to the selection above, then re-run this script.',
);

// Selected model: full fit, coefficients, LOO calibration.
const model = fitOddsModel(snapshot);
console.log(`\nSelected model fit on all ${model.n} odds rows (converged: ${model.converged})`);
const names = oddsFeatureNames(model.spec, model.ctx);
model.beta.forEach((b, i) => console.log(`  ${names[i].padEnd(28)} ${b >= 0 ? '+' : ''}${b.toFixed(4)}`));
const selLoo = looBrier(rows, model.spec, ctx, snapshot.as_of);
console.log(`\nSelected model LOO Brier: ${selLoo.brier.toFixed(4)} (base rate ${baseBrier.toFixed(4)}; improvement ${((1 - selLoo.brier / baseBrier) * 100).toFixed(1)}%)`);
const selWf = walkForwardBrier(rows, model.spec, ctx, snapshot.as_of);
console.log(`Selected model walk-forward Brier: ${selWf.brier.toFixed(4)} (train ${selWf.nTrain} older, test ${selWf.nTest} newer, cutoff ${selWf.cutoff})`);
console.log('\nCalibration (leave-one-out predictions, equal-count deciles):');
console.log('decile  n   mean predicted  observed token rate');
for (const d of calibrationDeciles(selLoo.preds, ys)) {
  console.log(`  ${String(d.bin).padEnd(4)} ${String(d.n).padEnd(4)} ${(d.meanPred * 100).toFixed(1).padStart(6)}%         ${(d.observed * 100).toFixed(1)}%`);
}

// The peers' record by age bucket (for the dashboard): token rate by years listed.
console.log('\nPeers\' record — token rate by age (all odds rows):');
const bucket = (p) => {
  if (p.listed_at === null) return 'listing date unknown';
  const d = (Date.parse(snapshot.as_of) - Date.parse(p.listed_at)) / 86_400_000;
  return d < 180 ? '< 6 months' : d < 365 ? '6-12 months' : d < 730 ? '1-2 years' : d < 1460 ? '2-4 years' : '4+ years';
};
const buckets = new Map();
for (const p of rows) {
  const k = bucket(p);
  const b = buckets.get(k) ?? { n: 0, y: 0 };
  b.n++;
  if (hasToken(p)) b.y++;
  buckets.set(k, b);
}
for (const k of ['< 6 months', '6-12 months', '1-2 years', '2-4 years', '4+ years', 'listing date unknown']) {
  const b = buckets.get(k);
  if (b) console.log(`  ${k.padEnd(20)} ${String(b.n).padEnd(4)} protocols, ${b.y} record a token = ${(100 * (b.y / b.n)).toFixed(1)}%`);
}
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
