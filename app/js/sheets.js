/* secondmind – sheets.js
   Overlays: Bottom-Sheets, Bestätigungen, Menüs, Toasts, Erstell-Flows. */

import * as db from './db.js';
import { esc, ICON, haptic, fmtBytes, WEEKDAYS, WEEKDAYS_SHORT, TAG_COLORS, isoDate, parseISO, addMinutesToTime } from './util.js';
import { navigate } from './router.js';
import * as gemini from './gemini.js';
import * as repeat from './repeat.js';

const root = () => document.getElementById('sheetRoot');
const toastRoot = () => document.getElementById('toastRoot');

let openHandle = null;
let generation = 0;

/* ---------------- Grundgerüst ---------------- */

export function openSheet({ title = '', body = '', menu = '', centered = false, headLeft = '', headRight = '', onMount, dismissable = true }) {
  closeSheet(true);
  generation++;
  const r = root();
  r.innerHTML = '';

  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  if (dismissable) scrim.addEventListener('click', () => handle.close());

  const sheet = document.createElement('div');
  sheet.className = 'sheet' + (centered ? ' centered' : '');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');

  let html = '';
  if (!centered) html += '<div class="grabber"></div>';
  if (title || headLeft || headRight) {
    html += `<div class="sheet-head">
      ${headLeft || '<span style="width:60px"></span>'}
      <div class="sheet-title">${esc(title)}</div>
      ${headRight || '<span style="width:60px"></span>'}
    </div>`;
  }
  if (menu) html += menu;
  else html += `<div class="sheet-body${centered ? ' tight' : ''}">${body}</div>`;
  sheet.innerHTML = html;

  r.appendChild(scrim);
  r.appendChild(sheet);
  r.classList.add('active');
  requestAnimationFrame(() => requestAnimationFrame(() => r.classList.add('open')));

  const handle = {
    root: sheet,
    close: (immediate = false) => closeSheet(immediate),
    body: (html2) => { const b = sheet.querySelector('.sheet-body'); if (b) b.innerHTML = html2; },
  };
  openHandle = handle;
  onMount?.(sheet, handle);

  const escHandler = (e) => { if (e.key === 'Escape') handle.close(); };
  document.addEventListener('keydown', escHandler);
  handle._esc = escHandler;

  return handle;
}

export function closeSheet(immediate = false) {
  const r = root();
  if (!r.classList.contains('open') && !r.classList.contains('active')) return;
  const h = openHandle;
  if (h?._esc) document.removeEventListener('keydown', h._esc);
  openHandle = null;
  r.classList.remove('open');
  const myGen = generation;
  const done = () => {
    if (myGen !== generation) return;   // inzwischen wurde ein neues Sheet geöffnet
    r.classList.remove('active');
    r.innerHTML = '';
  };
  if (immediate) done();
  else setTimeout(done, 420);
}

export const sheetIsOpen = () => root().classList.contains('open');

/* ---------------- Bestätigung ---------------- */

export function confirm({ title, text = '', confirmLabel = 'OK', cancelLabel = 'Abbrechen', danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const h = openSheet({
      centered: true,
      title,
      body: `<p class="confirm-text">${esc(text)}</p>
        <div class="sheet-menu" style="padding:0 0 4px">
          <button class="menu-btn ${danger ? 'danger' : ''}" data-yes style="justify-content:center">${esc(confirmLabel)}</button>
          <button class="menu-btn" data-no style="justify-content:center; color:var(--accent)">${esc(cancelLabel)}</button>
        </div>`,
      onMount(sheet) {
        sheet.querySelector('[data-yes]').onclick = () => { settled = true; h.close(); haptic(12); resolve(true); };
        sheet.querySelector('[data-no]').onclick = () => { settled = true; h.close(); resolve(false); };
      },
      onclose: null,
    });
    sheet_close_guard(h, () => { if (!settled) { settled = true; resolve(false); } });
  });
}

function sheet_close_guard(handle, cb) {
  const orig = handle.close;
  handle.close = (immediate) => { orig.call(handle, immediate); cb(); };
}

/* ---------------- Toast ---------------- */

export function toast(message, { action, onAction, duration = 4200, type = '' } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' err' : '');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button class="t-act">${esc(action)}</button>` : ''}`;
  toastRoot().appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    el.classList.remove('in');
    setTimeout(() => el.remove(), 360);
  };
  if (action) {
    el.querySelector('.t-act').onclick = () => { remove(); onAction?.(); };
  }
  setTimeout(remove, duration);
  return { remove };
}

/* ---------------- Löschen mit Rückfrage ---------------- */

export async function guardedDelete(name, doDelete) {
  if (!db.getSetting('confirmDelete')) { doDelete(); return true; }
  haptic(14);
  const ok = await confirm({
    title: 'Wirklich löschen?',
    text: `„${name}“ wird gelöscht. Du kannst es direkt danach rückgängig machen.`,
    confirmLabel: 'Löschen',
  });
  if (ok) { haptic(16); doDelete(); }
  return ok;
}

export function undoToast(message, restore) {
  toast(message, {
    action: 'Rückgängig',
    onAction: () => { restore(); haptic(8); },
    duration: 5000,
  });
}

/* ---------------- Erstellen (FAB) ---------------- */

export function openCreateMenu() {
  openSheet({
    title: 'Neu erstellen',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn" data-close>Schließen</button>',
    menu: `<div class="sheet-menu">
      <button class="menu-btn" data-new="note">
        <span class="mi">📝</span>
        <span class="mb"><span>Notiz</span><span class="ms">Titel, Text, Links & Fotos</span></span>
      </button>
      <button class="menu-btn" data-new="list">
        <span class="mi">✅</span>
        <span class="mb"><span>To-Do-Liste</span><span class="ms">Woche, Standard oder Simpel</span></span>
      </button>
    </div>`,
    onMount(sheet, handle) {
      sheet.querySelector('[data-close]').onclick = () => handle.close();
      sheet.querySelector('[data-new="note"]').onclick = () => {
        handle.close();
        const note = db.create('note', { title: '', text: '', dirty: 1 });
        haptic(8);
        navigate(`#/notiz/${note.id}`);
      };
      sheet.querySelector('[data-new="list"]').onclick = () => { handle.close(); setTimeout(openTemplatePicker, 240); };
    },
  });
}

const TEMPLATES = [
  { key: 'woche', icon: '📅', label: 'Woche', sub: '7 Wochentage, Historie, Archiv & Memory' },
  { key: 'standard', icon: '🗒', label: 'Standard', sub: 'Titel, Punkte mit Unterpunkten, alles dabei' },
  { key: 'simple', icon: '⚡️', label: 'Simpel', sub: 'Nur Liste – abgehakte Punkte verschwinden' },
];

export function openTemplatePicker() {
  openSheet({
    title: 'Vorlage wählen',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn" data-close>Abbrechen</button>',
    menu: `<div class="sheet-menu">
      ${TEMPLATES.map((t) => `
        <button class="menu-btn" data-tpl="${t.key}">
          <span class="mi">${t.icon}</span>
          <span class="mb"><span>${t.label}</span><span class="ms">${t.sub}</span></span>
        </button>`).join('')}
    </div>`,
    onMount(sheet, handle) {
      sheet.querySelector('[data-close]').onclick = () => handle.close();
      sheet.querySelectorAll('[data-tpl]').forEach((btn) => {
        btn.onclick = () => {
          const tpl = btn.dataset.tpl;
          handle.close();
          const list = db.create('list', { template: tpl, title: tpl === 'woche' ? 'Diese Woche' : '' });
          haptic(8);
          navigate(`#/liste/${list.id}`);
          if (tpl !== 'simple') setTimeout(() => openListTitleSheet(list.id), 380);
        };
      });
    },
  });
}

export function openListTitleSheet(listId) {
  const rec = db.byId(listId);
  if (!rec) return;
  openSheet({
    title: 'Listen-Titel',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn strong" data-done>Fertig</button>',
    body: `<input class="text-in" id="ttl" placeholder="Worum geht es?" value="${esc(rec.title)}" maxlength="120">`,
    onMount(sheet, handle) {
      const input = sheet.querySelector('#ttl');
      setTimeout(() => input.focus(), 320);
      const save = () => { if (db.byId(listId)) db.update(listId, { title: input.value.trim() }); };
      input.oninput = save;
      input.onkeydown = (e) => { if (e.key === 'Enter') { save(); handle.close(); } };
      sheet.querySelector('[data-done]').onclick = () => { save(); handle.close(); };
    },
  });
}

/* ---------------- Punkt-Editor ---------------- */

export const COLOR_LABELS = { neutral: 'Neutral', green: 'Erledigt/Wichtig', yellow: 'Mittlere Dringlichkeit', red: 'Dringend' };

export function openItemSheet(itemId) {
  const item = db.byId(itemId);
  if (!item || item.kind !== 'item') return;
  const list = db.byId(item.listId);
  const isWeek = list?.template === 'woche';
  const note = item.noteId ? db.byId(item.noteId) : null;

  const colors = ['neutral', 'green', 'yellow', 'red'];

  const body = `
    <textarea class="text-in" id="itext" rows="2" placeholder="Punkt beschreiben" style="resize:none;min-height:56px">${esc(item.text)}</textarea>

    <div class="settings-group" style="margin-top:16px">
      <div class="row" style="flex-direction:column;align-items:stretch;gap:10px">
        <div class="r-label">Farbe</div>
        <div class="color-dots" data-colors>
          ${colors.map((c) => `<button class="color-dot dot-${c} ${item.color === c ? 'sel' : ''}" data-color="${c}" aria-label="${COLOR_LABELS[c]}"></button>`).join('')}
        </div>
      </div>
      ${isWeek ? `
      <div class="row" style="flex-direction:column;align-items:stretch;gap:10px">
        <div class="r-label">Wochentag</div>
        <div class="seg" data-days>
          ${WEEKDAYS.map((d, i) => `<button class="${(item.day ?? -1) === i ? 'on' : ''}" data-day="${i}">${d.slice(0, 2)}</button>`).join('')}
          <button class="${(item.day ?? -1) < 0 ? 'on' : ''}" data-day="-1">–</button>
        </div>
      </div>` : ''}
      <button class="row tappable" data-note>
        <span class="r-label">Mit Notiz verknüpfen</span>
        <span class="r-value">${note ? esc(note.title || 'Notiz ohne Titel') : 'Keine'}</span>
        <span class="chev">›</span>
      </button>
      ${note ? `
      <button class="row tappable" data-open-note>
        <span class="r-label">Verknüpfte Notiz öffnen</span>
        <span class="chev">›</span>
      </button>` : ''}
    </div>

    <div class="settings-group">
      <button class="row tappable" data-archive>
        <span class="r-label">Ins Archiv verschieben</span>
        <span class="chev">›</span>
      </button>
      ${db.getSetting('memoryEnabled') ? `
      <button class="row tappable" data-memory>
        <span class="r-label">In Memory verschieben</span>
        <span class="chev">›</span>
      </button>` : ''}
      <button class="row tappable destructive" data-delete>
        <span class="r-label">Punkt löschen</span>
      </button>
    </div>
  `;

  openSheet({
    title: 'Punkt',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn strong" data-done>Fertig</button>',
    body,
    onMount(sheet, handle) {
      const ta = sheet.querySelector('#itext');
      setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 320);
      ta.oninput = () => { if (db.byId(itemId)) db.update(itemId, { text: ta.value }); };

      sheet.querySelectorAll('[data-color]').forEach((b) => {
        b.onclick = () => {
          sheet.querySelectorAll('[data-color]').forEach((x) => x.classList.remove('sel'));
          b.classList.add('sel');
          haptic(6);
          if (db.byId(itemId)) db.update(itemId, { color: b.dataset.color });
        };
      });

      sheet.querySelectorAll('[data-day]').forEach((b) => {
        b.onclick = () => {
          sheet.querySelectorAll('[data-day]').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          haptic(6);
          const d = Number(b.dataset.day);
          if (db.byId(itemId)) db.update(itemId, { day: d < 0 ? null : d });
        };
      });

      sheet.querySelector('[data-note]').onclick = () => {
        handle.close();
        openNotePicker({
          title: 'Notiz verknüpfen',
          current: item.noteId,
          allowUnlink: true,
          onPick: (noteId) => linkNoteToItem(itemId, noteId),
          onUnlink: () => linkNoteToItem(itemId, null),
          onCreate: () => {
            const n = db.create('note', { title: ta.value || '', text: '' });
            linkNoteToItem(itemId, n.id);
            return n.id;
          },
        });
      };

      sheet.querySelector('[data-open-note]')?.addEventListener('click', () => {
        handle.close();
        navigate(`#/notiz/${item.noteId}`);
      });

      sheet.querySelector('[data-archive]').onclick = () => {
        handle.close();
        archiveItem(itemId);
      };
      sheet.querySelector('[data-memory]')?.addEventListener('click', () => {
        handle.close();
        toMemory(itemId);
      });
      sheet.querySelector('[data-delete]').onclick = async () => {
        handle.close();
        await guardedDelete(item.text || 'Punkt', () => deleteItem(itemId));
      };
      sheet.querySelector('[data-done]').onclick = () => handle.close();
    },
  });
}

/* ---------------- Farbwahl direkt aus der Punktzeile ---------------- */

export function openItemColorSheet(itemId) {
  const item = db.byId(itemId);
  if (!item || item.kind !== 'item') return;

  const colors = ['neutral', 'green', 'yellow', 'red'];

  openSheet({
    title: 'Farbe',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn strong" data-close>Fertig</button>',
    body: `
      <div class="settings-group">
        <div class="row" style="flex-direction:column;align-items:stretch;gap:10px">
          <div class="r-label">Punkt einfärben</div>
          <div class="color-dots" data-colors>
            ${colors.map((c) => `<button class="color-dot dot-${c} ${item.color === c ? 'sel' : ''}" data-color="${c}" aria-label="${COLOR_LABELS[c] || c}"></button>`).join('')}
          </div>
        </div>
        <div class="row"><span class="r-note">Die Farbe färbt den ganzen Punkt bzw. Unterpunkt ein. „Neutral“ entfernt die Farbe.</span></div>
      </div>`,
    onMount(sheet, handle) {
      sheet.querySelector('[data-close]').onclick = () => handle.close();
      sheet.querySelectorAll('[data-color]').forEach((b) => {
        b.onclick = () => {
          sheet.querySelectorAll('[data-color]').forEach((x) => x.classList.remove('sel'));
          b.classList.add('sel');
          haptic(6);
          if (db.byId(itemId)) db.update(itemId, { color: b.dataset.color });
        };
      });
    },
  });
}

export function archiveItem(itemId) {
  const it = db.byId(itemId);
  if (!it) return;
  const list = db.byId(it.listId);
  const now = Date.now();
  const origin = list?.title || it.originTitle || 'Gelöschte Liste';
  const ids = [itemId, ...db.childIds(itemId)];        // Unterpunkte wandern mit
  ids.forEach((x, i) => db.update(x, { state: 'archived', archivedAt: now + i, originTitle: origin }));
  haptic(10);
  undoToast('In Archiv verschoben', () => ids.forEach((x) => db.update(x, { state: 'active', archivedAt: 0 })));
}

export function toMemory(itemId) {
  const it = db.byId(itemId);
  if (!it) return;
  const now = Date.now();
  const ids = [itemId, ...db.childIds(itemId)];        // Unterpunkte wandern mit
  ids.forEach((x, i) => db.update(x, { state: 'memory', memoryAt: now + i }));
  haptic(10);
  undoToast('In Memory verschoben', () => ids.forEach((x) => db.update(x, { state: 'active', memoryAt: 0 })));
}

/** Wiederherstellen: immer die ganze Gruppe – ist der Hauptpunkt noch im
    Memory/Archiv, kommt er samt allen Unterpunkten zurück (sonst landet
    der wiederhergestellte Unterpunkt in einer unsichtbaren Leere). */
export function restoreItem(itemId) {
  const rec = db.byId(itemId);
  if (!rec) return;
  const parent = rec.parentId ? db.byId(rec.parentId) : null;
  const root = parent && (parent.state === 'memory' || parent.state === 'archived') ? parent.id : itemId;
  const ids = [root, ...db.childIds(root)];
  ids.forEach((x) => db.update(x, { state: 'active', archivedAt: 0, memoryAt: 0 }));
  haptic(10);
  toast('Wiederhergestellt');
}

export function deleteItem(itemId) {
  db.softDeleteTree(itemId);
}

/* ---------------- Notiz-Wähler ---------------- */

/**
 * Punkt und Notiz beidseitig verknüpfen.
 * noteId = null löst die Verknüpfung – beide Seiten werden konsistent gehalten
 * (item.noteId und note.linkedItems), damit auch das Gegenstück darauf zeigt.
 */
export function linkNoteToItem(itemId, noteId) {
  const item = db.byId(itemId);
  if (!item || item.kind !== 'item') return;

  const prev = item.noteId ? db.byId(item.noteId) : null;
  const next = noteId ? db.byId(noteId) : null;

  if (prev && prev.id !== (next?.id || null)) {
    db.update(prev.id, { linkedItems: (prev.linkedItems || []).filter((x) => x !== itemId) });
  }
  if (next) {
    const set = new Set(next.linkedItems || []);
    set.add(itemId);
    db.update(next.id, { linkedItems: [...set] });
  }
  db.update(itemId, { noteId: next ? next.id : null });
  haptic(8);
}

export function openNotePicker({ title = 'Notiz wählen', current = null, allowUnlink = false, onPick, onUnlink, onCreate }) {
  const notes = db.recs('note').sort((a, b) => b.updatedAt - a.updatedAt);
  const rows = notes.slice(0, 60).map((n) => `
    <button class="row tappable" data-pick="${n.id}">
      <span class="r-label">${esc(n.title || 'Notiz ohne Titel')}</span>
      <span class="r-value">${n.id === current ? '✓' : ''}</span>
    </button>`).join('');

  openSheet({
    title,
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn" data-close>Abbrechen</button>',
    body: `
      ${onCreate ? `<button class="btn secondary" data-create style="margin-bottom:14px">＋ Neue Notiz erstellen</button>` : ''}
      ${allowUnlink && current ? `<button class="btn secondary" data-unlink style="margin-bottom:14px">Verknüpfung lösen</button>` : ''}
      <div class="settings-group">
        ${rows || '<div class="row"><span class="r-label" style="color:var(--label-2)">Noch keine Notizen</span></div>'}
      </div>`,
    onMount(sheet, handle) {
      sheet.querySelector('[data-close]').onclick = () => handle.close();
      sheet.querySelector('[data-create]')?.addEventListener('click', () => {
        const id = onCreate();
        handle.close();
        if (id) navigate(`#/notiz/${id}`);
      });
      sheet.querySelector('[data-unlink]')?.addEventListener('click', () => {
        handle.close();
        onUnlink?.();
      });
      sheet.querySelectorAll('[data-pick]').forEach((b) => {
        b.onclick = () => { handle.close(); onPick?.(b.dataset.pick); };
      });
    },
  });
}

/* ---------------- Tag-Editor (mit Farben pro Tag) ---------------- */

export function openTagSheet(recordId) {
  const rec = db.byId(recordId);
  if (!rec) return;
  const tags = [...(rec.tags || [])];
  const tagColors = { ...(rec.tagColors || {}) };
  let sel = -1;                                   // ausgewählter Tag für die Farbwahl

  const all = new Set();
  for (const r of db.state.records.values()) (r.tags || []).forEach((t) => all.add(t));

  const persist = () => {
    if (!db.byId(recordId)) return;
    const colors = {};
    for (const [t, c] of Object.entries(tagColors)) {
      if (tags.includes(t) && c && c !== 'neutral') colors[t] = c;
    }
    db.update(recordId, { tags: [...tags], tagColors: colors });
  };

  const render = (sheet) => {
    // Tag-Pills: Name wählt die Farbe, × entfernt den Tag
    sheet.querySelector('[data-chips]').innerHTML = tags.length
      ? tags.map((t, i) => `
        <span class="tag-edit ${i === sel ? 'sel' : ''}">
          <button class="te-name" data-sel="${i}">
            <span class="te-dot ${tagColors[t] && tagColors[t] !== 'neutral' ? `c-${tagColors[t]}` : ''}"></span>${esc(t)}
          </button>
          <button class="te-x" data-rm="${i}" aria-label="Tag entfernen">×</button>
        </span>`).join('')
      : '<span class="r-note" style="color:var(--label-3)">Noch keine Tags</span>';
    sheet.querySelectorAll('[data-sel]').forEach((b) => {
      b.onclick = () => { sel = Number(b.dataset.sel); haptic(6); render(sheet); };
    });
    sheet.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.rm);
        delete tagColors[tags[i]];
        tags.splice(i, 1);
        if (sel >= tags.length) sel = tags.length - 1;
        persist();
        render(sheet);
      };
    });

    // Farbpalette für den ausgewählten Tag
    const pal = sheet.querySelector('[data-palette]');
    if (sel < 0 || !tags[sel]) {
      pal.innerHTML = '<span class="r-note" style="color:var(--label-3)">Tag antippen, um eine Farbe zu wählen.</span>';
    } else {
      const cur = tagColors[tags[sel]] || 'neutral';
      pal.innerHTML = `<div class="color-dots">${TAG_COLORS.map((c) =>
        `<button class="color-dot dot-${c} ${cur === c ? 'sel' : ''}" data-tcolor="${c}" aria-label="Farbe ${c}"></button>`).join('')}</div>`;
      pal.querySelectorAll('[data-tcolor]').forEach((b) => {
        b.onclick = () => { tagColors[tags[sel]] = b.dataset.tcolor; haptic(6); persist(); render(sheet); };
      });
    }

    // Vorschläge aus anderen Datensätzen
    const sug = [...all].filter((t) => !tags.includes(t)).slice(0, 10);
    sheet.querySelector('[data-sug]').innerHTML = sug.map((t) => `<button class="chip" data-add="${esc(t)}">${esc(t)}</button>`).join('');
    sheet.querySelectorAll('[data-add]').forEach((b) => {
      b.onclick = () => { tags.push(b.dataset.add); persist(); render(sheet); };
    });
  };

  openSheet({
    title: 'Tags',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn strong" data-done>Fertig</button>',
    body: `
      <div class="chips" data-chips style="margin-bottom:14px"></div>
      <input class="text-in" id="tagin" placeholder="Tag eingeben und Enter drücken" maxlength="30">
      <div class="grp-label" style="margin-top:16px">Farbe</div>
      <div data-palette style="margin-bottom:4px"></div>
      <div class="grp-label" style="margin-top:14px">Vorschläge</div>
      <div class="chips" data-sug></div>`,
    onMount(sheet, handle) {
      render(sheet);
      const input = sheet.querySelector('#tagin');
      setTimeout(() => input.focus(), 320);
      const add = () => {
        const v = input.value.trim().replace(/,$/, '');
        if (v && !tags.includes(v)) { tags.push(v); sel = tags.length - 1; persist(); render(sheet); }
        input.value = '';
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
      input.onblur = add;
      sheet.querySelector('[data-done]').onclick = () => { add(); handle.close(); };
    },
  });
}

/* ---------------- Farbwähler (Hintergrund) ---------------- */

/** 15 kräftige Hintergründe + „Keine Farbe“.
    Die Textfarbe rechnet cardStyle() anhand der Luminanz automatisch um
    (helle Töne = dunkle Schrift, kräftige/dunkle Töne = weiße Schrift). */
export const BG_SWATCHS = [
  '', '#FFD400', '#FFB300', '#FF8C00', '#FF5300', '#FF3B30',
  '#FF2D55', '#E11D8C', '#AF52DE', '#5E5CE6', '#0A84FF', '#00A8CC',
  '#00B386', '#34C759', '#A0703C', '#8E8E93',
];

export function openBgSheet(recordId) {
  const rec = db.byId(recordId);
  if (!rec) return;
  openSheet({
    title: 'Hintergrundfarbe',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn strong" data-done>Fertig</button>',
    body: `<div class="bg-swatches" data-sw style="margin-top:6px">
      ${BG_SWATCHS.map((c) => `<button class="bg-swatch ${(rec.bg || '') === c ? 'sel' : ''}" data-bg="${c}"
        style="background:${c || 'var(--fill)'};${c ? '' : 'color:var(--label-2);font-size:13px'}"
        aria-label="${c ? c : 'Keine Farbe'}">${c ? '' : '✕'}</button>`).join('')}
    </div>`,
    onMount(sheet, handle) {
      sheet.querySelectorAll('[data-bg]').forEach((b) => {
        b.onclick = () => {
          sheet.querySelectorAll('[data-bg]').forEach((x) => x.classList.remove('sel'));
          b.classList.add('sel');
          haptic(6);
          if (db.byId(recordId)) db.update(recordId, { bg: b.dataset.bg });
        };
      });
      sheet.querySelector('[data-done]').onclick = () => handle.close();
    },
  });
}

/* ---------------- Anhang-Auswahl (Links) ---------------- */

export function openLinkSheet(recordId) {
  const rec = db.byId(recordId);
  if (!rec) return;
  const links = rec.links || [];

  openSheet({
    title: 'Link hinzufügen',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn strong" data-done>Fertig</button>',
    body: `
      <input class="text-in" id="lu" type="url" inputmode="url" placeholder="https://…" autocapitalize="off">
      <input class="text-in" id="lt" placeholder="Bezeichnung (optional)" style="margin-top:10px">
      <button class="btn" data-add style="margin-top:14px">Hinzufügen</button>
      <div class="grp-label" style="margin-top:20px">Gespeicherte Links</div>
      <div class="attach-list" data-list></div>`,
    onMount(sheet, handle) {
      const render = () => {
        const cur = db.byId(recordId)?.links || [];
        sheet.querySelector('[data-list]').innerHTML = cur.length
          ? cur.map((l, i) => `
            <div class="attach">
              <div class="a-icon">🔗</div>
              <div class="a-body">
                <div class="a-title">${esc(l.title || l.url)}</div>
                <div class="a-sub">${esc(l.url)}</div>
              </div>
              <button class="a-del" data-rm="${i}">×</button>
            </div>`).join('')
          : '<div class="r-note" style="color:var(--label-3);padding:6px 2px">Noch keine Links</div>';
        sheet.querySelectorAll('[data-rm]').forEach((b) => {
          b.onclick = () => {
            const cur2 = [...(db.byId(recordId)?.links || [])];
            cur2.splice(Number(b.dataset.rm), 1);
            db.update(recordId, { links: cur2 });
            render();
          };
        });
      };
      render();

      sheet.querySelector('[data-add]').onclick = () => {
        const url = sheet.querySelector('#lu').value.trim();
        if (!url) return;
        const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        const title = sheet.querySelector('#lt').value.trim();
        const cur = [...(db.byId(recordId)?.links || [])];
        cur.push({ id: uidShort(), url: full, title });
        db.update(recordId, { links: cur });
        sheet.querySelector('#lu').value = '';
        sheet.querySelector('#lt').value = '';
        haptic(8);
        render();
      };
      sheet.querySelector('[data-done]').onclick = () => handle.close();
    },
  });
}

/* ---------------- Kalender: Punkte einplanen ---------------- */

export const PLAN_DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

const durLabel = (d) => (d < 60 ? `${d} Min` : `${String(d / 60).replace('.', ',')} Std`);

const WHEEL_ROW = 40;                     // Pixel pro Wahlrad-Zeile

/** iOS-artiges Wahlrad für Dauern: scrollen oder auf einen Wert tippen. */
function mountWheel(box, values, idx, onChange) {
  box.className = 'wheel';
  box.innerHTML = `
    <div class="wheel-band"></div>
    <div class="wheel-list">${values.map((v, i) =>
      `<div class="wheel-opt" data-i="${i}">${durLabel(v)}</div>`).join('')}</div>`;
  const list = box.querySelector('.wheel-list');
  let cur = Math.max(0, Math.min(values.length - 1, idx));
  const mark = () => list.querySelectorAll('.wheel-opt').forEach((o, i) => o.classList.toggle('sel', i === cur));
  let t = 0;
  list.addEventListener('scroll', () => {
    const i = Math.max(0, Math.min(values.length - 1, Math.round(list.scrollTop / WHEEL_ROW)));
    if (i !== cur) { cur = i; mark(); onChange(values[cur]); haptic(4); }
    clearTimeout(t);
    t = setTimeout(mark, 140);
  });
  list.scrollTop = cur * WHEEL_ROW;
  mark();
  list.querySelectorAll('.wheel-opt').forEach((o) => {
    o.addEventListener('click', () => list.scrollTo({ top: Number(o.dataset.i) * WHEEL_ROW, behavior: 'smooth' }));
  });
}

/** Index des nächstgelegenen Dauer-Werts im Wahlrad. */
const nearestDurIndex = (v) => {
  const i = PLAN_DURATIONS.indexOf(v);
  if (i >= 0) return i;
  return PLAN_DURATIONS.reduce((best, d, j) =>
    Math.abs(d - v) < Math.abs(PLAN_DURATIONS[best] - v) ? j : best, 0);
};

const dayLabel = (dateStr) => {
  const d = parseISO(dateStr);
  return `${WEEKDAYS_SHORT[(d.getDay() + 6) % 7]}, ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
};

/** Termin-Sheet: Datum, Uhrzeit, Dauer – für Haupt- und Unterpunkte.
    `slot` ({ date, time }) füllt Datum/Urzeit vor, wenn der Punkt noch
    keinen Termin hat (Klick auf ein leeres Kalender-Fenster). */
export function openPlanSheet(itemId, slot = null) {
  const item = db.byId(itemId);
  if (!item || item.kind !== 'item') return;

  const plan = item.plan?.date ? item.plan : null;
  const vorDauer = Number(item.plan?.dur) || 60;   // auch nur zugewiesene Dauer (ohne Termin)
  const now = new Date();
  const q = Math.min(45, Math.ceil(now.getMinutes() / 15) * 15);   // nächste Viertelstunde
  // Getippter Kalender-Slot schlägt alles (auch vorhandene Termine) –
  // der Punkt landet genau dort, wo getippt wurde
  const def = slot
    ? { date: slot.date, time: slot.time, dur: Number(plan?.dur) || vorDauer }
    : plan
      ? { ...plan, dur: Number(plan.dur) || vorDauer }
      : {
          date: isoDate(now),
          time: `${String((now.getHours() + (q === 0 ? 1 : 0)) % 24).padStart(2, '0')}:${String(q).padStart(2, '0')}`,
          dur: vorDauer,
        };

  openSheet({
    title: plan ? 'Termin verschieben' : 'In Kalender einplanen',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn" data-close>Abbrechen</button>',
    body: `
      <div class="r-note" style="margin:0 2px 12px">📅 ${esc(item.text || 'Ohne Text')}</div>
      <div class="settings-group">
        <div class="row" style="flex-direction:column;align-items:stretch;gap:8px">
          <span class="r-label">Datum</span>
          <input type="date" class="text-in" id="pdate" value="${esc(def.date)}">
        </div>
        <div class="row" style="flex-direction:column;align-items:stretch;gap:8px">
          <span class="r-label">Uhrzeit</span>
          <input type="time" class="text-in" id="ptime" value="${esc(def.time)}">
        </div>
        <div class="row" style="flex-direction:column;align-items:stretch;gap:9px">
          <span class="r-label">Dauer</span>
          <div data-wheel></div>
        </div>
      </div>
      <div class="r-note" data-prev style="padding:0 2px 14px"></div>
      <button class="btn" data-save>${plan ? 'Verschieben' : 'Einplanen'}</button>
      ${plan ? '<button class="btn secondary" data-clear style="margin-top:10px">Aus Kalender entfernen</button>' : ''}`,
    onMount(sheet, handle) {
      sheet.querySelector('[data-close]').onclick = () => handle.close();

      const dateEl = sheet.querySelector('#pdate');
      const timeEl = sheet.querySelector('#ptime');
      const prev = sheet.querySelector('[data-prev]');
      let dur = def.dur;

      const upd = () => {
        if (!dateEl.value) { prev.textContent = 'Bitte ein Datum wählen.'; return; }
        const t = timeEl.value || '00:00';
        prev.textContent = `📅 ${dayLabel(dateEl.value)} · ${t} – ${addMinutesToTime(t, dur)} Uhr · ${durLabel(dur)}`;
      };

      dateEl.oninput = upd;
      timeEl.oninput = upd;
      mountWheel(sheet.querySelector('[data-wheel]'), PLAN_DURATIONS,
        nearestDurIndex(def.dur), (v) => { dur = v; upd(); });

      sheet.querySelector('[data-save]').onclick = () => {
        if (!dateEl.value) { toast('Bitte ein Datum wählen', { type: 'error' }); return; }
        db.update(itemId, { plan: { date: dateEl.value, time: timeEl.value || '09:00', dur } });
        haptic(10);
        toast(plan ? 'Termin verschoben' : 'In den Kalender eingeplant');
        handle.close();
      };
      sheet.querySelector('[data-clear]')?.addEventListener('click', () => {
        db.update(itemId, { plan: null });
        haptic(8);
        toast('Aus dem Kalender entfernt');
        handle.close();
      });

      upd();
    },
  });
}

/** Dauer-Sheet (Zeilen-Button): per Wahlrad eine Dauer zuweisen – auch ohne
    Termin. Solche Punkte erscheinen im Seitenbereich des Kalenders und können
    von dort direkt ins Raster gezogen werden. */
export function openDurSheet(itemId) {
  const item = db.byId(itemId);
  if (!item || item.kind !== 'item') return;

  const geplant = !!item.plan?.date;
  const cur = Number(item.plan?.dur) || 60;

  openSheet({
    title: 'Dauer zuweisen',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn" data-close>Abbrechen</button>',
    body: `
      <div class="r-note" style="margin:0 2px 12px">⏱ ${esc(item.text || 'Ohne Text')}</div>
      <div class="settings-group">
        <div class="row" style="flex-direction:column;align-items:stretch;gap:9px">
          <span class="r-label">Dauer</span>
          <div data-wheel></div>
        </div>
      </div>
      ${geplant ? '' : '<div class="r-note" style="padding:12px 2px 0">Der Punkt erscheint danach links oder rechts im Kalender und kann direkt ins Raster gezogen werden.</div>'}
      <button class="btn" data-save>Fertig</button>
      ${geplant ? '' : '<button class="btn secondary" data-plan style="margin-top:10px">Direkt einplanen</button>'}
      ${item.plan?.dur ? '<button class="btn secondary" data-clear style="margin-top:10px">Ohne Dauer</button>' : ''}`,
    onMount(sheet, handle) {
      sheet.querySelector('[data-close]').onclick = () => handle.close();
      let dur = cur;
      mountWheel(sheet.querySelector('[data-wheel]'), PLAN_DURATIONS, nearestDurIndex(cur), (v) => { dur = v; });

      sheet.querySelector('[data-save]').onclick = () => {
        const plan = item.plan?.date ? { ...item.plan, dur } : { dur };
        db.update(itemId, { plan });
        haptic(10);
        toast('Dauer gespeichert');
        handle.close();
      };
      sheet.querySelector('[data-clear]')?.addEventListener('click', () => {
        db.update(itemId, { plan: item.plan?.date ? { date: item.plan.date, time: item.plan.time } : null });
        haptic(8);
        toast('Dauer entfernt');
        handle.close();
      });
      sheet.querySelector('[data-plan]')?.addEventListener('click', () => {
        handle.close();
        setTimeout(() => openPlanSheet(itemId), 260);
      });
    },
  });
}

/* ---------------- Gemini-Chat ---------------- */

/** Chat mit Gemini – Kontext = die laut Zugriffseinstellung freigegebenen Inhalte. */
export function openGeminiChat() {
  if (!gemini.isGeminiReady()) {
    toast('Bitte zuerst in den Einstellungen Gemini aktivieren und den API-Key eintragen.');
    return;
  }

  openSheet({
    title: 'Gemini',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn" data-close>Schließen</button>',
    body: `
      <div class="r-note" style="margin:0 2px 10px">${esc(gemini.exposureSummary())}</div>
      <div class="gchat" id="gchatLog"></div>
      <div class="gsend">
        <input class="text-in" id="gchatIn" placeholder="Frage zu deinen Inhalten …" autocomplete="off" spellcheck="false">
        <button class="btn" id="gchatSend">Senden</button>
      </div>`,
    onMount(sheet, handle) {
      sheet.querySelector('[data-close]').onclick = () => handle.close();
      const log = sheet.querySelector('#gchatLog');
      const input = sheet.querySelector('#gchatIn');
      const sendBtn = sheet.querySelector('#gchatSend');

      const add = (rolle, text, klasse = '') => {
        const b = document.createElement('div');
        b.className = `gb ${rolle}${klasse ? ' ' + klasse : ''}`;
        b.textContent = text;
        log.appendChild(b);
        log.scrollTop = log.scrollHeight;
        return b;
      };

      add('ai', 'Hallo! Frag mich ruhig zu deinen freigegebenen Inhalten – z. B. „Was steht diese Woche an?“');

      const send = async () => {
        const q = input.value.trim();
        if (!q) return;
        input.value = '';
        add('user', q);
        const bubble = add('ai', 'Denkt nach …', 'busy');
        sendBtn.disabled = true;
        try {
          bubble.textContent = await gemini.askGemini(q);
        } catch (err) {
          bubble.textContent = `⚠️ ${err.message}`;
          bubble.classList.add('err');
        } finally {
          bubble.classList.remove('busy');
          sendBtn.disabled = false;
          log.scrollTop = log.scrollHeight;
        }
      };

      sendBtn.onclick = send;
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
      setTimeout(() => input.focus(), 60);
    },
  });
}

/* ---------------- Wiederkehrende Punkte ---------------- */

/** Wiederkehrenden Punkt anlegen (itemId = null) oder bearbeiten. */
export function openRepeatSheet(itemId = null, listIdParam = null) {
  const it = itemId ? db.byId(itemId) : null;
  if (itemId && (!it || !it.repeat)) return;

  const listId = listIdParam || repeat.repeatListId();
  if (!listId) {
    toast('Die Wiederkehrend-Liste wurde gelöscht.');
    return;
  }

  const r0 = it?.repeat || {};
  const draft = {
    freq: r0.freq || 'daily',
    interval: Math.max(1, Number(r0.interval) || 1),
    weekday: r0.weekday ?? new Date().getDay(),
    day: r0.day || new Date().getDate(),
    start: r0.start || isoDate(),
  };

  openSheet({
    title: it ? 'Wiederholung bearbeiten' : 'Wiederkehrender Punkt',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn" data-close>Schließen</button>',
    body: `
      <div class="rep-sheet-label">Aufgabe</div>
      <input class="text-in" id="repText" placeholder="Was wiederholt sich? (z. B. „Müll rausbringen“)"
        value="${esc(it?.text || '')}" autocomplete="off" spellcheck="false" maxlength="120">
      <div class="rep-sheet-label">Wiederholung</div>
      <div class="seg" id="repFreq">
        <button data-val="daily" class="${draft.freq === 'daily' ? 'on' : ''}">Täglich</button>
        <button data-val="weekly" class="${draft.freq === 'weekly' ? 'on' : ''}">Wöchentlich</button>
        <button data-val="monthly" class="${draft.freq === 'monthly' ? 'on' : ''}">Monatlich</button>
      </div>
      <div id="repOptions"></div>
      <button class="btn" id="repSave" style="margin-top:18px">${it ? 'Änderungen speichern' : 'Wiederholung anlegen'}</button>
      ${it ? '<button class="btn danger" id="repDel" style="margin-top:8px">🗑 Wiederholung löschen</button>' : ''}
    `,
    onMount(sheet, handle) {
      const opt = sheet.querySelector('#repOptions');

      const stepperHtml = (label, n) => `
        <div class="rep-row-line">
          <span class="r-label">${label}</span>
          <button class="rep-step" data-step="-1" aria-label="weniger">−</button>
          <span class="rep-step-val">${n}</span>
          <button class="rep-step" data-step="1" aria-label="mehr">＋</button>
        </div>`;

      const renderOptions = () => {
        let html = '';
        if (draft.freq === 'daily') {
          html = stepperHtml(draft.interval === 1 ? 'Jeden Tag' : `Alle … Tage`, draft.interval);
        } else if (draft.freq === 'weekly') {
          html = `
            <div class="rep-wd">
              ${[1, 2, 3, 4, 5, 6, 0].map((w) => `
                <button class="rep-wd-chip${draft.weekday === w ? ' on' : ''}" data-wd="${w}">${WEEKDAYS_SHORT[repeat.wdIdx(w)]}</button>`).join('')}
            </div>
            ${stepperHtml(draft.interval === 1 ? 'Jede Woche' : 'Alle … Wochen', draft.interval)}`;
        } else {
          html = `
            <div class="rep-row-line">
              <span class="r-label">Am</span>
              <input class="rep-day" id="repDay" type="number" min="1" max="31" value="${draft.day}">
              <span class="r-label">des Monats</span>
            </div>
            ${stepperHtml(draft.interval === 1 ? 'Jeden Monat' : 'Alle … Monate', draft.interval)}`;
        }
        opt.innerHTML = html;

        opt.querySelectorAll('[data-step]').forEach((b) => {
          b.addEventListener('click', () => {
            draft.interval = Math.min(30, Math.max(1, draft.interval + Number(b.dataset.step)));
            haptic(4);
            renderOptions();
          });
        });
        opt.querySelectorAll('.rep-wd-chip').forEach((b) => {
          b.addEventListener('click', () => {
            draft.weekday = Number(b.dataset.wd);
            haptic(4);
            renderOptions();
          });
        });
        const dayIn = opt.querySelector('#repDay');
        if (dayIn) dayIn.addEventListener('input', () => {
          draft.day = Math.min(31, Math.max(1, Number(dayIn.value) || 1));
        });
      };
      renderOptions();

      sheet.querySelectorAll('#repFreq button').forEach((b) => {
        b.addEventListener('click', () => {
          draft.freq = b.dataset.val;
          sheet.querySelectorAll('#repFreq button').forEach((x) => x.classList.toggle('on', x === b));
          haptic(4);
          renderOptions();
        });
      });

      sheet.querySelector('[data-close]').onclick = () => handle.close();

      const save = () => {
        const text = sheet.querySelector('#repText').value.trim();
        if (!text) { toast('Bitte zuerst einen Text eingeben.'); return; }
        const rep = {
          freq: draft.freq,
          interval: draft.interval,
          weekday: draft.weekday,
          day: draft.day,
          start: draft.start,
          enabled: it ? it.repeat?.enabled !== false : true,
          lastDone: it?.repeat?.lastDone || null,
        };
        handle.close();
        if (it) db.update(it.id, { text, repeat: rep });
        else db.create('item', { listId, text, repeat: rep });
        haptic(10);
        toast(it ? 'Wiederholung aktualisiert' : 'Wiederholung angelegt');
      };
      sheet.querySelector('#repSave').onclick = save;
      sheet.querySelector('#repText').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

      const del = sheet.querySelector('#repDel');
      if (del) del.onclick = () => {
        if (!window.confirm('Wiederholung wirklich löschen?')) return;
        handle.close();
        db.update(it.id, { deleted: true });
        haptic(12);
        toast('Wiederholung gelöscht');
      };

      setTimeout(() => sheet.querySelector('#repText')?.focus(), 60);
    },
  });
}

/** Aus der Kalender-Ansicht: passenden Punkt wählen und einplanen.
    Kommt der Aufruf von einem leeren Zeitfenster (slot), werden Datum und
    Uhrzeit dort vorbelegt. */
export function openPlanChooser(slot = null) {
  const items = db.recs('item')
    .filter((i) => i.state === 'active' && !i.done && (i.text || '').trim())
    .slice(0, 80);

  openSheet({
    title: 'To-Do einplanen',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn" data-close>Abbrechen</button>',
    body: `
      ${slot ? `<div class="r-note" style="margin:0 2px 12px">📅 ${esc(dayLabel(slot.date))} · ${esc(slot.time)} Uhr</div>` : ''}
      <input class="text-in" id="pq" placeholder="Punkt suchen …" style="margin-bottom:12px">
      <div class="settings-group" data-list></div>`,
    onMount(sheet, handle) {
      sheet.querySelector('[data-close]').onclick = () => handle.close();
      const listEl = sheet.querySelector('[data-list]');
      const input = sheet.querySelector('#pq');

      const draw = () => {
        const q = input.value.trim().toLowerCase();
        const hit = items.filter((i) => !q || (i.text || '').toLowerCase().includes(q));
        listEl.innerHTML = hit.length
          ? hit.map((it) => {
              const l = db.byId(it.listId);
              return `<button class="row tappable" data-pick="${it.id}">
                <span class="r-label">${esc(it.text)}</span>
                <span class="r-value">${it.plan?.date ? '📅 ' : ''}${esc(l?.title || '')}</span>
              </button>`;
            }).join('')
          : '<div class="row"><span class="r-label" style="color:var(--label-2)">Keine passenden Punkte</span></div>';
        listEl.querySelectorAll('[data-pick]').forEach((b) => {
          b.onclick = () => {
            const id = b.dataset.pick;
            handle.close();
            setTimeout(() => openPlanSheet(id, slot), 260);
          };
        });
      };

      input.oninput = draw;
      setTimeout(() => input.focus(), 320);
      draw();
    },
  });
}

const uidShort = () => Math.random().toString(36).slice(2, 10);
