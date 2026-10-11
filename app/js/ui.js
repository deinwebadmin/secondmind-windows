/* secondmind – ui.js
   Ansichten: Start, Suche, Listen-Detail + globale Aktions-Delegation. */

import * as db from './db.js';
import * as S from './sheets.js';
import * as sync from './sync.js';
import { esc, ICON, fmtRel, haptic, WEEKDAYS, WEEKDAYS_SHORT, todayIndex, tagChip } from './util.js';
import {
  listCardHtml, noteCardHtml, parentGroupHtml, cardSwipeHtml,
  bindSwipes, bindItemDrag, toggleItem, addParentItem, addChildItem, pruneEmptyItems, tplInfo, cardStyle,
  archiveItemAction,
} from './parts.js';
import {
  renderNote, renderArchive, renderMemory, renderSettings, renderCalendar, emptyState, exportData, applyTheme, releasePreview,
} from './views.js';
import { navigate, parse } from './router.js';
import { checkForUpdate } from './update.js';

let query = '';
let pendingFocus = null;
let histOpen = true;

export function setQuery(q) { query = q.trim(); render(); }
export function getQuery() { return query; }

/* ============================================================
   Render-Dispatch
   ============================================================ */

export function render() {
  const route = parse();
  const v = document.getElementById('view');

  switch (route.name) {
    case 'liste': renderList(route.params.id); break;
    case 'notiz': renderNote(route.params.id); break;
    case 'archiv': renderArchive(); break;
    case 'memory': renderMemory(); break;
    case 'einstellungen': renderSettings(); break;
    case 'kalender': renderCalendar(); break;
    default:
      if (query) renderSearch();
      else renderHome();
  }

  updateTabs(route.name);
  applyPendingFocus();
  bindSwipes(v);
}

function applyPendingFocus() {
  if (!pendingFocus) return;
  const el = document.querySelector(`[data-edit="${pendingFocus}"]`);
  pendingFocus = null;
  if (el) {
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function updateTabs(name) {
  document.querySelectorAll('.drawer-nav a').forEach((a) => {
    const r = a.dataset.route;
    a.classList.toggle('active', (r === 'home' && name === 'home') || r === name);
  });
  document.getElementById('calBtn')?.classList.toggle('active', name === 'kalender');
}

/* ============================================================
   Start-Ansicht
   ============================================================ */

function renderHome() {
  const lists = db.recs('list').filter((l) => !l.archived);
  const notes = db.recs('note').filter((n) => !n.archived);

  const pinnedLists = lists.filter((l) => l.pinned);
  const pinnedNotes = notes.filter((n) => n.pinned);
  const otherLists = lists.filter((l) => !l.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
  const otherNotes = notes.filter((n) => !n.pinned).sort((a, b) => b.updatedAt - a.updatedAt);

  let html = `<div class="view-title">secondmind <span class="count">${lists.length + notes.length} Elemente</span></div>`;

  if (!lists.length && !notes.length) {
    html += emptyState('✨', 'Noch alles leer',
      'Erstelle mit dem Plus-Button unten rechts deine erste Notiz oder To-Do-Liste.',
      `<button class="btn" data-act="create" style="max-width:260px;margin:20px auto 0">Erste Notiz erstellen</button>`);
    document.getElementById('view').innerHTML = html;
    return;
  }

  const pinned = [...pinnedLists, ...pinnedNotes];
  if (pinned.length) {
    html += `<div class="section-head"><h2>Angepinnt</h2></div>`;
    html += pinned.map((r) => swipeCard(r)).join('');
  }

  if (otherLists.length) {
    html += `<div class="section-head"><h2>To-Do-Listen</h2></div>`;
    html += otherLists.map((r) => swipeCard(r)).join('');
  }

  if (otherNotes.length) {
    html += `<div class="section-head"><h2>Notizen</h2></div>`;
    html += otherNotes.map((r) => swipeCard(r)).join('');
  }

  const v = document.getElementById('view');
  v.innerHTML = html;
  bindSwipes(v);
}

function swipeCard(r) {
  const inner = r.kind === 'list' ? listCardHtml(r) : noteCardHtml(r);
  return cardSwipeHtml(inner, { id: r.id, mode: 'home' });
}

/* ============================================================
   Suche
   ============================================================ */

function renderSearch() {
  const q = query.toLowerCase();
  const hit = (s) => String(s || '').toLowerCase().includes(q);

  const lists = db.recs('list').filter((l) => !l.archived &&
    (hit(l.title) || (l.tags || []).some(hit) || db.itemsOfList(l.id).some((i) => hit(i.text))));
  const notes = db.recs('note').filter((n) => !n.archived &&
    (hit(n.title) || hit(n.text) || (n.tags || []).some(hit)));
  const loose = db.recs('item').filter((i) =>
    i.state === 'active' && !i.done && i.parentId && hit(i.text));

  let html = `<div class="view-title">Suche <span class="count">${lists.length + notes.length + loose.length} Treffer</span></div>`;

  if (!lists.length && !notes.length && !loose.length) {
    html += emptyState('🔍', 'Keine Treffer', `Nichts gefunden für „${query}“.`);
  } else {
    if (lists.length) {
      html += `<div class="section-head"><h2>Listen</h2></div>` + lists.map((r) => swipeCard(r)).join('');
    }
    if (notes.length) {
      html += `<div class="section-head"><h2>Notizen</h2></div>` + notes.map((r) => swipeCard(r)).join('');
    }
    if (loose.length) {
      html += `<div class="section-head"><h2>Punkte</h2></div><div class="group">`;
      html += loose.slice(0, 50).map((it) => {
        const l = db.byId(it.listId);
        return `<button class="row tappable" data-href="#/liste/${it.listId}">
          <span class="r-label">${esc(it.text)}</span>
          <span class="r-value">${esc(l?.title || '')}</span>
          <span class="chev">›</span>
        </button>`;
      }).join('');
      html += `</div>`;
    }
  }

  const v = document.getElementById('view');
  v.innerHTML = html;
  bindSwipes(v);
}

/* ============================================================
   Listen-Detail
   ============================================================ */

function renderList(id) {
  const list = db.byId(id);
  const v = document.getElementById('view');

  if (!list || list.kind !== 'list' || list.deleted) {
    v.innerHTML = emptyState('🔍', 'Liste nicht gefunden', 'Sie wurde gelöscht oder existiert auf diesem Gerät nicht.');
    return;
  }

  // Nur aktive Punkte: nach Memory/Archiv verschobene sind hier nicht mehr sichtbar
  const all = db.itemsOfList(id).filter((i) => (i.state || 'active') === 'active');
  const parents = all.filter((i) => !i.parentId).sort((a, b) => (a.order || 0) - (b.order || 0));
  const kidsOf = (pid) => all.filter((i) => i.parentId === pid).sort((a, b) => (a.order || 0) - (b.order || 0));
  const isSimple = list.template === 'simple';
  const isWeek = list.template === 'woche';

  const activeParents = parents.filter((p) => !p.done);
  const doneParents = parents.filter((p) => p.done);
  const t = tplInfo(list.template);

  // Immer als Gruppe rendern: nur so ist „＋ Unterpunkt“ auch ohne bestehende
  // Kinder erreichbar (in allen Vorlagen: Woche, Standard und Simpel).
  const groupHtml = (p) => parentGroupHtml(p, kidsOf(p.id), { list, history: p.done });

  let body = '';

  if (isWeek) {
    const order = [...activeParents];
    for (let d = 0; d < 7; d++) {
      const dayItems = order.filter((p) => (p.day ?? -1) === d);
      body += `<div class="day-section" data-day="${d}">
        <div class="day-head">${WEEKDAYS[d]} ${d === todayIndex() ? '<span class="today-tag">Heute</span>' : ''}</div>
        <div class="day-list">${dayItems.map(groupHtml).join('')}</div>
        <button class="add-item" data-act="add-parent" data-id="${list.id}" data-day="${d}">
          <span class="plus">＋</span> Punkt für ${WEEKDAYS[d]}
        </button>
      </div>`;
    }
    const noDay = order.filter((p) => (p.day ?? -1) < 0);
    if (noDay.length) {
      body += `<div class="day-section" data-day="-1">
        <div class="day-head">Ohne Tag</div>
        ${noDay.map(groupHtml).join('')}
      </div>`;
    }
  } else {
    body = activeParents.map(groupHtml).join('');
    if (!activeParents.length) {
      body += emptyState('✅', 'Alles geschafft' , 'Füge mit „＋ Hauptpunkt“ einen neuen Punkt hinzu.');
    }
  }

  if (!isWeek) {
    body += `<button class="add-item" data-act="add-parent" data-id="${list.id}" style="margin-top:12px">
      <span class="plus">＋</span> Hauptpunkt
    </button>`;
  }

  if (!isSimple && doneParents.length && db.getSetting('showDone')) {
    body += `<button class="hist-toggle ${histOpen ? 'open' : ''}" data-act="toggle-hist" style="margin-top:18px">
      <span>Abgehakt &amp; Historie (${doneParents.length})</span><span class="chev">›</span>
    </button>`;
    if (histOpen) {
      body += doneParents.map(groupHtml).join('');
    }
  }

  const openCount = activeParents.length;
  const doneCount = doneParents.length;

  v.innerHTML = `
    <div class="detail-head">
      <button class="back-btn" data-act="back">${ICON.back}<span>Zurück</span></button>
      <div class="spacer"></div>
      <div class="detail-actions">
        <button class="icon-btn" data-act="list-pin" aria-label="Anpinnen" title="Anpinnen">${list.pinned ? '📌' : '📍'}</button>
        <button class="icon-btn" data-act="list-edit-title" aria-label="Titel bearbeiten" title="Titel bearbeiten">✏️</button>
        <button class="icon-btn" data-act="list-bg" aria-label="Hintergrundfarbe" title="Hintergrundfarbe">🎨</button>
        <button class="icon-btn" data-act="list-tags" aria-label="Tags bearbeiten" title="Tags bearbeiten">🏷</button>
        <button class="icon-btn" data-act="list-archive" aria-label="Ins Archiv verschieben" title="Ins Archiv verschieben">📥</button>
        <button class="icon-btn danger" data-act="list-delete" aria-label="Liste löschen" title="Liste löschen">🗑</button>
      </div>
    </div>

    <div class="detail-title" data-act="edit-title" ${cardStyle(list.bg, 'border-radius:12px;padding:6px 10px')}>${esc(list.title || 'Ohne Titel')}</div>
    <div class="detail-sub">
      <span class="tpl-badge ${t.cls}">${t.label}</span>
      <span>${openCount} offen · ${doneCount} erledigt</span>
      ${(list.tags || []).length ? list.tags.map((x) => tagChip(list, x)).join('') : ''}
    </div>

    <div id="listBody">${body}</div>
  `;
  bindSwipes(v);
  bindItemDrag(v);
}

/* ============================================================
   Notiz: Kopf-Auswahl (Link bzw. To-Do)
   ============================================================ */

/** 🔗-Button im Notiz-Kopf: Link hinzufügen oder mit einem To-Do verknüpfen. */
function openNoteLinkChooser(id) {
  S.openSheet({
    title: 'Verknüpfen',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn" data-close>Schließen</button>',
    menu: `<div class="sheet-menu">
      <button class="menu-btn" data-a="link"><span class="mi">🔗</span><span class="mb"><span>Link hinzufügen</span><span class="ms">URL in der Notiz speichern</span></span></button>
      <button class="menu-btn" data-a="todo"><span class="mi">✅</span><span class="mb"><span>Mit To-Do verknüpfen</span><span class="ms">Bestehenden Punkt auswählen</span></span></button>
    </div>`,
    onMount(sheet, handle) {
      sheet.querySelector('[data-close]').onclick = () => handle.close();
      sheet.querySelectorAll('[data-a]').forEach((b) => {
        b.onclick = () => {
          const a = b.dataset.a;
          handle.close();
          setTimeout(() => {
            if (a === 'link') S.openLinkSheet(id);
            if (a === 'todo') openItemPicker(id);
          }, 250);
        };
      });
    },
  });
}

/** To-Do-Punkt mit einer Notiz verknüpfen (aus der Notiz heraus). */
function openItemPicker(noteId) {
  const items = db.recs('item').filter((i) => i.state === 'active' && !i.done).slice(0, 60);
  S.openSheet({
    title: 'To-Do wählen',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn" data-close>Abbrechen</button>',
    body: `<div class="settings-group">
      ${items.length ? items.map((it) => {
        const l = db.byId(it.listId);
        const on = (db.byId(noteId)?.linkedItems || []).includes(it.id);
        return `<button class="row tappable" data-pick="${it.id}">
          <span class="r-label">${esc(it.text || 'Ohne Text')}</span>
          <span class="r-value">${on ? '✓' : esc(l?.title || '')}</span>
        </button>`;
      }).join('') : '<div class="row"><span class="r-label" style="color:var(--label-2)">Keine offenen Punkte</span></div>'}
    </div>`,
    onMount(sheet, handle) {
      sheet.querySelector('[data-close]').onclick = () => handle.close();
      sheet.querySelectorAll('[data-pick]').forEach((b) => {
        b.onclick = () => {
          const itemId = b.dataset.pick;
          const note = db.byId(noteId);
          const item = db.byId(itemId);
          if (!note || !item) return;
          const on = (note.linkedItems || []).includes(itemId);
          S.linkNoteToItem(itemId, on ? null : noteId);   // beidseitig setzen/lösen
          haptic(8);
          handle.close();
        };
      });
    },
  });
}

/* ============================================================
   Globale Aktions-Delegation
   ============================================================ */

export function bindActions() {
  const v = document.getElementById('view');

  v.addEventListener('click', (e) => {
    const href = e.target.closest('[data-href]');
    const t = e.target.closest('[data-act]');

    if (t && t.dataset.act === 'open-item' && e.target.closest('[contenteditable="true"]')) return;

    if (t) {
      const act = t.dataset.act;
      const id = t.dataset.id;
      if (handleAction(act, id, t, e) === false) return;
    }
    if (href && !t) {
      pruneEmptyItems();
      navigate(href.dataset.href);
    }
  });

  // Inline-Text der Punkte speichern
  v.addEventListener('focusout', (e) => {
    const el = e.target;
    if (el.matches?.('[data-edit]')) {
      const id = el.dataset.edit;
      const rec = db.byId(id);
      if (!rec) return;
      const text = el.textContent.trim();
      if (!text && !rec.done) {
        db.purge(id);
      } else if (text !== rec.text) {
        db.update(id, { text });
      }
    }
  });

  v.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches?.('[data-edit]')) {
      e.preventDefault();
      e.target.blur();
    }
  });
}

function handleAction(act, id, el, e) {
  const route = parse();

  switch (act) {
    case 'back':
      if (history.length > 1) history.back();
      else navigate('#/');
      return;

    case 'create': S.openCreateMenu(); return;
    case 'create-list': S.openTemplatePicker(); return;
    case 'create-note': {
      const n = db.create('note', {});
      navigate(`#/notiz/${n.id}`);
      return;
    }
    case 'goto-settings': navigate('#/einstellungen'); return;

    /* --- Direktaktionen auf der Startseite / in der Punktzeile --- */
    case 'pin-card': {
      e.stopPropagation();
      const rec = db.byId(id);
      if (rec) {
        db.update(id, { pinned: rec.pinned ? 0 : 1 });
        haptic(8);
        S.toast(rec.pinned ? 'Von der Startseite gelöst' : 'Angepinnt');
      }
      return;
    }

    case 'item-color':
      e.stopPropagation();
      S.openItemColorSheet(id);
      return;

    case 'item-plan':
      e.stopPropagation();
      S.openPlanSheet(id);
      return;

    case 'item-archive':
      e.stopPropagation();
      archiveItemAction(id);            // Gedächtnis/Archiv inkl. Unterpunkten
      return;

    case 'card-tags':
      e.stopPropagation();
      S.openTagSheet(id);
      return;

    case 'item-link': {
      e.stopPropagation();
      const it = db.byId(id);
      if (!it || it.kind !== 'item') return;
      S.openNotePicker({
        title: 'Notiz verknüpfen',
        current: it.noteId,
        allowUnlink: true,
        onPick: (noteId) => S.linkNoteToItem(id, noteId),
        onUnlink: () => S.linkNoteToItem(id, null),
        onCreate: () => {
          const n = db.create('note', { title: it.text || '', text: '' });
          S.linkNoteToItem(id, n.id);
          return n.id;
        },
      });
      return;
    }

    case 'toggle':
      e.stopPropagation();
      toggleItem(id);
      return;

    case 'toggle-linked':
      e.stopPropagation();
      toggleItem(id);
      return;

    case 'open-item':
      pruneEmptyItems();
      S.openItemSheet(id);
      return;

    case 'open-linked-note': {
      e.stopPropagation();
      pruneEmptyItems();
      const note = db.byId(id);
      if (note && !note.deleted) navigate(`#/notiz/${id}`);
      else S.toast('Diese Notiz existiert nicht mehr', { type: 'error' });
      return;
    }

    case 'unlink-todo': {
      e.stopPropagation();
      S.linkNoteToItem(id, null);          // id = Punkt
      S.toast('Verknüpfung gelöst');
      return;
    }

    case 'archive-done':
      e.stopPropagation();
      S.archiveItem(id);
      return;

    case 'restore-item':
      S.restoreItem(id);                // ganze Gruppe inkl. Unterpunkten
      return;

    case 'add-sub': {
      const item = addChildItem(id);
      if (item) pendingFocus = item.id;
      haptic(6);
      return;
    }

    case 'add-parent': {
      const day = el.dataset.day !== undefined && el.dataset.day !== '' ? Number(el.dataset.day) : null;
      const item = addParentItem(id, day);
      if (item) pendingFocus = item.id;
      haptic(6);
      return;
    }

    case 'toggle-hist':
      histOpen = !histOpen;
      render();
      return;

    case 'edit-title':
      if (route.name === 'liste') S.openListTitleSheet(route.params.id);
      return;

    case 'list-pin': {
      const l = db.byId(route.params.id);
      if (l) { db.update(l.id, { pinned: l.pinned ? 0 : 1 }); haptic(8); }
      return;
    }
    case 'list-edit-title': S.openListTitleSheet(route.params.id); return;
    case 'list-bg': S.openBgSheet(route.params.id); return;
    case 'list-tags': S.openTagSheet(route.params.id); return;
    case 'list-archive': {
      const l = db.byId(route.params.id);
      if (!l) return;
      db.update(l.id, { archived: 1 });
      navigate('#/');
      S.undoToast('Ins Archiv verschoben', () => db.update(l.id, { archived: 0 }));
      return;
    }
    case 'list-delete': {
      const l = db.byId(route.params.id);
      if (!l) return;
      S.guardedDelete(l.title || 'Liste', () => {
        const ids = [l.id, ...db.itemsOfList(l.id).map((i) => i.id)];
        db.softDeleteList(l.id);
        navigate('#/');
        S.undoToast('Liste gelöscht', () => ids.forEach((x) => db.update(x, { deleted: 0 })));
      });
      return;
    }

    case 'note-pin': {
      const n = db.byId(route.params.id);
      if (n) { db.update(n.id, { pinned: n.pinned ? 0 : 1 }); haptic(8); }
      return;
    }
    case 'note-bg': S.openBgSheet(route.params.id); return;
    case 'note-tags': S.openTagSheet(route.params.id); return;
    case 'note-link': openNoteLinkChooser(route.params.id); return;
    case 'note-archive': {
      const n = db.byId(route.params.id);
      if (!n) return;
      db.update(n.id, { archived: 1 });
      navigate('#/');
      S.undoToast('Ins Archiv verschoben', () => db.update(n.id, { archived: 0 }));
      return;
    }
    case 'note-delete': {
      const n = db.byId(route.params.id);
      if (!n) return;
      S.guardedDelete(n.title || 'Notiz', () => {
        db.softDelete(n.id);
        navigate('#/');
        S.undoToast('Notiz gelöscht', () => db.update(n.id, { deleted: 0 }));
      });
      return;
    }

    case 'add-link': S.openLinkSheet(route.params.id); return;
    case 'add-file': document.getElementById('filePicker')?.click(); return;

    case 'rm-link': {
      const note = db.byId(id);
      if (!note) return;
      const links = [...(note.links || [])];
      links.splice(Number(el.dataset.i), 1);
      db.update(id, { links });
      return;
    }
    case 'rm-file': {
      const note = db.byId(id);
      if (!note) return;
      const files = [...(note.files || [])];
      const ref = files.splice(Number(el.dataset.i), 1)[0];
      if (ref) { db.delBlob(ref.id); releasePreview(ref.id); }
      db.update(id, { files });
      return;
    }
    case 'link-todo': openItemPicker(route.params.id); return;

    /* --- Einstellungen --- */
    case 'connect': doConnect(); return;
    case 'disconnect': doDisconnect(); return;
    case 'sync-now':
      sync.syncNow();
      S.toast('Synchronisation gestartet');
      return;
    case 'export': exportData(); return;
    case 'import': document.getElementById('importPicker')?.click(); return;
    case 'wipe': doWipe(); return;
    case 'check-update': checkForUpdate({ manual: true }); return;
  }
}

/* ---------------- Verbindungs-Flows ---------------- */

async function doConnect() {
  try {
    const res = await sync.connect();
    if (res?.needsManual) {
      openManualAuth(res.hint);
      return;
    }
    if (res?.ok) {
      S.toast(res.switched
        ? 'Konto gewechselt – secondmind nutzt jetzt dieses Google-Konto'
        : 'Google Drive verbunden');
      sync.syncNow();
      render();
    }
  } catch (e) {
    S.toast(e.message || 'Verbindung fehlgeschlagen', { type: 'error', duration: 6000 });
    render();
  }
}

function openManualAuth(hint) {
  S.openSheet({
    title: 'Manuell abschließen',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn" data-close>Abbrechen</button>',
    body: `
      <p class="confirm-text">${esc(hint || 'Kopiere die Adresse, die nach der Anmeldung angezeigt wird (http://127.0.0.1:…).')}</p>
      <input class="text-in" id="redir" placeholder="http://127.0.0.1:…/oauth?code=…" spellcheck="false" autocapitalize="off">
      <button class="btn" data-apply style="margin-top:14px">Verknüpfung abschließen</button>`,
    onMount(sheet, handle) {
      sheet.querySelector('[data-close]').onclick = () => handle.close();
      sheet.querySelector('[data-apply]').onclick = async () => {
        const parsed = (await import('./bridge.js')).parseRedirect(sheet.querySelector('#redir').value);
        if (!parsed.code) { S.toast('Kein gültiger Code in der URL', { type: 'error' }); return; }
        try {
          await sync.exchangeCode(parsed.code, parsed.redirectUri);
          handle.close();
          S.toast('Google Drive verbunden');
          sync.syncNow();
          render();
        } catch (err) {
          S.toast(err.message || 'Fehler', { type: 'error', duration: 6000 });
        }
      };
    },
  });
}

async function doDisconnect() {
  const ok = await S.confirm({
    title: 'Verbindung trennen?',
    text: 'Die lokalen Daten bleiben erhalten, es wird nur nicht mehr mit Drive synchronisiert.',
    confirmLabel: 'Trennen',
    danger: false,
  });
  if (!ok) return;
  await sync.disconnect();
  S.toast('Verbindung getrennt');
  render();
}

async function doWipe() {
  const ok = await S.confirm({
    title: 'Alle lokalen Daten löschen?',
    text: 'Notizen, Listen und Punkte auf diesem Gerät werden entfernt. Ist Drive verbunden, kommen sie beim nächsten Synchronisieren zurück.',
    confirmLabel: 'Alles löschen',
  });
  if (!ok) return;
  await db.wipeEverything();
  S.toast('Lokale Daten gelöscht');
  navigate('#/');
  render();
}
