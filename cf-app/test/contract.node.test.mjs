// The API contract on the Node server: the real api/server.js in a child, as api/test does, run
// through the scripted session (contract/scenario.js). Its transcript is contract.golden.json;
// UPDATE_GOLDEN=1 rewrites it (after an upstream change to the API, then check the Worker test).
//   node --test test/contract.node.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from '../../api/test/helpers.mjs';
import { runScenario, ORIGIN } from './contract/scenario.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(here, '../../api');
const GOLDEN = path.join(here, 'contract/contract.golden.json');

test('api/server.js answers the scripted session as contract.golden.json says', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-contract-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    // The switches the Worker has (wrangler.jsonc): MCP on, the first profile admin, and the
    // features the port leaves out left at their defaults (off).
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', MCP: '1', FIRST_USER_ADMIN: '1', MEDIA_UPLOADS: '1' },
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const port = await boundPort(child, () => log);
  const got = await runScenario((method, p, init) => fetch(`http://127.0.0.1:${port}${p}`, { method, ...init, redirect: 'manual' }));
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + '\n');
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  for (let i = 0; i < Math.max(got.length, golden.length); i++) assert.deepStrictEqual({ i, ...got[i] }, { i, ...golden[i] });
});
