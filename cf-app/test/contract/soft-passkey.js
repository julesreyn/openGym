// A software passkey on WebCrypto, so the same code runs in Node (the real server.js) and in the
// Workers runtime: what navigator.credentials.create() and .get() hand back for a P-256 key,
// serialised as the app sends them. Same bytes as api/test/soft-passkey.mjs, async.
const enc = new TextEncoder();
const b64u = bytes => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
const sha = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const cborHead = (major, n) => n < 24 ? Uint8Array.of((major << 5) | n)
  : n < 256 ? Uint8Array.of((major << 5) | 24, n) : Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
const cborText = s => cat(cborHead(3, enc.encode(s).length), enc.encode(s));
const cborBytes = b => cat(cborHead(2, b.length), b);

// WebCrypto signs ECDSA as r||s; WebAuthn wants ASN.1 DER.
function derSignature(raw) {
  const int = b => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = cat(Uint8Array.of(0), v);
    return cat(Uint8Array.of(0x02, v.length), v);
  };
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32));
  return cat(Uint8Array.of(0x30, r.length + s.length), r, s);
}

export async function softPasskey({ origin, rpId = new URL(origin).hostname } = {}) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const cose = cat(
    Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20), fromB64u(jwk.x),
    Uint8Array.of(0x22, 0x58, 0x20), fromB64u(jwk.y)
  );
  const raw = crypto.getRandomValues(new Uint8Array(16));
  const id = b64u(raw);
  const rpHash = await sha(enc.encode(rpId));
  let counter = 0;
  return {
    id,
    async attestation(challenge) {
      const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
      const authData = cat(rpHash, Uint8Array.of(0x45), new Uint8Array(4), new Uint8Array(16), Uint8Array.of(raw.length >> 8, raw.length & 255), raw, cose);
      const attestationObject = cat(
        Uint8Array.of(0xa3), cborText('fmt'), cborText('none'), cborText('attStmt'), Uint8Array.of(0xa0),
        cborText('authData'), cborBytes(authData)
      );
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal', 'hybrid'] }
      };
    },
    async assertion(challenge) {
      const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
      counter++;
      const authData = cat(rpHash, Uint8Array.of(0x05), Uint8Array.of(counter >>> 24, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, cat(authData, await sha(clientDataJSON))));
      return {
        id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(derSignature(sig)), userHandle: null }
      };
    }
  };
}
