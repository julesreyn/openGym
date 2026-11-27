// What PUT /api/data does to a profile's document before it is written, without the writing.
// server.js (one file per profile) and the Cloudflare port (one Durable Object per profile,
// cf-app/) both call it, so the revision, write-id and stamp rules stay one piece of code.
import crypto from 'node:crypto';
import { stampPut } from './sync-stamps.js';

// How many earlier write ids a document keeps (`_wids`, see PUT /api/data): a device that last
// synced more writes ago than this merges on its next pull instead of taking the server's copy.
export const WID_KEEP = 50;

export const newWid = () => crypto.randomBytes(8).toString('hex');

/**
 * Prepares `state` (what a device sent) to replace `cur` (what is stored, or null).
 * Mutates `state`. Returns { status: 400, body } for a document that cannot be stored, or
 * { status: 200, body, text, state } where `text` is what to write.
 */
export function planCommit(cur, state, { overRead = false, stamped = false, wid = newWid } = {}) {
  const curRev = cur?._rev || 0;
  delete state.active;              // in-progress workouts stay device-local
  // A reset moves forward only: a device that missed it must not bring the old history back.
  const storedReset = Number(cur?.resetAt) || 0;
  if (storedReset > (Number(state.resetAt) || 0)) {
    state.resetAt = cur.resetAt;
    if (cur.resetIds && typeof cur.resetIds === 'object') state.resetIds = cur.resetIds;
    else delete state.resetIds;
  }
  const report = {};
  try { stampPut(cur, state, { overRead, stamped, report }); }
  catch (e) { if (e instanceof RangeError) return { status: 400, body: { error: 'invalid state' } }; throw e; }
  state._rev = curRev + 1;          // server-owned; whatever the client sent is ignored
  if (report.changed) state._rev = curRev + 2;
  state._wids = [...(Array.isArray(cur?._wids) ? cur._wids : []), ...(cur?._wid ? [cur._wid] : [])]
    .filter(x => typeof x === 'string').slice(-WID_KEEP);
  state._wid = wid();
  let text;
  try { text = JSON.stringify(state); }
  catch (e) { if (e instanceof RangeError) return { status: 400, body: { error: 'invalid state' } }; throw e; }
  return { status: 200, body: { ok: true, ts: state._ts || null, rev: curRev + 1, wid: state._wid }, text, state };
}

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * The checks PUT /api/data makes on a request body before it reads the stored document.
 * Returns null when the body may go on (dropping entries of workouts and routines that are not
 * objects, in place), or { status: 400, body } to answer with.
 */
export function checkPutBody(body) {
  if (!body.state || typeof body.state !== 'object') return { status: 400, body: { error: 'state required' } };
  // An object with nothing of the profile in it would empty the document with the counter left
  // intact. `_rev` and `_ts` are bookkeeping, so `{}` and `{"_rev":5}` get the same refusal.
  if (!Array.isArray(body.state) && !Object.keys(body.state).some(k => k !== '_rev' && k !== '_ts')) {
    return { status: 400, body: { error: 'state required' } };
  }
  // The reminder tick and the admin routes iterate these two, so a truthy non-array is refused.
  const list = v => v == null || Array.isArray(v);
  if (Array.isArray(body.state) || !list(body.state.workouts) || !list(body.state.routines)) return { status: 400, body: { error: 'invalid state' } };
  // Entries that are not objects carry nothing worth keeping: dropped, not refused.
  for (const k of ['workouts', 'routines']) if (Array.isArray(body.state[k])) body.state[k] = body.state[k].filter(record);
  return null;
}

/** Whether a conditional write was made over another document than the stored one (409). */
export function putConflicts(body, cur) {
  const curRev = cur?._rev || 0;
  return (body.baseRev != null && body.baseRev !== curRev) ||
    (body.baseRev != null && typeof body.baseWid === 'string' && !!cur?._wid && body.baseWid !== cur._wid);
}

/** planCommit's options for a PUT body that passed putConflicts. */
export const putOptions = (body, cur) => ({
  overRead: body.baseRev != null && body.baseRev === (cur?._rev || 0),
  stamped: body.stamped === true,
});
