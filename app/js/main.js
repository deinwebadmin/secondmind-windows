/* secondmind – main.js
   Start, Event-Verdrahtung, Rendering-Steuerung. */

import * as db from './db.js';
import * as sync from './sync.js';
import * as S from './sheets.js';
import { render, bindActions, setQuery, getQuery } from './ui.js';
import { applyTheme } from './views.js';
import { pruneEmptyItems } from './parts.js';
import { onRoute, start as startRouter, navigate } from './router.js';
import { platform } from './bridge.js';
import * as U from './update.js';
import * as gemini from './gemini.js';
import * as repeat from './repeat.js';
import { debounce, haptic } from './util.js';
import * as C from './crypto.js';

/* ---------------- Rendering mit Fokus-Schutz ---------------- */

let pendingRender = false;

function safeRender() {
  const ae = document.activeElement;
  const editing = ae && document.getElementById('view')?.contains(ae)
    && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
  if (editing) { pendingRender = true; return; }
  render();
}

document.addEventListener('focusout', () => {
  if (pendingRender) { pendingRender = false; safeRender(); }
}, true);

/* ---------------- Suche ---------------- */

function wireSearch() {
  const input = document.getElementById('search');
  const clear = document.getElementById('searchClear');

  const apply = debounce(() => {
    const q = input.value.trim();
    clear.hidden = !q;
    if (q && location.hash !== '#/' && location.hash !== '') navigate('#/');
    setQuery(q);
  }, 180);

  input.addEventListener('input', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; apply(); input.blur(); }
  });
  clear.addEventListener('click', () => {
    input.value = '';
    clear.hidden = true;
    setQuery('');
    input.focus();
  });
}

/* ---------------- Drawer ---------------- */

function wireDrawer() {
  const root = document.getElementById('drawerRoot');
  const open = () => {
    root.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('open')));
    updateDrawerStats();
  };
  const close = () => {
    root.classList.remove('open');
    setTimeout(() => { root.hidden = true; }, 380);
  };

  document.getElementById('logoBtn').addEventListener('click', () => {
    if (!root.hidden) close();
    navigate('#/');
  });
  document.getElementById('menuBtn').addEventListener('click', () => (root.hidden ? open() : close()));
  root.querySelector('.drawer-scrim').addEventListener('click', close);
  root.querySelectorAll('.drawer-nav a').forEach((a) => a.addEventListener('click', () => setTimeout(close, 10)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) close(); });

  window.__closeDrawer = close;
}

function updateDrawerStats() {
  const s = db.stats();
  const el = document.getElementById('drawerStats');
  if (el) el.textContent = `${s.notes} Notizen · ${s.lists} Listen · ${s.open} offen`;
}

/* ---------------- Kalender-Button (Topbar) ---------------- */

function wireCalBtn() {
  const btn = document.getElementById('calBtn');
  const apply = () => { btn.hidden = !db.getSetting('calendarEnabled'); };
  btn.addEventListener('click', () => navigate('#/kalender'));
  apply();
  db.on('settings', (p) => { if (p.key === 'calendarEnabled') apply(); });
}

/* ---------------- Gemini-Button (Topbar) ---------------- */

function wireGeminiBtn() {
  const btn = document.getElementById('geminiBtn');
  if (!btn) return;
  const apply = () => { btn.hidden = !gemini.isGeminiReady(); };
  btn.addEventListener('click', () => S.openGeminiChat());
  apply();
  db.on('settings', (p) => {
    if (p.key === 'geminiEnabled' || p.key === 'geminiApiKey') apply();
  });
}

/* ---------------- Sync-Status ---------------- */

const STATE_MAP = { ok: 'ok', syncing: 'syncing', offline: 'offline', error: 'error', expired: 'error', disconnected: 'waiting', idle: 'idle' };

function wireSyncStatus() {
  const dot = document.querySelector('#syncBtn .dot');
  const drawerSync = document.getElementById('drawerSync');

  sync.onStatus((s) => {
    dot.dataset.state = STATE_MAP[s.state] || 'idle';
    const text = s.state === 'ok' ? `Synchronisiert · ${s.account || ''}`.trim()
      : s.state === 'syncing' ? 'Synchronisiere …'
      : s.state === 'offline' ? 'Offline – Daten bleiben lokal'
      : s.state === 'error' ? (s.message || 'Sync-Fehler')
      : s.state === 'expired' ? 'Verbindung abgelaufen – erneut verknüpfen'
      : s.state === 'disconnected' ? 'Nicht verbunden'
      : 'Bereit';
    dot.parentElement.title = text;
    if (drawerSync) drawerSync.textContent = text;
  });

  document.getElementById('syncBtn').addEventListener('click', () => {
    if (sync.status.expired) { navigate('#/einstellungen'); return; }
    if (!sync.status.connected) { navigate('#/einstellungen'); return; }
    sync.syncNow();
    S.toast('Synchronisation gestartet');
  });
}

/* ---------------- FAB & Taps ---------------- */

function wireFab() {
  document.getElementById('fab').addEventListener('click', () => {
    haptic(8);
    S.openCreateMenu();
  });
}

function updateFab(route, params) {
  const fab = document.getElementById('fab');
  let show = route === 'home' || route === 'suche';
  if (route === 'liste') {
    // In der Wiederkehrend-Liste nutzt man den eigenen „＋“-Button
    const l = params?.id ? db.byId(params.id) : null;
    show = !(l && l.template === 'repeat');
  }
  fab.classList.toggle('hidden', !show);
}

/* ---------------- Start ---------------- */

/**
 * Onboarding-Zustand (A) ableiten:
 * - schon gewählt (none/google) -> nichts tun
 * - bestehende Verknüpfung -> Local-Modus nie erzwingen (A.5)
 * - vorhandene lokale Daten ohne Verknüpfung -> Local-Modus annehmen
 * - nichts von beidem -> frische Installation -> Begrüßungsseite
 * @returns {boolean} true, wenn die Begrüßungsseite gezeigt werden soll
 */
function decideSyncMode() {
  if (db.getSetting('syncMode')) return false;
  if (sync.status.connected) { db.setSetting('syncMode', 'google'); return false; }
  const hatDaten = db.allRecords().some((r) => r.id !== db.SETTINGS_ID);
  if (hatDaten) { db.setSetting('syncMode', 'none'); return false; }
  return true;
}

async function boot() {
  try {
    await db.loadAll();
  } catch (e) {
    console.error('Datenbank konnte nicht geöffnet werden', e);
    document.getElementById('view').innerHTML =
      '<div class="empty"><div class="e-ico">⚠️</div><div class="e-title">Speicher nicht verfügbar</div><div class="e-sub">Diese App benötigt lokalen Speicher (IndexedDB).</div></div>';
    return;
  }

  // Migration: alte Klartext-Daten einmalig verschlüsseln (idempotent).
  // Läuft vor dem ersten Interaktionsmöglichen – so gibt es kein Rennen
  // zwischen Migrationslauf und gleichzeitigen Änderungen.
  try { await db.migrateLocal(); } catch (e) { console.warn('Verschlüsselungs-Migration', e); }

  // Identität/Tokens früh laden – der Onboarding-Zustand hängt daran.
  try { await sync.initTokens(); } catch (e) { console.warn('Tokens konnten nicht gelesen werden', e); }

  applyTheme(db.getSetting('theme') || 'auto');

  // A: Onboarding-Zustand bestimmen (frisch / lokal / verbunden)
  const frisch = decideSyncMode();

  // Seed-Liste für wiederkehrende Aufgaben (einmalig, beim Löschen bleibt es weg)
  try { repeat.ensureRepeatList(); } catch (e) { console.warn('Repeat-Seed fehlgeschlagen', e); }

  bindActions();
  wireSearch();
  wireDrawer();
  wireCalBtn();
  wireGeminiBtn();
  wireSyncStatus();
  wireFab();

  // Datenänderungen → neu zeichnen
  db.on('change', safeRender);
  db.on('settings', (p) => {
    if (p.key === 'theme') applyTheme(p.value);
    updateDrawerStats();
  });

  // Routen
  // A.1: frische Installation ohne Entscheidung -> Begrüßungsseite mit
  // zwei Buttons. D.6: neuer Schlüssel -> "Schlüssel sichern" anbieten.
  if (frisch) navigate('#/willkommen', { replace: true });
  else if (C.wasKeyCreated() && !db.getSetting('keyBackupDone')) navigate('#/schluessel', { replace: true });

  onRoute((r) => {
    updateFab(r.name, r.params);
    if (window.__closeDrawer && !document.getElementById('drawerRoot').hidden) window.__closeDrawer();
    render();
  });
  startRouter();

  // Leere Punkte aufräumen, wenn man eine Ansicht verlässt
  window.addEventListener('hashchange', () => {
    setTimeout(() => { try { pruneEmptyItems(); } catch (e) { console.warn(e); } }, 500);
  });

  // Debug-/Entwickler-Schnittstelle
  window.secondmind = { db, sync, sheets: S, render, update: U, gemini, repeat };

  // Sync starten
  sync.startSync();

  // Beim Öffnen gleich Abgleich
  if (sync.status.connected) sync.syncNow();

  // Update-Wächter: alle 30 Minuten nach neuen Releases suchen (nur Plattform-Apps)
  U.startUpdateWatcher();

  console.info(`secondmind bereit (${platform})`);
}

boot();
