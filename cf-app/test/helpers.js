// Shared steps for the Worker tests: a signed-up profile with its cookie, a scoped token.
import { SELF } from 'cloudflare:test';
import { softPasskey } from './contract/soft-passkey.js';

export const ORIGIN = 'http://localhost:8080';

export function api(path, { method = 'GET', body, cookie, bearer, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (bearer) h.authorization = 'Bearer ' + bearer;
  if (body !== undefined) h['content-type'] = 'application/json';
  if (method !== 'GET' && !h.origin) h['sec-fetch-site'] = 'same-origin';
  return SELF.fetch(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
}

export async function signUp(name = 'Ana') {
  const pk = await softPasskey({ origin: ORIGIN });
  const o = await (await api('/api/register/options', { method: 'POST', body: { name } })).json();
  const r = await api('/api/register/verify', { method: 'POST', body: { cid: o.cid, credential: await pk.attestation(o.options.challenge) } });
  if (r.status !== 200) throw new Error('sign-up failed: ' + r.status + ' ' + await r.text());
  const cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
  const { user } = await r.json();
  return { pk, cookie, user };
}

export async function makeToken(cookie, scopes = { workouts: 'apply', plans: 'apply', bodyweight: 'view' }) {
  const r = await api('/api/tokens', { method: 'POST', cookie, body: { name: 'Test', scopes, days: 30 } });
  return (await r.json()).token;
}
