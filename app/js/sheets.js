/* secondmind – sheets.js
   Overlays: Bottom-Sheets, Bestätigungen, Menüs, Toasts, Erstell-Flows. */

import * as db from './db.js';
import { esc, ICON, haptic, fmtBytes, WEEKDAYS } from './util.js';
import { navigate } from './router.js';

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

export function archiveItem(itemId) {
  const it = db.byId(itemId);
  if (!it) return;
  const list = db.byId(it.listId);
  db.update(itemId, { state: 'archived', archivedAt: Date.now(), originTitle: list?.title || it.originTitle || 'Gelöschte Liste' });
  haptic(10);
  undoToast('In Archiv verschoben', () => db.update(itemId, { state: 'active', archivedAt: 0 }));
}

export function toMemory(itemId) {
  const it = db.byId(itemId);
  if (!it) return;
  db.update(itemId, { state: 'memory', memoryAt: Date.now() });
  haptic(10);
  undoToast('In Memory verschoben', () => db.update(itemId, { state: 'active', memoryAt: 0 }));
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

/* ---------------- Tag-Editor ---------------- */

export function openTagSheet(recordId) {
  const rec = db.byId(recordId);
  if (!rec) return;
  const tags = [...(rec.tags || [])];
  const all = new Set();
  for (const r of db.state.records.values()) (r.tags || []).forEach((t) => all.add(t));

  const render = (sheet) => {
    sheet.querySelector('[data-chips]').innerHTML = tags.length
      ? tags.map((t, i) => `<button class="chip on" data-rm="${i}">${esc(t)} ×</button>`).join('')
      : '<span class="r-note" style="color:var(--label-3)">Noch keine Tags</span>';
    sheet.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = () => { tags.splice(Number(b.dataset.rm), 1); persist(); render(sheet); };
    });
    const sug = [...all].filter((t) => !tags.includes(t)).slice(0, 10);
    sheet.querySelector('[data-sug]').innerHTML = sug.map((t) => `<button class="chip" data-add="${esc(t)}">${esc(t)}</button>`).join('');
    sheet.querySelectorAll('[data-add]').forEach((b) => {
      b.onclick = () => { tags.push(b.dataset.add); persist(); render(sheet); };
    });
  };

  const persist = () => { if (db.byId(recordId)) db.update(recordId, { tags: [...tags] }); };

  openSheet({
    title: 'Tags',
    headLeft: '<span style="width:60px"></span>',
    headRight: '<button class="sh-btn strong" data-done>Fertig</button>',
    body: `
      <div class="chips" data-chips style="margin-bottom:14px"></div>
      <input class="text-in" id="tagin" placeholder="Tag eingeben und Enter drücken" maxlength="30">
      <div class="grp-label" style="margin-top:16px">Vorschläge</div>
      <div class="chips" data-sug></div>`,
    onMount(sheet, handle) {
      render(sheet);
      const input = sheet.querySelector('#tagin');
      setTimeout(() => input.focus(), 320);
      const add = () => {
        const v = input.value.trim().replace(/,$/, '');
        if (v && !tags.includes(v)) { tags.push(v); persist(); render(sheet); }
        input.value = '';
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
      input.onblur = add;
      sheet.querySelector('[data-done]').onclick = () => { add(); handle.close(); };
    },
  });
}

/* ---------------- Farbwähler (Hintergrund) ---------------- */

export const BG_SWATCHS = ['', '#FFF6D9', '#E6F6E9', '#FFE7E4', '#E7F0FF', '#F2E9FF', '#EDEDF2'];

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

const uidShort = () => Math.random().toString(36).slice(2, 10);
