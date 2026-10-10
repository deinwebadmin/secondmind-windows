/* secondmind – db.js
   Lokale Datenbank (IndexedDB) + In-Memory-Spiegel + Settings + Event-Bus. */

import { uid, now, debounce } from './util.js';

const DB_NAME = 'secondmind';
const DB_VER = 1;

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

/* ---------------- State ---------------- */

export const state = {
  ready: false,
  records: new Map(),   // id -> Datensatz
  settings: { ...DEFAULT_SETTINGS },
};

export const recs = (kind) => [...state.records.values()].filter((r) => r.kind === kind && !r.deleted);
export const byId = (id) => state.records.get(id) || null;
export const itemsOfList = (listId) =>
  [...state.records.values()].filter((r) => r.kind === 'item' && r.listId === listId && !r.deleted);

export function allRecords() { return [...state.records.values()]; }

/* ---------------- Initialisierung ---------------- */

export async function loadAll() {
  const [records, kv] = await Promise.all([reqAll('records'), reqAll('kv')]);
  for (const r of records) state.records.set(r.id, r);

  const map = new Map(kv.map((e) => [e.k, e.v]));
  state.settings = { ...DEFAULT_SETTINGS, ...(map.get('settings') || {}) };

  state.ready = true;
  emit('change', { reason: 'load' });
  return state;
}

/* ---------------- Settings ---------------- */

export const getSetting = (k) => state.settings[k];
export const setSetting = (k, v) => {
  state.settings[k] = v;
  const cur = { ...state.settings };
  tx('kv', 'readwrite', (s) => s.put({ k: 'settings', v: cur })).catch(() => {});
  emit('settings', { key: k, value: v });
};

/* ---------------- KV (Sonstiges: Sync-Token, Drive-IDs) ---------------- */

export async function kvGet(k, fallback = null) {
  const v = await tx('kv', 'readonly', (s) => s.get(k));
  return v ? v.v : fallback;
}
export function kvSet(k, v) {
  return tx('kv', 'readwrite', (s) => s.put({ k, v })).catch((e) => console.warn('kvSet', e));
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
  tx('records', 'readwrite', (s) => s.put(rec)).catch((e) => console.error('put', e));
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
  tx('records', 'readwrite', (s) => s.put(base)).catch((e) => console.error('put', e));
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

export function putBlob(id, blob) {
  return tx('blobs', 'readwrite', (s) => s.put({ id, blob, at: now() })).catch((e) => console.error('blob', e));
}
export async function getBlob(id) {
  const r = await tx('blobs', 'readonly', (s) => s.get(id));
  return r?.blob || null;
}
export function delBlob(id) {
  return tx('blobs', 'readwrite', (s) => s.delete(id)).catch(() => {});
}

/* ---------------- Sync-Bridge (vom Sync-Modul genutzt) ---------------- */

/** Datensätze aus Drive einspielen – LWW-Merge nach updatedAt. */
export function mergeRecords(incoming) {
  let changed = false;
  for (const r of incoming) {
    if (!r || !r.id || !r.kind) continue;
    const local = state.records.get(r.id);
    if (!local) {
      const rec = { ...defaultsFor(r.kind), ...r, dirty: 0 };
      state.records.set(rec.id, rec);
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
    tx('records', 'readwrite', (s) => { for (const r of all) s.put(r); })
      .catch((e) => console.error('merge', e));
    notifyChange();
  }
  return changed;
}

/** Aktueller, noch nicht hochgeladener Datensatz-Bestand. */
export const dirtyRecords = () => [...state.records.values()].filter((r) => r.dirty);
export const hasDirty = () => [...state.records.values()].some((r) => r.dirty);

export function clearAllDirty() {
  for (const r of state.records.values()) r.dirty = 0;
  tx('records', 'readwrite', (s) => { for (const r of state.records.values()) s.put(r); }).catch(() => {});
}

/** Alle lokalen Daten löschen. */
export async function wipeEverything() {
  for (const st of ['records', 'blobs', 'kv']) {
    await tx(st, 'readwrite', (s) => s.clear()).catch(() => {});
  }
  state.records.clear();
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
