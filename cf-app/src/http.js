// The small piece of node:http that the ported route handlers expect, over fetch's Request and
// Response. Handlers keep the shape they have in api/server.js — `async (req, res) => json(res, …)`
// — so a route can be compared with its original line by line.

export const MAX_BODY = 5 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** A node-like request: method, url (path + query), lowercased headers, the client address. */
export function nodeReq(request, extra = {}) {
  const u = new URL(request.url);
  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
  return {
    method: request.method,
    url: u.pathname + u.search,
    headers,
    raw: request,
    ip: request.headers.get('cf-connecting-ip') || '',
    ...extra,
  };
}

/** Collects what a handler writes and turns it into a Response. */
export function nodeRes() {
  const headers = new Headers();
  let status = 200, body = null, sent = false;
  const res = {
    get headersSent() { return sent; },
    get statusCode() { return status; },
    setHeader(k, v) { setH(headers, k, v); },
    getHeader(k) { return headers.get(k); },
    writeHead(code, h = {}) { status = code; for (const [k, v] of Object.entries(h)) setH(headers, k, v); sent = true; return res; },
    end(b = null) { sent = true; if (b != null) body = b; },
    /** A ReadableStream or bytes for media answers. */
    stream(b) { sent = true; body = b; },
    toResponse() {
      const nobody = status === 204 || status === 304;
      return new Response(nobody ? null : body, { status, headers });
    },
  };
  return res;
}
function setH(headers, k, v) {
  if (Array.isArray(v)) { headers.delete(k); for (const x of v) headers.append(k, String(x)); }
  else headers.set(k, String(v));
}

export function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}

/** Same answers as api/server.js readBody: {} for an empty body, 415, 413, 400 'invalid json'. */
/**
 * A body read up to `max` bytes: the stream is cancelled as soon as more arrive, so an oversized
 * body (with or without a Content-Length) is never held in memory. → Uint8Array, or null when
 * it is over `max`.
 */
export async function readCapped(body, max) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.byteLength; }
  return out;
}

export async function readBody(req, max = MAX_BODY) {
  const len = +(req.headers['content-length'] || 0);
  if (len > max) throw new HttpError(413, 'body too large');
  const buf = await readCapped(req.raw.body, max);
  if (!buf) throw new HttpError(413, 'body too large');
  if (!buf.length) return {};
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'content-type must be application/json');
  }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(buf)); }
  catch { throw new HttpError(400, 'invalid json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid json');
  return body;
}

/** application/x-www-form-urlencoded or JSON, as the OAuth token endpoint takes (server.js readForm). */
export async function readForm(req, max = 64 * 1024) {
  if (+(req.headers['content-length'] || 0) > max) throw new HttpError(413, 'body too large');
  const buf = await readCapped(req.raw.body, max);
  if (!buf) throw new HttpError(413, 'body too large');
  const t = new TextDecoder().decode(buf);
  const ct = req.headers['content-type'] || '';
  if (/^application\/json/i.test(ct)) {
    try { const v = JSON.parse(t || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    catch { throw new HttpError(400, 'invalid json'); }
  }
  return Object.fromEntries(new URLSearchParams(t));
}

export const text = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
