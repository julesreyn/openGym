// The API contract on the Worker (Durable Objects in the Workers runtime): the same session as
// against the Node server, the same transcript (test/contract/scenario.js).
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { runScenario, ORIGIN } from './contract/scenario.js';
import golden from './contract/contract.golden.json';

describe('API contract', () => {
  it('the Worker answers the scripted session exactly as api/server.js does', async () => {
    const got = await runScenario((method, path, init) => SELF.fetch(ORIGIN + path, { method, ...init, redirect: 'manual' }));
    expect(golden.length).toBeGreaterThan(50);
    expect(got.length).toBe(golden.length);
    for (let i = 0; i < Math.max(got.length, golden.length); i++) {
      expect({ i, ...got[i] }).toEqual({ i, ...golden[i] });
    }
  });
});
