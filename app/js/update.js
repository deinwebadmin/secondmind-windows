/* secondmind – update.js
   In-App-Update-Check: fragt GitHub (öffentlich, anonym) nach der neuesten
   Release-Version und – auf entsprechender Plattform – startet die Installation.
   Windows: Setup still über NSIS bzw. neue Portable-EXE starten.
   Android: APK laden, System-Installer öffnen (Nutzer bestätigt einmal). */

import { APP_VERSION, esc } from './util.js';
import { platform, applyUpdate } from './bridge.js';
import * as S from './sheets.js';

const REPOS = {
  windows: 'deinwebadmin/secondmind-windows',
  android: 'deinwebadmin/secondmind-android',
};

const CHECK_MS = 30 * 60_000;      // automatischer Check alle 30 Minuten

/** Version vergleichen: remote neuer als current? */
export function isNewer(remote, current = APP_VERSION) {
  const parse = (s) => String(s || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(remote);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** Neuestes Release von GitHub holen. Liefert Status + Asset-URLs. */
export async function fetchLatest(which = platform) {
  const repo = REPOS[which];
  if (!repo) return { status: 'unsupported' };
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error('GitHub nicht erreichbar (HTTP ' + res.status + ')');
  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  const assets = (rel.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url }));
  return {
    status: isNewer(version) ? 'update' : 'up-to-date',
    version,
    notes: String(rel.body || ''),
    assets,
  };
}

let askedThisRun = false;

/**
 * Update-Check. Auto-Checks fragen pro App-Lauf nur einmal nach;
 * manuelle Checks (Einstellungen) melden auch „aktuell“/Fehler als Toast.
 */
export async function checkForUpdate({ manual = false } = {}) {
  if (platform === 'web') {
    if (manual) S.toast('Updates gibt es in der Windows- und Android-App.');
    return { status: 'unsupported' };
  }
  let res;
  try {
    res = await fetchLatest();
  } catch (e) {
    if (manual) S.toast('Update-Check fehlgeschlagen: ' + e.message, { type: 'error' });
    return { status: 'error', error: e.message };
  }
  if (res.status === 'up-to-date') {
    if (manual) S.toast(`secondmind ${APP_VERSION} ist aktuell.`);
    return res;
  }
  if (!manual && askedThisRun) return res;    // Auto-Check: einmal pro Start fragen
  askedThisRun = true;
  openUpdateSheet(res);
  return res;
}

/** Sheet „Update verfügbar“ mit Jetzt/Später. */
export function openUpdateSheet(res) {
  const notes = String(res.notes || '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^-{3,}$/gm, '')
    .trim()
    .slice(0, 300);
  S.openSheet({
    title: `Update ${esc(res.version)} verfügbar`,
    body: `
      <div class="row" style="flex-direction:column;align-items:stretch;gap:8px">
        <span class="r-note">Deine Einträge, Einstellungen und die Google-Drive-Verknüpfung bleiben erhalten.</span>
        ${notes ? `<span class="r-note" style="white-space:pre-wrap">${esc(notes)}</span>` : ''}
      </div>
      <div class="row" style="flex-direction:column;gap:10px;padding-top:6px">
        <button class="btn primary" id="updNow">Jetzt aktualisieren</button>
        <button class="btn secondary" id="updLater">Später</button>
      </div>`,
    onMount(sheet, handle) {
      sheet.querySelector('#updLater').onclick = () => handle.close();
      sheet.querySelector('#updNow').onclick = async () => {
        handle.close();
        const url = (name) => res.assets.find((a) => a.name === name)?.url || null;
        let target;
        if (platform === 'android') {
          target = { url: url(`secondmind-${res.version}.apk`), version: res.version };
        } else {
          target = {
            setupUrl: url(`secondmind-Setup-${res.version}.exe`),
            portableUrl: url(`secondmind-${res.version}-portable.exe`),
            version: res.version,
          };
        }
        const hasUrl = platform === 'android' ? target.url : (target.setupUrl || target.portableUrl);
        if (!hasUrl) { S.toast('Installationsdatei im Release nicht gefunden', { type: 'error' }); return; }

        S.toast('Update wird heruntergeladen …');
        const r = await applyUpdate(target);
        if (r?.needsPermission) {
          S.toast('Android verlangt die Erlaubnis „Apps aus unbekannten Quellen“ für secondmind – erlaube sie und tippe erneut auf „Jetzt aktualisieren“.', { type: 'error' });
        } else if (r?.error) {
          S.toast('Update fehlgeschlagen: ' + r.error, { type: 'error' });
        } else if (r?.ok) {
          if (r.fallback === 'browser') {
            S.toast('Der Installer konnte nicht geöffnet werden – die APK wurde im Browser geöffnet. Lade sie herunter und tippe auf die Datei, um zu installieren.', { type: 'error' });
          } else if (platform === 'android') {
            S.toast('Installer geöffnet – tippe auf „Installieren“. Nach dem Update starte secondmind neu.');
          } else if (r.mode === 'setup') {
            S.toast('Update wird installiert – secondmind schließt sich und öffnet sich gleich mit der neuen Version neu.');
          } else {
            S.toast('Update wird eingespielt – secondmind startet gleich neu.');
          }
        }
      };
    },
  });
}

/** Wächter: Start-Check nach ~20 s, danach alle 30 Minuten (nur Plattform-Apps). */
export function startUpdateWatcher() {
  if (platform === 'web') return;
  setTimeout(() => { checkForUpdate().catch(() => {}); }, 20_000);
  setInterval(() => { checkForUpdate().catch(() => {}); }, CHECK_MS);
}
