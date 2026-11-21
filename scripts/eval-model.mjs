// Reproduce the model's hold-out evaluation from the sealed snapshot.
//
//   node scripts/eval-model.mjs --input <snapshot.json>
//
// One fixed split, declared in lib/model.ts: the traded set sorted by
// slug, every 5th protocol (index % 5 === 4) held out as the test set,
// the rest as the train set. The fit procedure runs on the train set
// only and the test set is scored with it. The numbers printed here are
// the numbers the dashboard and README report; re-running this script
// on the same snapshot prints the same numbers. The shipped program
// (main.ts) refits the same procedure on all traded tokens at runtime.
import { readFileSync } from 'node:fs';
import { evaluateHoldout, fitModel, parseSnapshot, tradedSet } from '../lib/model.ts';

const at = process.argv.indexOf('--input');
const inputFile = at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : '/input/snapshot.json';
const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const traded = tradedSet(snapshot);
const full = fitModel(traded);
const holdout = evaluateHoldout(snapshot);

const pct = (n) => `${(n * 100).toFixed(1)}%`;
console.log('Token Radar — hold-out evaluation (one fixed split, run once)');
console.log(`Snapshot: ${snapshot.as_of}, ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist`);
console.log(`Traded set (market cap and TVL both above zero): ${traded.length} tokens`);
console.log(`Split: traded tokens sorted by slug; every 5th (index % 5 === 4) held out.`);
console.log(`  train: ${holdout.trainCount} tokens, test: ${holdout.testCount} tokens`);
console.log(`Train fit: log10(market cap) = ${holdout.trainIntercept.toFixed(4)} + ${holdout.trainSlope.toFixed(4)} * log10(TVL)`);
console.log('Full pipeline (base x growth x maturity), test set:');
console.log(`  log-space R-squared: ${holdout.logR2.toFixed(4)}`);
console.log(`  median absolute percentage error: ${pct(holdout.mdAPE)}`);
console.log(`  mean absolute percentage error: ${pct(holdout.mape)}`);
console.log('Base comps fit alone (no growth/maturity), test set:');
console.log(`  log-space R-squared: ${holdout.baseLogR2.toFixed(4)}`);
console.log(`  median absolute percentage error: ${pct(holdout.baseMdAPE)}`);
console.log('Shipped model (same procedure refit on all traded tokens):');
console.log(`  log10(market cap) = ${full.intercept.toFixed(4)} + ${full.slope.toFixed(4)} * log10(TVL)`);
console.log(`  categories with a shrunk adjustment (${full.adjustedCategories.length}): ${full.adjustedCategories.join(', ')}`);
for (const c of full.adjustedCategories) console.log(`    ${c}: ${full.categoryAdj[c].toFixed(4)} (log10)`);
console.log('Reading: the fit is weak — TVL alone explains little of a token\'s market cap. Implied values are rough comps, not forecasts.');
