/* Photos, GIFs, videos and sounds of a person's own: the media routes of api/server.js over R2.
 *
 * The rules (types, magic bytes, caps, quota, the hash check, what a state references) are
 * api/media.js's, imported rather than copied; only the storage is different:
 *
 *   R2 (env.UPLOADS)  uploads/<uid>/<sha256>.<ext>
 *
 * What differs from the Node store, and why:
 * - No per-profile in-memory index and no .gc.json: every upload, lookup and sweep lists the
 *   profile's prefix (a profile holds hundreds of files at most, one or two list pages).
 * - The bytes go straight to their final key, never through a temp object (R2 has no rename).
 *   They are sniffed from the first bytes *before* the put (the key needs the extension), and
 *   the put carries the URL's sha256, so R2 itself refuses bytes that do not match their name:
 *   a mismatching upload never lands. The digest is still computed on the way (DigestStream)
 *   to tell that refusal from any other R2 error.
 * - The refusals Node decides after the whole body arrived (wrong type, over the sniffed kind's
 *   cap) are decided here before the put, but the rest of the body is still read and hashed
 *   first, so the answer for a file that is wrong in several ways is the one Node gives
 *   (too large over the declared cap, then hash-mismatch, then the type and size).
 * - No Content-Length: R2 needs the length of a streamed body up front. Node streams such an
 *   upload against the declared kind's cap. Here it is buffered up to that cap when the cap is
 *   at most BUFFER_MAX (photos, GIFs, sounds); a video upload without a length is refused with
 *   411 { code: 'length-required' } — browsers and the app always send one for a Blob body.
 * - The video length limit IS enforced: the top-level MP4/MOV boxes are walked as the bytes
 *   stream past and the moov (at most 8 MB, as in mp4Info) is kept in memory and parsed for
 *   mvhd / mvex.mehd after the put. A refused video is deleted again.
 * - The 14-day GC of other profiles' unreferenced files (sweepAll, the grace marks, noteState)
 *   is not done here: only POST /api/media/sweep (grace 0, the caller's own files) and
 *   removeUser() delete. Under quota pressure Node first drops files unreferenced for an hour;
 *   without marks this uses the object's upload time instead (unreferenced in a readable state
 *   and uploaded more than an hour ago).
 * - No free-disk floor (MEDIA_MIN_FREE_MB): R2 has none to protect.
 * - Nothing to drain: a refused request's unread body is cancelled, not read to the end.
 */
import { MediaError, HASH_RE, MEDIA_TYPES, MAX_INFLIGHT, sniffMedia, referencedHashes, mediaLimits } from '../../api/media.js';
import { createWindow } from '../../api/rate-limit.js';

export { MediaError } from '../../api/media.js';

const MB = 1024 * 1024;
const HOUR = 3600000;
const HEAD_BYTES = 64;
const MOOV_MAX = 8 * MB;
const MAX_BOXES = 10000;
const BUFFER_MAX = 16 * MB;        // the most an upload without Content-Length is held in memory
const EXT_MIME = Object.fromEntries(Object.entries(MEDIA_TYPES).map(([mime, t]) => [t.ext, mime]));
const FILE_RE = new RegExp(`^([0-9a-f]{64})\\.(${Object.keys(EXT_MIME).join('|')})$`);
const round1 = n => Math.round(n * 10) / 10;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

const ACCOUNT_HEADER = 'x-opengym-account';
const wrongAccount = (req, user) => {
  const want = req.headers[ACCOUNT_HEADER];
  return typeof want === 'string' && want !== '' && want !== String(user.id);
};
const ACCOUNT_MISMATCH = { error: 'signed in as another account now', code: 'account-mismatch' };

// The same sanitising as media.js safe(): an id that sanitises to nothing would name uploads/
// itself, and removeUser() would then delete everybody's files.
function safe(uid) {
  const s = String(uid ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!s) throw new Error('media: a profile id is required');
  return s;
}
const contentType = req => String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
function contentLength(req) {
  const raw = req.headers?.['content-length'];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function discard(req) {
  try { req.raw?.body?.cancel().catch(() => {}); } catch { /* already read or locked */ }
}

/* ---------------------------------------------------------------- MP4 / MOV, streamed */

const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
function u64(b, o) {
  const v = (BigInt(u32(b, o)) << 32n) + BigInt(u32(b, o + 4));
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
}
const unknownDur = (d, version) => d === 0 || d === (version === 1 ? Number.MAX_SAFE_INTEGER : 0xffffffff);
const latin1 = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

// The box whose header starts at b[pos], inside [pos, end) of an in-memory buffer.
function boxIn(b, pos, end) {
  if (end - pos < 8) return null;
  let size = u32(b, pos), headerLen = 8;
  if (size === 1) {
    if (end - pos < 16) return null;
    size = u64(b, pos + 8);
    if (size === Number.MAX_SAFE_INTEGER) return null;
    headerLen = 16;
  } else if (size === 0) size = end - pos;
  if (size < headerLen || pos + size > end) return null;
  return { type: latin1(b, pos + 4, 4), body: pos + headerLen, bodyLen: size - headerLen, end: pos + size };
}

/** mp4Info (api/media.js) for bytes that stream past once: walks the top-level boxes as they
 *  arrive and keeps the moov. Same refusals: no ftyp first, no moov, a box overrunning the file,
 *  more than 10k boxes, a moov over 8 MB, no mvhd, a zero timescale. */
function mp4Walker(total) {
  let pos = 0, boxStart = 0, boxEnd = 0, count = 0, phase = 'hdr';
  let hdr = new Uint8Array(16), hdrLen = 0, hdrNeed = 8;
  let moov = null, moovFill = 0;
  function startBox() {
    boxStart = pos; hdrLen = 0; hdrNeed = 8;
    phase = pos >= total ? 'end' : total - pos < 8 ? 'bad' : 'hdr';
  }
  function parseHeader() {
    let size = u32(hdr, 0), headerLen = 8;
    if (size === 1) {
      if (hdrLen < 16) { if (total - boxStart < 16) return (phase = 'bad'); hdrNeed = 16; return; }
      size = u64(hdr, 8);
      if (size === Number.MAX_SAFE_INTEGER) return (phase = 'bad');
      headerLen = 16;
    } else if (size === 0) size = total - boxStart;
    if (size < headerLen || boxStart + size > total) return (phase = 'bad');
    if (++count > MAX_BOXES) return (phase = 'bad');
    const type = latin1(hdr, 4, 4), bodyLen = size - headerLen;
    if (count === 1 && (type !== 'ftyp' || bodyLen < 4)) return (phase = 'bad');
    boxEnd = boxStart + size;
    if (type === 'moov') {
      if (bodyLen + 8 > MOOV_MAX) return (phase = 'bad');
      moov = new Uint8Array(bodyLen); moovFill = 0;
      phase = bodyLen ? 'moov' : 'done';
    } else {
      phase = 'skip';
      if (pos === boxEnd) startBox();
    }
  }
  return {
    feed(chunk) {
      let i = 0;
      while (i < chunk.length && (phase === 'hdr' || phase === 'skip' || phase === 'moov')) {
        if (phase === 'hdr') {
          const n = Math.min(hdrNeed - hdrLen, chunk.length - i);
          hdr.set(chunk.subarray(i, i + n), hdrLen);
          hdrLen += n; i += n; pos += n;
          if (hdrLen === hdrNeed) parseHeader();
        } else if (phase === 'skip') {
          const n = Math.min(boxEnd - pos, chunk.length - i);
          i += n; pos += n;
          if (pos === boxEnd) startBox();
        } else {
          const n = Math.min(moov.length - moovFill, chunk.length - i);
          moov.set(chunk.subarray(i, i + n), moovFill);
          moovFill += n; i += n; pos += n;
          if (moovFill === moov.length) phase = 'done';
        }
      }
      if (phase === 'end' || phase === 'bad') return;
      pos += chunk.length - i;
    },
    /** { durationSec } (null when the file does not say), or null for a broken file. */
    result() {
      if (phase !== 'done') return null;
      const b = moov;
      let timescale = 0, dur = null, fragDur = null, sawMvhd = false, p = 0;
      while (p < b.length) {
        if (++count > MAX_BOXES) return null;
        const x = boxIn(b, p, b.length);
        if (!x) return null;
        if (x.type === 'mvhd' && !sawMvhd) {
          sawMvhd = true;
          const v = b.subarray(x.body, x.body + Math.min(x.bodyLen, 32));
          if (v.length < 20) return null;
          if (v[0] === 1) {
            if (v.length < 32) return null;
            timescale = u32(v, 20); dur = u64(v, 24);
            if (unknownDur(dur, 1)) dur = null;
          } else {
            timescale = u32(v, 12); dur = u32(v, 16);
            if (unknownDur(dur, 0)) dur = null;
          }
        } else if (x.type === 'mvex') {
          let q = x.body;
          while (q < x.end) {
            if (++count > MAX_BOXES) return null;
            const c = boxIn(b, q, x.end);
            if (!c) return null;
            if (c.type === 'mehd') {
              const v = b.subarray(c.body, c.body + Math.min(c.bodyLen, 12));
              if (v.length >= 8) {
                const wide = v[0] === 1 && v.length >= 12;
                const d = wide ? u64(v, 4) : u32(v, 4);
                if (!unknownDur(d, wide ? 1 : 0)) fragDur = d;
              }
            }
            q = c.end;
          }
        }
        p = x.end;
      }
      if (!sawMvhd || !timescale) return null;
      const ticks = dur ?? fragDur;
      return { durationSec: ticks == null ? null : Math.round((ticks / timescale) * 1000) / 1000 };
    }
  };
}

/* ---------------------------------------------------------------- the routes */

export function createMediaRoutes({ bucket, limits, readSession, audit, json, readBody, profile, now = Date.now }) {
  const L = { ...mediaLimits({}), ...(limits || {}) };
  const quotaBytes = L.quotaMB > 0 ? Math.round(L.quotaMB * MB) : 0;
  const capMB = kind => (kind === 'video' ? L.videoMB : kind === 'gif' ? L.gifMB : kind === 'audio' ? L.audioMB : L.imageMB);
  const capOf = kind => Math.round(capMB(kind) * MB);
  const inflight = new Map();      // safe uid -> { n, reserved }, uploads of this instance

  // The hourly budgets of server.js, per profile (in memory: lost when the object is evicted).
  const MEDIA_BURST = createWindow({ max: L.uploadsPerHour, windowMs: HOUR, now });
  const MEDIA_SWEEPS = createWindow({ max: 10, windowMs: HOUR, now });
  const throttleNoted = new Map();
  let lastSweep = now();
  function mediaThrottle(req, user, win) {
    if (now() - lastSweep > 600000) {
      lastSweep = now();
      MEDIA_BURST.sweep(); MEDIA_SWEEPS.sweep();
      for (const [k, until] of throttleNoted) if (until < now()) throttleNoted.delete(k);
    }
    const wait = win.take(user.id);
    if (!wait) return;
    if ((throttleNoted.get(user.id) || 0) < now()) {
      throttleNoted.set(user.id, now() + wait * 1000);
      audit(req, 'media.throttled', { ok: false, user, msg: win === MEDIA_SWEEPS ? 'sweep' : 'upload' });
    }
    throw new MediaError(429, 'locked', { retryAfter: wait }, { 'Retry-After': String(wait) });
  }

  const prefixOf = uid => `uploads/${safe(uid)}/`;
  async function listAll(prefix) {
    const out = [];
    let cursor;
    do {
      const page = await bucket.list({ prefix, cursor });
      out.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  }
  // hash -> { key, ext, size, uploaded } of the profile's whole files. An empty object is what a
  // failed write could leave: not a file this profile has (media.js entry()).
  async function filesOf(uid, prefix = prefixOf(uid)) {
    const files = new Map();
    for (const o of await listAll(prefix)) {
      const m = FILE_RE.exec(o.key.slice(prefixOf(uid).length));
      if (!m || !o.size || files.has(m[1])) continue;
      files.set(m[1], { key: o.key, ext: m[2], size: o.size, uploaded: +new Date(o.uploaded || 0) });
    }
    return files;
  }
  const usageOf = files => {
    let bytes = 0;
    for (const f of files.values()) bytes += f.size;
    return { bytes, count: files.size, quotaBytes };
  };
  async function stateOf(uid) {
    try {
      const r = await profile(uid).raw();
      const S = r && !r.unreadable ? r.state : null;
      return S && typeof S === 'object' && !Array.isArray(S) ? S : null;
    } catch { return null; }
  }
  async function deleteKeys(keys) {
    for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
  }

  // Unreferenced files go: all of them for graceMs 0, else those uploaded more than graceMs ago.
  async function sweep(uid, { graceMs = 0, files } = {}) {
    files = files || await filesOf(uid);
    const res = { removed: 0, freedBytes: 0, skipped: false };
    if (!files.size) return res;
    const S = await stateOf(uid);
    if (!S) { res.skipped = true; return res; }   // never infer anything from a missing state
    const refs = referencedHashes(S);
    const t = now(), gone = [];
    for (const [h, f] of files) {
      if (refs.has(h)) continue;
      if (graceMs > 0 && !(t - f.uploaded >= graceMs)) continue;
      gone.push(h);
    }
    if (!gone.length) return res;
    await deleteKeys(gone.map(h => files.get(h).key));
    for (const h of gone) { res.removed++; res.freedBytes += files.get(h).size; files.delete(h); }
    return res;
  }

  /** Reads the rest of a body that is refused after it started, through the hash, so the answer
   *  is the one Node gives once the whole file is in: over the declared cap, then hash-mismatch,
   *  then `pending`. */
  async function refuseAfterBody(chunks, reader, hash, cap, maxMB, pending) {
    const ds = new crypto.DigestStream('SHA-256');
    const w = ds.getWriter();
    let size = 0;
    const take = async c => {
      size += c.length;
      if (size > cap) { try { reader?.cancel(); } catch { /* gone */ } throw new MediaError(413, 'media-too-large', { maxMB }); }
      await w.write(c);
    };
    for (const c of chunks) await take(c);
    if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; await take(value); }
    await w.close();
    if (hex(await ds.digest) !== hash) throw new MediaError(400, 'hash-mismatch');
    throw pending;
  }

  async function receive(uid, hash, req) {
    if (!HASH_RE.test(String(hash))) { discard(req); throw new MediaError(400, 'bad-request'); }
    const id = safe(uid);
    const slot = inflight.get(id) || { n: 0, reserved: 0 };
    if (slot.n >= MAX_INFLIGHT) { discard(req); throw new MediaError(429, 'busy', { retryAfter: 5 }, { 'Retry-After': '5' }); }
    slot.n++; inflight.set(id, slot);
    let reserved = 0;
    try {
      const declared = MEDIA_TYPES[contentType(req)];
      if (!declared) { discard(req); throw new MediaError(415, 'media-type'); }
      const cap = capOf(declared.kind), maxMB = capMB(declared.kind);
      let len = contentLength(req);
      if (len != null && len > cap) { discard(req); throw new MediaError(413, 'media-too-large', { maxMB }); }

      const files = await filesOf(uid);
      // A file this profile already has is taken as it is, unless an upload of a different size
      // says it is not whole; then these bytes replace it.
      const have = files.get(hash);
      if (have && (len == null || len === have.size)) {
        discard(req);
        return { status: 200, body: { ok: true, hash, mime: EXT_MIME[have.ext], size: have.size, existed: true } };
      }

      const need = len ?? cap;
      // As in media.js, a damaged copy being replaced still counts until it is replaced.
      const used = () => usageOf(files).bytes;
      if (quotaBytes && used() + slot.reserved + need > quotaBytes) {
        try { await sweep(uid, { graceMs: HOUR, files }); } catch (err) { console.error('media: quota sweep failed for', id, err.message); }
        if (used() + slot.reserved + need > quotaBytes) {
          discard(req);
          throw new MediaError(413, 'media-quota', { usedMB: round1(usageOf(files).bytes / MB), quotaMB: L.quotaMB });
        }
      }
      slot.reserved += need; reserved = need;

      const body = req.raw?.body;
      let reader = body ? body.getReader() : null;
      const chunks = [];
      let headLen = 0;
      if (len == null) {
        // R2 needs the length of a streamed body before the first byte: buffered, up to the cap.
        if (cap > BUFFER_MAX) { discard(req); throw new MediaError(411, 'length-required'); }
        let size = 0;
        if (reader) for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > cap) { try { reader.cancel(); } catch { /* gone */ } throw new MediaError(413, 'media-too-large', { maxMB }); }
          chunks.push(value);
        }
        reader = null;
        len = size;
        headLen = size;
      } else if (reader) {
        // The first bytes decide the extension, and so the key, before the put starts.
        while (headLen < HEAD_BYTES) {
          const { done, value } = await reader.read();
          if (done) { reader = null; break; }
          chunks.push(value);
          headLen += value.length;
        }
      }
      const headBuf = new Uint8Array(Math.min(headLen, HEAD_BYTES));
      { let o = 0; for (const c of chunks) { if (o >= headBuf.length) break; const n = Math.min(c.length, headBuf.length - o); headBuf.set(c.subarray(0, n), o); o += n; } }

      const sn = sniffMedia(headBuf);
      if (!sn || sn.category !== declared.category) return await refuseAfterBody(chunks, reader, hash, cap, maxMB, new MediaError(415, 'media-type'));
      if (len > capOf(sn.kind)) return await refuseAfterBody(chunks, reader, hash, cap, maxMB, new MediaError(413, 'media-too-large', { maxMB: capMB(sn.kind) }));

      const walker = sn.ext === 'mp4' || sn.ext === 'mov' ? mp4Walker(len) : null;
      const ds = new crypto.DigestStream('SHA-256');
      const dw = ds.getWriter();
      let size = 0, streamErr = null, hashed = false;
      const queued = chunks.slice();
      // `ds.digest` only settles once the writer is closed: closed exactly once, by whoever is first.
      const finishDigest = async () => { if (hashed) return; hashed = true; await dw.close(); };
      const src = new ReadableStream({
        async pull(ctrl) {
          try {
            let value;
            if (queued.length) value = queued.shift();
            else if (reader) { const r = await reader.read(); if (r.done) reader = null; else value = r.value; }
            if (value === undefined) { await finishDigest(); return ctrl.close(); }
            size += value.length;
            if (size > len) throw new MediaError(413, 'media-too-large', { maxMB });
            walker?.feed(value);
            await dw.write(value);
            ctrl.enqueue(value);
          } catch (e) {
            streamErr = e instanceof MediaError ? e : new MediaError(400, 'bad-request');
            ctrl.error(streamErr);
          }
        },
        cancel() { try { reader?.cancel(); } catch { /* gone */ } }
      });
      const key = `${prefixOf(uid)}${hash}.${sn.ext}`;
      try {
        await bucket.put(key, src.pipeThrough(new FixedLengthStream(len)), {
          httpMetadata: { contentType: sn.mime },
          sha256: hash          // R2 refuses the put when the bytes are not what their name says
        });
      } catch (err) {
        if (streamErr) throw streamErr;
        // Fewer bytes than declared end in the length check; a digest that does not match is
        // the refusal the sha256 option asked for.
        if (size !== len) throw new MediaError(400, 'bad-request');
        let sha = null;
        try { await finishDigest(); sha = hex(await ds.digest); } catch { /* the digest never finished */ }
        if (sha !== hash) throw new MediaError(400, 'hash-mismatch');
        throw err;
      }
      await finishDigest();
      const sha = hex(await ds.digest);
      if (size !== len || sha !== hash) { await bucket.delete(key); throw new MediaError(400, 'hash-mismatch'); }
      if (walker) {
        const info = walker.result();
        if (!info) { await bucket.delete(key); throw new MediaError(415, 'media-invalid'); }
        // One second of slack: the client measures with the platform's player, which rounds.
        if (info.durationSec != null && info.durationSec > L.videoSec + 1) {
          await bucket.delete(key);
          throw new MediaError(413, 'media-too-long', { maxSec: L.videoSec });
        }
      }
      // A damaged copy under another extension goes; the same key was just overwritten.
      if (have && have.key !== key) { try { await bucket.delete(have.key); } catch { /* left for the sweep */ } }
      return { status: 201, body: { ok: true, hash, mime: sn.mime, size: len, existed: false } };
    } finally {
      slot.reserved -= reserved;
      slot.n--;
      if (!slot.n) inflight.delete(id);
    }
  }

  const routes = {
    'PUT /api/media/{hash}': async (req, res) => {
      const user = readSession(req);
      if (!user) { discard(req); return json(res, 401, { error: 'not signed in' }); }
      if (wrongAccount(req, user)) { discard(req); return json(res, 409, ACCOUNT_MISMATCH); }
      try { mediaThrottle(req, user, MEDIA_BURST); } catch (e) { discard(req); throw e; }
      const r = await receive(user.id, req.mediaHash, req);
      json(res, r.status, r.body);
    },
    'GET /api/media/{hash}': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const hash = req.mediaHash;
      if (!HASH_RE.test(String(hash))) throw new MediaError(404, 'media-missing');
      // Only ever the caller's own prefix: another profile's file is exactly as missing as one
      // that was never uploaded.
      const f = (await filesOf(user.id, `${prefixOf(user.id)}${hash}.`)).get(hash);
      if (!f) throw new MediaError(404, 'media-missing');
      const obj = await bucket.get(f.key);
      if (!obj || !obj.size) throw new MediaError(404, 'media-missing');   // swept in between
      res.writeHead(200, {
        'Content-Type': EXT_MIME[f.ext],
        'Content-Length': String(obj.size),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Disposition': `inline; filename="${hash}.${f.ext}"`,
        'X-Robots-Tag': 'noindex',
        'Access-Control-Expose-Headers': 'Content-Length'
      });
      res.stream(obj.body);
    },
    'POST /api/media/missing': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const body = await readBody(req);
      if (wrongAccount(req, user)) return json(res, 409, ACCOUNT_MISMATCH);
      const hashes = body.hashes;
      if (!Array.isArray(hashes) || hashes.length > 1000 || !hashes.every(h => typeof h === 'string' && HASH_RE.test(h))) {
        throw new MediaError(400, 'bad-request', { error: 'hashes must be a list of at most 1000 lowercase sha256 hex strings' });
      }
      const files = await filesOf(user.id);
      json(res, 200, { missing: [...new Set(hashes)].filter(h => !files.has(h)), usage: usageOf(files) });
    },
    'POST /api/media/sweep': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      await readBody(req);
      mediaThrottle(req, user, MEDIA_SWEEPS);
      const files = await filesOf(user.id);
      const r = await sweep(user.id, { graceMs: 0, files });
      audit(req, 'media.sweep', { user, msg: `${r.removed} file(s), ${(r.freedBytes / 1048576).toFixed(1)} MB${r.skipped ? ', state unreadable' : ''}` });
      json(res, 200, { removed: r.removed, freedBytes: r.freedBytes, usage: usageOf(files) });
    }
  };

  return {
    routes,
    limits: L,
    receive,
    sweep,
    usage: async uid => usageOf(await filesOf(uid)),
    /** Account deletion: every object under the profile's prefix. */
    async removeUser(uid) {
      const objs = await listAll(prefixOf(uid));
      await deleteKeys(objs.map(o => o.key));
      inflight.delete(safe(uid));
    }
  };
}
