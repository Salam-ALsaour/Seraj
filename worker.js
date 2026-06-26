/**
 * seraj-push — Cloudflare Worker for Web Push Notifications
 * Implements RFC 8030 (Web Push), RFC 8292 (VAPID), RFC 8291 (aes128gcm)
 * No npm dependencies — pure Web Crypto API
 *
 * Deploy: paste this file into your Cloudflare Worker (ES module format)
 */

const AUTH_TOKEN = 'seraj_push_token_2026';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }
    if (request.method !== 'POST') {
      return cors(json({ error: 'Method Not Allowed' }, 405));
    }

    let body;
    try { body = await request.json(); }
    catch { return cors(json({ error: 'Invalid JSON body' }, 400)); }

    const { subscriptions, title, body: notifBody, message, vapidKeys, token } = body;

    if (token !== AUTH_TOKEN) return cors(json({ error: 'Unauthorized' }, 401));
    if (!vapidKeys?.publicKey || !vapidKeys?.privateKey) return cors(json({ error: 'VAPID keys missing' }, 400));

    const text    = notifBody || message || '';
    const payload = JSON.stringify({ title, body: text });
    const subs    = Array.isArray(subscriptions) ? subscriptions : [];
    const testMode = !!body.testNoEncrypt; // test: send without payload/encryption

    const results = await Promise.all(
      subs.map(sub =>
        (testMode ? sendWebPushEmpty(sub, vapidKeys) : sendWebPush(sub, payload, vapidKeys))
          .catch(e => ({ status: 0, ok: false, error: e.message }))
      )
    );

    const successes = results.filter(r => r.status >= 200 && r.status < 300).length;
    return cors(json({ success: true, successes, failures: results.length - successes, results, testMode }));
  },
};

// ─── Send empty push (no payload, no encryption) for testing ────────────────

async function sendWebPushEmpty(subscription, vapidKeys) {
  const { endpoint } = subscription;
  const audience = new URL(endpoint).origin;
  const jwt      = await buildVapidJwt(audience, vapidKeys.publicKey, vapidKeys.privateKey);

  console.log('[Push-Test] empty push to:', endpoint.slice(0, 70));
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${vapidKeys.publicKey}`,
      'TTL':           '86400',
      'Urgency':       'high',
      'Content-Length': '0',
    },
  });
  const respBody = await resp.text().catch(() => '');
  console.log('[Push-Test] status:', resp.status, 'body:', respBody.slice(0, 100));
  return { status: resp.status, ok: resp.ok, endpoint, fcmBody: respBody.slice(0, 100) };
}

// ─── VAPID JWT (RFC 8292) ────────────────────────────────────────────────────

async function buildVapidJwt(audience, publicKeyB64url, privateKeyB64url) {
  const now = Math.floor(Date.now() / 1000);

  const headerB64  = b64urlStr(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payloadB64 = b64urlStr(JSON.stringify({ aud: audience, exp: now + 43200, sub: 'mailto:seraj@admin.com' }));
  const sigInput   = `${headerB64}.${payloadB64}`;

  const privBytes = decodeB64url(privateKeyB64url);
  const pubBytes  = decodeB64url(publicKeyB64url);
  if (pubBytes.length < 65) throw new Error('VAPID public key too short');

  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: encodeB64url(privBytes),
    x: encodeB64url(pubBytes.slice(1, 33)),
    y: encodeB64url(pubBytes.slice(33, 65)),
  };
  const signingKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, signingKey, te(sigInput),
  );
  return `${sigInput}.${encodeB64url(sigBuf)}`;
}

// ─── Payload Encryption (RFC 8291 / aes128gcm) — native HKDF ────────────────

async function encryptPayload(plaintext, subscription) {
  const receiverPubBytes = decodeB64url(subscription.keys.p256dh);
  const authSecret       = decodeB64url(subscription.keys.auth);

  // Ephemeral sender ECDH key pair
  const senderPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const senderPubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', senderPair.publicKey));

  // Import receiver public key
  const receiverPub = await crypto.subtle.importKey(
    'raw', receiverPubBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );

  // ECDH shared secret (32 bytes — X coordinate only)
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverPub }, senderPair.privateKey, 256),
  );

  // key_info = "WebPush: info\x00" + receiver_pub + sender_pub (RFC 8291 §2.3)
  const keyInfo = cat(te('WebPush: info\x00'), receiverPubBytes, senderPubBytes);

  // IKM derivation: HKDF(salt=auth, IKM=sharedSecret, info=keyInfo, L=32) — native Web Crypto
  const ikmSource = await crypto.subtle.importKey('raw', sharedSecret, { name: 'HKDF' }, false, ['deriveBits']);
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: keyInfo },
      ikmSource, 256,
    ),
  );

  // Random 16-byte content salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // CEK/Nonce info strings (RFC 8291 §2.3)
  const cekInfo   = cat(te('Content-Encoding: aes128gcm\x00'), new Uint8Array([1]));
  const nonceInfo = cat(te('Content-Encoding: nonce\x00'),      new Uint8Array([1]));

  // CEK and NONCE via native HKDF(salt=content_salt, IKM=ikm)
  const ikmKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const cek   = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo   }, ikmKey, 128,
  ));
  const nonce = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo }, ikmKey, 96,
  ));

  // AES-128-GCM encrypt: plaintext + 0x02 padding delimiter (RFC 8188 §2.5)
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = cat(te(plaintext), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded),
  );

  // aes128gcm record: salt(16) + rs(4 BE=4096) + keyid_len(1) + keyid(65) + ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return cat(salt, rs, new Uint8Array([senderPubBytes.length]), senderPubBytes, ciphertext);
}

// ─── Send one Web Push ───────────────────────────────────────────────────────

async function sendWebPush(subscription, payload, vapidKeys) {
  const { endpoint } = subscription;
  if (!endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    throw new Error('Invalid subscription: missing endpoint or keys');
  }

  const audience  = new URL(endpoint).origin;
  const jwt       = await buildVapidJwt(audience, vapidKeys.publicKey, vapidKeys.privateKey);
  const bodyBytes = await encryptPayload(payload, subscription);

  console.log('[Push] endpoint:', endpoint.slice(0, 70));
  console.log('[Push] payload bytes:', bodyBytes.byteLength);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization':    `vapid t=${jwt},k=${vapidKeys.publicKey}`,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
      'Urgency':          'high',
    },
    body: bodyBytes,
  });

  const respBody = await resp.text().catch(() => '');
  console.log('[Push] FCM/APNS status:', resp.status, '| body:', respBody.slice(0, 200));

  return { status: resp.status, ok: resp.ok, endpoint, fcmBody: respBody.slice(0, 200) };
}

// ─── Crypto helpers ──────────────────────────────────────────────────────────

async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let prev = new Uint8Array(0);
  const out = new Uint8Array(length);
  let offset = 0, counter = 1;
  while (offset < length) {
    const data = cat(prev, info, new Uint8Array([counter++]));
    prev = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
    const take = Math.min(prev.length, length - offset);
    out.set(prev.slice(0, take), offset);
    offset += take;
  }
  return out;
}

function cat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let i = 0;
  for (const a of arrays) { out.set(a, i); i += a.length; }
  return out;
}

function te(str) { return new TextEncoder().encode(str); }

function decodeB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)), c => c.charCodeAt(0));
}

function encodeB64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlStr(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ─── Response helpers ────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cors(response) {
  const h = new Headers(response.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, { status: response.status, headers: h });
}
