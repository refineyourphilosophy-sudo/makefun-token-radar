// Capture the three required dashboard screenshots at 1440x900.
// The gate caps the long side at 1440px, so 1920x1080 would FAIL.
// Run after main.ts has written an out dir (it writes data.js and the
// dashboard before it checks for screenshots):
//   MAKEFUN_OUTPUT_DIR=/tmp/radar-out node main.ts --input <snapshot>  # exits 1, writes data.js
//   node scripts/shot.mjs --out /tmp/radar-out
//   (screenshots land in screenshots/; re-run main.ts to finish the dossier)
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const at = process.argv.indexOf('--out');
const outDir = at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : '/tmp/radar-out';
const executablePath = join(homedir(), '.cache/ms-playwright/chromium-1255/chrome-linux64/chrome');

const views = [
  ['index.html', '1-board.png', null],
  ['index.html#/p/steakhouse-financial', '2-detail.png', null],
  ['index.html', '3-filtered.png', '#evidence'],
];

const browser = await chromium.launch({ executablePath });
for (const [page, shot, scrollTo] of views) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto('file://' + join(outDir, 'dashboard', page));
  await p.waitForSelector('table, .card', { timeout: 15000 });
  await p.waitForTimeout(500);
  if (scrollTo) {
    await p.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'start' });
    }, scrollTo);
    await p.waitForTimeout(300);
  }
  await p.screenshot({ path: join(root, 'screenshots', shot) });
  await ctx.close();
  console.log('captured', shot);
}
await browser.close();
console.log('done');
