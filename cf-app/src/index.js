// The Worker in front of everything (what nginx does in the Docker setup, web/nginx.conf.template):
//   /api/*, /.well-known/*   the API, in the instance's DirectoryDO (directory.js)
//   /mcp                     the remote MCP server (mcp.js), which reads and writes through the API
//   /exercise-media/*        the licensed exercise stills and clips, from R2, signed-in only
//   anything else            the built app (static assets, served without running this code)
import { handleMcp } from './mcp.js';

export { DirectoryDO } from './directory.js';
export { ProfileDO } from './profile.js';

export const directoryOf = env => env.DIRECTORY.get(env.DIRECTORY.idFromName('instance'));

// Headers nginx adds to every answer (web/nginx.conf.template, server block).
const SECURITY = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};
function withSecurity(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

const WELL_KNOWN = /^\/\.well-known\/(oauth-authorization-server|oauth-protected-resource|openid-configuration)(\/.*)?$/;
const MEDIA_PATH = /^\/exercise-media\/((?:still|clip)\/[A-Za-z0-9._-]+\.(?:webp|mp4)|NOTICE\.md)$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p.startsWith('/api/') || WELL_KNOWN.test(p)) return withSecurity(await directoryOf(env).fetch(request));
    if (p === '/mcp' || p.startsWith('/mcp/')) return withSecurity(await handleMcp(request, env, ctx, { directory: directoryOf(env) }));
    if (p.startsWith('/exercise-media/')) return withSecurity(await exerciseMedia(request, env, url));
    return env.ASSETS.fetch(request);
  },
};

/* The catalogue's 180 px media are licensed (NOTICE.md): no CDN, no public URL. They are kept
   in a private R2 bucket and handed out by this Worker only to a request that carries a session,
   same-origin, cached by that browser alone (private), never by Cloudflare's edge. */
async function exerciseMedia(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const m = MEDIA_PATH.exec(url.pathname);
  if (!m) return new Response('not found', { status: 404 });
  if (!env.EXERCISE_MEDIA) return new Response('not found', { status: 404 });
  if (!(await directoryOf(env).signedIn([...request.headers]))) {
    return new Response('sign in to see the exercise media', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const range = request.headers.get('range');
  const obj = await env.EXERCISE_MEDIA.get(m[1], range ? { range: request.headers } : {});
  if (!obj) return new Response('not found', { status: 404 });
  const headers = new Headers({
    'Content-Type': m[1].endsWith('.mp4') ? 'video/mp4' : m[1].endsWith('.webp') ? 'image/webp' : 'text/markdown; charset=utf-8',
    'Cache-Control': 'private, max-age=2592000, immutable',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Accept-Ranges': 'bytes',
    'ETag': obj.httpEtag,
  });
  let status = 200;
  if (range && obj.range) {
    const r = obj.range;
    const offset = 'suffix' in r ? obj.size - r.suffix : (r.offset || 0);
    const length = 'suffix' in r ? r.suffix : (r.length ?? obj.size - offset);
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('Content-Length', String(length));
    status = 206;
  } else headers.set('Content-Length', String(obj.size));
  return new Response(request.method === 'HEAD' ? null : obj.body, { status, headers });
}
