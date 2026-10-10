/* secondmind – views.js
   Ansichten: Notiz-Detail, Archiv, Memory, Einstellungen. */

import * as db from './db.js';
import * as S from './sheets.js';
import * as sync from './sync.js';
import { esc, ICON, fmtRel, fmtDate, yearOf, download, fmtBytes, haptic, APP_VERSION } from './util.js';
import { cardSwipeHtml, itemRowHtml, noteCardHtml, listCardHtml, cardStyle, bindSwipes, toggleItem, pruneEmptyItems } from './parts.js';
import { navigate } from './router.js';

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
        <button class="icon-btn" data-act="note-pin" aria-label="Anpinnen" title="Anpinnen">${note.pinned ? '📌' : '📍'}</button>
        <button class="icon-btn" data-act="note-more" aria-label="Mehr" title="Mehr">${ICON.more}</button>
      </div>
    </div>

    <div class="card note-editor" ${cardStyle(note.bg)} style="padding:14px 16px 18px">
      <input class="note-title-in" id="noteTitle" placeholder="Titel" value="${esc(note.title)}" maxlength="200">
      <textarea class="note-text-in" id="noteText" placeholder="Text schreiben …">${esc(note.text)}</textarea>

      ${(note.tags || []).length ? `<div class="chips" style="margin-bottom:14px">${note.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}

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
    return html + emptyState('🗂', 'Das Archiv ist leer', 'Wische Links über Listen oder Notizen, um sie hier abzulegen.');
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
        html += `<div class="archive-group"><div class="ag-title">${esc(key)}</div>`;
        html += its.map((it) => archiveRow(it, 'archiv')).join('');
        html += `</div>`;
      }
    }
  }

  view().innerHTML = html;
  bindSwipes(view());
}

function archiveRow(it, mode) {
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
    return view().innerHTML = html + emptyState('🧠', 'Noch nichts gemerkt', 'Wische Punkte nach links, um sie hier abzulegen.');
  }

  const byYear = new Map();
  for (const it of items) {
    const y = yearOf(it.memoryAt || it.updatedAt);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(it);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);

  for (const y of years) {
    const group = byYear.get(y).sort((a, b) => (b.memoryAt || 0) - (a.memoryAt || 0));
    html += `<div class="year-head">${y}</div><div class="group" style="margin-bottom:16px">`;
    html += group.map((it) => {
      const list = db.byId(it.listId);
      return `<div class="item">
        <div class="item-body" style="padding-left:2px">
          <div class="item-text">${esc(it.text || 'Ohne Text')}</div>
          <div class="card-meta">${esc(list && !list.deleted ? list.title : it.originTitle || '')} · ${fmtDate(it.memoryAt || it.updatedAt)}</div>
        </div>
        <div class="item-tail">
          <button class="item-open" data-act="restore-item" data-id="${it.id}" title="Zurück">↺</button>
          <button class="item-open" data-act="open-item" data-id="${it.id}">›</button>
        </div>
      </div>`;
    }).join('');
    html += `</div>`;
  }

  view().innerHTML = html;
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
    });
  });

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
