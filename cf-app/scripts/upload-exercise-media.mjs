#!/usr/bin/env node
// Puts the catalogue's 180 px exercise media (catalogue/media/still, clip, NOTICE.md) into the
// private R2 bucket the Worker serves them from (wrangler.jsonc EXERCISE_MEDIA). Once per
// catalogue change. Never anything larger than 180 px: scripts/catalogue/check-media.mjs is run
// first and its refusal stops the upload (NOTICE.md, CLAUDE.md "Exercise media").
//
//   node cf-app/scripts/upload-exercise-media.mjs [--bucket opengym-exercise-media] [--dry-run]
//
// It writes a key/file list and hands it to `wrangler r2 bulk put` (EU jurisdiction, as the
// bucket). The script only lists the files; it never reads their content.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const media = path.join(root, 'catalogue/media');
const args = process.argv.slice(2);
const bucket = args.includes('--bucket') ? args[args.indexOf('--bucket') + 1] : 'opengym-exercise-media';
const dry = args.includes('--dry-run');

execFileSync(process.execPath, [path.join(root, 'scripts/catalogue/check-media.mjs')], { stdio: 'inherit' });

const list = [];
for (const dir of ['still', 'clip']) {
  for (const f of fs.readdirSync(path.join(media, dir))) {
    if (!/^[A-Za-z0-9._-]+\.(webp|mp4)$/.test(f)) continue;
    list.push({ key: `${dir}/${f}`, file: path.join(media, dir, f) });
  }
}
list.push({ key: 'NOTICE.md', file: path.join(media, 'NOTICE.md') });
console.log(`${list.length} files for r2://${bucket}`);
if (dry) process.exit(0);

// In batches, so one failed request (R2's API answers a 502 now and then) costs one batch, not
// the whole upload: each batch is tried three times, and the ones done are remembered in
// .wrangler/ (gitignored), so running the script again carries on where it stopped.
const BATCH = 500;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-media-'));
const stateFile = path.join(root, 'cf-app', '.wrangler', `media-upload-${bucket}.json`);
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
const sig = list.length + ':' + list[0].key + ':' + list[list.length - 1].key;
let done = new Set();
try { const st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (st.sig === sig) done = new Set(st.done); } catch { /* first run */ }
const batches = Math.ceil(list.length / BATCH);
for (let b = 0; b < batches; b++) {
  if (done.has(b)) continue;
  const file = path.join(dir, `batch-${b}.json`);
  fs.writeFileSync(file, JSON.stringify(list.slice(b * BATCH, (b + 1) * BATCH)));
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('npx', ['wrangler', 'r2', 'bulk', 'put', bucket, '--filename', file, '--remote', '--jurisdiction', 'eu', '--concurrency', '10'], { stdio: ['ignore', 'ignore', 'inherit'], cwd: path.join(root, 'cf-app') });
      break;
    } catch (e) {
      if (attempt >= 3) { console.error(`batch ${b + 1}/${batches} failed three times; run the script again to carry on`); process.exit(1); }
      console.error(`batch ${b + 1}/${batches} failed (attempt ${attempt}), trying again`);
    }
  }
  done.add(b);
  fs.writeFileSync(stateFile, JSON.stringify({ sig, done: [...done] }));
  console.log(`batch ${b + 1}/${batches} uploaded`);
}
console.log(`all ${list.length} files are in r2://${bucket}`);
