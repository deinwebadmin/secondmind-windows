/* secondmind – sync.js
   Google Drive als Fernspeicher.
   - OAuth 2.0 (Loopback / Installed-App-Flow, funktioniert ohne App Store)
   - db-Datei "secondmind.db.json" im Ordner "secondmind"
   - Sync-Takt: alle 60 s (konfigurierbar), sofort bei Internet-Wiederverbindung
   - Lokal: alles bleibt in IndexedDB und funktioniert offline. */

import * as db from './db.js';
import { uid, debounce } from './util.js';
import { openAuth, parseRedirect, secureGet, secureSet, secureDel, platform } from './bridge.js';
import * as C from './crypto.js';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_EP = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

const SCOPES = {
  file: 'https://www.googleapis.com/auth/drive.file',
  full: 'https://www.googleapis.com/auth/drive',
};
const BASE_SCOPE = 'openid email profile';

const DB_FILE = 'secondmind.db.json';
const FOLDER = 'secondmind';
const PLACEHOLDER_REDIRECT = 'http://127.0.0.1:0';

/* ---------------- Status ---------------- */

const listeners = new Set();
export const onStatus = (cb) => { listeners.add(cb); cb(status); return () => listeners.delete(cb); };

export const status = {
  state: 'idle',        // idle | disconnected | offline | syncing | ok | error | expired
  message: '',
  lastSync: 0,
  account: '',
  name: '',             // Anzeigename des verbundenen Kontos
  picture: '',          // Avatar-URL (ID-Token)
  sub: '',              // Google-Konto-ID (Schlüssel für lokale Drive-IDs)
  connected: false,
  expired: false,       // Grant abgelaufen/widerrufen -> Banner statt Datenverlust
  platform,
};

function setStatus(patch) {
  Object.assign(status, patch);
  for (const cb of [...listeners]) { try { cb(status); } catch (e) { console.error(e); } }
}

/* ---------------- Tokens ---------------- */

let tokens = null;
let loginHint = '';     // für die stille Wiederanmeldung (prompt=none)

export async function initTokens() {
  tokens = await secureGet('tokens');
  loginHint = (await db.kvGet('loginHint')) || '';
  setStatus({
    connected: !!tokens?.refresh_token,
    account: tokens?.email || '',
    name: tokens?.name || '',
    picture: tokens?.picture || '',
    sub: tokens?.sub || '',
    expired: false,
  });
  // Konto-Check: nach App-Start ggf. Cache alter Drive-IDs verwerfen
  if (tokens?.refresh_token) await ensureAccount(tokens.sub || tokens.email);
  return tokens;
}

/** Identität des verbundenen Kontos für die Einstellungs-Anzeige. */
export function identity() {
  if (!tokens?.refresh_token) return null;
  return {
    email: tokens.email || '',
    name: tokens.name || '',
    picture: tokens.picture || '',
    sub: tokens.sub || '',
  };
}

export const hasLoginHint = () => !!loginHint;

function saveTokens(t) {
  tokens = t;
  return secureSet('tokens', t);
}

/**
 * Verbindung trennen: Tokens und login_hint löschen, Drive-Dateien bleiben,
 * Daten bleiben, App läuft ab jetzt lokal weiter (Local-Modus).
 */
export async function disconnect() {
  tokens = null;
  loginHint = '';
  secureDel('tokens');
  await db.kvDel('loginHint');
  await resetDriveCache();
  await db.kvDel('driveAccount');
  db.setSetting('syncMode', 'none');
  setStatus({
    connected: false, account: '', name: '', picture: '', sub: '',
    state: 'idle', message: '', expired: false,
  });
}

/* ---------------- Konto & Ordner-Cache ---------------- */

async function resetDriveCache() {
  await db.kvDel('driveFolder');
  await db.kvDel('driveDbFile');
  await db.kvDel('driveDbMd5');
  await db.kvDel('driveDbModified');
}

/**
 * Schutz vor Konto-Wechseln: gehörten die gecachten Drive-IDs noch zum
 * vorherigen Google-Konto, werden sie verworfen – sonst würde secondmind im
 * fremden Ordner nach seinen Daten suchen.
 * Schlüssel ist die Konto-`sub` (nicht die E-Mail, die sich ändern kann).
 * Vorhandene E-Mail-Schlüssel werden idempotent migriert.
 * @returns {Promise<boolean>} true, wenn das Konto gewechselt wurde
 */
async function ensureAccount(id) {
  if (!id) return false;
  const prev = await db.kvGet('driveAccount');
  if (!prev) { await db.kvSet('driveAccount', id); return false; }
  if (prev === id) return false;

  // Alt (E-Mail) -> neu (sub) desselben Kontos: nur umschlüsseln, nichts leeren
  if (prev === (tokens?.email || '')) {
    await db.kvSet('driveAccount', id);
    return false;
  }

  // Echtes Kontenverhalten: fremdes Konto -> Drive-Cache verwerfen
  await db.kvSet('driveAccount', id);
  await resetDriveCache();
  return true;
}

async function ensureAccess() {
  if (!tokens?.refresh_token) throw new Error('nicht verbunden');
  if (tokens.access_token && Date.now() < (tokens.expires_at || 0) - 60_000) return tokens.access_token;

  const body = new URLSearchParams({
    client_id: clientId(),
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_EP, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await res.json();
  if (!res.ok) {
    // Ablauf oder Widerruf: Tokens weg, Daten bleiben, Banner mit einem Tap.
    // Niemals Daten löschen, weil ein Token abgelaufen ist.
    if (data.error === 'invalid_grant') handleExpired();
    throw new Error(data.error_description || data.error || 'Token-Erneuerung fehlgeschlagen');
  }
  await saveTokens({ ...tokens, access_token: data.access_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 });
  return tokens.access_token;
}

/** Token abgelaufen/widerrufen: nur Tokens löschen – die Daten bleiben. */
function handleExpired() {
  tokens = null;
  secureDel('tokens');
  setStatus({
    connected: false, expired: true, state: 'expired',
    message: 'Verbindung abgelaufen – erneut verknüpfen',
  });
}

function clientId() {
  const id = db.getSetting('clientId') || '';
  if (!id) throw new Error('Keine Google Client-ID hinterlegt (Einstellungen → Google Drive)');
  return id;
}

/* ---------------- Auth-Flow ---------------- */

export function authUrl({ silent = false } = {}) {
  const scope = [SCOPES[db.getSetting('scopeMode') === 'full' ? 'full' : 'file'], BASE_SCOPE].join(' ');
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: PLACEHOLDER_REDIRECT,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: silent ? 'none' : 'consent',     // still zuerst, erst dann interaktiv
    include_granted_scopes: 'true',
    state: uid(),
  });
  if (silent && loginHint) p.set('login_hint', loginHint);
  return `${AUTH}?${p}`;
}

export async function connect() {
  let url;
  try {
    url = authUrl();
  } catch (e) {
    setStatus({ state: 'error', message: e.message });
    throw e;
  }
  setStatus({ state: 'syncing', message: 'Warte auf Google-Anmeldung …', expired: false });
  const res = await openAuth(url);
  if (res?.needsManual) return { needsManual: true, hint: res.hint };
  if (res?.error) {
    setStatus({ state: res.error === 'access_denied' ? 'disconnected' : 'error', message: fmtAuthError(res.error) });
    return { error: res.error };
  }
  return exchangeCode(res.code, res.redirectUri);
}

/**
 * Stille Wiederanmeldung (B.6): zuerst prompt=none mit gespeichertem
 * login_hint – erst wenn Google ablehnt, kommt der interaktive Flow.
 */
export async function silentReconnect() {
  if (!loginHint) return { needsInteractive: true };
  let url;
  try { url = authUrl({ silent: true }); } catch (e) { return { needsInteractive: true, error: e.message }; }
  setStatus({ state: 'syncing', message: 'Versuche stille Wiederanmeldung …', expired: false });
  const res = await openAuth(url);
  if (res?.error) {
    // login_required / consent_required / interaktiv nötig
    setStatus({ state: 'expired', expired: true, message: 'Verbindung abgelaufen – erneut verknüpfen' });
    return { needsInteractive: true, error: res.error };
  }
  if (res?.needsManual) return { needsManual: true, hint: res.hint };
  try {
    return await exchangeCode(res.code, res.redirectUri);
  } catch (e) {
    setStatus({ state: 'expired', expired: true, message: 'Verbindung abgelaufen – erneut verknüpfen' });
    return { needsInteractive: true, error: e.message };
  }
}

/** ID-Token-Payload lesen und lokal prüfen: aud = eigene Client-ID, iss, exp.
    Reine Claim-Prüfung ohne eigenen Krypto-Code (B.1). */
function idTokenClaims(idToken, clientIdValue) {
  try {
    const part = String(idToken || '').split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const bin = atob(b64 + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const p = JSON.parse(new TextDecoder().decode(bytes));

    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (clientIdValue && !aud.includes(clientIdValue)) return null;          // aud
    if (typeof p.iss !== 'string' || !p.iss.startsWith('https://accounts.google.com')) return null; // iss
    if (!p.exp || p.exp * 1000 < Date.now()) return null;                    // exp
    if (!p.sub) return null;
    return p;
  } catch { return null; }
}

function safeClientId() { try { return clientId(); } catch { return ''; } }

export async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: clientId(),
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_EP, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Code-Tausch fehlgeschlagen');

  const t = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens?.refresh_token || '',
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    email: '', name: '', picture: '', sub: '',
  };

  // Identität aus dem ID-Token (Claims aud/iss/exp lokal geprüft)
  const claims = idTokenClaims(data.id_token, safeClientId());
  if (claims) {
    t.sub = claims.sub || '';
    t.email = claims.email || '';
    t.name = claims.name || '';
    t.picture = claims.picture || '';
  }

  await saveTokens(t);
  setStatus({
    connected: true, state: 'ok', message: '', expired: false,
    account: t.email, name: t.name, picture: t.picture, sub: t.sub,
  });

  // Fallback ohne ID-Token: userinfo-Endpoint (alter Weg)
  if (!claims) {
    try {
      const at = await ensureAccess();
      const info = await (await fetch(USERINFO, { headers: { Authorization: `Bearer ${at}` } })).json();
      if (info.email) {
        t.email = info.email;
        await saveTokens(t);
        setStatus({ account: info.email });
      }
    } catch { /* userinfo ist optional */ }
  }

  let switched = false;
  try {
    if (t.email) {
      loginHint = t.email;
      await db.kvSet('loginHint', loginHint);     // Basis für prompt=none
    }
    const id = t.sub || t.email;
    if (id) {
      switched = await ensureAccount(id);
      db.setSetting('syncMode', 'google');        // A.3: verbunden
    }
  } catch { /* Identität ist optional für den Sync */ }

  return { ok: true, switched };
}

function fmtAuthError(e) {
  const map = {
    access_denied: 'Anmeldung abgebrochen',
    invalid_client: 'Client-ID ungültig – bitte prüfen',
    unauthorized_client: 'Client-Typ falsch („Desktop-App“ wählen)',
    invalid_redirect_uri: 'Redirect-URI wird vom Google-Projekt nicht akzeptiert',
  };
  return map[e] || e;
}

/* ---------------- Drive REST ---------------- */

async function api(path, options = {}, base = API) {
  const at = await ensureAccess();
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${at}`, ...(options.headers || {}) },
  });
  if (res.status === 401) { // ein letztes Mal neu laden
    tokens.expires_at = 0;
    const at2 = await ensureAccess();
    const res2 = await fetch(`${base}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${at2}`, ...(options.headers || {}) },
    });
    return res2;
  }
  return res;
}

async function findOrCreateFolder() {
  const cached = await db.kvGet('driveFolder');
  if (cached) return cached;

  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const list = await (await api(`/files?q=${q}&fields=files(id,name)&pageSize=5`)).json();
  if (list.files?.length) {
    await db.kvSet('driveFolder', list.files[0].id);
    return list.files[0].id;
  }
  const meta = { name: FOLDER, mimeType: 'application/vnd.google-apps.folder' };
  const created = await (await api('/files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta),
  })).json();
  if (!created.id) throw new Error('Drive-Ordner konnte nicht erstellt werden');
  await db.kvSet('driveFolder', created.id);
  return created.id;
}

async function findDbFile(folderId) {
  const cached = await db.kvGet('driveDbFile');
  if (cached) return cached;
  const q = encodeURIComponent(`name='${DB_FILE}' and '${folderId}' in parents and trashed=false`);
  const list = await (await api(`/files?q=${q}&fields=files(id,name)&pageSize=5`)).json();
  if (list.files?.length) {
    await db.kvSet('driveDbFile', list.files[0].id);
    return list.files[0].id;
  }
  return null;
}

/* ---------------- Serialisierung ---------------- */

async function snapshot() {
  const recs = [...db.state.records.values()];
  const out = [];
  for (const r of recs) out.push(C.hasKey() ? await C.encodeRecord(r) : { ...r });
  // Versiegelte Sätze (anderer Schlüssel) nie still verwerfen – sonst wäre
  // der Push für andere Geräte ein Datenverlust.
  for (const env of db.sealedRecords()) out.push(env);
  return {
    v: C.hasKey() ? 2 : 1,               // v2 = Chiffretext je Satz
    app: 'secondmind',
    device: await_deviceId(),
    updatedAt: Date.now(),
    records: out,
  };
}

let _deviceId = null;
function await_deviceId() {
  if (_deviceId) return _deviceId;
  _deviceId = localStorage.getItem('sm.device');
  if (!_deviceId) { _deviceId = uid(); localStorage.setItem('sm.device', _deviceId); }
  return _deviceId;
}

/* ---------------- Pull / Push ---------------- */

let busy = false;
let remoteIsPlain = true;   // Drive-Datei noch in Klartext (v1) -> beim nächsten Push auf v2 nachziehen

async function pull(folderId) {
  const fileId = await findDbFile(folderId);
  if (!fileId) return false;

  const metaRes = await api(`/files/${fileId}?fields=id,md5Checksum,modifiedTime,version`);
  if (metaRes.status === 404) {          // Datei ist weg (anderes Konto, gelöscht)
    await db.kvDel('driveDbFile');
    await db.kvDel('driveDbMd5');
    return false;
  }
  if (!metaRes.ok) return false;
  const meta = await metaRes.json();
  const seen = await db.kvGet('driveDbMd5');

  if (meta.md5Checksum && meta.md5Checksum === seen) return false;

  const content = await api(`/files/${fileId}?alt=media`);
  if (!content.ok) throw new Error('Drive-Datei konnte nicht gelesen werden');
  const remote = await content.json();

  // Lesen müssen beide Formate: v1 (Klartext) und v2 (Chiffretext je Satz)
  const list = Array.isArray(remote.records) ? remote.records : [];
  remoteIsPlain = C.hasKey() ? list.some((r) => r && !r.ct && r.id) : false;
  const decrypted = [];
  const sealed = [];
  for (const env of list) {
    if (!env || !env.id) continue;
    if (env.ct) {
      const rec = await C.decodeRecord(env);     // fremder Schlüssel -> null
      if (rec) decrypted.push(rec); else sealed.push(env);
    } else {
      decrypted.push(env);                       // Legacy-Klartext (Migration)
    }
  }
  if (sealed.length) db.keepSealed(sealed);      // aufbewahren, nicht verwerfen

  const changed = db.mergeRecords(decrypted);
  await db.kvSet('driveDbMd5', meta.md5Checksum || '');
  await db.kvSet('driveDbModified', meta.modifiedTime || '');
  return changed;
}

async function push(folderId, allowRecreate = true, force = false) {
  let fileId = await findDbFile(folderId);
  const payload = await snapshot();
  const dirty = new Set(payload.records.filter((r) => r.dirty).map((r) => r.id));
  if (!dirty.size && !force) return false;   // force: v1 -> v2 nachziehen

  const stamp = new Map(payload.records.filter((r) => r.dirty).map((r) => [r.id, r.updatedAt]));
  const body = JSON.stringify(payload);

  if (!fileId) {
    const meta = { name: DB_FILE, parents: [folderId], mimeType: 'application/json' };
    const res = await api('/files?fields=id,md5Checksum,modifiedTime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    });
    if (res.status === 404 && allowRecreate) {
      // Ordner existiert in diesem Konto nicht (mehr) – neuen suchen/anlegen
      await db.kvDel('driveFolder');
      return push(await findOrCreateFolder(), false, force);
    }
    const created = res.ok ? await res.json() : null;
    if (!created?.id) throw new Error('Drive-Datei konnte nicht erstellt werden');
    fileId = created.id;
    await db.kvSet('driveDbFile', fileId);
    // Inhalt separat hochladen
    const up = await api(`/files/${fileId}?uploadType=media&fields=id,md5Checksum,modifiedTime`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
    }, UPLOAD);
    if (!up.ok) throw new Error('Sync-Upload fehlgeschlagen');
    const fin = await up.json();
    await db.kvSet('driveDbMd5', fin.md5Checksum || '');
  } else {
    const up = await api(`/files/${fileId}?uploadType=media&fields=id,md5Checksum,modifiedTime`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
    }, UPLOAD);
    if (up.status === 412) {
      // Jemand war schneller: neu einlesen, mergen, einmal wiederholen
      await db.kvDel('driveDbMd5');
      await pull(folderId);
      return push(folderId, allowRecreate, force);
    }
    if (up.status === 404 && allowRecreate) {
      // Datei existiert in diesem Konto nicht mehr – neu anlegen
      await db.kvDel('driveDbFile');
      await db.kvDel('driveDbMd5');
      return push(folderId, false, force);
    }
    if (!up.ok) throw new Error('Sync-Upload fehlgeschlagen');
    const fin = await up.json();
    await db.kvSet('driveDbMd5', fin.md5Checksum || '');
  }

  // Dirty-Flags nur löschen, wenn sich der Datensatz nicht erneut geändert hat
  for (const rec of db.state.records.values()) {
    if (stamp.has(rec.id) && stamp.get(rec.id) === rec.updatedAt) rec.dirty = 0;
  }
  remoteIsPlain = false;                       // Drive ist jetzt auf dem aktuellen Format
  return true;
}

/* ---------------- Anhänge (Fotos & Dateien) ---------------- */

async function uploadAttachment(fileRef) {
  const blob = await db.getBlob(fileRef.id);
  if (!blob) { fileRef.state = 'missing'; return false; }
  const folderId = await findOrCreateFolder();

  // Dateibyte vor dem Upload verschlüsseln (D.4.2). content-Typ und Größe
  // bleiben als Metadaten stehen, der Dateiname verrät nichts über den Inhalt.
  let body = blob;
  let enc = false;
  if (C.hasKey()) {
    const sealed = await C.sealBytes(new Uint8Array(await blob.arrayBuffer()));
    body = new Blob([sealed], { type: 'application/octet-stream' });
    enc = true;
  }
  const size = body.size;
  const partType = enc ? 'application/octet-stream' : (fileRef.type || 'application/octet-stream');

  const meta = {
    name: `sm-file-${fileRef.id}`,
    parents: [folderId],
    mimeType: fileRef.type || 'application/octet-stream',
    appProperties: { sm: 'file', ...(enc ? { enc: '2' } : {}) },
  };

  let driveId;
  if (size > 6 * 1024 * 1024) {
    // Resumable-Upload für größere Dateien
    const start = await api('/files?uploadType=resumable&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': partType, 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify(meta),
    }, UPLOAD);
    if (!start.ok) throw new Error('Upload-Start fehlgeschlagen');
    const loc = start.headers.get('location');
    const put = await fetch(loc, {
      method: 'PUT',
      headers: { 'Content-Type': partType, 'Content-Range': `bytes 0-${size - 1}/${size}` },
      body,
    });
    const out = await put.json();
    driveId = out.id;
  } else {
    const boundary = 'sm' + uid();
    const ctype = `multipart/related; boundary=${boundary}`;
    const head = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(meta),
      `\r\n--${boundary}\r\nContent-Type: ${partType}\r\nContent-Transfer-Encoding: binary\r\n\r\n`,
    ], { type: ctype });
    const full = new Blob([head, body, `\r\n--${boundary}--`], { type: ctype });
    const res = await api('/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': ctype },
      body: full,
    }, UPLOAD);
    if (!res.ok) throw new Error('Anhang-Upload fehlgeschlagen');
    driveId = (await res.json()).id;
  }
  if (!driveId) throw new Error('Anhang-Upload fehlgeschlagen');
  fileRef.enc = enc ? 1 : 0;
  return driveId;
}

async function syncAttachments() {
  // 1) Neue lokale Anhänge hochladen
  for (const rec of [...db.state.records.values()]) {
    if (rec.kind !== 'note' || rec.deleted || !rec.files?.length) continue;
    let touched = false;
    for (const f of rec.files) {
      if (!f.driveId && f.state !== 'missing') {
        try {
          f.driveId = await uploadAttachment(f);
          f.state = 'up';
          touched = true;
        } catch (e) {
          console.warn('Anhang-Upload', e);
          f.state = 'error';
          touched = true;
        }
        continue;
      }
      // Migration: in der alten Version unverschlüsselt hochgeladene Datei
      // einmalig ersetzen – danach enthält Drive nur noch Chiffretext.
      if (f.driveId && !f.enc && f.state !== 'error' && C.hasKey()) {
        const alt = f.driveId;
        try {
          f.driveId = await uploadAttachment(f);
          f.state = 'up';
          touched = true;
          api(`/files/${alt}`, { method: 'DELETE' }).catch(() => {});   // alte Klartext-Datei weg
        } catch (e) {
          console.warn('Anhang-Migration', e);
          f.state = 'error';
          touched = true;
        }
      }
    }
    if (touched) db.update(rec.id, { files: rec.files });
  }
}

/** Anhang aus Drive nachladen (lazy, nur wenn angezeigt). */
export async function fetchAttachment(fileRef) {
  if (!fileRef.driveId) return null;
  const cached = await db.getBlob(fileRef.id);
  if (cached) return cached;
  if (!navigator.onLine) return null;
  try {
    const res = await api(`/files/${fileRef.driveId}?alt=media`);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    let bytes = buf;
    if (fileRef.enc) {
      bytes = await C.openBytes(buf);
      if (!bytes) return null;               // ohne passenden Schlüssel nicht lesbar
    }
    const blob = new Blob([bytes], { type: fileRef.type || 'application/octet-stream' });
    await db.putBlob(fileRef.id, blob);      // lokal wieder verschlüsselt ablegen
    return blob;
  } catch (e) {
    console.warn('Anhang-Download', e);
    return null;
  }
}

/* ---------------- Tick ---------------- */

async function runSync({ full = true } = {}) {
  if (busy) return;
  // Local-Modus: kein Drive-Zugriff, kein Drängeln (A.2)
  if (db.getSetting('syncMode') === 'none') {
    if (status.state !== 'idle') setStatus({ state: 'idle', message: '' });
    return;
  }
  if (!status.connected) {
    setStatus({ state: status.expired ? 'expired' : 'disconnected',
      message: status.expired ? 'Verbindung abgelaufen – erneut verknüpfen' : '' });
    return;
  }
  if (!navigator.onLine) { setStatus({ state: 'offline', message: 'Keine Verbindung – Änderungen bleiben lokal gespeichert' }); return; }

  busy = true;
  setStatus({ state: 'syncing', message: '' });
  try {
    const folderId = await findOrCreateFolder();
    if (full) await pull(folderId);

    // v1 (Klartext) im Drive -> beim nächsten Schreiben auf v2 nachziehen
    const needV2 = remoteIsPlain && C.hasKey();
    if (db.hasDirty() || needV2) await push(folderId, true, needV2);

    await syncAttachments();
    if (db.hasDirty()) await push(folderId);

    setStatus({ state: 'ok', message: '', lastSync: Date.now(), expired: false });
  } catch (e) {
    if (status.expired) {
      setStatus({ state: 'expired', message: 'Verbindung abgelaufen – erneut verknüpfen' });
    } else {
      console.error('sync', e);
      setStatus({ state: 'error', message: e.message || 'Sync fehlgeschlagen' });
    }
  } finally {
    busy = false;
  }
}

const pushSoon = debounce(() => runSync({ full: false }), 2500);

/* ---------------- Steuerung ---------------- */

let timer = null;
let wired = false;

export function startSync() {
  stopSync();
  const secs = Number(db.getSetting('syncInterval')) || 60;
  timer = setInterval(() => runSync({ full: true }), Math.max(10, secs) * 1000);

  if (!wired) {
    wired = true;

    window.addEventListener('online', () => {
      if (!status.connected) return;
      setStatus({ message: 'Internetverbindung wieder da – synchronisiere …' });
      runSync({ full: true });
    });
    window.addEventListener('offline', () =>
      setStatus({ state: 'offline', message: 'Offline – Änderungen werden lokal gespeichert' }));

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && status.connected) runSync({ full: true });
    });

    db.on('dirty', () => { if (status.connected && navigator.onLine) pushSoon(); });
  }

  if (status.connected) runSync({ full: true });
  else if (!navigator.onLine) setStatus({ state: 'offline' });
}

export function stopSync() { if (timer) clearInterval(timer); timer = null; }

export const syncNow = () => runSync({ full: true });

export function syncInfo() {
  return {
    connected: status.connected,
    account: status.account,
    name: status.name,
    picture: status.picture,
    sub: status.sub,
    expired: status.expired,
    syncMode: db.getSetting('syncMode') || '',
    interval: Number(db.getSetting('syncInterval')) || 60,
    platform: status.platform,
    scopeMode: db.getSetting('scopeMode'),
  };
}
