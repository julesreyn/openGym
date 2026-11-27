// The instance's accounts (db.json on a Node server) and the API routes the PWA, the phone apps
// and the MCP server use, ported from api/server.js. One Durable Object for the whole instance:
// like the Node process, it runs one request at a time between awaits, and its SQLite calls are
// synchronous, so the handlers below keep server.js's invariants ("checked right before push,
// with no await in between") as they are. Each profile's document lives in its own ProfileDO.
//
// The handlers are copied from server.js and kept in its order and wording, so a change upstream
// can be carried over by reading the two side by side. What this port leaves out is listed in
// cf-app/README.md; those routes answer as a Node server with the feature switched off does.
import { DurableObject } from 'cloudflare:workers';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { createSessionCodec } from '../../api/session-token.js';
import { checkPutBody } from '../../api/state-commit.js';
import { emptyDb } from '../../api/storage/index.js';
import { verifyError, isMisconfigured } from '../../api/verify-error.js';
import { createBackoff, createWindow } from '../../api/rate-limit.js';
import {
  MAX_PASSKEYS, transportsOf, listPasskeys, addPasskeyRecord, renamePasskeyRecord,
  passkeyRemovalRefused, removePasskeyRecord,
} from '../../api/passkeys-store.js';
import { createDeviceLink, findDeviceLink, burnDeviceLink, dropDeviceLinks } from '../../api/device-link.js';
import {
  TOKEN_PREFIX, TOKEN_CATEGORIES, TOKEN_DAYS, DEFAULT_DAYS, ScopeError,
  createToken, findToken, touchToken, listTokens, revokeTokens, scopedState,
} from '../../api/tokens.js';
import * as oauth from '../../api/oauth.js';
import { excusedOn, nudgeFor } from '../../api/nudge.js';
import { mediaLimits, mediaConfig } from '../../api/media.js';
import { configFrom } from './config.js';
import { HttpError, nodeReq, nodeRes, json, readBody, readForm, text } from './http.js';
import { createDocStore, PersistentMap } from './sqlstore.js';
import { createMediaRoutes, MediaError } from './media.js';

const b64uToBuf = s => Buffer.from(s, 'base64url');

export class DirectoryDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.app = createApp({ sql: ctx.storage.sql, env });
  }
  /** /api/* and /.well-known/* (the Worker forwards them here). */
  async fetch(request) { return this.app.handle(request); }
  /** For the Worker: whether a request carries a valid session (exercise media). */
  signedIn(headers) { return !!this.app.sessionFromHeaders(headers); }
}

export function createApp({ sql, env, now = Date.now }) {
  const C = configFrom(env);
  const { ORIGIN, RP_ID, RP_NAME, SECURE, SESSION_DAYS, SAME_SITE, INVITE_ONLY, ALLOW_GUEST,
    ADMIN_UIDS, FIRST_USER_ADMIN, DEFAULT_LANG, API_TOKENS, MCP_ON, OAUTH_ORIGIN, MCP_RESOURCE } = C;
  if (!C.SECRET) throw new Error('SESSION_SECRET is not set: `wrangler secret put SESSION_SECRET` (cf-app/README.md)');

  /* ---------- db (db.json) ---------- */
  const docs = createDocStore(sql, 'directory');
  const loadDb = () => { const t = docs.read('db'); return t ? JSON.parse(t) : emptyDb(); };
  let db = loadDb();
  db.users = db.users || []; db.creds = db.creds || []; db.subs = db.subs || [];
  db.invites = db.invites || []; db.deviceLinks = db.deviceLinks || [];
  const saveDb = () => docs.write('db', JSON.stringify(db));

  const profile = uid => env.PROFILE.get(env.PROFILE.idFromName(uid));

  const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
  function ownerId() {
    const flagged = db.users.find(u => u.owner === true && isAdmin(u));
    if (flagged) return flagged.id;
    const fromEnv = ADMIN_UIDS.find(id => db.users.some(u => u.id === id));
    if (fromEnv) return fromEnv;
    return db.users.find(isAdmin)?.id || null;
  }
  const isOwner = user => !!user && isAdmin(user) && user.id === ownerId();
  function claimFirstAdmin(req, user) {
    if (!FIRST_USER_ADMIN || db.users.length !== 0) return;
    user.admin = true;
    user.owner = true;
    audit(req, 'admin.first-user', { user });
  }
  const PULL_NOTE_MS = 10 * 60 * 1000;
  function notePull(user, t = now()) {
    if (user.lastPull && t - user.lastPull < PULL_NOTE_MS) return;
    user.lastPull = t;
    try { saveDb(); } catch (e) { console.error('db save failed', e.message); }
  }

  /* ---------- audit: one JSON line per event in the Worker's logs (no audit.log file here) ---------- */
  function audit(req, ev, f = {}) {
    const { user, ...rest } = f;
    console.log(JSON.stringify({ audit: ev, uid: user?.id || f.uid || null, ip: req?.ip || null, ...rest, user: undefined }));
  }
  const FAIL_AUDIT = createWindow({ max: 20, windowMs: 60000 });
  function auditFail(req, ev, f) {
    if (FAIL_AUDIT.take(ev + '|' + limitAddress(req))) return;
    audit(req, ev, f);
  }

  /* ---------- sessions (signed cookie), as server.js ---------- */
  const SESSIONS = createSessionCodec(C.SECRET, { days: SESSION_DAYS, now });
  const { sessionVersion, makeSession } = SESSIONS;
  const COOKIE = SECURE ? '__Host-gymsid' : 'gymsid';
  const LEGACY_COOKIE = 'gymsid';
  function cookieValues(req, name) {
    const out = [];
    for (const c of (req.headers.cookie || '').split(';')) {
      const i = c.indexOf('=');
      if (i < 0) continue;
      if (c.slice(0, i).trim() === name) out.push(c.slice(i + 1).trim());
    }
    return out;
  }
  function cookieToken(req) {
    for (const name of (COOKIE === LEGACY_COOKIE ? [COOKIE] : [COOKIE, LEGACY_COOKIE])) {
      const vals = cookieValues(req, name);
      if (!vals.length) continue;
      if (vals.some(v => v !== vals[0])) return null;
      return vals[0];
    }
    return null;
  }
  const sessionUser = tok => SESSIONS.sessionUser(tok, uid => db.users.find(u => u.id === uid));
  function sessionOf(req) {
    const auth = req.headers.authorization || '';
    const cookie = cookieToken(req);
    const tok = cookie || (auth.startsWith('Bearer ') ? auth.slice(7).trim() : null);
    const s = sessionUser(tok);
    return s && { ...s, bearer: !cookie };
  }
  const readSession = req => sessionOf(req)?.user || null;
  const expireCookie = name => `${name}=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=${SAME_SITE}`;
  function sessionCookie(user, at = null) {
    const fresh = `${COOKIE}=${makeSession(user, 'c', at)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=${SAME_SITE}`;
    return COOKIE === LEGACY_COOKIE ? [fresh] : [fresh, expireCookie(LEGACY_COOKIE)];
  }
  const clearCookie = COOKIE === LEGACY_COOKIE
    ? [expireCookie(LEGACY_COOKIE)]
    : [expireCookie(COOKIE), expireCookie(LEGACY_COOKIE)];

  const verifyAnswer = e => ({
    error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }),
    ...(isMisconfigured(e) ? { code: 'origin-mismatch', expected: ORIGIN } : {})
  });

  /* ---------- CSRF ---------- */
  const CSRF_EXEMPT = new Set(['POST /api/oauth/register', 'POST /api/oauth/token', 'POST /api/oauth/revoke', 'POST /api/pair/redeem', 'POST /api/watch/redeem', 'POST /api/watch/box', 'POST /api/oidc/app/redeem', 'PUT /api/token/data']);
  const PASSKEY_ROUTES = new Set([
    'POST /api/register/options', 'POST /api/register/verify',
    'POST /api/login/options', 'POST /api/login/verify'
  ]);
  const SIGN_IN_ROUTES = new Set([
    'POST /api/login/password', 'POST /api/register/password', 'POST /api/login/password-reset',
    'POST /api/device-link/options', 'POST /api/device-link/verify'
  ]);
  const originsMatch = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  function bearerAuthenticates(req) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || cookieToken(req)) return false;
    return !!sessionUser(auth.slice(7).trim());
  }
  function csrfOk(req, key) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    if (CSRF_EXEMPT.has(key)) return true;
    if (!PASSKEY_ROUTES.has(key) && !SIGN_IN_ROUTES.has(key) && bearerAuthenticates(req)) return true;
    const site = req.headers['sec-fetch-site'];
    if (site) return site === 'same-origin' || site === 'none';
    const origin = req.headers.origin;
    if (!origin) return true;
    return originsMatch(origin, ORIGIN);
  }

  /* ---------- short-lived state that must outlive an eviction: challenges, pairing codes ---------- */
  const challenges = new PersistentMap(sql, 'challenges', { now });
  const MAX_CHALLENGES = 20000;
  function putChallenge(data) {
    if (challenges.size >= MAX_CHALLENGES) challenges.sweep();
    const cid = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    challenges.set(cid, { ...data, exp: now() + 5 * 60000 });
    return cid;
  }
  function takeChallenge(cid) {
    if (typeof cid !== 'string' || !cid) return null;
    const c = challenges.get(cid);
    challenges.delete(cid);
    if (!c || c.exp < now()) return null;
    return c;
  }
  const pairings = new PersistentMap(sql, 'pairings', { now });
  const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — read off a screen
  function makePairCode() {
    let code;
    do {
      code = Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => PAIR_CODE_ALPHABET[b % PAIR_CODE_ALPHABET.length]).join('');
    } while (pairings.has(code));
    return code;
  }
  const dropPairings = uid => { for (const [k, v] of pairings) if (v.uid === uid) pairings.delete(k); };

  /* ---------- throttles (in memory, as on Node: lost when the object restarts) ---------- */
  const AUTH_BURST = createWindow({ max: 60, windowMs: 60000 });
  const ADDR_FAILS = createBackoff({ free: 20, baseMs: 30000, maxMs: 15 * 60000, forgetMs: 3600000 });
  const TOKEN_READS = createWindow({ max: C.TOKEN_READS_PER_MIN, windowMs: 60000 });
  const TOKEN_WRITES = createWindow({ max: C.TOKEN_WRITES_PER_HOUR, windowMs: 3600000 });
  const OAUTH_ANON = createWindow({ max: C.OAUTH_ANON_PER_MIN, windowMs: 60000 });
  const THROTTLED = {
    'POST /api/device-link/options': 'link', 'POST /api/device-link/verify': 'link',
    'POST /api/account/passkeys/options': null, 'POST /api/account/device-link': null,
    'POST /api/pair/create': null,
    'DELETE /api/account/passkeys': null,
    'POST /api/account/delete': null
  };
  // Behind Cloudflare the address is CF-Connecting-IP, which the edge sets itself.
  function limitAddress(req) {
    const raw = String(req.ip || '').replace(/^\[|\]$/g, '').toLowerCase();
    const g = ipv6Groups(raw);
    if (g) {
      if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
      return g.slice(0, 4).map(x => x.toString(16)).join(':') + '::/64';
    }
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) ? raw : 'unknown';
  }
  function tooMany(res, secs) {
    json(res, 429, { error: 'too many attempts, try again later', code: 'locked', retryAfter: secs }, { 'Retry-After': String(secs) });
  }
  function addressPaused(req, res, kind) {
    const wait = ADDR_FAILS.retryAfter(kind + '|' + limitAddress(req));
    if (wait) tooMany(res, wait);
    return wait > 0;
  }
  function strikeAddress(req, kind) {
    const lock = ADDR_FAILS.fail(kind + '|' + limitAddress(req));
    if (lock) audit(req, 'auth.throttled', { ok: false, msg: kind });
  }

  /* ---------- users ---------- */
  const publicUser = u => ({ id: u.id, name: u.name, admin: isAdmin(u), ...(isOwner(u) ? { owner: true } : {}) });
  // No password sign-in and no identity provider on this port (cf-app/README.md): a passkey is
  // the only way in, as on a Node server with PASSWORD_LOGIN and OIDC unset.
  const passwordWayIn = () => false;
  const otherWaysIn = () => 0;
  const passkeyCount = u => db.creds.filter(c => c.userId === u.id).length;
  const lastAdminLeaving = u => isAdmin(u) && db.users.length > 1 && db.users.filter(isAdmin).length <= 1;
  const notSignedIn = res => json(res, 401, { error: 'not signed in' });

  async function passkeyStepUp(user, body) {
    const c = takeChallenge(body.cid);
    const cred = c?.kind === 'login' && db.creds.find(x => x.id === body.credential?.id && x.userId === user.id);
    if (!cred) return false;
    try {
      const v = await verifyAuthenticationResponse({
        response: body.credential, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
        requireUserVerification: false,
        credential: { id: cred.id, publicKey: b64uToBuf(cred.publicKey), counter: cred.counter, transports: cred.transports }
      });
      if (!v.verified) return false;
      cred.counter = v.authenticationInfo.newCounter;
      cred.lastUsed = new Date(now()).toISOString();
      return true;
    } catch { return false; }
  }
  async function proveOwner(req, res, user, body, act) {
    if (body.credential) {
      if (await passkeyStepUp(user, body)) return 'passkey';
      audit(req, 'auth.proof.fail', { ok: false, user, msg: 'step-up-failed', act });
      json(res, 403, { error: 'the passkey could not be verified', code: 'passkey' });
      return null;
    }
    // passwordWayIn is always false here (no PASSWORD_LOGIN), which is server.js's answer then.
    json(res, 403, { error: 'confirm with your passkey first', code: 'passkey-required' });
    return null;
  }
  async function removeAccount(u) {
    db.users = db.users.filter(x => x.id !== u.id);
    db.creds = (db.creds || []).filter(c => c.userId !== u.id);
    db.subs = (db.subs || []).filter(x => x.userId !== u.id);
    dropDeviceLinks(db, u.id);
    revokeTokens(db, u.id);
    saveDb();
    try { await profile(u.id).remove(); } catch (e) { console.error('state: could not remove', u.id, e.message); }
    try { await media.removeUser(u.id); } catch (e) { console.error('media: could not remove uploads of', u.id, e.message); }
  }

  const passkeyState = u => {
    const passkeys = listPasskeys(db, u.id);
    return { passkeys, password: passwordWayIn(u), lastWayIn: passkeys.length + otherWaysIn(u) <= 1 };
  };
  const LIMIT = { error: `a profile can have at most ${MAX_PASSKEYS} passkeys`, code: 'passkey-limit' };
  const LINK_INVALID = { error: 'that code is wrong, used or expired', code: 'link-invalid' };
  const moreOptions = user => generateRegistrationOptions({
    rpName: RP_NAME, rpID: RP_ID,
    userID: Buffer.from(user.id), userName: user.name, userDisplayName: user.name,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    excludeCredentials: db.creds.filter(c => c.userId === user.id).map(c => ({ id: c.id, transports: c.transports || [] }))
  });
  async function newPasskey(req, res, c, body, ev, user) {
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
        requireUserVerification: false
      });
    } catch (e) {
      audit(req, ev, { ok: false, user, msg: 'verify-error' });
      json(res, 400, verifyAnswer(e));
      return null;
    }
    if (!verification.verified) {
      audit(req, ev, { ok: false, user, msg: 'not-verified' });
      json(res, 400, { error: 'not verified' });
      return null;
    }
    const { credential } = verification.registrationInfo;
    return {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: body.credential?.response?.transports,
      name: body.name
    };
  }

  /* ---------- scoped tokens ---------- */
  function tokenAuth(req, res) {
    const auth = req.headers.authorization || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const found = tok.startsWith(TOKEN_PREFIX) ? findToken(db, tok, uid => db.users.find(u => u.id === uid) || null) : null;
    const row = found && !found.kind ? found : null;
    if (!row) {
      auditFail(req, 'auth.token.fail', { ok: false, msg: tok ? 'token-invalid' : 'no-token' });
      json(res, 401, { error: 'token not accepted', code: 'token-invalid' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      return null;
    }
    const user = db.users.find(u => u.id === row.userId);
    const wait = TOKEN_READS.take(row.id);
    if (wait) { tooMany(res, wait); return null; }
    if (touchToken(row)) saveDb();
    return { row, user };
  }

  /* ---------- OAuth for the MCP connector (api/oauth.js) ---------- */
  const oauthPending = new PersistentMap(sql, 'oauthPending', { now });
  const oauthCodes = new PersistentMap(sql, 'oauthCodes', { now });
  const redirectTo = (res, location) => { res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' }); res.end(); };
  const oauthJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' }); res.end(JSON.stringify(body)); };
  const userById = uid => db.users.find(u => u.id === uid) || null;
  const oauthBudget = (req, res) => {
    const wait = OAUTH_ANON.take(limitAddress(req));
    if (wait) tooMany(res, wait);
    return !wait;
  };
  // A client metadata document is fetched over https with fetch (no node:https Agent here):
  // public addresses only, which Cloudflare's own egress already guarantees.
  const fetchCimd = async u => {
    const r = await fetch(u, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = await r.text();
    if (t.length > 16384) throw new Error('too large');
    return JSON.parse(t);
  };
  const form = async req => new URLSearchParams(Object.entries(await readForm(req, 16384)).map(([k, v]) => [k, String(v)]));
  function oauthRoutes() {
    const meta = (req, res) => json(res, 200, oauth.authServerMetadata(OAUTH_ORIGIN));
    const resource = (req, res) => json(res, 200, oauth.protectedResourceMetadata(OAUTH_ORIGIN));
    return {
      'GET /.well-known/oauth-authorization-server': meta,
      'GET /.well-known/openid-configuration': meta,
      'GET /.well-known/oauth-protected-resource': resource,
      'GET /.well-known/oauth-protected-resource/mcp': resource,
      'POST /api/oauth/register': async (req, res) => {
        if (!oauthBudget(req, res)) return;
        const body = await readBody(req).catch(() => ({}));
        const r = oauth.registerClient(db, body);
        if (r.status === 201) saveDb();
        json(res, r.status, r.body);
      },
      'GET /api/oauth/authorize': async (req, res) => {
        if (!oauthBudget(req, res)) return;
        const q = new URL(req.url, 'http://x').searchParams;
        const opts = { issuer: OAUTH_ORIGIN, resource: MCP_RESOURCE };
        if (oauth.isCimdId(q.get('client_id'))) {
          const c = await oauth.resolveCimd(q.get('client_id'), { fetchDoc: fetchCimd });
          if (!c.ok) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('openGym could not start this sign-in: ' + c.error); }
          opts.client = c.client;
        }
        const r = oauth.startAuthorize(db, q, oauthPending, now(), opts);
        if (r.ok) return redirectTo(res, `${OAUTH_ORIGIN}/#/connect/${r.request.id}`);
        if (r.redirect) return redirectTo(res, r.redirect);
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('openGym could not start this sign-in: ' + r.error);
      },
      'GET /api/oauth/request': async (req, res) => {
        const user = readSession(req);
        if (!user) return json(res, 401, { error: 'not signed in' });
        const d = oauth.describeRequest(oauthPending, new URL(req.url, 'http://x').searchParams.get('id') || '');
        if (!d) return json(res, 404, { error: 'this sign-in has expired; start it again from the assistant', code: 'expired' });
        json(res, 200, d);
      },
      'POST /api/oauth/approve': async (req, res) => {
        const user = readSession(req);
        if (!user) return json(res, 401, { error: 'not signed in' });
        const body = await readBody(req);
        let made = null;
        try {
          const r = oauth.approve(oauthPending, oauthCodes, text(body.id), { scopes: body.scopes, days: body.days }, (name, scopes, days) => {
            made = createToken(db, user, { name, scopes, days, evict: row => !!row.connector });
            return { value: made.token, scopes: made.row.scopes, expiresIn: made.row.exp ? Math.round((made.row.exp - now()) / 1000) : null, row: made.row };
          });
          if (!r.ok) return json(res, r.status, { error: r.error, code: 'expired' });
          saveDb();
          audit(req, 'auth.token.create', { user, msg: made.row.name });
          json(res, 200, { redirect: r.redirect });
        } catch (e) { if (e instanceof ScopeError) return json(res, e.status, { error: e.message, code: e.code }); throw e; }
      },
      'POST /api/oauth/deny': async (req, res) => {
        const user = readSession(req);
        if (!user) return json(res, 401, { error: 'not signed in' });
        const body = await readBody(req);
        const r = oauth.deny(oauthPending, text(body.id));
        if (!r.ok) return json(res, r.status, { error: r.error, code: 'expired' });
        json(res, 200, { redirect: r.redirect });
      },
      'POST /api/oauth/token': async (req, res) => {
        const f = await form(req);
        if (!f.get('client_id')) { const id = oauth.basicClientId(req.headers.authorization); if (id) f.set('client_id', id); }
        if (f.get('grant_type') === 'refresh_token') {
          const r = oauth.refresh(db, f, userById);
          if (r.changed) saveDb();
          return oauthJson(res, r.status, r.body);
        }
        const r = oauth.exchange(oauthCodes, f, db);
        if (r.status === 200) saveDb();
        oauthJson(res, r.status, r.body);
      },
      'POST /api/oauth/revoke': async (req, res) => {
        const f = await form(req);
        const row = oauth.revocable(db, f.get('token') || '', v => findToken(db, v, userById));
        if (row) { revokeTokens(db, row.userId, row.id); saveDb(); }
        res.writeHead(200, { 'Cache-Control': 'no-store' }); res.end();
      }
    };
  }

  /* ---------- media (R2, media.js in this folder) ---------- */
  const MEDIA_LIMITS = mediaLimits(env);
  const MEDIA_ON = MEDIA_LIMITS.enabled && !!env.UPLOADS;
  const media = createMediaRoutes({ bucket: env.UPLOADS, limits: MEDIA_LIMITS, readSession, audit, json, readBody, profile, now });

  /* ---------- the routes ---------- */
  const passkeyRoutes = {
    'GET /api/account/passkeys': async (req, res) => {
      const user = readSession(req);
      if (!user) return notSignedIn(res);
      json(res, 200, { ...passkeyState(user), ...(lastAdminLeaving(user) ? { deleteBlocked: 'last-admin' } : {}) });
    },
    'POST /api/account/passkeys/options': async (req, res) => {
      const user = readSession(req);
      if (!user) return notSignedIn(res);
      const body = await readBody(req);
      if (passkeyCount(user) >= MAX_PASSKEYS) return json(res, 409, LIMIT);
      const proof = await proveOwner(req, res, user, body, 'passkey-add');
      if (!proof) return;
      if (readSession(req) !== user) return notSignedIn(res);
      if (proof === 'passkey') saveDb();   // the confirming passkey's counter and last use
      const options = await moreOptions(user);
      const cid = putChallenge({ challenge: options.challenge, uid: user.id, kind: 'add', sv: sessionVersion(user), proof });
      json(res, 200, { cid, options });
    },
    'POST /api/account/passkeys/verify': async (req, res) => {
      const user = readSession(req);
      if (!user) return notSignedIn(res);
      const body = await readBody(req);
      const c = takeChallenge(text(body.cid));
      if (!c || c.kind !== 'add' || c.uid !== user.id) {
        audit(req, 'auth.passkey.fail', { ok: false, user, msg: 'challenge-expired' });
        return json(res, 400, { error: 'challenge expired, try again', code: 'challenge-expired' });
      }
      const cred = await newPasskey(req, res, c, body, 'auth.passkey.fail', user);
      if (!cred) return;
      if (readSession(req) !== user || sessionVersion(user) !== c.sv) return notSignedIn(res);
      const added = addPasskeyRecord(db, user.id, cred);
      if (added.error) {
        audit(req, 'auth.passkey.fail', { ok: false, user, msg: added.code });
        return json(res, 409, { error: added.error, code: added.code });
      }
      saveDb();
      audit(req, 'auth.passkey.add', { user, msg: c.proof });
      json(res, 200, { ok: true, ...passkeyState(user) });
    },
    'POST /api/account/passkeys/rename': async (req, res) => {
      const user = readSession(req);
      if (!user) return notSignedIn(res);
      const body = await readBody(req);
      const r = renamePasskeyRecord(db, user.id, text(body.id), body.name);
      if (r.error) return json(res, 404, { error: r.error, code: r.code });
      saveDb();
      json(res, 200, { ok: true, ...passkeyState(user) });
    },
    'DELETE /api/account/passkeys': async (req, res) => {
      const user = readSession(req);
      if (!user) return notSignedIn(res);
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      const body = await readBody(req);
      const refuse = r => json(res, r.code === 'last-way-in' ? 409 : 404, { error: r.error, code: r.code });
      const refused = passkeyRemovalRefused(db, user.id, id, otherWaysIn(user));
      if (refused) return refuse(refused);
      const proof = await proveOwner(req, res, user, body, 'passkey-remove');
      if (!proof) return;
      if (readSession(req) !== user) return notSignedIn(res);
      if (proof === 'passkey') saveDb();
      const r = removePasskeyRecord(db, user.id, id, otherWaysIn(user));
      if (r.error) return refuse(r);
      dropDeviceLinks(db, user.id);
      saveDb();
      audit(req, 'auth.passkey.remove', { user, msg: r.row.name || null });
      json(res, 200, { ok: true, ...passkeyState(user) });
    },
    'POST /api/account/device-link': async (req, res) => {
      const user = readSession(req);
      if (!user) return notSignedIn(res);
      const body = await readBody(req);
      if (passkeyCount(user) >= MAX_PASSKEYS) return json(res, 409, LIMIT);
      const proof = await proveOwner(req, res, user, body, 'device-link');
      if (!proof) return;
      if (readSession(req) !== user) return notSignedIn(res);
      const { code, link } = createDeviceLink(db, user.id);
      saveDb();
      audit(req, 'auth.link.create', { user, msg: proof });
      json(res, 200, { code, expires: link.exp });
    },
    'POST /api/device-link/options': async (req, res) => {
      const body = await readBody(req);
      if (addressPaused(req, res, 'link')) return;
      const link = findDeviceLink(db, text(body.code));
      if (!link) {
        strikeAddress(req, 'link');
        audit(req, 'auth.link.fail', { ok: false, msg: 'link-invalid' });
        return json(res, 400, LINK_INVALID);
      }
      const user = db.users.find(u => u.id === link.userId);
      if (!user || user.disabled) {
        audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'user-unavailable' });
        return json(res, 400, LINK_INVALID);
      }
      if (link.kind !== 'recovery' && passkeyCount(user) >= MAX_PASSKEYS) return json(res, 409, LIMIT);
      const options = await moreOptions(user);
      const cid = putChallenge({ challenge: options.challenge, uid: user.id, kind: 'link', lh: link.h });
      json(res, 200, { cid, options, id: user.id, name: user.name, ...(link.kind === 'recovery' ? { recovery: true } : {}) });
    },
    'POST /api/device-link/verify': async (req, res) => {
      const body = await readBody(req);
      if (addressPaused(req, res, 'link')) return;
      const code = text(body.code);
      const c = takeChallenge(text(body.cid));
      const link = findDeviceLink(db, code);
      if (!link) {
        strikeAddress(req, 'link');
        audit(req, 'auth.link.fail', { ok: false, msg: 'link-invalid' });
        return json(res, 400, LINK_INVALID);
      }
      if (!c || c.kind !== 'link' || c.lh !== link.h || c.uid !== link.userId) {
        audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'challenge-expired' });
        return json(res, 400, { error: 'challenge expired, try again', code: 'challenge-expired' });
      }
      const owner = db.users.find(u => u.id === link.userId);
      const cred = await newPasskey(req, res, c, body, 'auth.link.fail', owner || { id: link.userId });
      if (!cred) return;
      const user = db.users.find(u => u.id === link.userId);
      if (findDeviceLink(db, code) !== link || !user || user.disabled) {
        audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'link-invalid' });
        return json(res, 400, LINK_INVALID);
      }
      const recovery = link.kind === 'recovery';
      let dropped = null;
      if (recovery && passkeyCount(user) >= MAX_PASSKEYS) {
        const oldest = listPasskeys(db, user.id).slice().sort((a, b) => String(a.lastUsed || a.created || '').localeCompare(String(b.lastUsed || b.created || '')))[0];
        if (oldest && !removePasskeyRecord(db, user.id, oldest.id, 1).error) dropped = oldest;
      }
      const added = addPasskeyRecord(db, user.id, cred);
      if (added.error) {
        audit(req, 'auth.link.fail', { ok: false, user, msg: added.code });
        return json(res, 409, { error: added.error, code: added.code });
      }
      added.row.lastUsed = added.row.created;
      burnDeviceLink(db, link);
      saveDb();
      audit(req, recovery ? 'auth.recovery.ok' : 'auth.link.ok', { user, msg: [added.row.name, dropped && `replaced ${dropped.name || 'a passkey'}`].filter(Boolean).join(', ') || null });
      json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
    }
  };

  const tokenRoutes = !API_TOKENS ? {} : {
    'GET /api/tokens': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      json(res, 200, { tokens: listTokens(db, user), categories: TOKEN_CATEGORIES, days: TOKEN_DAYS, defaultDays: DEFAULT_DAYS, mcp: MCP_ON });
    },
    'POST /api/tokens': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const body = await readBody(req);
      let made;
      try { made = createToken(db, user, { name: text(body.name), scopes: body.scopes, days: body.days }); }
      catch (e) { if (e instanceof ScopeError) return json(res, e.status, { error: e.message, code: e.code }); throw e; }
      saveDb();
      audit(req, 'auth.token.create', { user, msg: made.row.name });
      json(res, 200, { token: made.token, tokens: listTokens(db, user), id: made.row.id });
    },
    'POST /api/tokens/revoke': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const body = await readBody(req);
      const gone = revokeTokens(db, user.id, text(body.id) || null);
      if (gone.length) {
        saveDb();
        audit(req, 'auth.token.revoke', { user, msg: gone.length === 1 ? gone[0].name : `${gone.length} tokens` });
      }
      json(res, 200, { ok: true, revoked: gone.length, tokens: listTokens(db, user) });
    },
    ...(MCP_ON ? oauthRoutes() : {}),
    'GET /api/token/me': async (req, res) => {
      const t = tokenAuth(req, res); if (!t) return;
      json(res, 200, { user: { id: t.user.id, name: t.user.name || '' }, token: { id: t.row.id, name: t.row.name, scopes: { ...t.row.scopes }, exp: t.row.exp || null } });
    },
    'GET /api/token/data': async (req, res) => {
      const t = tokenAuth(req, res); if (!t) return;
      const r = await profile(t.user.id).raw();
      if (r.unreadable) { console.error('state unreadable for', t.user.id); return json(res, 503, { error: 'state unreadable' }); }
      const state = r.state;
      json(res, 200, { state: state ? scopedState(state, t.row.scopes) : null, rev: state?._rev || 0, ...(state?._wid ? { wid: state._wid } : {}) });
    },
    'GET /api/token/data/rev': async (req, res) => {
      const t = tokenAuth(req, res); if (!t) return;
      json(res, 200, await profile(t.user.id).rev());
    },
    'PUT /api/token/data': async (req, res) => {
      const t = tokenAuth(req, res); if (!t) return;
      const body = await readBody(req);
      if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) return json(res, 400, { error: 'state required' });
      if (!Number.isInteger(body.baseRev)) return json(res, 400, { error: 'baseRev required: write over the revision you read', code: 'base-rev' });
      const p = profile(t.user.id);
      // First without writing: the write budget is spent only on a change, as in server.js.
      const dry = await p.tokenPut(body, t.row.scopes, false);
      if (!dry.writes) {
        if (dry.denied) auditFail(req, 'token.denied', { ok: false, user: t.user, msg: t.row.name });
        return json(res, dry.status, dry.body);
      }
      const wait = TOKEN_WRITES.take(t.row.id);
      if (wait) return tooMany(res, wait);
      const done = await p.tokenPut(body, t.row.scopes, true);
      if (done.status === 200 && done.touched) audit(req, 'token.write', { user: t.user, msg: `${t.row.name}: ${done.touched.join(', ')}` });
      json(res, done.status, done.body);
    },
  };

  const routes = {
    'GET /api/health': async (req, res) => {
      json(res, 200, { ok: true, users: db.users.length, writable: true });
    },
    'GET /api/config': async (req, res) => {
      const signed = !!readSession(req);
      json(res, 200, {
        invite_only: INVITE_ONLY, allow_guest: ALLOW_GUEST,
        signed_in: signed,
        ...(API_TOKENS && signed ? { api_tokens: true, ...(MCP_ON ? { mcp: true } : {}) } : {}),
        ...(DEFAULT_LANG ? { default_lang: DEFAULT_LANG } : {}),
        ...(MEDIA_ON ? { media: mediaConfig(MEDIA_LIMITS) } : {}),
        ...(signed ? { coach: null } : {}),
      });
    },
    'GET /api/me': async (req, res) => {
      const s = sessionOf(req);
      if (!s) return json(res, 401, { error: 'not signed in' });
      const { user } = s;
      const renew = s.bearer && s.kind !== 'c' && s.exp - now() < SESSION_DAYS * 86400000 / 2;
      json(res, 200, { user: publicUser(user), ...(renew ? { token: makeSession(user) } : {}) });
    },
    'POST /api/register/options': async (req, res) => {
      const body = await readBody(req);
      const name = text(body.name).trim().slice(0, 40);
      if (!name) return json(res, 400, { error: 'name required' });
      const code = text(body.code).trim().toUpperCase();
      if (INVITE_ONLY && !db.invites.some(i => i.code === code && !i.usedBy && !i.revoked)) {
        audit(req, 'auth.register.denied', { ok: false, name, msg: 'invite-rejected' });
        return json(res, 403, { error: 'a valid invite code is required', code: 'invite' });
      }
      const uid = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url');
      const options = await generateRegistrationOptions({
        rpName: RP_NAME, rpID: RP_ID,
        userID: Buffer.from(uid), userName: name, userDisplayName: name,
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        excludeCredentials: []
      });
      const cid = putChallenge({ kind: 'register', challenge: options.challenge, name, uid, code });
      json(res, 200, { cid, options });
    },
    'POST /api/register/verify': async (req, res) => {
      const body = await readBody(req);
      const c = takeChallenge(body.cid);
      if (!c || c.kind !== 'register' || !c.uid) {
        auditFail(req, 'auth.register.fail', { ok: false, msg: 'challenge-expired' });
        return json(res, 400, { error: 'challenge expired, try again', code: 'challenge-expired' });
      }
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: body.credential,
          expectedChallenge: c.challenge,
          expectedOrigin: ORIGIN,
          expectedRPID: RP_ID,
          requireUserVerification: false
        });
      } catch (e) {
        auditFail(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'verify-error' });
        return json(res, 400, verifyAnswer(e));
      }
      if (!verification.verified) {
        auditFail(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'not-verified' });
        return json(res, 400, { error: 'not verified' });
      }
      const { credential } = verification.registrationInfo;
      if (db.creds.find(x => x.id === credential.id)) {
        audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'credential-exists' });
        return json(res, 409, { error: 'credential already registered' });
      }
      let invite = null;
      if (INVITE_ONLY) {
        invite = db.invites.find(i => i.code === c.code && !i.usedBy && !i.revoked);
        if (!invite) {
          audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'invite-invalid' });
          return json(res, 403, { error: 'invite code is no longer valid, ask for a new one', code: 'invite' });
        }
      }
      const user = { id: c.uid, name: c.name, created: new Date(now()).toISOString() };
      if (invite) { user.invitedBy = invite.code; invite.usedBy = user.id; invite.usedAt = user.created; }
      claimFirstAdmin(req, user);
      db.users.push(user);
      db.creds.push({
        id: credential.id, userId: user.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter || 0,
        transports: transportsOf(body.credential?.response?.transports),
        created: user.created, lastUsed: user.created
      });
      saveDb();
      audit(req, 'auth.register.ok', { user, msg: invite ? invite.code : null });
      json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
    },
    'POST /api/login/options': async (req, res) => {
      const options = await generateAuthenticationOptions({
        rpID: RP_ID, userVerification: 'preferred', allowCredentials: []
      });
      const cid = putChallenge({ kind: 'login', challenge: options.challenge });
      json(res, 200, { cid, options });
    },
    'POST /api/login/verify': async (req, res) => {
      const body = await readBody(req);
      const c = takeChallenge(body.cid);
      if (c?.kind !== 'login') {
        auditFail(req, 'auth.login.fail', { ok: false, msg: 'challenge-expired' });
        return json(res, 400, { error: 'challenge expired, try again', code: 'challenge-expired' });
      }
      const cred = db.creds.find(x => x.id === body.credential?.id);
      if (!cred) {
        auditFail(req, 'auth.login.fail', { ok: false, msg: 'unknown-credential' });
        return json(res, 404, { error: 'unknown passkey, create a profile first', code: 'unknown-credential' });
      }
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: body.credential,
          expectedChallenge: c.challenge,
          expectedOrigin: ORIGIN,
          expectedRPID: RP_ID,
          requireUserVerification: false,
          credential: { id: cred.id, publicKey: b64uToBuf(cred.publicKey), counter: cred.counter, transports: cred.transports }
        });
      } catch (e) {
        auditFail(req, 'auth.login.fail', { ok: false, uid: cred.userId, msg: 'verify-error' });
        return json(res, 400, verifyAnswer(e));
      }
      if (!verification.verified) {
        auditFail(req, 'auth.login.fail', { ok: false, uid: cred.userId, msg: 'not-verified' });
        return json(res, 400, { error: 'not verified' });
      }
      cred.counter = verification.authenticationInfo.newCounter;
      cred.lastUsed = new Date(now()).toISOString();
      saveDb();
      const user = db.users.find(u => u.id === cred.userId);
      if (!user) {
        audit(req, 'auth.login.fail', { ok: false, uid: cred.userId, msg: 'user-missing' });
        return json(res, 500, { error: 'user missing' });
      }
      if (user.disabled) {
        audit(req, 'auth.login.fail', { ok: false, user, msg: 'account-disabled' });
        return json(res, 403, { error: 'this account has been disabled', code: 'disabled' });
      }
      audit(req, 'auth.login.ok', { user });
      json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
    },
    'POST /api/logout': async (req, res) => {
      const user = readSession(req);
      if (user) audit(req, 'auth.logout', { user });
      json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
    },
    'POST /api/logout/all': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      user.sv = sessionVersion(user) + 1;
      dropPairings(user.id);
      dropDeviceLinks(db, user.id);
      revokeTokens(db, user.id);
      saveDb();
      audit(req, 'auth.logout.all', { user });
      json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
    },
    'POST /api/account/delete': async (req, res) => {
      const s = sessionOf(req);
      if (!s) return json(res, 401, { error: 'not signed in' });
      const { user } = s;
      const body = await readBody(req);
      if (sessionOf(req)?.user !== user) return json(res, 401, { error: 'not signed in' });
      if (typeof body.name !== 'string' || body.name.trim() !== user.name) {
        return json(res, 400, { error: 'type the account name to confirm', code: 'confirm-name' });
      }
      const lastAdmin = () => lastAdminLeaving(user);
      const refuseLastAdmin = () => json(res, 409, { error: 'the last admin cannot leave while other profiles remain', code: 'last-admin' });
      if (lastAdmin()) return refuseLastAdmin();
      const paired = s.bearer && s.kind !== 'c';
      const proof = paired && !passwordWayIn(user) ? 'device' : await proveOwner(req, res, user, body, 'account-delete');
      if (!proof) return;
      if (readSession(req) !== user) return json(res, 401, { error: 'not signed in' });
      if (lastAdmin()) return refuseLastAdmin();
      await removeAccount(user);
      audit(req, 'auth.account.delete', { user, msg: proof });
      json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
    },
    'POST /api/pair/create': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const body = await readBody(req);
      const proof = await proveOwner(req, res, user, body, 'pair');
      if (!proof) return;
      if (readSession(req) !== user) return json(res, 401, { error: 'not signed in' });
      if (proof === 'passkey') saveDb();
      dropPairings(user.id);
      const code = makePairCode();
      pairings.set(code, { uid: user.id, exp: now() + 5 * 60000 });
      audit(req, 'auth.pair.create', { user, msg: proof });
      json(res, 200, { code });
    },
    'POST /api/pair/redeem': async (req, res) => {
      const body = await readBody(req);
      const code = text(body.code).trim().toUpperCase();
      const p = code ? pairings.get(code) : undefined;
      if (p) pairings.delete(code);
      if (!p || p.exp < now()) {
        auditFail(req, 'auth.pair.fail', { ok: false, msg: 'code-invalid' });
        return json(res, 400, { error: 'invalid or expired code', code: 'pair-invalid' });
      }
      const user = db.users.find(u => u.id === p.uid);
      if (!user || user.disabled) {
        audit(req, 'auth.pair.fail', { ok: false, uid: p.uid, msg: 'user-unavailable' });
        return json(res, 400, { error: 'invalid or expired code', code: 'pair-invalid' });
      }
      audit(req, 'auth.pair.ok', { user });
      json(res, 200, { token: makeSession(user), user: publicUser(user) });
    },

    ...tokenRoutes,
    ...passkeyRoutes,
    ...(MEDIA_ON ? media.routes : {}),

    'GET /api/data': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const r = await profile(user.id).read();
      if (r.unreadable) { console.error('state unreadable for', user.id); return json(res, 503, { error: 'state unreadable' }); }
      notePull(user);
      json(res, 200, { state: r.state, rev: r.rev });
    },
    'GET /api/data/rev': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      json(res, 200, await profile(user.id).rev());
    },
    'GET /api/nudge-check': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const date = new URL(req.url, 'http://x').searchParams.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) {
        return json(res, 400, { error: 'date must be YYYY-MM-DD', code: 'date-invalid' });
      }
      const r = await profile(user.id).raw();
      const doc = (!r.unreadable && r.state) || {};
      const workouts = Array.isArray(doc.workouts) ? doc.workouts : [];
      const done = workouts.some(w => w && w.d === date) || excusedOn(doc, date);
      let nudge = false;
      try { nudge = !done && !!nudgeFor(doc, date); } catch { nudge = true; }
      json(res, 200, { date, done, nudge, rev: doc._rev || 0 });
    },
    'PUT /api/data': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const body = await readBody(req);
      const refused = checkPutBody(body);
      if (refused) return json(res, refused.status, refused.body);
      // The compare-and-write happens inside the profile's own object (profile.js put).
      const done = await profile(user.id).put(body);
      json(res, done.status, done.body);
    },
  };

  /* ---------- dispatch (server.js createServer) ---------- */
  const APP_ORIGINS = new Set(['https://localhost', 'capacitor://localhost', 'http://localhost']);
  function wellKnownPath(p) {
    if (!C.APP_BASE || !p.startsWith('/.well-known/')) return p;
    for (const doc of ['oauth-authorization-server', 'openid-configuration', 'oauth-protected-resource']) {
      const at = '/.well-known/' + doc + C.APP_BASE;
      if (p === at) return '/.well-known/' + doc;
      if (p === at + '/mcp') return '/.well-known/' + doc + '/mcp';
    }
    return p;
  }

  async function handle(request) {
    const req = nodeReq(request);
    const res = nodeRes();
    const origin = req.headers.origin;
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      const pna = String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true'
        && APP_ORIGINS.has(origin);
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret, X-OpenGym-Account, If-Match',
        'Access-Control-Max-Age': '86400',
        ...(pna ? { 'Access-Control-Allow-Private-Network': 'true' } : {})
      });
      res.end();
      return res.toResponse();
    }
    const url = new URL(request.url);
    let key = req.method + ' ' + (MCP_ON ? wellKnownPath(url.pathname) : url.pathname);
    const mm = /^\/api\/media\/([0-9a-f]{64})$/.exec(url.pathname);
    if (mm) { key = req.method + ' /api/media/{hash}'; req.mediaHash = mm[1]; }
    const handler = routes[key];
    if (!handler) { json(res, 404, { error: 'not found' }); return res.toResponse(); }
    if (!csrfOk(req, key)) {
      if ((req.headers.authorization || '').startsWith('Bearer ') && !cookieToken(req) && !bearerAuthenticates(req)) {
        json(res, 401, { error: 'not signed in' });
        return res.toResponse();
      }
      json(res, 403, { error: 'cross-origin request refused', code: 'origin-mismatch', expected: ORIGIN });
      return res.toResponse();
    }
    if (key in THROTTLED) {
      const addr = limitAddress(req);
      const kind = THROTTLED[key];
      const wait = AUTH_BURST.take(addr) || (kind ? ADDR_FAILS.retryAfter(kind + '|' + addr) : 0);
      if (wait) { tooMany(res, wait); return res.toResponse(); }
    }
    try { await handler(req, res); }
    catch (e) {
      if (e instanceof HttpError) { if (!res.headersSent) json(res, e.status, { error: e.message }); }
      else if (e instanceof MediaError) { if (!res.headersSent) json(res, e.status, { error: e.message, code: e.code, ...e.extra }, e.headers); }
      else { console.error(key, e); if (!res.headersSent) json(res, 500, { error: 'server error' }); }
    }
    return res.toResponse();
  }

  const sessionFromHeaders = headers => sessionOf(nodeReq(new Request('http://x/', { headers })));

  return { handle, sessionFromHeaders, routes, _db: () => db };
}

function ipv6Groups(v) {
  if (!v.includes(':') || !/^[0-9a-f:.%]+$/i.test(v)) return null;
  let s = v.replace(/%.*$/, '');
  const m4 = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (m4) {
    const [a, b, c, d] = m4[1].split('.').map(Number);
    s = s.slice(0, -m4[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail = ''] = s.split('::');
  const groups = head ? head.split(':') : [];
  const rest = tail ? tail.split(':') : [];
  if (s.includes('::')) while (groups.length + rest.length < 8) groups.push('0');
  const out = groups.concat(rest).map(x => parseInt(x, 16));
  return out.length === 8 && out.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null;
}
