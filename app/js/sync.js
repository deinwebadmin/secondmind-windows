/* secondmind – sync.js
   Google Drive als Fernspeicher.
   - OAuth 2.0 (Loopback / Installed-App-Flow, funktioniert ohne App Store)
   - db-Datei "secondmind.db.json" im Ordner "secondmind"
   - Sync-Takt: alle 60 s (konfigurierbar), sofort bei Internet-Wiederverbindung
   - Lokal: alles bleibt in IndexedDB und funktioniert offline. */

import * as db from './db.js';
import { uid, debounce } from './util.js';
import { openAuth, parseRedirect, secureGet, secureSet, secureDel, platform } from './bridge.js';

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
  state: 'idle',        // idle | disconnected | offline | syncing | ok | error
  message: '',
  lastSync: 0,
  account: '',
  connected: false,
  platform,
};

function setStatus(patch) {
  Object.assign(status, patch);
  for (const cb of [...listeners]) { try { cb(status); } catch (e) { console.error(e); } }
}

/* ---------------- Tokens ---------------- */

let tokens = null;

export async function initTokens() {
  tokens = await secureGet('tokens');
  setStatus({
    connected: !!tokens?.refresh_token,
    account: tokens?.email || '',
  });
  return tokens;
}

function saveTokens(t) {
  tokens = t;
  return secureSet('tokens', t);
}

export async function disconnect() {
  tokens = null;
  secureDel('tokens');
  await db.kvDel('driveFolder');
  await db.kvDel('driveDbFile');
  await db.kvDel('driveDbMd5');
  setStatus({ connected: false, account: '', state: 'idle', message: '' });
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
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token-Erneuerung fehlgeschlagen');
  await saveTokens({ ...tokens, access_token: data.access_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 });
  return tokens.access_token;
}

function clientId() {
  const id = db.getSetting('clientId') || '';
  if (!id) throw new Error('Keine Google Client-ID hinterlegt (Einstellungen → Google Drive)');
  return id;
}

/* ---------------- Auth-Flow ---------------- */

export function authUrl() {
  const scope = [SCOPES[db.getSetting('scopeMode') === 'full' ? 'full' : 'file'], BASE_SCOPE].join(' ');
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: PLACEHOLDER_REDIRECT,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: uid(),
  });
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
  setStatus({ state: 'syncing', message: 'Warte auf Google-Anmeldung …' });
  const res = await openAuth(url);
  if (res?.needsManual) return { needsManual: true, hint: res.hint };
  if (res?.error) {
    setStatus({ state: res.error === 'access_denied' ? 'disconnected' : 'error', message: fmtAuthError(res.error) });
    return { error: res.error };
  }
  return exchangeCode(res.code, res.redirectUri);
}

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
    email: '',
  };
  await saveTokens(t);
  setStatus({ connected: true, state: 'ok', message: '' });

  try {
    const at = await ensureAccess();
    const info = await (await fetch(USERINFO, { headers: { Authorization: `Bearer ${at}` } })).json();
    if (info.email) { t.email = info.email; await saveTokens(t); setStatus({ account: info.email }); }
  } catch { /* userinfo ist optional */ }

  return { ok: true };
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

function snapshot() {
  const recs = [...db.state.records.values()];
  return {
    v: 1,
    app: 'secondmind',
    device: await_deviceId(),
    updatedAt: Date.now(),
    records: recs.map((r) => ({ ...r })),
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

async function pull(folderId) {
  const fileId = await findDbFile(folderId);
  if (!fileId) return false;

  const metaRes = await api(`/files/${fileId}?fields=id,md5Checksum,modifiedTime,version`);
  if (!metaRes.ok) return false;
  const meta = await metaRes.json();
  const seen = await db.kvGet('driveDbMd5');

  if (meta.md5Checksum && meta.md5Checksum === seen) return false;

  const content = await api(`/files/${fileId}?alt=media`);
  if (!content.ok) throw new Error('Drive-Datei konnte nicht gelesen werden');
  const remote = await content.json();

  const changed = db.mergeRecords(Array.isArray(remote.records) ? remote.records : []);
  await db.kvSet('driveDbMd5', meta.md5Checksum || '');
  await db.kvSet('driveDbModified', meta.modifiedTime || '');
  return changed;
}

async function push(folderId) {
  let fileId = await findDbFile(folderId);
  const payload = snapshot();
  const dirty = new Set(payload.records.filter((r) => r.dirty).map((r) => r.id));
  if (!dirty.size) return false;

  const stamp = new Map(payload.records.filter((r) => r.dirty).map((r) => [r.id, r.updatedAt]));
  const body = JSON.stringify(payload);

  if (!fileId) {
    const meta = { name: DB_FILE, parents: [folderId], mimeType: 'application/json' };
    const res = await api('/files?fields=id,md5Checksum,modifiedTime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    });
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
      return push(folderId);
    }
    if (!up.ok) throw new Error('Sync-Upload fehlgeschlagen');
    const fin = await up.json();
    await db.kvSet('driveDbMd5', fin.md5Checksum || '');
  }

  // Dirty-Flags nur löschen, wenn sich der Datensatz nicht erneut geändert hat
  for (const rec of db.state.records.values()) {
    if (stamp.has(rec.id) && stamp.get(rec.id) === rec.updatedAt) rec.dirty = 0;
  }
  return true;
}

/* ---------------- Anhänge (Fotos & Dateien) ---------------- */

async function uploadAttachment(fileRef) {
  const blob = await db.getBlob(fileRef.id);
  if (!blob) { fileRef.state = 'missing'; return false; }
  const folderId = await findOrCreateFolder();

  const meta = {
    name: `sm-file-${fileRef.id}-${fileRef.name}`,
    parents: [folderId],
    mimeType: fileRef.type || 'application/octet-stream',
    appProperties: { sm: 'file' },
  };

  let driveId;
  if (blob.size > 6 * 1024 * 1024) {
    // Resumable-Upload für größere Dateien
    const start = await api('/files?uploadType=resumable&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': meta.mimeType, 'X-Upload-Content-Length': String(blob.size) },
      body: JSON.stringify(meta),
    }, UPLOAD);
    if (!start.ok) throw new Error('Upload-Start fehlgeschlagen');
    const loc = start.headers.get('location');
    const put = await fetch(loc, {
      method: 'PUT',
      headers: { 'Content-Type': meta.mimeType, 'Content-Range': `bytes 0-${blob.size - 1}/${blob.size}` },
      body: blob,
    });
    const out = await put.json();
    driveId = out.id;
  } else {
    const boundary = 'sm' + uid();
    const ctype = `multipart/related; boundary=${boundary}`;
    const head = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(meta),
      `\r\n--${boundary}\r\nContent-Type: ${meta.mimeType}\r\nContent-Transfer-Encoding: binary\r\n\r\n`,
    ], { type: ctype });
    const full = new Blob([head, blob, `\r\n--${boundary}--`], { type: ctype });
    const res = await api('/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': ctype },
      body: full,
    }, UPLOAD);
    if (!res.ok) throw new Error('Anhang-Upload fehlgeschlagen');
    driveId = (await res.json()).id;
  }
  if (!driveId) throw new Error('Anhang-Upload fehlgeschlagen');
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
    const blob = await res.blob();
    await db.putBlob(fileRef.id, blob);
    return blob;
  } catch (e) {
    console.warn('Anhang-Download', e);
    return null;
  }
}

/* ---------------- Tick ---------------- */

async function runSync({ full = true } = {}) {
  if (busy) return;
  if (!status.connected) { setStatus({ state: 'disconnected' }); return; }
  if (!navigator.onLine) { setStatus({ state: 'offline', message: 'Keine Verbindung – Änderungen bleiben lokal gespeichert' }); return; }

  busy = true;
  setStatus({ state: 'syncing', message: '' });
  try {
    const folderId = await findOrCreateFolder();
    if (full) await pull(folderId);

    const localDirty = db.hasDirty();
    if (localDirty) await push(folderId);

    await syncAttachments();
    if (db.hasDirty()) await push(folderId);

    setStatus({ state: 'ok', message: '', lastSync: Date.now() });
  } catch (e) {
    console.error('sync', e);
    setStatus({ state: 'error', message: e.message || 'Sync fehlgeschlagen' });
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
    interval: Number(db.getSetting('syncInterval')) || 60,
    platform: status.platform,
    scopeMode: db.getSetting('scopeMode'),
  };
}
