/* secondmind – db.js
   Lokale Datenbank (IndexedDB) + In-Memory-Spiegel + Settings + Event-Bus. */

import { uid, now, debounce } from './util.js';
import * as C from './crypto.js';

const DB_NAME = 'secondmind';
const DB_VER = 1;

/* Fixe ID des synchronisierten Settings-Datensatzes: er liegt als singleton
   in der Drive-Datei "secondmind.db.json" und überträgt Einstellungen
   (Theme, Kalender/Memory, OAuth-Client-ID, …) automatisch auf neue Geräte. */
export const SETTINGS_ID = '__settings__';

const DEFAULT_SETTINGS = {
  confirmDelete: true,      // vor dem Löschen fragen
  memoryEnabled: true,      // Memory-Funktion an/aus
  archiveEnabled: true,     // Archiv
  calendarEnabled: true,    // Kalender-Funktion an/aus
  syncInterval: 60,         // Sekunden
  clientId: '',             // Google OAuth Client-ID
  scopeMode: 'file',        // 'file' (drive.file) | 'full' (drive)
  theme: 'auto',            // auto | light | dark
  showDone: true,           // Historie im Listen-Detail anzeigen
  geminiEnabled: false,     // optionale Gemini-KI ein/aus
  geminiApiKey: '',         // Gemini-API-Key (bleibt lokal)
  geminiModel: 'gemini-3.8-flash', // KI-Modell (Dropdown in den Einstellungen)
  geminiMode: 'custom',     // 'full' = alle Einträge | 'custom' = nur exponierte
  geminiExposedLists: [],   // exponierte Listen-IDs (Modus custom)
  geminiExposedNotes: [],   // exponierte Notiz-IDs (Modus custom)
  syncMode: '',             // '' = noch nie gewählt | 'none' = nur lokal | 'google' = Drive
  keyBackupDone: false,     // Schlüssel-Sicherung erledigt (D.6)
};

/* ---------------- Event-Bus ---------------- */

const listeners = new Map();

export function on(evt, cb) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(cb);
  return () => listeners.get(evt)?.delete(cb);
}

export function emit(evt, payload) {
  const set = listeners.get(evt);
  if (set) for (const cb of [...set]) { try { cb(payload); } catch (e) { console.error(e); } }
}

/* ---------------- IndexedDB ---------------- */

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return open().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaktion abgebrochen'));
  }));
}

function reqAll(store) {
  return tx(store, 'readonly', (s) => s.getAll());
}

/* ---------------- Chiffretext-Hüllen ----------------
   Gespeichert wird immer das Envelope {id, updatedAt, type, rev, keyId, iv,
   ct}; unverschlüsselt bleiben ausschließlich id/updatedAt/type/rev/dirty –
   nötig für Sortierung, LWW und Filter. Klartext existiert nur im Speicher. */

async function putRec(rec) {
  if (!C.hasKey()) { await tx('records', 'readwrite', (s) => s.put(rec)); return; }
  const env = await C.encodeRecord(rec);
  await tx('records', 'readwrite', (s) => s.put(env));
}

async function putEnvelopes(envs) {
  if (!envs.length) return;
  await tx('records', 'readwrite', (s) => { for (const e of envs) s.put(e); });
}

async function encodeKv(k, v) {
  if (!C.hasKey()) return { k, v };
  const env = await C.encodeRecord({ id: 'kv:' + k, kind: 'kv', updatedAt: 0, v });
  return { k, rev: env.rev, keyId: env.keyId, iv: env.iv, ct: env.ct };
}

async function decodeKv(e) {
  if (!e) return undefined;
  if (!e.ct) return e.v;                          // Legacy-Klartext (Migration)
  const rec = await C.decodeRecord({
    id: 'kv:' + e.k, type: 'kv', updatedAt: 0, iv: e.iv, ct: e.ct, keyId: e.keyId, rev: e.rev,
  });
  return rec ? rec.v : undefined;
}

async function putKv(k, v) {
  const env = await encodeKv(k, v);
  await tx('kv', 'readwrite', (s) => s.put(env));
}

async function putKvs(envs) {
  if (!envs.length) return;
  await tx('kv', 'readwrite', (s) => { for (const e of envs) s.put(e); });
}

/* ---------------- State ---------------- */

export const state = {
  ready: false,
  records: new Map(),   // id -> Datensatz (Klartext im Speicher)
  settings: { ...DEFAULT_SETTINGS },
  /* Versiegelte Envelopes: Sätze, die mit dem (noch) fehlenden Schlüssel
     nicht lesbar sind – werden aufbewahrt statt weggeworfen und nach dem
     Pairing erneut entschlüsselt. */
  sealed: new Map(),    // id -> Envelope
  sealedKv: new Map(),  // kv-Schlüssel -> Envelope
  /* true, wenn die Einstellungen selbst unlesbar sind (Schlüssel fehlt).
     Dann wird der lokale Default-Stand nicht als neu ins Drive gepusht. */
  settingsSealed: false,
};

export const recs = (kind) => [...state.records.values()].filter((r) => r.kind === kind && !r.deleted);
export const byId = (id) => state.records.get(id) || null;
export const itemsOfList = (listId) =>
  [...state.records.values()].filter((r) => r.kind === 'item' && r.listId === listId && !r.deleted);

export function allRecords() { return [...state.records.values()]; }

/* ---------------- Initialisierung ---------------- */

export async function loadAll() {
  // 1) Geräteschlüssel (DEK) laden – erst danach lässt sich lesen.
  //    Ohne WebCrypto bleibt der Klartext-Pfad (wird in den Einstellungen gemeldet).
  try { await C.init(); } catch (e) { console.error('Schlüssel nicht verfügbar', e); }

  // 2) Datensätze entschlüsseln (versiegelte liegen bleiben)
  await readRecordsIntoState();

  // 3) Einstellungen
  await refreshSettings();

  state.ready = true;
  emit('change', { reason: 'load' });
  return state;
}

/** Rohdaten aus IndexedDB lesen, entschlüsseln, in den Speicher spiegeln. */
async function readRecordsIntoState() {
  const records = await reqAll('records');
  state.records.clear();
  state.sealed.clear();
  for (const raw of records) {
    if (C.isEncoded(raw)) {
      const rec = await C.decodeRecord(raw);
      if (rec) state.records.set(rec.id, rec);
      else state.sealed.set(raw.id, raw);        // fremder/fehlender Schlüssel
    } else {
      state.records.set(raw.id, raw);            // Legacy-Klartext (Migration)
    }
  }
}

/** KV laden (inkl. Einstellungs-Singleton) und übernehmen. */
async function refreshSettings() {
  const kv = await reqAll('kv');
  const map = new Map();
  state.sealedKv.clear();
  for (const e of kv) {
    const v = await decodeKv(e);
    if (v === undefined) {
      if (e.ct) state.sealedKv.set(e.k, e);      // ohne Schlüssel unlesbar
      continue;
    }
    map.set(e.k, v);
  }
  // Einstellungen unlesbar (fremder/fehlender Schlüssel): der Default-Stand
  // darf dann nicht als "neu" ins Drive gepusht werden – sonst würden gute
  // Einstellungen (Client-ID, Gemini-Key, …) aller anderen Geräte überschrieben.
  state.settingsSealed = state.sealedKv.has('settings');
  state.settings = { ...DEFAULT_SETTINGS, ...(map.get('settings') || {}) };

  // Synchronisierter Settings-Datensatz: kommt er frisch aus dem Drive
  // (neuer als die lokale Kopie), gewinnt er – so übernimmt ein neues
  // Gerät sofort alle Einstellungen des ersten Geräts.
  const srec = state.records.get(SETTINGS_ID);
  if (srec?.data && (srec.updatedAt || 0) > (map.get('settingsAt') || 0)) {
    applySettingsRecord(srec);
  } else if (!srec) {
    // Upgrade-Pfad: bereits angepasste Einstellungen aus früheren Versionen
    // einmalig ins Drive heben. updatedAt = 0, damit ein vorhandener
    // Remote-Datensatz beim ersten Pull immer gewinnt (kein Überschreiben).
    // Frische Installationen (nur Defaults) legen hier bewusst nichts an.
    const customized = Object.keys(DEFAULT_SETTINGS).some((k) => state.settings[k] !== DEFAULT_SETTINGS[k]);
    if (customized) putSettingsRecord(0);
  }
}

/* ---------------- Settings ---------------- */

export const getSetting = (k) => state.settings[k];

export const setSetting = (k, v) => {
  state.settings[k] = v;
  // Einstellungen unlesbar: den versiegelten kv-Satz NICHT überschreiben,
  // sonst wäre das Original (mit Client-ID, API-Key, …) dauerhaft zerstört.
  // Die Änderung gilt lokal in diesem Start und wird nach dem Schlüssel-
  // import ohnehin neu geschrieben.
  if (state.settingsSealed) {
    emit('settings', { key: k, value: v });
    return;
  }
  const at = now();
  Promise.all([putKv('settings', { ...state.settings }), putKv('settingsAt', at)]).catch(() => {});
  putSettingsRecord(at);          // wandert über den Sync ins Drive
  emit('settings', { key: k, value: v });
};

/** Singleton-Datensatz für die Settings anlegen/aktualisieren (dirty -> Sync trägt ihn mit). */
function putSettingsRecord(at) {
  // Einstellungen unlesbar (Schlüssel fehlt): der lokale Default-Stand darf
  // nicht als neu markiert werden – sonst verdrängt er im Drive die echten
  // Einstellungen aller Geräte (Client-ID, API-Key, …). Lokal wird gespeichert.
  if (state.settingsSealed) return;
  const rec = state.records.get(SETTINGS_ID) || {
    id: SETTINGS_ID, kind: 'settings', createdAt: at, updatedAt: 0, deleted: 0, dirty: 1, data: {},
  };
  rec.data = { ...state.settings };
  rec.updatedAt = at;
  rec.dirty = 1;
  state.records.set(rec.id, rec);
  putRec(rec).catch((e) => console.error('put settings', e));
  notifyChange();
  notifyDirty();
}

/**
 * Einstellungen aus dem (neueren) synchronisierten Datensatz übernehmen.
 * LWW gilt nur für Felder, die der Datensatz auch wirklich führt: ein
 * fehlendes Feld (andere App-Version, anderes Gerät) darf einen lokal
 * gesetzten Wert – etwa die OAuth Client-ID – nicht auf den Default
 * zurücksetzen. Ein explizit leer gesetztes Feld wird dagegen übernommen,
 * damit ein bewusstes Löschen auf einem Gerät syncen kann.
 */
function applySettingsRecord(rec) {
  const before = { ...state.settings };
  const incoming = rec.data || {};
  const next = { ...state.settings };
  for (const k of new Set([...Object.keys(DEFAULT_SETTINGS), ...Object.keys(incoming)])) {
    next[k] = (k in incoming) ? incoming[k] : (k in state.settings ? state.settings[k] : DEFAULT_SETTINGS[k]);
  }
  state.settings = next;
  const at = rec.updatedAt || 0;
  // Lokal unlesbare Einstellungen nicht überschreiben (siehe setSetting):
  // der versiegelte kv-Satz ist die einzige Kopie mit den alten Werten.
  if (!state.settingsSealed) {
    Promise.all([putKv('settings', { ...next }), putKv('settingsAt', at)]).catch(() => {});
  }
  for (const k of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (before[k] !== next[k]) emit('settings', { key: k, value: next[k] });
  }
}

/* ---------------- KV (Sonstiges: Sync-Token, Drive-IDs) ---------------- */

export async function kvGet(k, fallback = null) {
  const e = await tx('kv', 'readonly', (s) => s.get(k));
  if (!e) return fallback;
  const v = await decodeKv(e);
  if (v === undefined) {
    if (e.ct) state.sealedKv.set(k, e);          // ohne Schlüssel unlesbar
    return fallback;
  }
  return v;
}
export function kvSet(k, v) {
  return putKv(k, v).catch((e) => console.warn('kvSet', e));
}
export function kvDel(k) {
  return tx('kv', 'readwrite', (s) => s.delete(k)).catch(() => {});
}

/* ---------------- Schreiben ---------------- */

const notifyChange = debounce(() => emit('change', { reason: 'write' }), 40);
const notifyDirty = debounce(() => emit('dirty'), 1200);

function touch(rec) {
  rec.updatedAt = now();
  rec.dirty = 1;
  state.records.set(rec.id, rec);
  state.sealed.delete(rec.id);                   // jetzt lesbar: versiegelt ist obsolet
  putRec(rec).catch((e) => console.error('put', e));
  notifyChange();
  notifyDirty();
}

/** Neuen Datensatz anlegen (nicht für Sync-Vorgänge nutzen). */
export function create(kind, patch = {}) {
  const base = {
    id: uid(),
    kind,
    createdAt: now(),
    updatedAt: now(),
    deleted: 0,
    dirty: 1,
    ...defaultsFor(kind),
    ...patch,
  };
  state.records.set(base.id, base);
  putRec(base).catch((e) => console.error('put', e));
  notifyChange();
  notifyDirty();
  return base;
}

function defaultsFor(kind) {
  switch (kind) {
    case 'note':
      return { title: '', text: '', bg: '', tags: [], tagColors: {}, links: [], files: [], linkedItems: [], pinned: 0, archived: 0 };
    case 'list':
      return { title: '', template: 'standard', bg: '', tags: [], tagColors: {}, pinned: 0, archived: 0, emoji: '' };
    case 'item':
      return {
        listId: '', parentId: null, text: '', order: now(), color: 'neutral',
        day: null, done: 0, doneAt: 0, noteId: null, state: 'active',
        originTitle: '', archivedAt: 0, memoryAt: 0,
        plan: null,           // Kalender: { date: 'YYYY-MM-DD', time: 'HH:MM', dur: Minuten }
        tagColors: {},        // Farben je Tag (Listen & Notizen)
      };
    default:
      return {};
  }
}

/** Teil-Update; setzt updatedAt + dirty. */
export function update(id, patch) {
  const rec = state.records.get(id);
  if (!rec) return null;
  Object.assign(rec, patch);
  touch(rec);
  return rec;
}

/** Soft-Delete (Tombstone – für Sync). */
export function softDelete(id) {
  const rec = state.records.get(id);
  if (!rec) return;
  rec.deleted = 1;
  rec.deletedAt = now();
  touch(rec);
}

/** Endgültig aus der DB entfernen (nach Sync/Import). */
export function purge(id) {
  state.records.delete(id);
  state.sealed.delete(id);
  tx('records', 'readwrite', (s) => s.delete(id)).catch(() => {});
  notifyChange();
}

/** Kinder eines Punktes rekursiv als IDs. */
export function childIds(id) {
  const out = [];
  const walk = (pid) => {
    for (const r of state.records.values()) {
      if (r.kind === 'item' && r.parentId === pid && !r.deleted) { out.push(r.id); walk(r.id); }
    }
  };
  walk(id);
  return out;
}

/** Gesamten Zweig (Punkt + Kinder) weich löschen. */
export function softDeleteTree(id) {
  for (const cid of childIds(id)) softDelete(cid);
  softDelete(id);
}

/** Komplette Liste (inkl. Punkten) weich löschen. */
export function softDeleteList(listId) {
  for (const r of state.records.values()) {
    if (r.kind === 'item' && r.listId === listId && !r.deleted) softDelete(r.id);
  }
  softDelete(listId);
}

/* ---------------- Blobs (Fotos & Dateien lokal) ---------------- */

export async function putBlob(id, blob) {
  try {
    const at = now();
    if (!C.hasKey()) { await tx('blobs', 'readwrite', (s) => s.put({ id, blob, at })); return; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const env = await C.encodeBytes(bytes);
    await tx('blobs', 'readwrite', (s) => s.put({ id, at, type: blob.type || '', ...env }));
  } catch (e) { console.error('blob', e); }
}
export async function getBlob(id) {
  const r = await tx('blobs', 'readonly', (s) => s.get(id));
  if (!r) return null;
  if (r.ct) {
    const bytes = await C.decodeBytes(r);         // unlesbar -> null (kein Klartext-Rückfall)
    return bytes ? new Blob([bytes], { type: r.type || '' }) : null;
  }
  return r.blob || null;
}
export function delBlob(id) {
  return tx('blobs', 'readwrite', (s) => s.delete(id)).catch(() => {});
}

/** Eine Menge Datensätze wegschreiben (Klartext im Speicher -> Envelope). */
async function writeAllRecords(list) {
  if (!C.hasKey()) { await tx('records', 'readwrite', (s) => { for (const r of list) s.put(r); }); return; }
  const envs = [];
  for (const r of list) envs.push(await C.encodeRecord(r));
  await putEnvelopes(envs);
}

/* ---------------- Verschlüsselung: Migration & Schlüsselübergabe ---------------- */

/** Versiegelte (unlesbare) Envelopes – bleiben immer im Snapshot des Push. */
export const sealedRecords = () => [...state.sealed.values()];

/** Nicht lesbare Envelopes aus Drive aufbewahren (idempotent, kein Datenverlust). */
export function keepSealed(envelopes) {
  let added = 0;
  const toWrite = [];
  for (const env of envelopes || []) {
    if (!env || !env.id || !C.isEncoded(env)) continue;
    if (state.records.has(env.id)) continue;      // lokale lesbare Kopie gewinnt
    state.sealed.set(env.id, env);
    toWrite.push(env);
    added++;
  }
  if (toWrite.length) {
    tx('records', 'readwrite', (s) => { for (const e of toWrite) s.put(e); }).catch(() => {});
  }
  return added;
}

/**
 * Migration: bestehende Klartext-Daten einmalig verschlüsseln.
 * Idempotent – nur geschrieben wird, was noch Klartext ist. Der Nutzer kann
 * währenddessen weiterarbeiten (eigene Transaktionen, kein Sperrfenster).
 * @returns Anzahl umgeschriebener Einträge
 */
export async function migrateLocal() {
  if (!C.hasKey()) return 0;
  const [records, kv, blobs] = await Promise.all([reqAll('records'), reqAll('kv'), reqAll('blobs')]);
  const recEnvs = [];
  for (const raw of records) if (!C.isEncoded(raw)) recEnvs.push(await C.encodeRecord(raw));
  const kvEnvs = [];
  for (const e of kv) if (!e.ct) kvEnvs.push(await encodeKv(e.k, e.v));
  const blobEnvs = [];
  for (const b of blobs) {
    if (b.ct || !b.blob) continue;
    const bytes = new Uint8Array(await b.blob.arrayBuffer());
    const env = await C.encodeBytes(bytes);
    blobEnvs.push({ id: b.id, at: b.at, type: b.type || '', ...env });
  }
  await putEnvelopes(recEnvs);
  await putKvs(kvEnvs);
  if (blobEnvs.length) await tx('blobs', 'readwrite', (s) => { for (const b of blobEnvs) s.put(b); });
  return recEnvs.length + kvEnvs.length + blobEnvs.length;
}

/** Versiegelte Sätze nach dem Vorhandensein eines Schlüssels erneut öffnen. */
export async function redecodeSealed() {
  let n = 0;
  if (state.sealed.size) {
    const raw = await reqAll('records');
    for (const env of raw) {
      if (!C.isEncoded(env)) continue;
      const rec = await C.decodeRecord(env);
      if (!rec) continue;
      const local = state.records.get(rec.id);
      if (local && local.updatedAt >= rec.updatedAt) { state.sealed.delete(rec.id); continue; }
      state.records.set(rec.id, rec);
      state.sealed.delete(rec.id);
      n++;
    }
  }
  if (state.sealedKv.size || n) await refreshSettings();
  if (n) { notifyChange(); notifyDirty(); }
  return n;
}

/**
 * Schlüsselübergabe (Pairing oder Import der .smkey-Datei):
 * erst mit dem alten Schlüssel alles lesen, dann umschalten und mit der
 * neuen DEK neu wegschreiben – so gehen lokale Änderungen nicht verloren.
 * @returns die vorherige DEK (Base64) oder null
 */
export async function adoptKey(newKeyB64) {
  // 1) Aktuell Lesbares in den Speicher holen (alter Schlüssel aktiv)
  const kvPlain = [];
  for (const e of await reqAll('kv')) {
    const v = await decodeKv(e);
    if (v !== undefined) kvPlain.push([e.k, v]);
  }
  const blobPlan = [];
  for (const b of await reqAll('blobs')) {
    let bytes = null;
    try {
      if (b.ct) bytes = await C.decodeBytes(b);
      else if (b.blob) bytes = new Uint8Array(await b.blob.arrayBuffer());
    } catch { /* unlesbar: liegen lassen */ }
    blobPlan.push({ id: b.id, at: b.at, type: b.type || '', bytes });
  }

  // 2) Umschalten
  const previous = await C.adoptKey(newKeyB64);

  // 3) Mit der neuen DEK neu wegschreiben
  await writeAllRecords([...state.records.values()]);
  await putKvs(await Promise.all(kvPlain.map(([k, v]) => encodeKv(k, v))));
  for (const b of blobPlan) {
    if (!b.bytes) continue;                       // unlesbarer Blob bleibt versiegelt
    try {
      const env = await C.encodeBytes(b.bytes);
      await tx('blobs', 'readwrite', (s) => s.put({ id: b.id, at: b.at, type: b.type, ...env }));
    } catch (e) { console.error('blob Re-Encode', e); }
  }

  // 4) Versiegelte Sätze mit dem neuen Schlüssel öffnen
  await redecodeSealed();
  notifyChange();
  return previous;
}

/* ---------------- Sync-Bridge (vom Sync-Modul genutzt) ---------------- */

/** Datensätze aus Drive einspielen – LWW-Merge nach updatedAt. */
export function mergeRecords(incoming) {
  let changed = false;
  const hadSettings = state.records.has(SETTINGS_ID);
  const settingsBefore = state.records.get(SETTINGS_ID)?.updatedAt || 0;
  for (const r of incoming) {
    if (!r || !r.id || !r.kind) continue;
    const local = state.records.get(r.id);
    if (!local) {
      const rec = { ...defaultsFor(r.kind), ...r, dirty: 0 };
      state.records.set(rec.id, rec);
      state.sealed.delete(rec.id);                // jetzt lesbar -> nicht mehr versiegelt
      changed = true;
      continue;
    }
    if (r.updatedAt > local.updatedAt) {
      Object.assign(local, r, { dirty: 0 });
      changed = true;
    }
  }
  if (changed) {
    const all = [...state.records.values()];
    writeAllRecords(all).catch((e) => console.error('merge', e));
    // Einstellungen aus dem Drive übernehmen (neueres Gerät gewinnt;
    // beim Einspielen in eine frische Datenbank immer)
    const srec = state.records.get(SETTINGS_ID);
    if (srec && (!hadSettings || (srec.updatedAt || 0) > settingsBefore)) applySettingsRecord(srec);
    notifyChange();
  }
  return changed;
}

/** Aktueller, noch nicht hochgeladener Datensatz-Bestand. */
export const dirtyRecords = () => [...state.records.values()].filter((r) => r.dirty);
export const hasDirty = () => [...state.records.values()].some((r) => r.dirty);

export function clearAllDirty() {
  for (const r of state.records.values()) r.dirty = 0;
  writeAllRecords([...state.records.values()]).catch(() => {});
}

/** Alle lokalen Daten löschen. */
export async function wipeEverything() {
  for (const st of ['records', 'blobs', 'kv']) {
    await tx(st, 'readwrite', (s) => s.clear()).catch(() => {});
  }
  state.records.clear();
  state.sealed.clear();
  state.sealedKv.clear();
  state.settings = { ...DEFAULT_SETTINGS };
  emit('change', { reason: 'wipe' });
}

/** Zähler für Drawer-Statistik */
export function stats() {
  const live = [...state.records.values()].filter((r) => !r.deleted);
  return {
    notes: live.filter((r) => r.kind === 'note' && !r.archived).length,
    lists: live.filter((r) => r.kind === 'list' && !r.archived).length,
    open: live.filter((r) => r.kind === 'item' && r.state === 'active' && !r.done).length,
    archived: live.filter((r) => (r.kind === 'item' && r.state === 'archived') || ((r.kind === 'note' || r.kind === 'list') && r.archived)).length,
    memory: live.filter((r) => r.kind === 'item' && r.state === 'memory').length,
  };
}
