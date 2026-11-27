// The API contract the PWA, the phone apps and the MCP server rely on, as one scripted session:
// sign-up and sign-in with a passkey, sync with its 409, pairing a phone, scoped tokens, OAuth
// discovery for the MCP connector, CORS and CSRF. It runs against the Node server
// (contract.node.test.mjs, the real api/server.js) and against the Worker (contract.worker.test.js),
// and both must produce the transcript in contract.golden.json: every status, the headers a
// client reads, and the shape of every body, with the values that are meant to be stable.
import { softPasskey } from './soft-passkey.js';

export const ORIGIN = 'http://localhost:8080';

// Values kept as they are in the transcript; everything else becomes its type.
const KEEP = new Set(['error', 'code', 'ok', 'rev', 'signed_in', 'invite_only', 'allow_guest', 'unchanged', 'done',
  'nudge', 'name', 'admin', 'owner', 'writable', 'mcp', 'api_tokens', 'users', 'revoked', 'date', 'expected',
  'lastWayIn', 'password', 'issuer', 'token_endpoint', 'authorization_endpoint', 'registration_endpoint', 'resource',
  'type', 'alg', 'attestation', 'residentKey', 'userVerification', 'unit', 'd', 'token_type', 'scope']);
export function shape(v, key = '') {
  if (Array.isArray(v)) return v.map(x => shape(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, shape(v[k], k)]));
  if (key === 'code') return typeof v === 'string' && /^[a-z0-9_-]+$/.test(v) ? v : `<${typeof v}>`;
  if (KEEP.has(key)) return v;
  return v === null ? null : `<${typeof v}>`;
}
const HEADERS = ['content-type', 'cache-control', 'access-control-allow-origin', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-max-age', 'access-control-allow-private-network', 'vary',
  'www-authenticate', 'location', 'pragma'];
const cookieShape = c => c.replace(/^([^=]+)=[^;]*/, (m, n) => `${n}=${m.length > n.length + 1 ? '<v>' : ''}`);

/**
 * `send(method, path, { headers, body })` → a fetch Response, against the server under test.
 * Returns the transcript: one entry per request.
 */
export async function runScenario(send) {
  const out = [];
  let cookie = '';
  async function call(step, method, path, { body, headers = {}, auth, raw, form, keepCookie = true } = {}) {
    const h = { ...headers };
    if (cookie && auth === undefined) h.cookie = cookie;
    if (auth) h.authorization = 'Bearer ' + auth;
    if (method !== 'GET' && method !== 'OPTIONS' && !('sec-fetch-site' in h) && !('origin' in h)) h['sec-fetch-site'] = 'same-origin';
    let b;
    if (form) { b = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    else if (raw !== undefined) b = raw;
    else if (body !== undefined) { b = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await send(method, path, { headers: h, body: b });
    const t = await res.text();
    let json = null;
    try { json = t ? JSON.parse(t) : null; } catch { /* not JSON */ }
    const hs = {};
    for (const k of HEADERS) { const v = res.headers.get(k); if (v != null) hs[k] = k === 'location' ? v.replace(/[0-9a-zA-Z_-]{16,}/g, '<id>') : v; }
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (set.length) {
      hs['set-cookie'] = set.map(cookieShape);
      if (keepCookie) {
        const live = set.map(c => c.split(';')[0]).filter(c => !/=$/.test(c));
        if (live.length) cookie = live.join('; ');
        else if (set.some(c => /Max-Age=0/.test(c))) cookie = '';
      }
    }
    out.push({ step, status: res.status, headers: hs, body: json != null ? shape(json) : (t ? '<text>' : null) });
    return { status: res.status, json, text: t };
  }

  const pk = await softPasskey({ origin: ORIGIN });

  await call('health', 'GET', '/api/health');
  await call('config, signed out', 'GET', '/api/config');
  await call('me, signed out', 'GET', '/api/me');
  await call('data, signed out', 'GET', '/api/data');
  await call('unknown route', 'GET', '/api/nothing-here');
  await call('register options, no name', 'POST', '/api/register/options', { body: {} });
  await call('register options, not json', 'POST', '/api/register/options', { raw: 'name=Ana', headers: { 'content-type': 'text/plain' } });
  const ro = await call('register options', 'POST', '/api/register/options', { body: { name: 'Ana' } });
  await call('register verify, stale challenge', 'POST', '/api/register/verify', { body: { cid: 'nope', credential: {} } });
  await call('register verify', 'POST', '/api/register/verify', { body: { cid: ro.json.cid, credential: await pk.attestation(ro.json.options.challenge) } });
  await call('me', 'GET', '/api/me');
  await call('config, signed in', 'GET', '/api/config');

  // Sync.
  await call('data, empty profile', 'GET', '/api/data');
  await call('rev, empty profile', 'GET', '/api/data/rev');
  await call('put, nothing in it', 'PUT', '/api/data', { body: { state: { _rev: 3 } } });
  await call('put, workouts not a list', 'PUT', '/api/data', { body: { state: { workouts: {} } } });
  await call('put, array', 'PUT', '/api/data', { body: { state: [] } });
  const doc = { unit: 'kg', lang: 'en', workouts: [{ id: 'w1', d: '2026-11-20', name: 'Push', ex: [] }, null], routines: [], bodyweight: [{ d: '2026-11-20', kg: 80 }] };
  await call('put, first write', 'PUT', '/api/data', { body: { state: doc, baseRev: 0 } });
  const r1 = await call('rev after write', 'GET', '/api/data/rev');
  await call('put, stale revision', 'PUT', '/api/data', { body: { state: { ...doc, unit: 'lb' }, baseRev: 0 } });
  await call('put, stale write id', 'PUT', '/api/data', { body: { state: { ...doc, unit: 'lb' }, baseRev: 1, baseWid: 'ffffffffffffffff' } });
  await call('put, second write', 'PUT', '/api/data', { body: { state: { ...doc, unit: 'lb' }, baseRev: 1, baseWid: r1.json.wid } });
  const dw = await call('data after writes', 'GET', '/api/data');
  await call('nudge check, bad date', 'GET', '/api/nudge-check?date=2026-13-45');
  await call('nudge check, trained day', 'GET', '/api/nudge-check?date=2026-11-20');

  // CORS and CSRF.
  await call('preflight from the phone app', 'OPTIONS', '/api/data', { headers: { origin: 'https://localhost', 'access-control-request-method': 'PUT', 'access-control-request-private-network': 'true' } });
  await call('cross-site write refused', 'PUT', '/api/data', { body: { state: doc }, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });

  // Sign in again with the passkey.
  const lo = await call('login options', 'POST', '/api/login/options', { body: {} });
  await call('login verify', 'POST', '/api/login/verify', { body: { cid: lo.json.cid, credential: await pk.assertion(lo.json.options.challenge) } });
  await call('passkeys', 'GET', '/api/account/passkeys');

  // Pair a phone: proof first, then the code, then the bearer.
  await call('pair without proof', 'POST', '/api/pair/create', { body: {} });
  const po = await call('login options for proof', 'POST', '/api/login/options', { body: {} });
  const pc = await call('pair create', 'POST', '/api/pair/create', { body: { cid: po.json.cid, credential: await pk.assertion(po.json.options.challenge) } });
  const pr = await call('pair redeem', 'POST', '/api/pair/redeem', { body: { code: pc.json.code.toLowerCase() }, auth: null, headers: { origin: 'https://localhost' } });
  await call('pair redeem twice', 'POST', '/api/pair/redeem', { body: { code: pc.json.code }, auth: null, headers: { origin: 'https://localhost' } });
  await call('phone reads data', 'GET', '/api/data', { auth: pr.json.token, headers: { origin: 'https://localhost' } });
  await call('phone writes', 'PUT', '/api/data', { auth: pr.json.token, body: { state: { ...dw.json.state, unit: 'kg' }, baseRev: dw.json.rev }, headers: { origin: 'https://localhost' } });
  await call('phone with a bad bearer', 'PUT', '/api/data', { auth: 'x.y', body: { state: doc }, headers: { origin: 'https://localhost' } });

  // Scoped tokens, as the MCP server uses them.
  const tk = await call('token create', 'POST', '/api/tokens', { body: { name: 'Assistant', scopes: { workouts: 'apply', plans: 'apply', bodyweight: 'view' }, days: 30 } });
  await call('tokens list', 'GET', '/api/tokens');
  await call('token me', 'GET', '/api/token/me', { auth: tk.json.token });
  const td = await call('token data', 'GET', '/api/token/data', { auth: tk.json.token });
  await call('token rev', 'GET', '/api/token/data/rev', { auth: tk.json.token });
  await call('token put without baseRev', 'PUT', '/api/token/data', { auth: tk.json.token, body: { state: {} } });
  await call('token put, nothing changed', 'PUT', '/api/token/data', { auth: tk.json.token, body: { state: {}, baseRev: td.json.rev } });
  await call('token put, stale', 'PUT', '/api/token/data', { auth: tk.json.token, body: { state: {}, baseRev: 1 } });
  await call('token put, a workout', 'PUT', '/api/token/data', { auth: tk.json.token, body: { state: { workouts: [...doc.workouts.filter(Boolean), { id: 'w2', d: '2026-11-21', name: 'Pull', ex: [] }] }, baseRev: td.json.rev } });
  await call('token with a session route', 'GET', '/api/data', { auth: tk.json.token });
  await call('bad token', 'GET', '/api/token/me', { auth: 'ogt_' + 'A'.repeat(43) });

  // OAuth discovery and client registration (the claude.ai connector).
  await call('oauth metadata', 'GET', '/.well-known/oauth-authorization-server');
  await call('protected resource metadata', 'GET', '/.well-known/oauth-protected-resource/mcp');
  await call('oauth register', 'POST', '/api/oauth/register', { auth: null, body: { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] } });
  await call('oauth token, bad grant', 'POST', '/api/oauth/token', { auth: null, form: { grant_type: 'authorization_code', code: 'nope', client_id: 'nope' } });

  // Sign out everywhere: every session and token stops working.
  await call('logout all', 'POST', '/api/logout/all', { body: {}, keepCookie: false });
  await call('old cookie after logout all', 'GET', '/api/me');
  await call('old token after logout all', 'GET', '/api/token/me', { auth: tk.json.token });
  return out;
}
