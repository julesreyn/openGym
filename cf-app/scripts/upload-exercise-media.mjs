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

// Cloudflare's API takes about 1,200 requests per 5 minutes and `r2 bulk put` makes one per file,
// so the files go in batches of 250, at most one batch every 80 s (under 1,000 per 5 minutes).
// A failed batch is tried three times; the files already sent are remembered in .wrangler/
// (gitignored), so running the script again sends only the rest.
const BATCH = 250, PACE_MS = 80_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-media-'));
const stateFile = path.join(root, 'cf-app', '.wrangler', `media-upload-${bucket}.json`);
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
let sent = new Set();
try { sent = new Set(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sent || []); } catch { /* first run */ }
const todo = list.filter(x => !sent.has(x.key));
const batches = Math.ceil(todo.length / BATCH);
console.log(`${list.length - todo.length} already sent, ${todo.length} to go in ${batches} batches (about ${Math.ceil(batches * PACE_MS / 60000)} min)`);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let b = 0; b < batches; b++) {
  const started = Date.now();
  const part = todo.slice(b * BATCH, (b + 1) * BATCH);
  const file = path.join(dir, `batch-${b}.json`);
  fs.writeFileSync(file, JSON.stringify(part));
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('npx', ['wrangler', 'r2', 'bulk', 'put', bucket, '--filename', file, '--remote', '--jurisdiction', 'eu', '--concurrency', '5'], { stdio: ['ignore', 'ignore', 'inherit'], cwd: path.join(root, 'cf-app') });
      break;
    } catch {
      if (attempt >= 3) { console.error(`batch ${b + 1}/${batches} failed three times; run the script again to carry on`); process.exit(1); }
      console.error(`batch ${b + 1}/${batches} failed (attempt ${attempt}), waiting and trying again`);
      wait(PACE_MS);
    }
  }
  for (const x of part) sent.add(x.key);
  fs.writeFileSync(stateFile, JSON.stringify({ sent: [...sent] }));
  console.log(`batch ${b + 1}/${batches} uploaded (${sent.size}/${list.length})`);
  if (b < batches - 1) wait(Math.max(0, PACE_MS - (Date.now() - started)));
}
console.log(`all ${list.length} files are in r2://${bucket}`);
