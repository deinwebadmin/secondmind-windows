/* secondmind – parts.js
   Gemeinsame Bausteine: Karten, Punkte, Fortschritt, Swipe-Gesten (Apple-Physik). */

import * as db from './db.js';
import * as S from './sheets.js';
import { isGeminiReady, isExposed } from './gemini.js';
import * as repeat from './repeat.js';
import { esc, ICON, fmtRel, spring, rubberband, reducedMotion, haptic, fmtBytes, tagChip } from './util.js';
import { navigate } from './router.js';

/* ---------------- Styling-Helfer ---------------- */

function luminance(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return 1;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function cardStyle(bg, extra = '') {
  if (!bg) return '';
  const dark = luminance(bg) < 0.5;
  const fg = dark ? '#fff' : '#111';
  const sec = dark ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.55)';
  const ter = dark ? 'rgba(255,255,255,.38)' : 'rgba(0,0,0,.35)';
  const fil = dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.08)';
  const sep = dark ? 'rgba(255,255,255,.2)' : 'rgba(0,0,0,.12)';
  return `style="background:${bg};color:${fg};--label-2:${sec};--label-3:${ter};--fill:${fil};--separator:${sep}${extra ? `;${extra}` : ''}"`;
}

const TPL = {
  woche: { emoji: '📅', label: 'Woche', cls: 'woche' },
  standard: { emoji: '🗒', label: 'Standard', cls: '' },
  simple: { emoji: '⚡️', label: 'Simpel', cls: 'einfach' },
  repeat: { emoji: '♻️', label: 'Wiederkehrend', cls: 'repeat' },
};

export const tplInfo = (t) => TPL[t] || TPL.standard;

/* ---------------- Wiederkehrende Punkte ---------------- */

/** Eine Zeile in der „Wiederkehrend“-Liste: Abhaken, Regel-Badge, Fälligkeit
    und An/Aus-Schalter. */
export function repeatRowHtml(it) {
  const rep = it.repeat || {};
  const paused = rep.enabled === false;
  const checked = repeat.isDoneForCycle(it);
  const due = repeat.isDueToday(it);
  const nd = repeat.nextDueDate(it);

  const dueText = paused ? 'pausiert'
    : due ? 'heute fällig'
    : nd ? `wieder am ${repeat.dueLabel(nd)}`
    : 'keine Termine mehr';

  return `
    <div class="rep-row${paused ? ' paused' : ''}" data-id="${it.id}">
      <button class="rep-check${checked ? ' on' : ''}" data-act="repeat-check" data-id="${it.id}"
        aria-label="${checked ? 'Als offen markieren' : 'Als erledigt markieren'}"
        title="${checked ? 'Als offen markieren' : 'Als erledigt markieren'}">${ICON.check}</button>
      <button class="rep-main" data-act="repeat-edit" data-id="${it.id}">
        <span class="rep-text">${esc(it.text || 'Ohne Text')}</span>
        <span class="rep-sub">
          <span class="rep-badge">♻️ ${esc(repeat.freqLabel(rep))}</span>
          <span class="rep-due${due && !paused ? ' f' : ''}">${esc(dueText)}</span>
        </span>
      </button>
      <button class="switch${paused ? '' : ' on'}" data-act="repeat-toggle" data-id="${it.id}"
        aria-label="Wiederholung ${paused ? 'aktivieren' : 'pausieren'}"
        title="Wiederholung ${paused ? 'aktivieren' : 'pausieren'}"></button>
    </div>`;
}

/* ---------------- Fortschritt ---------------- */

export function progressOf(children) {
  if (!children.length) return null;
  const done = children.filter((c) => c.done).length;
  return { done, total: children.length, pct: Math.round((done / children.length) * 100) };
}

/* ---------------- Karten (Home / Archiv / Suche) ---------------- */

export function listCardHtml(list, { context = 'home' } = {}) {
  const items = db.itemsOfList(list.id).filter((i) => (i.state || 'active') === 'active');
  const parents = items.filter((i) => !i.parentId);
  const done = parents.filter((i) => i.done).length;
  const prog = parents.length ? Math.round((done / parents.length) * 100) : 0;
  const t = tplInfo(list.template);

  // Erste 5 (offene) Hauptpunkte als Vorschau auf der Startseite
  const preview = parents.filter((p) => !p.done && p.text.trim()).slice(0, 5);

  const meta = list.template === 'repeat'
    ? [
        `${parents.filter((p) => p.repeat?.enabled !== false).length} aktiv`,
        parents.filter((p) => p.repeat?.enabled === false).length
          ? `${parents.filter((p) => p.repeat?.enabled === false).length} pausiert` : null,
      ].filter(Boolean).join(' · ')
    : [
        list.template === 'woche' ? 'Wochenliste' : `${parents.length} Punkt${parents.length === 1 ? '' : 'e'}`,
        parents.length ? `${done} erledigt` : 'leer',
      ].join(' · ');

  // Direktzugriff oben rechts: Tags öffnen + anpinnen (nicht im Archiv)
  const tagBtn = list.archived ? '' : `
    <button class="card-tag" data-act="card-tags" data-id="${list.id}"
      aria-label="Tags bearbeiten" title="Tags">${ICON.tag}</button>`;
  const pin = list.archived ? '' : `
    <button class="card-pin ${list.pinned ? 'on' : ''}" data-act="pin-card" data-id="${list.id}"
      aria-label="${list.pinned ? 'Von der Startseite lösen' : 'Anpinnen'}" title="${list.pinned ? 'Von der Startseite lösen' : 'Anpinnen'}">📌</button>`;
  // Gemini: Button neben dem Pin – nur im benutzerdefinierten Modus (Exponieren)
  const geminiBtn = (list.archived || !isGeminiReady() || db.state.settings.geminiMode === 'full') ? '' : `
    <button class="card-gemini ${isExposed('list', list.id) ? 'on' : ''}" data-act="gemini-expose" data-kind="list" data-id="${list.id}"
      aria-label="Für Gemini ${isExposed('list', list.id) ? 'freigegeben – klicken zum Entfernen' : 'freigeben'}"
      title="Für Gemini ${isExposed('list', list.id) ? 'freigegeben – klicken zum Entfernen' : 'freigeben'}">${ICON.gemini}</button>`;

  return `
    <div class="list-card card" data-href="#/liste/${list.id}" ${cardStyle(list.bg)}>
      <div class="card-top">
        <div class="card-emoji">${t.emoji}</div>
        <div class="card-title">${esc(list.title || 'Ohne Titel')}</div>
        ${tagBtn}
        ${pin}
        ${geminiBtn}
      </div>
      ${preview.length ? `<ul class="card-items">${preview.map((p) => `
        <li><span class="ci"></span><span class="cix">${esc(p.text)}</span></li>`).join('')}</ul>` : ''}
      <div class="card-meta">
        <span class="tpl-badge ${t.cls}">${t.label}</span>
        <span>${esc(meta)}</span>
        ${list.updatedAt ? `<span>· ${fmtRel(list.updatedAt)}</span>` : ''}
      </div>
      ${(list.tags || []).length ? `<div class="chips">${list.tags.map((x) => tagChip(list, x)).join('')}</div>` : ''}
      ${parents.length ? `<div class="card-progress" style="width:${prog}%"></div>` : ''}
    </div>`;
}

export function noteCardHtml(note, { context = 'home' } = {}) {
  // Erste 5 Zeilen als Vorschau auf der Startseite
  const lines = String(note.text || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 5);
  const preview = lines.join('\n');
  const att = (note.files?.length || 0) + (note.links?.length || 0);

  // Direktzugriff oben rechts: Tags öffnen + anpinnen (nicht im Archiv)
  const tagBtn = note.archived ? '' : `
    <button class="card-tag" data-act="card-tags" data-id="${note.id}"
      aria-label="Tags bearbeiten" title="Tags">${ICON.tag}</button>`;
  const pin = note.archived ? '' : `
    <button class="card-pin ${note.pinned ? 'on' : ''}" data-act="pin-card" data-id="${note.id}"
      aria-label="${note.pinned ? 'Von der Startseite lösen' : 'Anpinnen'}" title="${note.pinned ? 'Von der Startseite lösen' : 'Anpinnen'}">📌</button>`;
  // Gemini: Button neben dem Pin – nur im benutzerdefinierten Modus (Exponieren)
  const geminiBtn = (note.archived || !isGeminiReady() || db.state.settings.geminiMode === 'full') ? '' : `
    <button class="card-gemini ${isExposed('note', note.id) ? 'on' : ''}" data-act="gemini-expose" data-kind="note" data-id="${note.id}"
      aria-label="Für Gemini ${isExposed('note', note.id) ? 'freigegeben – klicken zum Entfernen' : 'freigeben'}"
      title="Für Gemini ${isExposed('note', note.id) ? 'freigegeben – klicken zum Entfernen' : 'freigeben'}">${ICON.gemini}</button>`;

  return `
    <div class="note-card card" data-href="#/notiz/${note.id}" ${cardStyle(note.bg)}>
      <div class="card-top">
        <div class="card-emoji">📝</div>
        <div class="card-title">${esc(note.title || 'Notiz ohne Titel')}</div>
        ${tagBtn}
        ${pin}
        ${geminiBtn}
      </div>
      ${preview ? `<div class="card-preview">${esc(preview)}</div>` : ''}
      <div class="card-meta">
        <span>${fmtRel(note.updatedAt)}</span>
        ${att ? `<span>· 📎 ${att}</span>` : ''}
        ${note.linkedItems?.length ? `<span>· ✅ ${note.linkedItems.length}</span>` : ''}
      </div>
      ${(note.tags || []).length ? `<div class="chips">${note.tags.map((x) => tagChip(note, x)).join('')}</div>` : ''}
    </div>`;
}

export function itemRowHtml(item, { sub = false, history = false, list = null } = {}) {
  const color = item.color && item.color !== 'neutral' ? item.color : '';
  const cls = [
    'item',
    sub ? 'sub' : '',
    item.done ? 'done' : '',
    sub && item.done ? 'item-sub-done' : '',
    color ? `item-c-${esc(color)}` : '',        // ganze Zeile einfärben
  ].filter(Boolean).join(' ');

  // Verknüpfte Notiz als sichtbarer Rückverweis (antippbar)
  const note = item.noteId ? db.byId(item.noteId) : null;
  const noteTitle = note && !note.deleted ? (note.title || 'Notiz ohne Titel') : '';

  const tail = [];
  if (!history) {
    // Direktzugriff in der Zeile: Farbe wählen + Kalender (einplanen) + Notiz verknüpfen
    tail.push(`<button class="row-btn color${color ? ` on c-${color}` : ''}" data-act="item-color" data-id="${item.id}" aria-label="Farbe wählen" title="Farbe">${ICON.palette}</button>`);
    if (db.getSetting('calendarEnabled')) {
      tail.push(`<button class="row-btn cal${item.plan ? ' on' : ''}" data-act="item-plan" data-id="${item.id}" aria-label="In den Kalender einplanen" title="Einplanen">${ICON.calendar}</button>`);
    }
    tail.push(`<button class="row-btn clip${noteTitle ? ' on' : ''}" data-act="item-link" data-id="${item.id}" aria-label="Notiz verknüpfen" title="Notiz verknüpfen">${ICON.clip}</button>`);
    // Direkt ins Archiv (unabhängig von der Wisch-Aktion, die je nach
    // Vorlage auch ins Memory führt)
    tail.push(`<button class="row-btn arch" data-act="item-archive" data-id="${item.id}" aria-label="Ins Archiv" title="Ins Archiv">${ICON.archive}</button>`);
  }
  if (history && !sub) tail.push(`<button class="check hist" data-act="archive-done" data-id="${item.id}" aria-label="Ins Archiv">${ICON.check}</button>`);

  const planTag = item.plan?.date && !history && db.getSetting('calendarEnabled') ? `
    <button class="plan-tag" data-act="item-plan" data-id="${item.id}" title="Termin ändern">📅 ${esc(item.plan.time || '')}${item.plan.dur ? ` · ${item.plan.dur} Min` : ''}</button>` : '';
  // Nur zugewiesene Dauer (noch kein Termin): sichtbarer Chip, öffnet das Wahlrad
  const durTag = !item.plan?.date && item.plan?.dur && !history && db.getSetting('calendarEnabled') ? `
    <button class="plan-tag dur" data-act="item-plan" data-id="${item.id}" title="Dauer ändern">⏱ ${item.plan.dur < 60 ? `${item.plan.dur} Min` : `${String(item.plan.dur / 60).replace('.', ',')} Std`}</button>` : '';

  // Griff zum Verschieben am linken Rand (nur außerhalb von Archiv/Memory)
  const handle = history ? '' : `<button class="drag-handle" type="button" aria-label="Verschieben" title="Verschieben (halten und ziehen)">${ICON.grip}</button>`;

  return `
    <div class="${cls}" data-act="open-item" data-id="${item.id}">
      ${handle}
      <button class="check ${item.done ? 'on' : ''}" data-act="toggle" data-id="${item.id}" aria-label="Abhaken">${ICON.check}</button>
      <div class="item-body">
        <div class="item-text" contenteditable="true" spellcheck="false" data-edit="${item.id}">${esc(item.text)}</div>
        ${noteTitle ? `<button class="linked-note" data-act="open-linked-note" data-id="${note.id}" title="Verknüpfte Notiz öffnen">📝 ${esc(noteTitle)}</button>` : ''}
        ${planTag}${durTag}
      </div>
      <div class="item-tail">${tail.join('')}</div>
    </div>`;
}

/** Rechte Swipe-Aktion für Punkte (je nach Vorlage/Einstellung). */
export function itemRightAction(list) {
  if (list?.template === 'simple') return { cls: 'archive', icon: ICON.archive, label: 'Archiv' };
  if (!db.getSetting('memoryEnabled')) return { cls: 'archive', icon: ICON.archive, label: 'Archiv' };
  return { cls: 'memory', icon: ICON.memory, label: 'Memory' };
}

/** Gruppe: Hauptpunkt (+ Unterpunkte + Fortschritt).
    Jede Zeile ist eine eigene Swipe-Einheit – Unterpunkte lassen sich damit
    genauso wischen und löschen wie Hauptpunkte. */
export function parentGroupHtml(parent, children, { list, history = false, context = 'list' } = {}) {
  const prog = progressOf(children);
  const ra = itemRightAction(list);

  const bg = `
      <div class="swipe-bg">
        <div class="swipe-act left">${ICON.trash}<span>Löschen</span></div>
        <div class="swipe-act right ${ra.cls}">${ra.icon}<span>${ra.label}</span></div>
      </div>`;

  const rowSwipe = (inner, id) => `
    <div class="swipe row-swipe" data-swipe data-id="${id}">
      ${bg}
      <div class="swipe-content">${inner}</div>
    </div>`;

  return `
    <div class="group">
      ${rowSwipe(`
        <div class="item-row">
          ${itemRowHtml(parent, { history, list })}
          ${prog ? `<div class="item-progress"><i style="width:${prog.pct}%"></i></div>` : ''}
        </div>`, parent.id)}
      ${children.map((c) => rowSwipe(itemRowHtml(c, { sub: true, history: false, list }), c.id)).join('')}
      ${history ? '' : `
        <button class="add-sub" data-act="add-sub" data-id="${parent.id}">
          <span class="plus">＋</span> Unterpunkt
        </button>`}
    </div>`;
}

/** Einzelner Punkt (ohne Kinder) als eigene Swipe-Einheit. */
export function standaloneItemHtml(item, { list, history = false } = {}) {
  const ra = itemRightAction(list);
  return `
    <div class="swipe" data-swipe data-id="${item.id}">
      <div class="swipe-bg">
        <div class="swipe-act left">${ICON.trash}<span>Löschen</span></div>
        <div class="swipe-act right ${ra.cls}">${ra.icon}<span>${ra.label}</span></div>
      </div>
      <div class="swipe-content">
        <div class="group" style="margin-bottom:0">
          ${itemRowHtml(item, { history, list })}
        </div>
      </div>
    </div>`;
}

export function cardSwipeHtml(inner, { id, mode }) {
  const rightAct = mode === 'restore'
    ? `<div class="swipe-act right restore">${ICON.restore}<span>Restore</span></div>`
    : mode === 'archive'
      ? `<div class="swipe-act right archive">${ICON.archive}<span>Archiv</span></div>`
      : `<div class="swipe-act right memory">${ICON.memory}<span>Memory</span></div>`;
  return `
    <div class="swipe" data-swipe data-id="${id}" data-mode="${mode}">
      <div class="swipe-bg">
        <div class="swipe-act left">${ICON.trash}<span>Löschen</span></div>
        ${rightAct}
      </div>
      <div class="swipe-content">${inner}</div>
    </div>`;
}

/* ---------------- Swipe-Gesten ---------------- */

export function bindSwipes(scope = document) {
  scope.querySelectorAll('.swipe[data-swipe]').forEach(bindSwipe);
}

function bindSwipe(container) {
  const content = container.querySelector('.swipe-content');
  if (!content || content.dataset.bound) return;
  content.dataset.bound = '1';

  let startX = 0, startY = 0, axis = null, pid = null, shown = 0, samples = [], moved = false;

  const maxX = () => Math.max(container.querySelector('.swipe-act.right')?.offsetWidth || 100, 80);

  const setX = (v) => { shown = v; content.style.transform = `translateX(${v}px)`; };

  content.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startX = e.clientX; startY = e.clientY; axis = null; moved = false;
    pid = e.pointerId; shown = 0; samples = [{ x: e.clientX, t: performance.now() }];
    content.style.willChange = 'transform';
  });

  content.addEventListener('pointermove', (e) => {
    if (pid !== e.pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (axis === null) {
      if (Math.abs(dx) > 9 || Math.abs(dy) > 9) {
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (axis === 'x') {
          try { content.setPointerCapture(e.pointerId); } catch { /* egal */ }
          container.classList.add('dragging');
          haptic(4);
        }
      } else return;
    }
    if (axis !== 'x') return;

    moved = true;
    const limit = maxX();
    let v = dx;
    if (Math.abs(dx) > limit) {
      v = Math.sign(dx) * (limit + rubberband(Math.abs(dx) - limit, 70));
    }
    setX(v);
    samples.push({ x: e.clientX, t: performance.now() });
    if (samples.length > 7) samples.shift();
  });

  const release = (e) => {
    if (pid !== e.pointerId) return;
    pid = null;
    container.classList.remove('dragging');
    content.style.willChange = '';

    if (axis !== 'x') { axis = null; return; }

    // Geschwindigkeit aus den letzten Samples
    let vel = 0;
    if (samples.length > 1) {
      const a = samples[0], b = samples[samples.length - 1];
      const dt = Math.max((b.t - a.t) / 1000, 0.001);
      vel = (b.x - a.x) / dt;
    }
    const dx = shown;
    const limit = maxX();

    let dir = 0;
    if (Math.abs(vel) > 450) dir = Math.sign(vel);
    else if (Math.abs(dx) > limit * 0.55) dir = Math.sign(dx);

    // Zurückfedern (Ausgangspunkt = aktueller Anzeigewert, Geschwindigkeit wird übernommen)
    const cancel = spring({
      from: dx, to: 0, velocity: vel, response: 0.32, damping: 1,
      onUpdate: (v) => setX(v),
      onComplete: () => { content.style.transform = ''; },
    });
    if (reducedMotion()) setX(0);

    // Klick nach dem Ziehen unterdrücken
    if (moved) {
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      content.addEventListener('click', swallow, { capture: true, once: true });
    }

    if (dir !== 0) {
      haptic(10);
      const id = container.dataset.id;
      const mode = container.dataset.mode || '';
      setTimeout(() => {
        if (dir > 0) handleSwipeAction(id, 'right', mode);
        else handleSwipeAction(id, 'left', mode);
      }, 160);
    }
    axis = null;
    moved = false;
  };

  content.addEventListener('pointerup', release);
  content.addEventListener('pointercancel', release);
}

/* ---------------- Reihenfolge per Drag & Drop ---------------- */

/** Punktzeilen lassen sich über den Griff am linken Rand (6-Punkte-Symbol,
    halten und ziehen) verschieben: Hauptpunkte innerhalb ihrer Ebene (in
    Wochenlisten auch auf einen anderen Tag), Unterpunkte innerhalb ihres
    Hauptpunkts. Horizontal wischen bleibt Swipe-Aktion (Archiv/Memory/Löschen). */
export function bindItemDrag(scope = document) {
  scope.querySelectorAll('.swipe[data-swipe]').forEach(bindRowDrag);
}

/** Nicht erledigte Hauptpunkt-Gruppen in einem Container. */
function parentGroupsIn(root) {
  return [...root.children].filter((el) => {
    if (!el.classList?.contains('group')) return false;
    const p = el.querySelector('.item');      // erste Zeile = Hauptpunkt
    return !!p && !p.classList.contains('done');
  });
}

/** Container für die Gruppen einer Sektion (Wochenlisten: die .day-list). */
function groupsRootIn(section) {
  return section?.querySelector?.('.day-list') || section;
}

function bindRowDrag(container) {
  if (container.dataset.dragBound) return;
  const row = container.querySelector('.item');
  if (!row) return;
  container.dataset.dragBound = '1';

  const isSub = row.classList.contains('sub');
  const dragEl = isSub ? container : (container.closest('.group') || container);
  let timer = null, pid = null, sx = 0, sy = 0, active = false, moved = false;
  let els = [], rects = [], idx0 = 0, dragH = 0, lastIdx = 0, srcSection = null;

  const scopeEls = () => {
    if (isSub) {
      const grp = container.closest('.group');
      return grp ? [...grp.children].filter((el) => el.classList?.contains('swipe') && el.querySelector('.item.sub')) : [];
    }
    const section = container.closest('.day-section');
    const root = section ? groupsRootIn(section) : document.getElementById('listBody');
    return root ? parentGroupsIn(root) : [];
  };

  const blockScroll = (e) => { if (active) e.preventDefault(); };

  const begin = () => {
    timer = null;
    els = scopeEls();
    idx0 = els.indexOf(dragEl);
    if (idx0 < 0) return;                    // z. B. erledigter Punkt
    rects = els.map((el) => el.getBoundingClientRect());
    dragH = rects[idx0].height;
    lastIdx = idx0;
    srcSection = container.closest('.day-section');
    active = true; moved = true;
    dragEl.classList.add('row-lift');
    document.body.classList.add('item-dragging');
    document.addEventListener('touchmove', blockScroll, { passive: false });
    haptic(10);
  };

  // Ziehen über den Griff am linken Rand (6-Punkte-Symbol): halten und ziehen
  const handle = container.querySelector('.drag-handle');
  if (handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (active || timer !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      pid = e.pointerId; sx = e.clientX; sy = e.clientY;
      timer = setTimeout(begin, 80);            // kurzes Halten, dann Ziehen
    });
    // Tipp auf den Griff tut nichts (Öffnen des Punkts verhindern)
    handle.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); });
  }

  container.addEventListener('pointermove', (e) => {
    if (pid === null || e.pointerId !== pid) return;
    if (!active) {
      if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) {
        clearTimeout(timer); timer = null; pid = null;   // war ein Scrollen/Wischen
      }
      return;
    }
    try { container.setPointerCapture(e.pointerId); } catch { /* egal */ }
    const dy = e.clientY - sy;
    dragEl.style.transform = `translateY(${dy}px)`;
    let idx = 0;
    for (let i = 0; i < rects.length; i++) {
      if (e.clientY > rects[i].top + rects[i].height / 2) idx = i;
    }
    if (idx !== lastIdx) { lastIdx = idx; haptic(4); }
    els.forEach((el, i) => {
      if (i === idx0) return;
      let sh = 0;
      if (idx > idx0 && i > idx0 && i <= idx) sh = -dragH;
      else if (idx < idx0 && i >= idx && i < idx0) sh = dragH;
      el.style.transform = sh ? `translateY(${sh}px)` : '';
    });
  });

  const finish = (e, commit) => {
    clearTimeout(timer); timer = null;
    if (pid === null || (e && e.pointerId !== pid)) return;
    pid = null;
    if (moved) {                              // Klick nach dem Ziehen unterdrücken
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      container.addEventListener('click', swallow, { capture: true, once: true });
    }
    if (!active) { moved = false; return; }
    active = false;
    dragEl.classList.remove('row-lift');
    document.body.classList.remove('item-dragging');
    document.removeEventListener('touchmove', blockScroll);
    els.forEach((el) => { el.style.transform = ''; });
    dragEl.style.transform = '';
    if (commit) applyReorder(e);
    moved = false;
  };

  container.addEventListener('pointerup', (e) => finish(e, true));
  container.addEventListener('pointercancel', (e) => finish(e, false));

  /** Neue Reihenfolge (und ggf. Wochentag) speichern. */
  function applyReorder(e) {
    const id = container.dataset.id;
    const idOf = (el) => el.dataset.id || el.querySelector('.swipe[data-swipe]')?.dataset.id;
    const save = (ids) => ids.forEach((x, i) => {
      const it = x && db.byId(x);
      const want = (i + 1) * 1000;
      if (it && (it.order || 0) !== want) db.update(x, { order: want });
    });

    // In einen anderen Bereich gezogen? (Wochen-Vorlage = anderer Tag)
    if (!isSub && srcSection && e) {
      container.style.visibility = 'hidden';  // nicht unter dem Finger liegen
      const under = document.elementFromPoint(e.clientX, e.clientY);
      container.style.visibility = '';
      const dropSection = under?.closest?.('.day-section');
      if (dropSection && dropSection !== srcSection) {
        const day = Number(dropSection.dataset.day ?? -1);
        const tEls = parentGroupsIn(groupsRootIn(dropSection));
        let idx = tEls.length;
        for (let i = 0; i < tEls.length; i++) {
          const r = tEls[i].getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) { idx = i; break; }
        }
        const ids = tEls.map(idOf);
        ids.splice(idx, 0, id);
        save(ids);
        const it = db.byId(id);
        if (it && (it.day ?? -1) !== day) db.update(id, { day: day >= 0 ? day : null });
        haptic(12);
        return;
      }
    }

    if (lastIdx === idx0) return;
    const ids = els.map(idOf);
    ids.splice(idx0, 1);
    ids.splice(lastIdx, 0, id);
    save(ids);
    haptic(12);
  }
}

/** Aktion je nach Wischrichtung und Kontext. */
function handleSwipeAction(id, dir, mode) {
  const rec = db.byId(id);
  if (!rec) return;

  if (rec.kind === 'note' || rec.kind === 'list') {
    const name = rec.title || (rec.kind === 'note' ? 'Notiz' : 'Liste');
    if (dir === 'left') {           // Archiv
      if (mode === 'restore') { db.update(id, { archived: 0 }); S.toast('Wiederhergestellt'); return; }
      db.update(id, { archived: 1 });
      haptic(10);
      S.undoToast('Ins Archiv verschoben', () => db.update(id, { archived: 0 }));
    } else {                         // Löschen
      S.guardedDelete(name, () => {
        if (rec.kind === 'list') db.softDeleteList(id); else db.softDelete(id);
        S.undoToast('Gelöscht', () => restoreListOrNote(id));
      });
    }
    return;
  }

  if (rec.kind === 'item') {
    const name = rec.text || 'Punkt';
    if (mode === 'restore' && dir === 'left') {   // Wiederherstellen (Archiv)
      S.restoreItem(id);                           // ganze Gruppe inkl. Unterpunkten
      return;
    }
    if (dir === 'left') {           // Memory (oder Archiv bei einfacher Liste)
      const list = db.byId(rec.listId);
      if (list?.template === 'simple') {
        const ids = [id, ...db.childIds(id)];      // Unterpunkte wandern mit
        const now = Date.now();
        ids.forEach((x, i) => db.update(x, { state: 'archived', archivedAt: now + i, originTitle: list.title || 'Liste' }));
        S.undoToast('Ins Archiv verschoben', () => ids.forEach((x) => db.update(x, { state: 'active', archivedAt: 0 })));
      } else if (db.getSetting('memoryEnabled')) {
        S.toMemory(id);
      } else {
        S.archiveItem(id);
      }
    } else {                         // Löschen
      S.guardedDelete(name, () => {
        const ids = [id, ...db.childIds(id)];
        S.deleteItem(id);
        S.undoToast('Gelöscht', () => ids.forEach((x) => db.update(x, { deleted: 0 })));
      });
    }
  }
}

function restoreListOrNote(id) {
  db.update(id, { deleted: 0 });
}

/* ---------------- Punkte-Aktionen ---------------- */

export function toggleItem(id, list) {
  const it = db.byId(id);
  if (!it) return;
  const lst = list || db.byId(it.listId);

  // Sofort visuell reagieren, dann neu zeichnen
  document.querySelectorAll(`[data-act="toggle"][data-id="${id}"]`).forEach((c) => {
    if (!it.done) c.classList.add('on');
    else c.classList.remove('on');
  });

  const delay = reducedMotion() ? 0 : 190;

  if (lst?.template === 'simple') {
    // Simpel: abgehakte Punkte werden entfernt
    const ids = [id, ...db.childIds(id)];
    setTimeout(() => {
      S.deleteItem(id);
      haptic(10);
      S.undoToast('Punkt erledigt & entfernt', () => ids.forEach((x) => db.update(x, { deleted: 0 })));
    }, delay);
    return;
  }

  setTimeout(() => {
    db.update(id, { done: it.done ? 0 : 1, doneAt: it.done ? 0 : Date.now() });
    haptic(8);
  }, delay);
}

export function addParentItem(listId, day = null) {
  const list = db.byId(listId);
  if (!list) return null;
  const siblings = db.itemsOfList(listId).filter((i) => !i.parentId);
  const maxOrder = siblings.reduce((m, i) => Math.max(m, i.order || 0), 0);
  const item = db.create('item', {
    listId, parentId: null, text: '', order: maxOrder + 1000,
    day: list.template === 'woche' ? day : null,
  });
  return item;
}

export function addChildItem(parentId) {
  const parent = db.byId(parentId);
  if (!parent) return null;
  const kids = db.itemsOfList(parent.listId).filter((i) => i.parentId === parentId);
  const maxOrder = kids.reduce((m, i) => Math.max(m, i.order || 0), 0);
  const item = db.create('item', {
    listId: parent.listId, parentId, text: '', order: maxOrder + 1000, day: parent.day ?? null,
  });
  return item;
}

/** Leere Punkte beim Verlassen entfernen. */
export function pruneEmptyItems() {
  for (const r of [...db.state.records.values()]) {
    if (r.kind === 'item' && !r.deleted && !r.text.trim() && !r.done) db.purge(r.id);
  }
}

export { handleSwipeAction };
