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

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-media-')), 'list.json');
fs.writeFileSync(tmp, JSON.stringify(list));
execFileSync('npx', ['wrangler', 'r2', 'bulk', 'put', bucket, '--filename', tmp, '--remote', '--jurisdiction', 'eu', '--concurrency', '20'], { stdio: 'inherit', cwd: path.join(root, 'cf-app') });
