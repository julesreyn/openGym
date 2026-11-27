// The remote MCP server at /mcp: mcp/src/http.js on fetch instead of node:http. Same tools
// (mcp/src/server.js buildServer), same rules: stateless (no MCP session, a fresh server per
// request, JSON answers), scoped `ogt_` tokens only, and every read and write goes through the
// API with that token (mcp/src/remote.js), which hands it only its categories. Here the API is
// not reached over the network: requests go straight to the instance's DirectoryDO.
//
// Claude's custom connector signs in with the API's own OAuth server (api/oauth.js): the 401
// below points it at /.well-known/oauth-protected-resource/mcp, and the token it ends up with is
// an ordinary `ogt_` token the person can see and revoke in Settings, API tokens.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer, VERSION } from '../../mcp/src/server.js';
import { withProfile } from '../../mcp/src/state.js';
import { createRemoteProfile } from '../../mcp/src/remote.js';
import { createWindow } from '../../api/rate-limit.js';

export const MAX_BODY = 1024 * 1024;
export const DEFAULT_SCOPE = 'workouts:view plans:apply bodyweight:view offline_access';
const TOKEN_RE = /^ogt_[A-Za-z0-9_-]{43}$/;
const INTERNAL = 'https://opengym.internal';

// Per isolate, as the Node server keeps them per process: one cached profile per token (by its
// hash) for ten idle minutes, and refused sign-ins per client address.
const cache = new Map();
const IDLE = 10 * 60000;
const refused = createWindow({ max: 30, windowMs: 60000 });

const send = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});
const rpcError = (status, message, headers) => send(status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null }, headers);

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function handleMcp(request, env, ctx, { directory } = {}) {
  const dir = directory;
  const publicOrigin = String(env.ORIGIN || '').replace(/\/+$/, '');
  const basePath = String(env.BASE_PATH || '').replace(/\/+$/, '');
  const allowedOrigins = String(env.MCP_ALLOWED_ORIGINS || env.ORIGIN || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const unauthorized = why => rpcError(401, why, {
    'WWW-Authenticate': 'Bearer realm="openGym", error="invalid_token", error_description="sign in with openGym, or make a token in Settings, API tokens"'
      + (publicOrigin ? `, resource_metadata="${publicOrigin}${basePath}/.well-known/oauth-protected-resource/mcp", scope="${DEFAULT_SCOPE}"` : ''),
  });

  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (p === '/mcp/health') return send(200, { ok: true, version: VERSION });
  if (p !== '/mcp') return send(404, { error: 'not found' });
  if (!/^(1|true|yes|on)$/i.test(String(env.MCP || ''))) {
    return rpcError(503, 'the MCP server is not switched on for this openGym (MCP=1)');
  }
  // DNS rebinding (the MCP spec's own rule): a browser page on another origin is turned away.
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins.includes(origin.replace(/\/+$/, ''))) return rpcError(403, 'origin not allowed');
  if (request.method !== 'POST') return rpcError(405, 'POST only: this endpoint is stateless (no GET stream, no session to delete)', { Allow: 'POST' });

  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const who = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!TOKEN_RE.test(token)) {
    const wait = refused.take(who);
    if (wait) return rpcError(429, 'too many refused requests, try again later', { 'Retry-After': String(wait) });
    return unauthorized(token ? 'that is not an openGym API token (ogt_…); a paired session is not taken here' : 'an openGym API token is needed (Authorization: Bearer ogt_…)');
  }

  let body;
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY) return rpcError(413, 'body too large');
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return rpcError(400, 'invalid json'); }

  // The API, in-process: the same routes a remote MCP server would call, with the token. The
  // cached profile outlives this request, but a Durable Object stub may not (Workers refuses I/O
  // on another request's objects), so each request hands the cache its own stub.
  const key = await sha256(token);
  const t = Date.now();
  for (const [k, v] of cache) if (t - v.at > IDLE) cache.delete(k);
  let hit = cache.get(key);
  if (!hit) {
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    const via = { dir };
    const fetchImpl = (u, init = {}) => via.dir.fetch(new Request(String(u), { method: init.method, headers: init.headers, body: init.body }));
    hit = { remote: createRemoteProfile({ base: INTERNAL, token }, { fetchImpl }), via, at: t };
    cache.set(key, hit);
  }
  hit.at = t;
  hit.via.dir = dir;
  const remote = hit.remote;

  let me;
  try { me = await remote.me({ fresh: true }); }
  catch (e) {
    cache.delete(key);
    if (e.code === 'EAUTH') {
      const wait = refused.take(who);
      if (wait) return rpcError(429, 'too many refused requests, try again later', { 'Retry-After': String(wait) });
      return unauthorized('openGym did not accept this token: revoked, expired, or the profile signed out everywhere');
    }
    if (e.code === 'ERATE') return rpcError(429, e.message, { 'Retry-After': '60' });
    console.error('[opengym-mcp] me failed:', e?.message || e);
    return rpcError(502, 'openGym could not be reached from the MCP server');
  }

  const server = buildServer({
    scopes: me.scopes || {},
    around: async fn => {
      await remote.refresh();
      return withProfile(remote.snapshot(), fn);
    },
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    // The request body was already read above; the transport takes it parsed.
    const res = await transport.handleRequest(new Request(request.url, { method: 'POST', headers: request.headers }), { parsedBody: body });
    ctx?.waitUntil?.(Promise.resolve().then(() => Promise.allSettled([transport.close(), server.close()])));
    return res;
  } catch (e) {
    console.error('[opengym-mcp] request failed:', e?.message || e);
    return rpcError(500, 'internal error');
  }
}
