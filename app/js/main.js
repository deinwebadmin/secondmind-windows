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
import { debounce, haptic } from './util.js';

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

/* ---------------- Sync-Status ---------------- */

const STATE_MAP = { ok: 'ok', syncing: 'syncing', offline: 'offline', error: 'error', disconnected: 'waiting', idle: 'idle' };

function wireSyncStatus() {
  const dot = document.querySelector('#syncBtn .dot');
  const drawerSync = document.getElementById('drawerSync');

  sync.onStatus((s) => {
    dot.dataset.state = STATE_MAP[s.state] || 'idle';
    const text = s.state === 'ok' ? `Synchronisiert · ${s.account || ''}`.trim()
      : s.state === 'syncing' ? 'Synchronisiere …'
      : s.state === 'offline' ? 'Offline – Daten bleiben lokal'
      : s.state === 'error' ? (s.message || 'Sync-Fehler')
      : s.state === 'disconnected' ? 'Nicht verbunden'
      : 'Bereit';
    dot.parentElement.title = text;
    if (drawerSync) drawerSync.textContent = text;
  });

  document.getElementById('syncBtn').addEventListener('click', () => {
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

function updateFab(route) {
  const fab = document.getElementById('fab');
  const show = route === 'home' || route === 'liste' || route === 'suche';
  fab.classList.toggle('hidden', !show);
}

/* ---------------- Start ---------------- */

async function boot() {
  try {
    await db.loadAll();
  } catch (e) {
    console.error('Datenbank konnte nicht geöffnet werden', e);
    document.getElementById('view').innerHTML =
      '<div class="empty"><div class="e-ico">⚠️</div><div class="e-title">Speicher nicht verfügbar</div><div class="e-sub">Diese App benötigt lokalen Speicher (IndexedDB).</div></div>';
    return;
  }

  applyTheme(db.getSetting('theme') || 'auto');

  bindActions();
  wireSearch();
  wireDrawer();
  wireCalBtn();
  wireSyncStatus();
  wireFab();

  // Datenänderungen → neu zeichnen
  db.on('change', safeRender);
  db.on('settings', (p) => {
    if (p.key === 'theme') applyTheme(p.value);
    updateDrawerStats();
  });

  // Routen
  onRoute((r) => {
    updateFab(r.name);
    if (window.__closeDrawer && !document.getElementById('drawerRoot').hidden) window.__closeDrawer();
    render();
  });
  startRouter();

  // Leere Punkte aufräumen, wenn man eine Ansicht verlässt
  window.addEventListener('hashchange', () => {
    setTimeout(() => { try { pruneEmptyItems(); } catch (e) { console.warn(e); } }, 500);
  });

  // Debug-/Entwickler-Schnittstelle
  window.secondmind = { db, sync, sheets: S, render, update: U };

  // Sync starten
  await sync.initTokens();
  sync.startSync();

  // Beim Öffnen gleich Abgleich
  if (sync.status.connected) sync.syncNow();

  // Update-Wächter: alle 30 Minuten nach neuen Releases suchen (nur Plattform-Apps)
  U.startUpdateWatcher();

  console.info(`secondmind bereit (${platform})`);
}

boot();
