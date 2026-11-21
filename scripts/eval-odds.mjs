// Token-launch odds: term selection and validation.
//
//   node scripts/eval-odds.mjs --input <snapshot.json>
//
// Prints the evaluation lib/odds.ts's evaluateOdds runs: the term table
// (a term is KEPT only if it lowers the Brier score in BOTH the
// leave-one-out and the walk-forward test), the shuffled control (which
// must not help), the selected model's coefficients, its LOO Brier and
// calibration, and the peers' token rate by age. The shipped program
// (main.ts) runs the same evaluateOdds at runtime and embeds the same
// numbers in data.js, so this script and the dashboard can never
// disagree. The odds train on every protocol except the 25 hold-out test
// slugs of the value model — those are off-limits for training and
// selection here too.
import { readFileSync } from 'node:fs';
import { parseSnapshot } from '../lib/model.ts';
import {
  SELECTED_ODDS_SPEC,
  evaluateOdds,
  fitOddsModel,
  oddsContext,
  oddsFeatureNames,
  oddsRows,
} from '../lib/odds.ts';

const args = process.argv.slice(2);
const get = (n, fb) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fb;
};
const snapshot = parseSnapshot(readFileSync(get('input', '/home/hatch/workspace/makefun-test/token-radar-01-kit/input/snapshot.json'), 'utf8'));
const t0 = Date.now();
const rows = oddsRows(snapshot);
const ctx = oddsContext(rows, snapshot.as_of);
const ev = evaluateOdds(snapshot);

console.log('Token Radar — token-launch odds (logistic P(token) from the peers\' record)');
console.log(`Snapshot: ${snapshot.as_of}, ${snapshot.protocols.length} protocols`);
console.log(`Odds training rows: ${ev.n} (all protocols except the 25 value-model hold-out test slugs)`);
console.log(`Token rate (base rate): ${(ev.baseRate * 100).toFixed(1)}% (${ev.positives} of ${ev.n} record a token)`);
console.log(`Base-rate Brier (constant prediction): ${ev.baseBrier.toFixed(4)}`);
console.log(`Category dummies (>=30 protocols): ${ctx.catDummies.join(', ')}`);
console.log(`Median age (known listing dates): ${ctx.medianAgeYears.toFixed(2)} years; protocols with no listing date: ${rows.filter((p) => p.listed_at === null).length}`);

console.log('\nTerm selection (Brier, lower is better; base rate = ' + ev.baseBrier.toFixed(4) + ')');
console.log('spec'.padEnd(44) + ' LOO     walk-forward  kept?');
for (const t of ev.terms) {
  const verdict = t.label.startsWith('base:') ? '(base)' : t.kept ? 'KEPT (helps in both)' : 'not kept';
  console.log(t.label.padEnd(44) + ` ${t.looBrier.toFixed(4)}  ${t.wfBrier.toFixed(4)}     ${verdict}`);
}
const controlHelped = ev.controlLoo < ev.terms[0].looBrier || ev.controlWf < ev.terms[0].wfBrier;
console.log(
  'CONTROL: base + shuffled log TVL'.padEnd(44) +
    ` ${ev.controlLoo.toFixed(4)}  ${ev.controlWf.toFixed(4)}     ${controlHelped ? 'HELPED — selection is suspect' : 'must-not-help: confirmed'}`,
);
console.log(`\nSelection keeps: ${ev.selectedSpec.join(' + ')}`);
console.log(`Shipped spec in lib/odds.ts: ${SELECTED_ODDS_SPEC.join(' + ')}`);
console.log(
  ev.selectedSpec.join(',') === SELECTED_ODDS_SPEC.join(',')
    ? 'MATCH: the shipped spec is the selected spec.'
    : 'MISMATCH: update SELECTED_ODDS_SPEC in lib/odds.ts to the selection above, then re-run this script.',
);

const model = fitOddsModel(snapshot);
console.log(`\nSelected model fit on all ${model.n} odds rows (converged: ${model.converged})`);
const names = oddsFeatureNames(model.spec, model.ctx);
model.beta.forEach((b, i) => console.log(`  ${names[i].padEnd(28)} ${b >= 0 ? '+' : ''}${b.toFixed(4)}`));
console.log(`\nSelected model LOO Brier: ${ev.selectedLoo.toFixed(4)} (base rate ${ev.baseBrier.toFixed(4)}; improvement ${((1 - ev.selectedLoo / ev.baseBrier) * 100).toFixed(1)}%)`);
console.log(`Selected model walk-forward Brier: ${ev.selectedWf.toFixed(4)} (train ${ev.wfTrain} older, test ${ev.wfTest} newer, cutoff ${ev.wfCutoff})`);
console.log('\nCalibration (leave-one-out predictions, equal-count deciles):');
console.log('decile  n   mean predicted  observed token rate');
for (const d of ev.calibration) {
  console.log(`  ${String(d.bin).padEnd(4)} ${String(d.n).padEnd(4)} ${(d.meanPred * 100).toFixed(1).padStart(6)}%         ${(d.observed * 100).toFixed(1)}%`);
}
console.log('\nPeers\' record — token rate by age (all odds rows):');
for (const b of ev.ageBuckets) {
  console.log(`  ${b.bucket.padEnd(20)} ${String(b.n).padEnd(4)} protocols, ${b.withToken} record a token = ${(b.rate * 100).toFixed(1)}%`);
}
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
