// Local gate check: replays the sealed scorer's seven rows against one
// main.ts output directory, using the kit's own buildDossier for the
// dossier row. Usage:
//   node scripts/gate-check.mjs --out <dir> --input <snapshot.json> --kit <kit dir>
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const get = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
};
const outDir = get('out', '/tmp/radar-out');
const inputFile = get('input', '/input/snapshot.json');
const kitDir = get('kit', '/home/hatch/workspace/makefun-test/token-radar-01-kit');

const { buildDossier } = await import(join(kitDir, 'starter/vendor/makefun-board.ts'));
const snapshot = JSON.parse(readFileSync(inputFile, 'utf8'));
const snapSlugs = new Set(snapshot.protocols.map((p) => p.slug));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const board = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8'));
const rows = Array.isArray(board) ? board : board.rows;

// board_file
let boardOk = true;
let boardDetail = '';
if (!Array.isArray(rows) || rows.length < 100 || rows.length > 4000) {
  boardOk = false;
  boardDetail = `rows: ${Array.isArray(rows) ? rows.length : 'not an array'}`;
} else {
  for (const r of rows) {
    if (!snapSlugs.has(r.slug)) { boardOk = false; boardDetail = `slug not in snapshot: ${r.slug}`; break; }
    if (typeof r.name !== 'string' || r.name.length === 0) { boardOk = false; boardDetail = `empty name: ${r.slug}`; break; }
    if (!Number.isSafeInteger(r.rank) || r.rank <= 0) { boardOk = false; boardDetail = `bad rank: ${r.slug}`; break; }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) { boardOk = false; boardDetail = `bad implied value: ${r.slug}`; break; }
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) { boardOk = false; boardDetail = `farm steps: ${r.slug}`; break; }
    for (const s of r.farm_steps) {
      if (typeof s !== 'string' || s.trim().length < 20 || s.trim().length > 600) { boardOk = false; boardDetail = `farm step length ${s.length}: ${r.slug}`; break; }
    }
    if (!boardOk) break;
  }
  if (boardOk) boardDetail = `${rows.length} rows, all slugs in snapshot, farm steps 3-12 x 20-600 chars`;
}
check('board_file', boardOk, boardDetail);

// sorted_by_value
const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
const ranksOk = ranks.every((r, i) => r === i + 1);
const orderOk = rows.every((r, i) => i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd);
const allSame = rows.length >= 2 && rows[0].implied_value_usd === rows[rows.length - 1].implied_value_usd;
check('sorted_by_value', ranksOk && orderOk && !allSame, `ranks 1..${rows.length} unique: ${ranksOk}, non-increasing: ${orderOk}, all same: ${allSame}`);

// coverage
const have = new Set(rows.map((r) => r.slug));
const missing = snapshot.watchlist.filter((s) => !have.has(s));
check('coverage', missing.length === 0, `${snapshot.watchlist.length - missing.length}/${snapshot.watchlist.length} watchlist slugs covered${missing.length ? ', missing: ' + missing.slice(0, 5).join(', ') : ''}`);

// farm_steps (already partly covered; explicit row)
const farmOk = rows.every((r) => r.farm_steps.length >= 3 && r.farm_steps.length <= 12 && r.farm_steps.every((s) => s.trim().length >= 20 && s.trim().length <= 600));
check('farm_steps', farmOk, `${rows.length} rows x 6 steps, lengths within 20-600`);

// screenshots
const shotDir = join(outDir, 'screenshots');
const shots = existsSync(shotDir) ? readdirSync(shotDir).filter((n) => !n.startsWith('.')) : [];
let shotsOk = shots.length >= 3 && shots.length <= 4;
let shotsDetail = `${shots.length} images`;
for (const name of shots) {
  const buf = readFileSync(join(shotDir, name));
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const longSide = Math.max(w, h);
  const shortSide = Math.min(w, h);
  if (!isPng || buf.length > 524_288 || longSide > 1440 || shortSide < 800) {
    shotsOk = false;
    shotsDetail += `; ${name} FAIL (${w}x${h}, ${buf.length} bytes)`;
  } else {
    shotsDetail += `; ${name} ${w}x${h} ${buf.length}B`;
  }
}
check('screenshots', shotsOk, shotsDetail);

// dashboard_files
const dashDir = join(outDir, 'dashboard');
const dashFiles = existsSync(dashDir) ? readdirSync(dashDir) : [];
let dashOk = dashFiles.includes('index.html') && dashFiles.some((f) => f.endsWith('.css')) && dashFiles.some((f) => f.endsWith('.js'));
let dashBytes = 0;
let dashDetail = `${dashFiles.length} files`;
for (const f of dashFiles) {
  const st = statSync(join(dashDir, f));
  dashBytes += st.size;
  if (st.size > 4_194_304) dashOk = false;
  const text = readFileSync(join(dashDir, f), 'utf8');
  if (/https?:\/\//.test(text) && (f.endsWith('.css') || f.endsWith('.js'))) { dashOk = false; dashDetail += `; http(s) in ${f}`; }
  if (f.endsWith('.html')) {
    const attrs = text.match(/<[^>]+(?:href|src|action|poster)\s*=\s*["']https?:\/\//gi);
    if (attrs) { dashOk = false; dashDetail += `; http(s) attribute in ${f}`; }
  }
}
if (dashFiles.length > 400 || dashBytes > 4_194_304) dashOk = false;
check('dashboard_files', dashOk, `${dashDetail}, ${dashBytes} bytes total (cap 4 MiB), no http(s) in attributes/CSS/JS imports`);

// dossier_matches
const dossierPath = join(outDir, 'dossier.json');
const dossier = readFileSync(dossierPath);
const rebuilt = buildDossier(outDir, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } });
const dossierOk = Buffer.compare(dossier, Buffer.from(rebuilt)) === 0 && dossier.length <= 1_572_864;
check('dossier_matches', dossierOk, `dossier ${dossier.length} bytes (cap 1.5 MiB), byte-identical to a fresh buildDossier call: ${Buffer.compare(dossier, Buffer.from(rebuilt)) === 0}`);

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? '\nGATE: all 7 rows PASS' : `\nGATE: ${failed.length} row(s) FAIL: ${failed.map((r) => r.name).join(', ')}`);
process.exit(failed.length === 0 ? 0 : 1);
