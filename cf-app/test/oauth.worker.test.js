// What claude.ai's custom connector does with https://<host>/mcp, end to end on the Worker:
// register a client, authorize with PKCE, the person approves in the app (signed in), the code
// becomes an ogt_ token, /mcp takes it, and the refresh token gives a new one. The pending
// request and the code are kept in the DirectoryDO's SQLite between those requests.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { api, signUp, ORIGIN } from './helpers.js';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const form = (path, fields) => SELF.fetch(ORIGIN + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

describe('OAuth for the claude.ai connector', () => {
  it('register, authorize, approve, exchange, call /mcp, refresh', async () => {
    const { cookie } = await signUp('Connector');
    const reg = await (await SELF.fetch(ORIGIN + '/api/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
    expect(reg.client_id).toBeTruthy();

    const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', scope: 'workouts:view plans:apply offline_access', resource: ORIGIN + '/mcp' });
    const auth = await SELF.fetch(ORIGIN + '/api/oauth/authorize?' + q, { redirect: 'manual' });
    expect(auth.status).toBe(302);
    const id = auth.headers.get('location').match(/#\/connect\/(.+)$/)[1];

    const described = await (await api('/api/oauth/request?id=' + encodeURIComponent(id), { cookie })).json();
    expect(described.client?.name || described.name || JSON.stringify(described)).toContain('Claude');
    const ok = await (await api('/api/oauth/approve', { method: 'POST', cookie, body: { id, scopes: { workouts: 'view', plans: 'apply' } } })).json();
    const back = new URL(ok.redirect);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('st8');

    const tok = await (await form('/api/oauth/token', { grant_type: 'authorization_code', code: back.searchParams.get('code'), client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: ORIGIN + '/mcp' })).json();
    expect(tok.access_token).toMatch(/^ogt_/);
    expect(tok.refresh_token).toBeTruthy();

    const mcp = await SELF.fetch(ORIGIN + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + tok.access_token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const names = (await mcp.json()).result.tools.map(t => t.name);
    expect(names).toContain('list_workouts');
    expect(names).toContain('create_routine');
    expect(names).not.toContain('log_workout'); // workouts were granted read-only

    const again = await (await form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id })).json();
    expect(again.access_token).toMatch(/^ogt_/);
    expect(again.access_token).not.toBe(tok.access_token);
    // The code was spent.
    expect((await form('/api/oauth/token', { grant_type: 'authorization_code', code: back.searchParams.get('code'), client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier })).status).toBe(400);
  });
});
