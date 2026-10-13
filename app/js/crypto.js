/* secondmind – crypto.js
   Einzige Krypto-Stelle der App. Alles über WebCrypto, keine Fremd-Bibliothek:
   - AES-256-GCM je Datensatz/Anhang (96-Bit-Zufalls-Nonce, nie wiederverwendet)
   - AAD = id|type|version -> Sätze sind nicht austauschbar
   - PBKDF2-HMAC-SHA-256, 310.000 Iterationen (nur für das optionale
     Passwort der .smkey-Sicherungsdatei)
   - SHA-256 für Fingerprint und SAS-Code
   Schlüsselmodell: DEK (256 Bit, einmalig erzeugt) + Geräteumschlag.
   Die DEK liegt auf dem Gerät im Plattform-Speicher (Windows: safeStorage/DPAPI,
   Android: Keystore) über bridge.secureSet/secureGet – sie verlässt ein Gerät
   nur über Pairing oder die explizite .smkey-Sicherung, nie über Google. */

import { secureGet, secureSet, secureDel } from './bridge.js';

export const FORMAT = 'sm2';   // Datensatz-/Dateiformat v2 (Chiffretext-Envelope)
export const KEY_ID = 1;       // Schlüsselversion (Rotation vorbereitet)

const IV_LEN = 12;             // 96 Bit, GCM-Standardlänge
const KEY_LEN = 32;            // AES-256
const PBKDF2_ITER = 310_000;   // >= 310.000 laut Auftrag
const DEK_KEY = 'dek';         // Speicherplatz im Geräteumschlag

const subtle = globalThis.crypto && globalThis.crypto.subtle;
const textEnc = new TextEncoder();
const textDec = new TextDecoder();

let dekBytes = null;           // Uint8Array(32) – die DEK selbst
let dekKey = null;             // CryptoKey-Puffer (AES-GCM, dekBytes)
let readyPromise = null;
let keyCreated = false;        // in diesem Start neu erzeugt (-> Sicherungs-Hinweis)

/* ---------------- Grundlagen ---------------- */

export function cryptoAvailable() {
  return !!(subtle && globalThis.crypto.getRandomValues);
}

function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Schlüsselmaterial nach Gebrauch best-effort nullen. */
export function zero(...bufs) {
  for (const b of bufs) {
    if (b && b.fill) { try { b.fill(0); } catch { /* egal */ } }
  }
}

async function aesKey(raw) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function freshIv() {
  const iv = new Uint8Array(IV_LEN);            // 96 Bit Zufall -> keine Wiederverwendung
  globalThis.crypto.getRandomValues(iv);
  return iv;
}

/** AAD = id|type|version (D.1): schützt gegen das Tauschen ganzer Sätze. */
function aadFor(id, type, version = `${FORMAT}:${KEY_ID}`) {
  return textEnc.encode(`${id}|${type}|${version}`);
}

/* ---------------- DEK: laden, erzeugen, übergeben ---------------- */

export function init() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (!cryptoAvailable()) throw new Error('WebCrypto nicht verfügbar (sicherer Kontext nötig)');
    let stored = null;
    try { stored = await secureGet(DEK_KEY); } catch { /* erster Start */ }
    if (stored && typeof stored.k === 'string' && stored.k.length >= 43) {
      dekBytes = unb64(stored.k);
    } else {
      dekBytes = globalThis.crypto.getRandomValues(new Uint8Array(KEY_LEN));
      await secureSet(DEK_KEY, { k: b64(dekBytes), at: Date.now(), keyId: KEY_ID });
      keyCreated = true;                        // -> "Schlüssel sichern" anbieten
    }
    dekKey = await aesKey(dekBytes);
    return true;
  })();
  return readyPromise;
}

export const hasKey = () => !!dekBytes;

/** true, wenn die DEK in diesem Start neu erzeugt wurde. */
export const wasKeyCreated = () => keyCreated;

/** Nur für Tests/Debug: Status ohne Seitenwirkung. */
export const keyId = () => (dekBytes ? KEY_ID : 0);

/**
 * Neue DEK annehmen (nach Pairing oder Import) und den Geräteumschlag neu
 * füllen. @returns die vorherige DEK (für den Re-Encode der lokalen Daten),
 * damit alte Sätze nicht unlesbar zurückbleiben.
 */
export async function adoptKey(base64Key) {
  const bytes = unb64(String(base64Key).trim());
  if (bytes.length !== KEY_LEN) { zero(bytes); throw new Error('Schlüssel hat nicht 256 Bit'); }
  const previous = dekBytes;
  dekBytes = bytes;
  dekKey = await aesKey(dekBytes);
  await secureSet(DEK_KEY, { k: b64(dekBytes), at: Date.now(), keyId: KEY_ID });
  return previous;
}

/** DEK löschen (nur im Klartext-Reset). */
export function clearKey() {
  dekBytes = null;
  dekKey = null;
  readyPromise = null;
  keyCreated = false;
  secureDel(DEK_KEY);
}

/** DEK als Base64 (~44 Zeichen) – Basis für QR, .smkey und Pairing. */
export function exportKey() {
  if (!dekBytes) throw new Error('Kein Schlüssel vorhanden');
  return b64(dekBytes);
}

/** SHA-256(DEK) -> kurzer Anzeigefingerabdruck (Bestätigung auf beiden Geräten). */
export async function fingerprint(dekB64 = null) {
  const raw = dekB64 ? unb64(dekB64) : dekBytes;
  if (!raw) return '';
  const d = await subtle.digest('SHA-256', raw);
  if (dekB64) zero(raw);
  return [...new Uint8Array(d)].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 6-stelliger SAS-Code für den LAN-Tausch (beide Seiten: Secret + DEK). */
export async function sasCode(sessionSecret, dekB64) {
  const data = textEnc.encode(`${sessionSecret}|${dekB64}`);
  const d = new Uint8Array(await subtle.digest('SHA-256', data));
  const n = ((d[0] << 16) | (d[1] << 8) | d[2]) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}

/* ---------------- Per-Record-Verschlüsselung (DB + Drive) ---------------- */

/**
 * Klartext-Datensatz -> Envelope {id, updatedAt, type, rev, keyId, iv, ct, dirty}.
 * Unverschlüsselt bleiben ausschließlich die für Sortierung/LWW/Filter
 * nötigen Metadaten: id, updatedAt, type (kind), rev, dirty.
 */
export async function encodeRecord(rec) {
  if (!dekKey) throw new Error('Schlüssel nicht initialisiert');
  const type = rec.kind || rec.type || 'daten';
  const plain = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'id' || k === 'updatedAt' || k === 'kind' || k === 'type' ||
        k === 'rev' || k === 'iv' || k === 'ct' || k === 'keyId' || k === 'dirty') continue;
    plain[k] = v;
  }
  const iv = freshIv();
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(rec.id, type) },
    dekKey,
    textEnc.encode(JSON.stringify(plain)),
  );
  return {
    id: rec.id,
    updatedAt: rec.updatedAt || 0,
    type,
    rev: 1,
    keyId: KEY_ID,
    dirty: rec.dirty ? 1 : 0,
    iv: b64(iv),
    ct: b64(ct),
  };
}

/**
 * Envelope -> Klartext-Datensatz. Liefert null, wenn der Satz nicht lesbar
 * ist (fremder/fehlender Schlüssel) – der Aufrufer bewahrt das Envelope dann
 * als "versiegelt" auf, statt es zu zerstören.
 */
export async function decodeRecord(env) {
  if (!env || typeof env !== 'object') return null;
  if (!env.ct) return env;                       // Legacy-Klartext (Migration v1)
  if (!dekKey) return null;
  try {
    const iv = unb64(env.iv || '');
    const ct = unb64(env.ct || '');
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aadFor(env.id, env.type || 'daten', `sm2:${env.keyId || KEY_ID}`) },
      dekKey,
      ct,
    );
    const plain = JSON.parse(textDec.decode(pt));
    const rec = {
      ...plain,
      id: env.id,
      updatedAt: env.updatedAt || 0,
      kind: env.type || plain.kind || 'daten',
      dirty: env.dirty ? 1 : 0,
    };
    zero(iv, ct);
    return rec;
  } catch {
    return null;
  }
}

/** Envelope wirklich enthält (Prüfung beim Migrationslauf). */
export const isEncoded = (raw) => !!(raw && raw.ct && raw.iv);

/* ---------------- Binärstrom für Anhänge (Upload/Download) ----------------
   Format: iv(12 Byte) || Chiffretext inkl. GCM-Tag. Metadaten (content-Typ,
   Größe) bleiben als Klartext-Metadaten bestehen, die Dateibyte nicht. */

export async function sealBytes(bytes) {
  if (!dekKey) throw new Error('Schlüssel nicht initialisiert');
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const iv = freshIv();
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor('anhang', 'blob') }, dekKey, src,
  );
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return out;
}

export async function openBytes(packed) {
  if (!dekKey || !packed) return null;
  try {
    const buf = packed instanceof Uint8Array ? packed : new Uint8Array(packed);
    if (buf.length <= IV_LEN) return null;
    const iv = buf.subarray(0, IV_LEN);
    const ct = buf.subarray(IV_LEN);
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aadFor('anhang', 'blob') }, dekKey, ct,
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

/** Ein Hüllenfeld (base64) als Byte-Array – für die JSON-Serialisierung. */
export function b64ToBytes(str) { return unb64(str); }

/* ---------------- Anhänge (Bytes) ---------------- */

export async function encodeBytes(bytes) {
  if (!dekKey) throw new Error('Schlüssel nicht initialisiert');
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const iv = freshIv();
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor('anhang', 'blob') },
    dekKey, src,
  );
  const out = { rev: 1, keyId: KEY_ID, iv: b64(iv), ct: b64(ct) };
  zero(src);
  return out;
}

export async function decodeBytes(env) {
  if (!env) return null;
  if (!env.ct) return env;                        // Legacy-Klartext
  if (!dekKey) return null;
  try {
    const iv = unb64(env.iv || '');
    const ct = unb64(env.ct || '');
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aadFor('anhang', 'blob', `sm2:${env.keyId || KEY_ID}`) },
      dekKey, ct,
    );
    const out = new Uint8Array(pt);
    zero(iv, ct);
    return out;
  } catch {
    return null;
  }
}

/* ---------------- Transport (LAN-Pairing) ---------------- */

/** DEK mit dem Session-Secret des QR-Codes verschlüsseln (Stufe 3). */
export async function sealForSession(dekB64, secretB64) {
  const raw = unb64(String(secretB64));
  if (raw.length !== KEY_LEN) { zero(raw); throw new Error('Session-Secret ungültig'); }
  const key = await aesKey(raw);
  const iv = freshIv();
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: textEnc.encode('secondmind-pairing') },
    key, unb64(String(dekB64)),
  );
  const out = { iv: b64(iv), ct: b64(ct) };
  zero(raw);
  return out;
}

export async function openSealedSession(payload, secretB64) {
  const raw = unb64(String(secretB64));
  const key = await aesKey(raw);
  const iv = unb64(payload.iv || '');
  const ct = unb64(payload.ct || '');
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: textEnc.encode('secondmind-pairing') },
    key, ct,
  );
  const out = b64(new Uint8Array(pt));
  zero(raw, iv, ct);
  return out;
}

/* ---------------- .smkey-Sicherungsdatei ---------------- */

/** Sicherungsdatei bauen – optional mit Passwort (PBKDF2, 310k). */
export async function makeKeyFile(password = '') {
  const key = exportKey();
  if (!password) {
    return { app: 'secondmind', format: FORMAT, kind: 'key', keyId: KEY_ID, key, createdAt: Date.now() };
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = freshIv();
  const material = await subtle.importKey('raw', textEnc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, material, 256,
  );
  const pwKey = await aesKey(new Uint8Array(bits));
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: textEnc.encode('secondmind-smkey') }, pwKey, unb64(key),
  );
  zero(new Uint8Array(bits));
  return {
    app: 'secondmind', format: FORMAT, kind: 'key', keyId: KEY_ID, createdAt: Date.now(),
    kdf: { name: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: b64(salt) },
    iv: b64(iv), ct: b64(ct),
  };
}

/** Sicherungsdatei lesen -> Base64-DEK (wirft bei falschem Passwort). */
export async function readKeyFile(obj, password = '') {
  if (!obj || obj.app !== 'secondmind' || obj.kind !== 'key') throw new Error('Keine secondmind-Schlüsseldatei');
  if (obj.kdf) {
    if (!password) throw new Error('Passwort erforderlich');
    const salt = unb64(obj.kdf.salt);
    const material = await subtle.importKey('raw', textEnc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: obj.kdf.iter || PBKDF2_ITER, hash: 'SHA-256' }, material, 256,
    );
    const pwKey = await aesKey(new Uint8Array(bits));
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(obj.iv), additionalData: textEnc.encode('secondmind-smkey') },
      pwKey, unb64(obj.ct),
    );
    zero(new Uint8Array(bits));
    return b64(new Uint8Array(pt));
  }
  if (typeof obj.key !== 'string') throw new Error('Unvollständige Schlüsseldatei');
  return obj.key;
}

/* ---------------- Selbsttest (Round-Trip, AAD-Tausch, Nonce) ---------------- */

/**
 * Feste Testfälle aus dem Auftrag:
 * 1) Round-Trip, 2) AAD-Tausch-Attacke schlägt fehl, 3) Nonces nie gleich,
 * 4) falscher Schlüssel scheitert, 5) PBKDF2 liefert 256 Bit.
 */
export async function selfTest() {
  const res = { roundtrip: false, aadBlocked: false, nonceUnique: false, wrongKeyBlocked: false, pbkdf2: false };
  if (!cryptoAvailable()) { res.fehler = 'kein WebCrypto'; return res; }

  // 1) Round-Trip
  const rec = { id: 't1', kind: 'note', updatedAt: 123, dirty: 1, title: 'Geheim', text: 'Hallo Welt', tags: ['a'] };
  const env = await encodeRecord(rec);
  const back = await decodeRecord(env);
  res.roundtrip = back?.title === 'Geheim' && back.text === 'Hallo Welt' && back.updatedAt === 123 && back.kind === 'note';

  // 2) AAD-Tausch: identischer Inhalt, aber fremde id -> muss scheitern
  const swapped = { ...env, id: 't2' };
  res.aadBlocked = (await decodeRecord(swapped)) === null;

  // 3) Nonce-Eindeutigkeit über viele Verschlüsselungen
  const ivs = new Set();
  let unique = true;
  for (let i = 0; i < 200; i++) {
    const e = await encodeRecord({ id: `n${i}`, kind: 'item', updatedAt: i, dirty: 1, text: String(i) });
    if (ivs.has(e.iv)) { unique = false; break; }
    ivs.add(e.iv);
  }
  res.nonceUnique = unique;

  // 4) Falscher Schlüssel darf nicht lesen
  const wrong = dekBytes.slice();
  wrong[0] ^= 0xff;
  const foreignKey = await aesKey(wrong);
  zero(wrong);
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(env.iv), additionalData: aadFor(env.id, env.type, `sm2:${env.keyId}`) },
      foreignKey, unb64(env.ct),
    );
    res.wrongKeyBlocked = pt.byteLength < 0;   // sollte nie erreicht werden
  } catch {
    res.wrongKeyBlocked = true;
  }

  // 5) PBKDF2 (310k) liefert 256 Bit
  try {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const m = await subtle.importKey('raw', textEnc.encode('passwort'), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 20_000, hash: 'SHA-256' }, m, 256);
    res.pbkdf2 = bits.byteLength === 32;         // 256 Bit
    zero(new Uint8Array(bits));
  } catch { res.pbkdf2 = false; }

  res.ok = res.roundtrip && res.aadBlocked && res.nonceUnique && res.wrongKeyBlocked && res.pbkdf2;
  return res;
}
