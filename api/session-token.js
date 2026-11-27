// The signed session token (cookie or Bearer): `uid:expMs:sv:kind[:atBase36].mac`, the mac an
// HMAC-SHA256 of the rest with the instance secret. Stateless: a token is checked against the
// account's session version (`sv`), which "sign out everywhere" bumps. Shared by server.js and
// the Cloudflare port (cf-app/), so a cookie minted by one is read the same way by the other.
import crypto from 'node:crypto';

export function createSessionCodec(secret, { days = 90, now = Date.now } = {}) {
  const sign = payload => payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  function verifySig(token) {
    const i = token.lastIndexOf('.');
    if (i < 0) return null;
    const payload = token.slice(0, i), mac = token.slice(i + 1);
    const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    try {
      if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
    } catch { return null; }
    return payload;
  }
  const sessionVersion = user => user.sv || 0;
  function makeSession(user, kind = 'b', at = null) {
    const exp = now() + days * 86400000;
    return sign(user.id + ':' + exp + ':' + sessionVersion(user) + ':' + kind + (at ? ':' + Math.floor(at).toString(36) : ''));
  }
  /** The token's claims when the signature holds and it has not expired, else null. The account
   *  checks (exists, not disabled, same session version) are the caller's: they need its users. */
  function readToken(tok) {
    if (!tok) return null;
    const payload = verifySig(tok);
    if (!payload) return null;
    const [uid, exp, ver, kind, at] = payload.split(':');
    if (!uid || +exp < now()) return null;
    const claimed = ver === undefined ? 0 : Number(ver);
    return { uid, exp: +exp, ver: claimed, kind: kind || null, at: at ? parseInt(at, 36) || null : null };
  }
  /** readToken plus the account checks, against `userById`. */
  function sessionUser(tok, userById) {
    const t = readToken(tok);
    if (!t) return null;
    const user = userById(t.uid) || null;
    if (!user) return null;
    if (user.disabled) return null;           // disabled accounts are locked out everywhere
    if (!Number.isInteger(t.ver) || t.ver !== sessionVersion(user)) return null;
    return { user, exp: t.exp, kind: t.kind, at: t.at };
  }
  return { sign, verifySig, sessionVersion, makeSession, readToken, sessionUser };
}
