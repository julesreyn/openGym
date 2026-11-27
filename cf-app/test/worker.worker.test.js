// What the Worker does beyond the shared contract: the compare-and-write under concurrency, the
// remote MCP server, the signed-in-only exercise media, uploads in R2.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, signUp, makeToken, ORIGIN } from './helpers.js';

const doc = (unit = 'kg') => ({ unit, workouts: [{ id: 'w1', d: '2026-11-20', name: 'Push', prs: ['0739'], entries: [{ id: '0739', topW: 150, sets: [{ w: 150, r: 5, done: true }] }] }], routines: [] });

describe('sync', () => {
  it('two devices writing over the same revision at once: one wins, the other gets the 409', async () => {
    const { cookie } = await signUp('Concurrent');
    expect((await api('/api/data', { method: 'PUT', cookie, body: { state: doc(), baseRev: 0 } })).status).toBe(200);
    const { rev } = await (await api('/api/data/rev', { cookie })).json();
    const [a, b] = await Promise.all([
      api('/api/data', { method: 'PUT', cookie, body: { state: doc('lb'), baseRev: rev } }),
      api('/api/data', { method: 'PUT', cookie, body: { state: doc('kg'), baseRev: rev } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const lost = a.status === 409 ? a : b;
    expect((await lost.json()).rev).toBe(rev + 1);
  });

  it('a document larger than one SQLite value (2 MB) round-trips', async () => {
    const { cookie } = await signUp('Big');
    const workouts = Array.from({ length: 6000 }, (_, i) => ({ id: 'w' + i, d: '2026-01-01', name: 'x'.repeat(400) }));
    expect((await api('/api/data', { method: 'PUT', cookie, body: { state: { unit: 'kg', workouts }, baseRev: 0 } })).status).toBe(200);
    const got = await (await api('/api/data', { cookie })).json();
    expect(got.state.workouts).toHaveLength(6000);
  });
});

describe('remote MCP (/mcp)', () => {
  const rpc = (token, body, headers = {}) => SELF.fetch(ORIGIN + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

  it('without a token: 401 that points Claude at the OAuth discovery document', async () => {
    const r = await rpc(null, init);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('with a scoped token: lists the tools it may use, reads history and PRs, logs a workout', async () => {
    const { cookie } = await signUp('Mcp');
    await api('/api/data', { method: 'PUT', cookie, body: { state: doc(), baseRev: 0 } });
    const token = await makeToken(cookie);
    const r = await rpc(token, init);
    expect(r.status).toBe(200);
    const tools = await (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    const names = tools.result.tools.map(t => t.name);
    for (const n of ['search_exercises', 'create_routine', 'update_routine', 'delete_routine', 'list_workouts', 'log_workout', 'list_personal_records', 'estimate_1rm', 'get_bodyweight']) expect(names).toContain(n);

    const call = async (name, args) => {
      const j = await (await rpc(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })).json();
      return JSON.parse(j.result.content[0].text);
    };
    const hist = await call('list_workouts', { exercise_id: '0739' });
    expect(hist.matching_count).toBe(1);
    const prs = await call('list_personal_records', {});
    expect(prs.records[0].exercise.id).toBe('0739');

    const logged = await call('log_workout', { date: '2026-11-21', name: 'From Claude', exercises: [{ exercise: '0739', sets: [{ reps: 5, weight: 100 }] }] });
    expect(JSON.stringify(logged)).not.toMatch(/error/i);
    const data = await (await api('/api/data', { cookie })).json();
    expect(data.state.workouts.some(w => w.d === '2026-11-21')).toBe(true);
  });

  it('a browser page on another origin is turned away', async () => {
    expect((await rpc('ogt_' + 'a'.repeat(43), init, { origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('exercise media (licensed, never public)', () => {
  it('needs a session, then serves from R2 with same-origin and private caching', async () => {
    await env.EXERCISE_MEDIA.put('still/0739.webp', new Uint8Array([1, 2, 3]));
    const anon = await SELF.fetch(ORIGIN + '/exercise-media/still/0739.webp');
    expect(anon.status).toBe(401);
    const { cookie } = await signUp('Media');
    const ok = await SELF.fetch(ORIGIN + '/exercise-media/still/0739.webp', { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(ok.headers.get('cache-control')).toMatch(/^private/);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await SELF.fetch(ORIGIN + '/exercise-media/still/missing.webp', { headers: { cookie } })).status).toBe(404);
  });
});

describe('uploads (R2)', () => {
  it('a photo goes up under its hash and comes back with the media headers', async () => {
    const { cookie } = await signUp('Uploader');
    // A minimal PNG: the signature and an IHDR chunk are what the sniffer reads.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', png))].map(b => b.toString(16).padStart(2, '0')).join('');
    const put = await SELF.fetch(ORIGIN + '/api/media/' + hash, { method: 'PUT', headers: { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'image/png', 'content-length': String(png.length) }, body: png });
    expect([200, 201]).toContain(put.status);
    const get = await SELF.fetch(ORIGIN + '/api/media/' + hash, { headers: { cookie } });
    expect(get.status).toBe(200);
    expect(get.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(png);
    const missing = await (await api('/api/media/missing', { method: 'POST', cookie, body: { hashes: [hash, 'f'.repeat(64)] } })).json();
    expect(JSON.stringify(missing)).toContain('f'.repeat(64));
    expect(JSON.stringify(missing)).not.toContain(hash);
  });
});

describe('request bodies', () => {
  it('a body over the cap without a Content-Length is refused with 413', async () => {
    const big = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64 * 1024)); } });
    const r = await SELF.fetch(ORIGIN + '/api/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: big, duplex: 'half' });
    expect(r.status).toBe(413);
  });
});
