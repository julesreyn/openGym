// One Durable Object per profile: its document (state-<uid>.json on a Node server) and the
// compare-and-write of PUT /api/data. The object runs one call at a time and SQLite calls do not
// yield, so two devices writing at once are ordered exactly as one Node process orders them: the
// second one sees the first one's revision and gets its 409.
import { DurableObject } from 'cloudflare:workers';
import { planCommit, putConflicts, putOptions } from '../../api/state-commit.js';
import { scopedState, mergeScoped, ScopeError } from '../../api/tokens.js';
import { createDocStore } from './sqlstore.js';

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const records = v => (Array.isArray(v) ? v.filter(record) : []);

/** A stored document as a client gets it: without the server's own notes (server.js forClient). */
export function forClient(S) {
  if (!S || typeof S !== 'object' || !('_unstamped' in S || '_prior' in S)) return S;
  const { _unstamped, _prior, ...rest } = S;
  return rest;
}

export class ProfileDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.docs = createDocStore(ctx.storage.sql, 'doc');
    this.cache = undefined;   // the parsed document, kept while the object is in memory
  }

  current() {
    if (this.cache !== undefined) return this.cache;
    const text = this.docs.read('state');
    if (text == null) return (this.cache = null);
    try { return (this.cache = JSON.parse(text)); }
    catch { return Symbol.for('opengym.state-unreadable'); }
  }
  store(text, state) {
    this.docs.write('state', text);
    this.cache = state;
  }

  /** GET /api/data: { unreadable } or { state, rev }. */
  read() {
    const S = this.current();
    if (typeof S === 'symbol') return { unreadable: true };
    return { state: forClient(S), rev: S?._rev || 0, wid: S?._wid || null };
  }
  /** The whole stored document (server-side readers: the token routes, the calendar feed). */
  raw() {
    const S = this.current();
    return typeof S === 'symbol' ? { unreadable: true } : { state: S };
  }
  rev() {
    const S = this.current();
    if (typeof S === 'symbol') return { rev: 0 };
    return { rev: S?._rev || 0, ...(S?._wid ? { wid: S._wid } : {}) };
  }

  /** PUT /api/data after checkPutBody (the body is already cleaned). */
  put(body) {
    const cur = this.current();
    if (typeof cur === 'symbol') return { status: 503, body: { error: 'state unreadable' } };
    if (putConflicts(body, cur)) return { status: 409, body: { error: 'conflict', rev: cur?._rev || 0, state: forClient(cur) } };
    const plan = planCommit(cur, body.state, putOptions(body, cur));
    if (plan.status !== 200) return plan;
    this.store(plan.text, plan.state);
    return { status: 200, body: plan.body };
  }

  /**
   * PUT /api/token/data (server.js), from the stored document on. `commit` false only says whether
   * a write would happen, so the caller can spend the token's write budget first, as server.js does.
   */
  tokenPut(body, scopes, commit) {
    const cur = this.current();
    if (typeof cur === 'symbol') return { status: 503, body: { error: 'state unreadable' } };
    if (!cur) return { status: 409, body: { error: 'this profile has not synced from a device yet', code: 'not-synced' } };
    const curRev = cur._rev || 0;
    if (body.baseRev !== curRev || (typeof body.baseWid === 'string' && cur._wid && body.baseWid !== cur._wid)) {
      return { status: 409, body: { error: 'conflict', rev: curRev, state: scopedState(cur, scopes), ...(cur._wid ? { wid: cur._wid } : {}) } };
    }
    let merged;
    try { merged = mergeScoped(cur, structuredClone(body.state), scopes); }
    catch (e) {
      if (e instanceof ScopeError) return { status: e.status, body: { error: e.message, code: e.code }, denied: true };
      throw e;
    }
    if (!merged.touched.length) return { status: 200, body: { ok: true, unchanged: true, rev: curRev, ...(cur._wid ? { wid: cur._wid } : {}) } };
    const next = merged.next;
    const list = v => v == null || Array.isArray(v);
    if (!list(next.workouts) || !list(next.routines)) return { status: 400, body: { error: 'invalid state' } };
    for (const k of ['workouts', 'routines']) if (Array.isArray(next[k])) next[k] = records(next[k]);
    if (!commit) return { status: 200, writes: true };
    const plan = planCommit(cur, next, { overRead: true, stamped: false });
    if (plan.status !== 200) return plan;
    this.store(plan.text, plan.state);
    return { status: 200, body: plan.body, touched: merged.touched };
  }

  /** Account deletion. */
  remove() {
    this.docs.remove('state');
    this.cache = null;
    return true;
  }

  /** Bytes the document takes (admin views on Node; here only for limits and tests). */
  bytes() { return this.docs.size('state'); }
}
