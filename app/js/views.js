/* secondmind – views.js
   Ansichten: Notiz-Detail, Archiv, Memory, Einstellungen. */

import * as db from './db.js';
import * as S from './sheets.js';
import * as sync from './sync.js';
import { esc, ICON, fmtRel, fmtDate, yearOf, download, fmtBytes, haptic, APP_VERSION, tagChip, mondayOfWeek, addDays, weekLabel, isoWeek, isoDate, WEEKDAYS_SHORT } from './util.js';
import { cardSwipeHtml, itemRowHtml, noteCardHtml, listCardHtml, cardStyle, bindSwipes, toggleItem, pruneEmptyItems } from './parts.js';
import { navigate } from './router.js';
import { platform } from './bridge.js';
import * as gemini from './gemini.js';
import * as repeat from './repeat.js';

const view = () => document.getElementById('view');

/* ============================================================
   Notiz-Detail
   ============================================================ */

const previews = new Map(); // fileId -> objectURL

export function releasePreview(id) {
  const url = previews.get(id);
  if (url) { URL.revokeObjectURL(url); previews.delete(id); }
}

export function renderNote(id) {
  const note = db.byId(id);
  if (!note || note.kind !== 'note' || note.deleted) {
    return emptyState('🔍', 'Notiz nicht gefunden', 'Sie wurde gelöscht oder existiert auf diesem Gerät nicht.');
  }

  const linked = (note.linkedItems || [])
    .map((iid) => db.byId(iid))
    .filter((it) => it && !it.deleted && it.state === 'active');

  const html = `
    <div class="detail-head">
      <button class="back-btn" data-act="back">${ICON.back}<span>Zurück</span></button>
      <div class="spacer"></div>
      <div class="detail-actions">
        <button class="icon-btn pin-toggle ${note.pinned ? 'on' : ''}" data-act="note-pin" aria-label="Anpinnen" title="Anpinnen">📌</button>
        <button class="icon-btn" data-act="note-bg" aria-label="Hintergrundfarbe" title="Hintergrundfarbe">🎨</button>
        <button class="icon-btn" data-act="note-tags" aria-label="Tags bearbeiten" title="Tags bearbeiten">🏷</button>
        <button class="icon-btn" data-act="note-link" aria-label="Verknüpfen" title="Link oder To-Do verknüpfen">🔗</button>
        <button class="icon-btn" data-act="note-archive" aria-label="Ins Archiv verschieben" title="Ins Archiv verschieben">📥</button>
        <button class="icon-btn danger" data-act="note-delete" aria-label="Notiz löschen" title="Notiz löschen">🗑</button>
      </div>
    </div>

    <div class="card note-editor" ${cardStyle(note.bg)} style="padding:14px 16px 18px">
      <input class="note-title-in" id="noteTitle" placeholder="Titel" value="${esc(note.title)}" maxlength="200">
      <textarea class="note-text-in" id="noteText" placeholder="Text schreiben …">${esc(note.text)}</textarea>

      ${(note.tags || []).length ? `<div class="chips" style="margin-bottom:14px">${note.tags.map((t) => tagChip(note, t)).join('')}</div>` : ''}

      <div class="section-head" style="margin-top:4px"><h2>Anhänge</h2></div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button class="btn secondary small" data-act="add-link" style="flex:1">🔗 Link</button>
        <button class="btn secondary small" data-act="add-file" style="flex:1">🖼 Foto / Datei</button>
      </div>
      <div class="attach-list" id="attachList">
        ${(note.links || []).map((l, i) => `
          <div class="attach">
            <div class="a-icon">🔗</div>
            <div class="a-body">
              <div class="a-title">${esc(l.title || l.url)}</div>
              <div class="a-sub">${esc(l.url)}</div>
            </div>
            <button class="a-del" data-act="rm-link" data-i="${i}" data-id="${note.id}">×</button>
          </div>`).join('')}
        ${(note.files || []).map((f, i) => `
          <div class="attach" data-file="${esc(f.id)}" data-note="${note.id}">
            <div class="a-icon" data-preview>${f.type?.startsWith('image/') ? '🖼' : '📄'}</div>
            <div class="a-body">
              <div class="a-title">${esc(f.name || 'Datei')}</div>
              <div class="a-sub">${fmtBytes(f.size)}${f.driveId ? '' : ' · wird hochgeladen'}</div>
            </div>
            <button class="a-del" data-act="rm-file" data-i="${i}" data-id="${note.id}">×</button>
          </div>`).join('')}
        ${!(note.links || []).length && !(note.files || []).length
          ? '<div class="r-note" style="color:var(--label-3);padding:4px 2px">Noch keine Anhänge</div>' : ''}
      </div>

      <div class="section-head"><h2>Verknüpfte To-Dos</h2></div>
      <div class="group" style="margin-bottom:12px">
        ${linked.length ? linked.map((it) => {
          const lst = db.byId(it.listId);
          return `<div class="item">
            <button class="check ${it.done ? 'on' : ''}" data-act="toggle-linked" data-id="${it.id}">${ICON.check}</button>
            <div class="item-body">
              <div class="item-text">${esc(it.text)}</div>
              <button class="linked-note" data-href="#/liste/${it.listId}" title="Zu der Liste springen">✅ ${esc(lst?.title || 'Liste ohne Titel')}</button>
            </div>
            <div class="item-tail">
              <button class="a-del" data-act="unlink-todo" data-id="${it.id}" data-note="${note.id}" title="Verknüpfung lösen">×</button>
            </div>
          </div>`;
        }).join('') : '<div class="row"><span class="r-label" style="color:var(--label-2);font-size:15px">Noch keine Verknüpfung</span></div>'}
      </div>
      <button class="btn secondary" data-act="link-todo">＋ Mit To-Do verknüpfen</button>
    </div>
    <input type="file" id="filePicker" multiple accept="image/*,application/pdf,.doc,.docx,.txt,.zip" hidden>
  `;

  view().innerHTML = html;
  bindNoteEditor(note.id);
  hydrateAttachments(note);
  autosize(document.getElementById('noteText'));
}

function autosize(ta) {
  if (!ta) return;
  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.max(180, ta.scrollHeight) + 'px'; };
  ta.addEventListener('input', fit);
  fit();
}

function bindNoteEditor(noteId) {
  const title = document.getElementById('noteTitle');
  const text = document.getElementById('noteText');

  const saveTitle = () => { if (db.byId(noteId)) db.update(noteId, { title: title.value }); };
  const saveText = () => { if (db.byId(noteId)) db.update(noteId, { text: text.value }); };

  title.addEventListener('input', saveTitle);
  title.addEventListener('blur', saveTitle);
  text.addEventListener('input', saveText);
  text.addEventListener('blur', saveText);

  const picker = document.getElementById('filePicker');
  picker.addEventListener('change', async () => {
    const note = db.byId(noteId);
    if (!note) return;
    const files = [...picker.files];
    const refs = [...(note.files || [])];
    for (const f of files) {
      const fid = 'f-' + Math.random().toString(36).slice(2, 11);
      refs.push({ id: fid, name: f.name, type: f.type, size: f.size, driveId: null, state: 'local' });
      await db.putBlob(fid, f);
    }
    db.update(noteId, { files: refs });
    picker.value = '';
    haptic(8);
  });
}

async function hydrateAttachments(note) {
  const nodes = view().querySelectorAll('[data-file]');
  for (const node of nodes) {
    const fid = node.dataset.file;
    const ref = (note.files || []).find((f) => f.id === fid);
    if (!ref) continue;
    if (!ref.type?.startsWith('image/')) continue;

    const holder = node.querySelector('[data-preview]');
    if (previews.has(fid)) { holder.innerHTML = `<img src="${previews.get(fid)}" alt="">`; continue; }

    let blob = await db.getBlob(fid);
    if (!blob && ref.driveId) {
      node.classList.add('loading');
      blob = await sync.fetchAttachment(ref);
      node.classList.remove('loading');
    }
    if (blob) {
      const url = URL.createObjectURL(blob);
      previews.set(fid, url);
      if (document.body.contains(node)) holder.innerHTML = `<img src="${url}" alt="">`;
    }
  }
}

/* ============================================================
   Archiv
   ============================================================ */

export function renderArchive() {
  const all = [...db.state.records.values()].filter((r) => !r.deleted);

  const lists = all.filter((r) => (r.kind === 'list' || r.kind === 'note') && r.archived);
  const items = all.filter((r) => r.kind === 'item' && r.state === 'archived');

  let html = `
    <div class="view-title">Archiv <span class="count">${lists.length + items.length} Einträge</span></div>
    <div class="detail-sub">Links wischen = Wiederherstellen · Rechts wischen = Löschen</div>
  `;

  if (!lists.length && !items.length) {
    // Wichtig: auch der Leerzustand muss die Ansicht ersetzen (sonst bleibt die
    // alte Ansicht stehen, z. B. nachdem alle Einträge wiederhergestellt wurden)
    view().innerHTML = html + emptyState('🗂', 'Das Archiv ist leer', 'Wische Links über Listen oder Notizen, um sie hier abzulegen.');
    return;
  }

  if (lists.length) {
    html += `<div class="section-head"><h2>Listen &amp; Notizen</h2></div>`;
    html += lists
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r) => {
        const inner = r.kind === 'list' ? listCardHtml(r) : noteCardHtml(r);
        return cardSwipeHtml(inner, { id: r.id, mode: 'restore' });
      }).join('');
  }

  if (items.length) {
    const byYear = new Map();
    for (const it of items) {
      const y = yearOf(it.archivedAt || it.updatedAt);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(it);
    }
    const years = [...byYear.keys()].sort((a, b) => b - a);

    html += `<div class="section-head"><h2>Punkte</h2></div>`;
    for (const y of years) {
      const group = byYear.get(y).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
      const byList = new Map();
      for (const it of group) {
        const list = db.byId(it.listId);
        const name = (list && !list.deleted && !list.archived ? list.title : it.originTitle) || 'Gelöschte Liste';
        const key = `${name} – Archiv`;
        if (!byList.has(key)) byList.set(key, []);
        byList.get(key).push(it);
      }
      html += `<div class="year-head">${y}</div>`;
      for (const [key, its] of byList) {
        const { tops, kidsOf } = splitGroups(its);
        html += `<div class="archive-group"><div class="ag-title">${esc(key)}</div>`;
        html += tops.map((it) => archiveRow(it, 'archiv', kidsOf(it.id))).join('');
        html += `</div>`;
      }
    }
  }

  view().innerHTML = html;
  bindSwipes(view());
}

function archiveRow(it, mode, kids = []) {
  const right = mode === 'memory'
    ? `<div class="swipe-act right restore">${ICON.restore}<span>Zurück</span></div>`
    : `<div class="swipe-act right restore">${ICON.restore}<span>Zurück</span></div>`;
  return `
    <div class="swipe" data-swipe data-id="${it.id}" data-mode="restore">
      <div class="swipe-bg">
        <div class="swipe-act left">${ICON.trash}<span>Löschen</span></div>
        ${right}
      </div>
      <div class="swipe-content">
        <div class="group" style="margin-bottom:0">
          <div class="item">
            <div class="item-body" style="padding-left:2px">
              <div class="item-text">${esc(it.text || 'Ohne Text')}</div>
              <div class="card-meta">${fmtDate(it.archivedAt || it.updatedAt)}</div>
            </div>
            <div class="item-tail">
              <button class="item-open" data-act="restore-item" data-id="${it.id}" title="Wiederherstellen">↺</button>
              <button class="item-open" data-act="open-item" data-id="${it.id}">›</button>
            </div>
          </div>
          ${kids.map((c) => `
          <div class="item mem sub">
            <div class="item-body" style="padding-left:18px">
              <div class="item-text">${esc(c.text || 'Ohne Text')}</div>
            </div>
            <div class="item-tail">
              <button class="item-open" data-act="restore-item" data-id="${c.id}" title="Wiederherstellen">↺</button>
            </div>
          </div>`).join('')}
        </div>
      </div>
    </div>`;
}

/* ============================================================
   Memory
   ============================================================ */

export function renderMemory() {
  if (!db.getSetting('memoryEnabled')) {
    return view().innerHTML = `
      <div class="view-title">Memory</div>
      ${emptyState('🧠', 'Memory ist deaktiviert', 'Schalte die Memory-Funktion in den Einstellungen ein, um Punkte pro Jahr zu sammeln.',
        `<button class="btn secondary" data-act="goto-settings" style="max-width:260px;margin:18px auto 0">Zu den Einstellungen</button>`)}`;
  }

  const items = [...db.state.records.values()]
    .filter((r) => r.kind === 'item' && !r.deleted && r.state === 'memory');

  let html = `
    <div class="view-title">Memory <span class="count">${items.length} Einträge</span></div>
    <div class="detail-sub">Gesammelte Punkte, nach Jahr sortiert</div>`;

  if (!items.length) {
    return view().innerHTML = html + emptyState('🧠', 'Noch nichts gemerkt',
      'Wische Punkte nach links, um sie hier abzulegen.');
  }

  // Hauptpunkte mit ihren Unterpunkten bündeln – die Gruppe wird vollständig angezeigt
  const { tops, kidsOf } = splitGroups(items);

  const byYear = new Map();
  for (const it of tops) {
    const y = yearOf(it.memoryAt || it.updatedAt);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(it);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);

  for (const y of years) {
    const group = byYear.get(y).sort((a, b) => (b.memoryAt || 0) - (a.memoryAt || 0));
    html += `<div class="year-head">${y}</div>`;
    html += group
      .map((it) => `<div class="group mem-group">${memGroupHtml(it, kidsOf(it.id))}</div>`)
      .join('');
  }

  view().innerHTML = html;
}

/** Top-Level-Einträge + Kind-Zuordnung: Kinder hängen an ihrem Hauptpunkt,
    sofern der Hauptpunkt im selben Status (Memory/Archiv) steht. */
function splitGroups(items) {
  const ids = new Set(items.map((i) => i.id));
  const kids = new Map();
  const tops = [];
  for (const it of items) {
    if (it.parentId && ids.has(it.parentId)) {
      if (!kids.has(it.parentId)) kids.set(it.parentId, []);
      kids.get(it.parentId).push(it);
    } else tops.push(it);
  }
  return {
    tops,
    kidsOf: (pid) => (kids.get(pid) || []).sort((a, b) => (a.order || 0) - (b.order || 0)),
  };
}

/** Zeile in Memory/Archiv: kompletter Text (bricht um statt zu kürzen),
    plus Notiz-Rückverweis und Termin wie in der Liste. */
function memRowHtml(it, { sub = false, meta = '' } = {}) {
  const note = it.noteId ? db.byId(it.noteId) : null;
  const noteTitle = note && !note.deleted ? (note.title || 'Notiz ohne Titel') : '';
  const planTag = it.plan?.date
    ? `<button class="plan-tag" data-act="open-item" data-id="${it.id}" title="Termin">📅 ${it.plan.date.slice(8, 10)}.${it.plan.date.slice(5, 7)}.${it.plan.date.slice(0, 4)}${it.plan.time ? ` · ${esc(it.plan.time)}` : ''}</button>`
    : '';
  return `
    <div class="item mem${sub ? ' sub' : ''}">
      <div class="item-body" style="padding-left:${sub ? 18 : 2}px">
        <div class="item-text">${esc(it.text || 'Ohne Text')}</div>
        ${meta ? `<div class="card-meta">${meta}</div>` : ''}
        ${noteTitle ? `<button class="linked-note" data-act="open-linked-note" data-id="${note.id}" title="Verknüpfte Notiz öffnen">📝 ${esc(noteTitle)}</button>` : ''}
        ${planTag}
      </div>
      <div class="item-tail">
        <button class="item-open" data-act="restore-item" data-id="${it.id}" title="Wiederherstellen">↺</button>
        ${sub ? '' : `<button class="item-open" data-act="open-item" data-id="${it.id}">›</button>`}
      </div>
    </div>`;
}

/** Komplette Memory-Gruppe: Hauptpunkt (mit Quelle/Datum) + Unterpunkte. */
function memGroupHtml(parent, kids) {
  const list = db.byId(parent.listId);
  const src = (list && !list.deleted ? list.title : parent.originTitle) || 'Gelöschte Liste';
  const meta = `${esc(src)} · ${fmtDate(parent.memoryAt || parent.updatedAt)}`;
  return memRowHtml(parent, { meta }) + kids.map((c) => memRowHtml(c, { sub: true })).join('');
}

/* ============================================================
   Kalender – Wochenraster (24 Stunden × 7 Tage)
   ============================================================ */

let calMonday = null;                       // Montag der angezeigten Woche
const HOUR_H = 48;                          // Pixel pro Stunde im Raster
const SNAP = 12;                            // Rasterpunkt (15 Minuten = 12px)
const GRID_H = HOUR_H * 24;

const ensureMonday = () => (calMonday ||= mondayOfWeek());

/** Startminuten (0–1439) eines Plans – ohne Uhrzeit = Mitternacht. */
const startMinOf = (plan) => {
  const t = String(plan?.time || '00:00').split(':');
  return Math.max(0, Math.min(1439, (Number(t[0]) || 0) * 60 + (Number(t[1]) || 0)));
};

/** Minuten -> "HH:MM". */
const fmtHM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(Math.round(mins) % 60).padStart(2, '0')}`;

export function renderCalendar() {
  const v = view();

  if (!db.getSetting('calendarEnabled')) {
    v.innerHTML = `
      <div class="view-title">Kalender</div>
      ${emptyState('📅', 'Kalender ist deaktiviert',
        'Schalte die Kalender-Funktion in den Einstellungen ein, um Punkte einzuplanen.',
        `<button class="btn secondary" data-act="goto-settings" style="max-width:260px;margin:18px auto 0">Zu den Einstellungen</button>`)}`;
    return;
  }

  const mon = ensureMonday();
  const todayKey = isoDate();

  // Alle eingeplanten Punkte – nur sichtbare, aktive Datensätze
  const planned = new Map();                // 'YYYY-MM-DD' -> [item]
  for (const it of db.state.records.values()) {
    if (it.kind !== 'item' || it.deleted || it.state !== 'active' || !it.plan?.date) continue;
    const list = db.byId(it.listId);
    if (list && (list.deleted || list.archived)) continue;
    if (!planned.has(it.plan.date)) planned.set(it.plan.date, []);
    planned.get(it.plan.date).push(it);
  }

  // Punkte mit zugewiesener Dauer, aber noch ohne Termin – Seitenbereich
  const tray = [];
  for (const it of db.state.records.values()) {
    if (it.kind !== 'item' || it.deleted || it.state !== 'active' || it.done) continue;
    if (!it.plan?.dur || it.plan.date) continue;
    const list = db.byId(it.listId);
    if (list && (list.deleted || list.archived)) continue;
    tray.push(it);
  }
  tray.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));   // neueste zuerst

  // Kopfzeile (7 Tagesspalten) und Rasterzellen parallel aufbauen
  let heads = '', cols = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const key = isoDate(d);
    const isToday = key === todayKey;
    heads += `
      <div class="cal-col-head${isToday ? ' is-today' : ''}">
        <span class="ch-day">${WEEKDAYS_SHORT[i]}</span>
        <span class="ch-date">${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.</span>
        ${isToday ? '<span class="today-tag">Heute</span>' : ''}
      </div>`;

    const items = (planned.get(key) || []).slice()
      .sort((a, b) => startMinOf(a.plan) - startMinOf(b.plan));
    cols += `<div class="cal-col${isToday ? ' is-today' : ''}" data-date="${key}">${repeatEntriesHtml(d)}${calEntriesHtml(items)}</div>`;
  }

  // Zeitachse: 24 Stunden
  let axis = '';
  for (let h = 0; h < 24; h++) axis += `<div class="cal-hour">${String(h).padStart(2, '0')}:00</div>`;

  const grid = `
    <div class="cal-scroll" id="calScroll">
      <div class="cal-grid">
        <div class="cal-axis-head"></div>
        ${heads}
        <div class="cal-axis">${axis}</div>
        ${cols}
      </div>
    </div>`;

  v.innerHTML = `
    <div class="view-title">Kalender <span class="count">KW ${isoWeek(mon)}</span></div>
    <div class="cal-nav">
      <button class="cal-arrow" data-cal="prev" aria-label="Vorherige Woche">‹</button>
      <div class="cal-range">${weekLabel(mon)}</div>
      <button class="cal-arrow" data-cal="next" aria-label="Nächste Woche">›</button>
      <button class="cal-today" data-cal="today">Heute</button>
    </div>
    ${tray.length ? `<div class="cal-body">${traySide(tray, 'left')}${grid}${traySide(tray, 'right')}</div>` : grid}
    <div class="cal-hint">${tray.length
      ? '♻️ = wiederkehrende Aufgabe. Tipp auf eine leere Zeit – oder ziehe Punkte mit Dauer aus dem Seitenbereich ins Raster.'
      : '♻️ = wiederkehrende Aufgabe. Tipp auf eine leere Zeit, um ein To-Do einzuplanen.'}</div>`;

  bindCalendar();
  bindTrayDrag(v);
}

/** Eine Seite des Kalender-Sidebars: Hälfte der Dauer-Punkte als Chips. */
function traySide(all, side) {
  const items = all.filter((_, i) => (side === 'left' ? i % 2 === 0 : i % 2 === 1));
  if (!items.length) return '';
  return `
    <div class="cal-tray ${side}" aria-label="Punkte mit Dauer">
      ${items.map((it) => {
        const d = Number(it.plan.dur) || 60;
        const c = it.color && it.color !== 'neutral' ? ` c-${it.color}` : '';
        const label = d < 60 ? `${d} Min` : `${String(d / 60).replace('.', ',')} Std`;
        return `<button class="tray-item${c}" data-id="${it.id}" data-dur="${d}" title="${esc(it.text || 'Ohne Text')}">
          <span class="ti-dur">${label}</span>
          <span class="ti-text">${esc(it.text || 'Ohne Text')}</span>
        </button>`;
      }).join('')}
    </div>`;
}

/** Seitenbereich: Dauer-Punkte per Ziehen ins Raster legen – Tippen öffnet
    das Termin-Sheet. */
function bindTrayDrag(v) {
  v.querySelectorAll('.tray-item').forEach((chip) => {
    chip.addEventListener('pointerdown', (e) => {
      e.preventDefault();                     // kein Markieren, kein Scrollen
      const id = chip.dataset.id;
      const dur = Number(chip.dataset.dur) || 60;
      const sx = e.clientX, sy = e.clientY;
      let moved = false, ghost = null, prev = null, col = null, hiCol = null, min = 0;

      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        ghost?.remove(); prev?.remove();
        chip.classList.remove('dragging');
        hiCol?.classList.remove('drop-target');
      };

      const move = (ev) => {
        if (!moved) {
          if (Math.abs(ev.clientX - sx) < 8 && Math.abs(ev.clientY - sy) < 8) return;
          moved = true;
          ghost = chip.cloneNode(true);
          ghost.classList.add('tray-ghost');
          ghost.style.width = `${chip.offsetWidth}px`;
          document.body.appendChild(ghost);
          chip.classList.add('dragging');
        }
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;

        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const nc = el ? el.closest('.cal-col') : null;
        if (nc !== col) {
          prev?.remove(); prev = null;
          hiCol?.classList.remove('drop-target');
          col = nc;
          hiCol = nc;
          if (col) {
            col.classList.add('drop-target');
            prev = document.createElement('div');
            prev.className = 'cal-entry preview';
            prev.innerHTML = `<span class="ce-time"></span><span class="ce-title">${esc(chip.querySelector('.ti-text')?.textContent || '')}</span>`;
            col.appendChild(prev);
          }
        }
        if (col && prev) {
          const r = col.getBoundingClientRect();
          const m = Math.round(((ev.clientY - r.top) / HOUR_H * 60) / 15) * 15;
          min = Math.max(0, Math.min(1440 - dur, m));
          prev.style.top = `${Math.round(min / 60 * HOUR_H)}px`;
          prev.style.height = `${Math.max(20, Math.round(dur / 60 * HOUR_H) - 2)}px`;
          const t = prev.querySelector('.ce-time');
          if (t) t.textContent = fmtHM(min);
        }
      };

      const up = () => {
        const gezogen = moved, ziel = col, zeit = min;
        cleanup();
        if (gezogen && ziel) {
          db.update(id, { plan: { date: ziel.dataset.date, time: fmtHM(zeit), dur } });
          haptic(14);
          S.toast('In den Kalender gezogen');
          renderCalendar();
        } else if (!gezogen) {
          S.openPlanSheet(id);                // Tippen: Termin-Sheet (Dauer vorausgewählt)
        }
      };

      const cancel = () => cleanup();

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    });
  });
}

/** Einträge eines Tages als positionierte Blöcke – zeitgleiche Termine
    verteilen sich auf Spuren nebeneinander. */
/** Wiederkehrende Punkte (♻️) für einen Kalendertag – ganztägig am Spalten-
    anfang, unabhängig von Uhrzeiten. Die Farbe des Punktes wird übernommen. */
function repeatEntriesHtml(date) {
  const items = repeat.repeatsOn(date);
  if (!items.length) return '';
  return items.map((it, i) => {
    const c = it.color && it.color !== 'neutral' ? ` c-${it.color}` : '';
    return `
    <button class="cal-entry repeat${c}" data-cal="repeat" data-id="${it.id}"
      style="top:${4 + i * 22}px;height:20px;left:2px;right:2px;width:auto"
      title="Wiederkehrender Punkt – tippen zum Bearbeiten">
      <span class="ce-time">♻️</span>
      <span class="ce-title">${esc(it.text || 'Ohne Text')}</span>
    </button>`;
  }).join('');
}

function calEntriesHtml(items) {
  if (!items.length) return '';
  const laneEnds = [];                      // Endminuten je Spur
  const placed = items.map((it) => {
    const s = startMinOf(it.plan);
    const dur = Math.max(Number(it.plan?.dur) || 0, 15);
    const e = Math.min(1440, s + dur);
    let lane = laneEnds.findIndex((end) => end <= s);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(e); } else laneEnds[lane] = e;
    return { it, s, dur, lane };
  });
  const lanes = Math.max(1, laneEnds.length);
  return placed.map((p) => calEntryHtml(p, lanes)).join('');
}

function calEntryHtml(p, lanes) {
  const { it, s, dur, lane } = p;
  const list = db.byId(it.listId);
  const color = it.color && it.color !== 'neutral' ? it.color : '';
  const w = 100 / lanes;
  const top = Math.round(s / 60 * HOUR_H);
  const h = Math.max(20, Math.round(dur / 60 * HOUR_H) - 2);
  return `
    <button class="cal-entry${color ? ` c-${color}` : ''}${it.done ? ' done' : ''}${h < 40 ? ' tight' : ''}"
      data-cal="plan" data-id="${it.id}"
      style="top:${top}px;height:${h}px;left:calc(${(lane * w).toFixed(2)}% + 2px);width:calc(${w.toFixed(2)}% - 4px)">
      <span class="ce-time">${esc(it.plan.time || '')}</span>
      <span class="ce-title">${esc(it.text || 'Ohne Text')}</span>
      <span class="ce-sub">${esc(list?.title || 'Liste')}</span>
    </button>`;
}

function bindCalendar() {
  const v = view();

  v.querySelectorAll('[data-cal]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = b.dataset.cal;
      if (a === 'prev') { calMonday = addDays(ensureMonday(), -7); haptic(6); renderCalendar(); }
      else if (a === 'next') { calMonday = addDays(ensureMonday(), 7); haptic(6); renderCalendar(); }
      else if (a === 'today') { calMonday = mondayOfWeek(); haptic(6); renderCalendar(); }
      else if (a === 'plan') S.openPlanSheet(b.dataset.id);
      else if (a === 'repeat') S.openRepeatSheet(b.dataset.id);
    });
  });

  // Leere Zeitfenster antippen: öffnet den Punkte-Wähler mit Datum und
  // Uhrzeit der getippten Fläche (statt Button unter dem Raster)
  let downX = 0, downY = 0, downCol = null;
  v.querySelectorAll('.cal-col').forEach((col) => {
    col.addEventListener('pointerdown', (e) => {
      downCol = col; downX = e.clientX; downY = e.clientY;
    });
    col.addEventListener('pointercancel', () => { downCol = null; });
    col.addEventListener('pointerup', (e) => {
      const selber = downCol === col;
      downCol = null;
      if (!selber) return;
      // Viel bewegt = Scrollen/Wischen, kein Tipp
      if (Math.abs(e.clientX - downX) > 8 || Math.abs(e.clientY - downY) > 8) return;
      if (e.target.closest('.cal-entry')) return;   // Einträge haben ihr eigenes Sheet
      const r = col.getBoundingClientRect();
      let min = Math.round(((e.clientY - r.top) / HOUR_H * 60) / 15) * 15;   // Viertelstunde
      min = Math.max(0, Math.min(23 * 60 + 45, min));
      const time = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
      haptic(6);
      S.openPlanChooser({ date: col.dataset.date, time });
    });
  });

  bindCalDrag(v);

  // Raster zur aktuellen Uhrzeit führen (in fremden Wochen auf den Morgen)
  const now = new Date();
  const today = isoDate();
  const inWeek = today >= isoDate(ensureMonday()) && today <= isoDate(addDays(ensureMonday(), 6));
  const focusMin = inWeek ? now.getHours() * 60 + now.getMinutes() : 8 * 60;
  v.scrollTop = Math.max(0, Math.round(focusMin / 60 * HOUR_H) - 150);
}

/** Termine im Raster verschieben: Tag (Spalte) und Uhrzeit (Höhe) per Drag. */
function bindCalDrag(v) {
  v.querySelectorAll('.cal-entry').forEach((entry) => {
    let pid = null, sx = 0, sy = 0, top0 = 0, newTop = 0, h = 0;
    let dragging = false, id = null, item = null, cols = [], curCol = null;

    entry.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pid = e.pointerId; sx = e.clientX; sy = e.clientY; dragging = false;
      id = entry.dataset.id; item = db.byId(id);
      top0 = parseFloat(entry.style.top) || 0; newTop = top0;
      h = entry.offsetHeight;
    });

    entry.addEventListener('pointermove', (e) => {
      if (pid !== e.pointerId || !item?.plan) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!dragging) {
        if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
        dragging = true;
        entry.classList.add('dragging');
        try { entry.setPointerCapture(e.pointerId); } catch { /* egal */ }
        cols = [...v.querySelectorAll('.cal-col')]
          .map((c) => ({ el: c, date: c.dataset.date, r: c.getBoundingClientRect() }));
        curCol = cols.find((c) => c.el.contains(entry)) || null;
        haptic(8);
      }
      newTop = Math.max(0, Math.min(GRID_H - h, Math.round((top0 + dy) / SNAP) * SNAP));
      entry.style.transform = `translate(${dx}px, ${newTop - top0}px)`;
      const over = cols.find((c) => e.clientX >= c.r.left && e.clientX <= c.r.right);
      if (over && over !== curCol) {
        curCol?.el.classList.remove('drop-target');
        curCol = over;
        curCol.el.classList.add('drop-target');
      }
    });

    const finish = (e, commit) => {
      if (pid === null || pid !== e.pointerId) return;
      const wasDrag = dragging;
      pid = null; dragging = false;
      if (!wasDrag) return;                 // Tap: das click-Event öffnet das Sheet
      entry.classList.remove('dragging');
      entry.style.transform = '';
      cols.forEach((c) => c.el.classList.remove('drop-target'));
      // Klick nach dem Ziehen unterdrücken
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      entry.addEventListener('click', swallow, { capture: true, once: true });

      const date = curCol?.date || item.plan.date;
      const time = fmtHM(Math.round(newTop / HOUR_H * 60));
      if (commit && (date !== item.plan.date || time !== (item.plan.time || ''))) {
        db.update(id, { plan: { ...item.plan, date, time } });
        haptic(14);
        S.toast('Termin verschoben');
      }
      renderCalendar();
    };

    entry.addEventListener('pointerup', (e) => finish(e, true));
    entry.addEventListener('pointercancel', (e) => finish(e, false));
  });
}

/* ============================================================
   Einstellungen
   ============================================================ */

export function renderSettings() {
  const info = sync.syncInfo();
  const st = sync.status;
  const s = db.state.settings;
  const stats = db.stats();

  const dotCls = st.state === 'ok' ? 'ok' : st.state === 'error' ? 'err'
    : st.state === 'syncing' ? 'busy' : '';
  const statusText = st.state === 'syncing' ? 'Synchronisiere …'
    : st.state === 'ok' ? `Synchronisiert · ${fmtRel(st.lastSync)}`
    : st.state === 'offline' ? 'Offline – Änderungen bleiben lokal gespeichert'
    : st.state === 'error' ? (st.message || 'Fehler beim Synchronisieren')
    : st.state === 'disconnected' ? 'Nicht verbunden'
    : 'Bereit';

  const html = `
    <div class="view-title">Einstellungen</div>

    <div class="settings-group">
      <div class="grp-label">Google Drive</div>
      <div class="status-line"><span class="dot ${dotCls}"></span><span>${esc(statusText)}</span></div>
      <div class="row">
        <span class="r-label">Konto</span>
        <span class="r-value">${info.connected ? esc(info.account || 'verbunden') : '–'}</span>
      </div>
      <div class="row" style="flex-direction:column;align-items:stretch;gap:8px">
        <span class="r-label">OAuth Client-ID</span>
        <input class="text-in" id="clientId" placeholder="….apps.googleusercontent.com" value="${esc(s.clientId)}" spellcheck="false" autocapitalize="off">
        <span class="r-note">Typ „Desktop-App“ in der Google Cloud Console erstellen und die Drive-API aktivieren. Jeder Nutzer trägt seine eigene ID ein – alle Geräte eines Nutzers nutzen dieselbe ID.</span>
      </div>
      <div class="row" style="flex-direction:column;align-items:stretch;gap:9px">
        <span class="r-label">Zugriffsumfang</span>
        <div class="seg" data-seg="scopeMode">
          <button class="${s.scopeMode !== 'full' ? 'on' : ''}" data-val="file">Nur secondmind-Dateien</button>
          <button class="${s.scopeMode === 'full' ? 'on' : ''}" data-val="full">Voller Drive-Zugriff</button>
        </div>
        <span class="r-note">Standard greift nur auf den Ordner „secondmind“ zu. Wechsle auf Erweitert, wenn sich Geräte gegenseitig die Dateien nicht sehen.</span>
      </div>
      <button class="row tappable" data-act="${info.connected ? 'disconnect' : 'connect'}">
        <span class="r-label" style="color:var(--accent)">${info.connected ? 'Verbindung trennen' : 'Mit Google verknüpfen'}</span>
        <span class="chev">›</span>
      </button>
      <div class="row"><span class="r-note">${info.connected
        ? `Verbunden mit ${esc(info.account || 'Google-Konto')}. Ein weiteres Gerät: dieselbe Client-ID eintragen und mit demselben Konto anmelden.`
        : 'Jeder Nutzer verbindet sein eigenes Google-Konto. Alle Geräte eines Nutzers teilen sich die Daten über den Drive-Ordner „secondmind“.'}</span></div>
      <button class="row tappable" data-act="sync-now">
        <span class="r-label">Jetzt synchronisieren</span>
        <span class="chev">›</span>
      </button>
      <div class="row" style="flex-direction:column;align-items:stretch;gap:9px">
        <span class="r-label">Sync-Intervall</span>
        <div class="seg" data-seg="syncInterval">
          ${[[30, '30 s'], [60, '60 s'], [120, '2 Min'], [300, '5 Min']].map(([v, l]) =>
            `<button class="${Number(s.syncInterval) === v ? 'on' : ''}" data-val="${v}">${l}</button>`).join('')}
        </div>
        <span class="r-note">Änderungen werden automatisch gepusht und zusätzlich im ${Number(s.syncInterval)}-Sekunden-Takt abgeglichen.</span>
      </div>
    </div>

    <div class="settings-group">
      <div class="grp-label">Verhalten</div>
      <button class="row tappable" data-toggle="memoryEnabled">
        <span class="r-label">Memory nutzen</span>
        <span class="switch ${s.memoryEnabled ? 'on' : ''}"></span>
      </button>
      <button class="row tappable" data-toggle="calendarEnabled">
        <span class="r-label">Kalender nutzen</span>
        <span class="switch ${s.calendarEnabled ? 'on' : ''}"></span>
      </button>
      <button class="row tappable" data-toggle="confirmDelete">
        <span class="r-label">Vor dem Löschen fragen</span>
        <span class="switch ${s.confirmDelete ? 'on' : ''}"></span>
      </button>
      <button class="row tappable" data-toggle="showDone">
        <span class="r-label">Historie in Listen anzeigen</span>
        <span class="switch ${s.showDone ? 'on' : ''}"></span>
      </button>
    </div>

    <div class="settings-group">
      <div class="grp-label">Darstellung</div>
      <div class="row" style="flex-direction:column;align-items:stretch;gap:9px">
        <span class="r-label">Design</span>
        <div class="seg" data-seg="theme">
          <button class="${s.theme === 'auto' ? 'on' : ''}" data-val="auto">Auto</button>
          <button class="${s.theme === 'light' ? 'on' : ''}" data-val="light">Hell</button>
          <button class="${s.theme === 'dark' ? 'on' : ''}" data-val="dark">Dunkel</button>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="grp-label">Gemini KI (optional)</div>
      <button class="row tappable" data-toggle="geminiEnabled">
        <span class="r-label">Gemini-Integration aktivieren</span>
        <span class="switch ${s.geminiEnabled ? 'on' : ''}"></span>
      </button>
      ${s.geminiEnabled ? `
      <div class="row" style="flex-direction:column;align-items:stretch;gap:8px">
        <span class="r-label">API-Key</span>
        <input class="text-in" id="geminiApiKey" type="password" placeholder="AIza…" value="${esc(s.geminiApiKey)}" spellcheck="false" autocapitalize="off" autocomplete="off">
        <span class="r-note">Im Google AI Studio unter „API keys“ anlegen. Der Schlüssel bleibt auf deinen Geräten und wird nur für die Anfragen genutzt.</span>
      </div>
      <div class="row" style="flex-direction:column;align-items:stretch;gap:9px">
        <span class="r-label">Zugriff auf deine Inhalte</span>
        <div class="seg" data-seg="geminiMode">
          <button class="${s.geminiMode !== 'full' ? 'on' : ''}" data-val="custom">Nur exponierte</button>
          <button class="${s.geminiMode === 'full' ? 'on' : ''}" data-val="full">Alle Einträge</button>
        </div>
        <span class="r-note">${esc(gemini.exposureSummary())} Im benutzerdefinierten Modus gibt es pro Karte einen Gemini-Button neben dem Pin.</span>
      </div>
      <button class="row tappable" data-act="gemini-chat">
        <span class="r-label" style="color:var(--accent)">Mit Gemini chatten</span>
        <span class="chev">›</span>
      </button>
      <div class="row"><span class="r-note">Anfragen gehen direkt von hier zu Google. Gesendet werden nur die Inhalte laut Zugriffseinstellung – alles andere bleibt auf deinen Geräten.</span></div>` : ''}
    </div>

    <div class="settings-group">
      <div class="grp-label">Daten</div>
      <button class="row tappable" data-act="export">
        <span class="r-label">Daten exportieren (JSON)</span>
        <span class="chev">›</span>
      </button>
      <button class="row tappable" data-act="import">
        <span class="r-label">Daten importieren</span>
        <span class="chev">›</span>
      </button>
      <button class="row tappable destructive" data-act="wipe">
        <span class="r-label">Alle Daten auf diesem Gerät löschen</span>
      </button>
      <input type="file" id="importPicker" accept="application/json" hidden>
    </div>

    <div class="settings-group">
      <div class="grp-label">Über</div>
      <div class="row"><span class="r-label">Notizen</span><span class="r-value">${stats.notes}</span></div>
      <div class="row"><span class="r-label">Listen</span><span class="r-value">${stats.lists}</span></div>
      <div class="row"><span class="r-label">Offene Punkte</span><span class="r-value">${stats.open}</span></div>
      <div class="row"><span class="r-label">Archiv / Memory</span><span class="r-value">${stats.archived} / ${stats.memory}</span></div>
      <div class="row"><span class="r-label">Plattform</span><span class="r-value">${esc(info.platform)}</span></div>
      <div class="row"><span class="r-label">Version</span><span class="r-value">${APP_VERSION}</span></div>
      ${platform !== 'web' ? `
      <button class="row tappable" data-act="check-update">
        <span class="r-label">Nach Updates suchen</span>
        <span class="chev">›</span>
      </button>
      <div class="row"><span class="r-note">secondmind prüft alle 30 Minuten nach neuen Versionen und fragt, ob direkt aktualisiert werden soll. Einträge, Einstellungen und Drive-Verknüpfung bleiben dabei erhalten.</span></div>` : ''}
    </div>
  `;

  view().innerHTML = html;
  bindSettings();
}

function bindSettings() {
  const v = view();
  const cid = v.querySelector('#clientId');
  cid.addEventListener('input', () => db.setSetting('clientId', cid.value.trim()));
  cid.addEventListener('blur', () => db.setSetting('clientId', cid.value.trim()));

  v.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.toggle;
      db.setSetting(key, !db.getSetting(key));
      btn.querySelector('.switch').classList.toggle('on');
      haptic(6);
      if (key === 'geminiEnabled') renderSettings();   // Felder ein-/ausblenden
    });
  });

  const gkey = v.querySelector('#geminiApiKey');
  if (gkey) {
    gkey.addEventListener('input', () => db.setSetting('geminiApiKey', gkey.value.trim()));
    gkey.addEventListener('blur', () => db.setSetting('geminiApiKey', gkey.value.trim()));
  }

  v.querySelectorAll('[data-seg]').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        const key = seg.dataset.seg;
        let val = b.dataset.val;
        if (key === 'syncInterval') val = Number(val);
        db.setSetting(key, val);
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        haptic(6);
        if (key === 'theme') applyTheme(val);
        if (key === 'syncInterval') sync.startSync();
        if (key === 'geminiMode') renderSettings();    // Hinweisstext aktualisieren
      });
    });
  });

  v.querySelector('#importPicker').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const recs = Array.isArray(data) ? data : data.records;
      if (!Array.isArray(recs)) throw new Error('Unbekanntes Format');

      // Einstellungen (inkl. Client-ID) übernehmen – praktisch für ein neues Gerät
      let nSettings = 0;
      if (!Array.isArray(data) && data.settings && typeof data.settings === 'object') {
        for (const [k, v] of Object.entries(data.settings)) {
          if (v === undefined) continue;
          db.setSetting(k, v);
          nSettings++;
        }
        if (data.settings.theme) applyTheme(data.settings.theme);
        if (data.settings.syncInterval) sync.startSync();
      }

      db.mergeRecords(recs.map((r) => ({ ...r, updatedAt: r.updatedAt || Date.now(), dirty: 1 })));
      S.toast(`${recs.length} Datensätze importiert${nSettings ? `, ${nSettings} Einstellungen` : ''}`);
      sync.syncNow();
    } catch (err) {
      S.toast('Import fehlgeschlagen: ' + err.message, { type: 'error' });
    }
    e.target.value = '';
  });
}

export function applyTheme(theme) {
  const el = document.documentElement;
  if (theme === 'auto') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', theme);
}

/* ---------------- Hilfen ---------------- */

export function emptyState(icon, title, sub, extra = '') {
  return `<div class="empty">
    <div class="e-ico">${icon}</div>
    <div class="e-title">${esc(title)}</div>
    <div class="e-sub">${esc(sub)}</div>
    ${extra}
  </div>`;
}

export function exportData() {
  const payload = {
    app: 'secondmind',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { ...db.state.settings },     // Client-ID & Einstellungen übernehmen
    records: [...db.state.records.values()],
  };
  download(`secondmind-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
  S.toast('Export erstellt');
}
