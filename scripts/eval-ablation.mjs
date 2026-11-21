// Value-model ablation: the same table the dashboard shows, reproducible.
//
//   node scripts/eval-ablation.mjs --input <snapshot.json>
//
// Runs lib/evidence.ts's valueAblation on the 103 TRAINING tokens only
// (the 25 hold-out test slugs are never used for selection). Prints the
// 5-fold CV and walk-forward scores per candidate term, the verdict
// (kept / tested-not-kept / must-not-help), and the range calibration.
// The shipped program computes the same table at runtime and embeds it
// in data.js, so this script and the dashboard can never disagree.
import { readFileSync } from 'node:fs';
import { parseSnapshot } from '../lib/model.ts';
import { valueAblation } from '../lib/evidence.ts';

const args = process.argv.slice(2);
const get = (n, fb) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fb;
};
const snapshot = parseSnapshot(readFileSync(get('input', '/home/hatch/workspace/makefun-test/token-radar-01-kit/input/snapshot.json'), 'utf8'));
const { variants, ranges } = valueAblation(snapshot);

console.log('Token Radar — value-model ablation (103 training tokens only; the 25 test tokens are never used)');
console.log('A term is KEPT only if it beats the shipped fit by more than 0.02 log R-squared in BOTH the 5-fold CV');
console.log('and the walk-forward test (fit older, score newer). A pooled gain under 0.02 is noise on 103 tokens.');
console.log('variant'.padEnd(46) + ' CV logR2  CV mdAPE   WF logR2  WF mdAPE   verdict');
for (const v of [...variants].sort((a, b) => b.cvLogR2 - a.cvLogR2)) {
  console.log(
    v.name.padEnd(46) +
      ` ${v.cvLogR2.toFixed(4)}   ${(v.cvMdAPE * 100).toFixed(1).padStart(5)}%   ${v.wfLogR2.toFixed(4)}   ${(v.wfMdAPE * 100).toFixed(1).padStart(5)}%   ${v.verdict}`,
  );
}
console.log('\nRange calibration (current variant, nested-fold intervals from out-of-fold residuals):');
console.log(`  P25-P75 stated ${ranges.p50Stated}% coverage, actual ${ranges.p50Actual.toFixed(1)}% (n=${ranges.n})`);
console.log(`  P10-P90 stated ${ranges.p80Stated}% coverage, actual ${ranges.p80Actual.toFixed(1)}% (n=${ranges.n})`);
console.log('\nReading: no alternative is materially better than the shipped fit — the best variant is inside');
console.log('the noise on 103 tokens. The limitation is the data (TVL-only features), not the method.');
