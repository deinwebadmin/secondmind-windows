/* secondmind – Electron Hauptprozess
   - Statischer Local-Server (http://127.0.0.1:PORT) für die App
   - Loopback-Endpoint für den Google-OAuth-Flow (gleicher Port)
   - Token-Verschlüsselung über safeStorage (Windows DPAPI)
   - Kein Node-Zugriff aus dem Renderer (contextIsolation). */

const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..', 'app');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

let mainWindow = null;
let server = null;
let appPort = 0;
let pendingAuth = null; // { resolve, timer, state }

/* ---------------- Local-Server + OAuth-Loopback ---------------- */

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1:${appPort}`);

        // OAuth-Callback (Redirect-URI = http://127.0.0.1:PORT)
        if (url.searchParams.has('code') || url.searchParams.has('error')) {
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');
          const state = url.searchParams.get('state');

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><meta charset="utf-8"><title>secondmind</title>
            <body style="font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f2f2f7;color:#111">
              <div style="text-align:center;padding:24px">
                <div style="font-size:44px">${error ? '⚠️' : '✅'}</div>
                <h1 style="font-size:22px;letter-spacing:-.02em">${error ? 'Anmeldung abgebrochen' : 'Verbunden'}</h1>
                <p style="color:#555">Du kannst dieses Fenster jetzt schließen und zu secondmind zurückkehren.</p>
              </div></body>`);

          if (pendingAuth) {
            clearTimeout(pendingAuth.timer);
            const ok = !error && pendingAuth.state === state;
            pendingAuth.resolve(ok
              ? { code, redirectUri: `http://127.0.0.1:${appPort}` }
              : { error: error || (state ? 'state-Abgleich fehlgeschlagen' : 'kein Code') });
            pendingAuth = null;
          }
          return;
        }

        // Statische Dateien
        let file = path.normalize(path.join(APP_DIR, decodeURIComponent(url.pathname)));
        if (!file.startsWith(APP_DIR)) { res.writeHead(403).end('forbidden'); return; }
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      appPort = server.address().port;
      resolve(appPort);
    });
  });
}

/* ---------------- Fenster ---------------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 470,
    height: 900,
    minWidth: 380,
    minHeight: 600,
    backgroundColor: '#f2f2f7',
    title: 'secondmind',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${appPort}/index.html`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ---------------- IPC ---------------- */

ipcMain.handle('sm:open-auth', async (_e, authUrl, timeoutMs = 300000) => {
  if (!authUrl) return { error: 'keine URL' };

  // Loopback-Redirect-URI ermitteln und in der Auth-URL einsetzen
  const u = new URL(authUrl);
  const state = u.searchParams.get('state') || '';
  u.searchParams.set('redirect_uri', `http://127.0.0.1:${appPort}`);

  // Alten Ausstieg aufräumen
  if (pendingAuth) {
    clearTimeout(pendingAuth.timer);
    pendingAuth.resolve({ error: 'abgebrochen' });
    pendingAuth = null;
  }

  const result = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingAuth && pendingAuth.state === state) {
        pendingAuth = null;
        resolve({ error: 'timeout' });
      }
    }, Math.max(30_000, Number(timeoutMs) || 300_000));
    pendingAuth = { resolve, timer, state };
  });

  await shell.openExternal(u.toString());
  return result;
});

ipcMain.handle('sm:encrypt', (_e, plain) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return Buffer.from(String(plain), 'utf8').toString('base64');
    return safeStorage.encryptString(String(plain)).toString('base64');
  } catch { return Buffer.from(String(plain), 'utf8').toString('base64'); }
});

ipcMain.handle('sm:decrypt', (_e, cipher) => {
  try {
    const buf = Buffer.from(String(cipher), 'base64');
    if (!safeStorage.isEncryptionAvailable()) return buf.toString('utf8');
    return safeStorage.decryptString(buf);
  } catch { return null; }
});

ipcMain.on('sm:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

/* ---------------- In-App-Update ---------------- */

/**
 * Update herunterladen und starten – ohne sichtbares Konsolenfenster.
 * Verzögerung und Start laufen über eine wscript-Datei (wscript.exe ist eine
 * GUI-Anwendung, es blitzt nie eine CMD auf). Erkennung der installierten
 * Variante sucht Uninstall*.exe (Name variiert je nach NSIS-Variante).
 * Installiert: NSIS-Setup still (/S), nachdem die App hart beendet ist.
 * Portable: Die neue EXE überschreibt die laufende Datei (Desktop-Verknüpfung
 * bleibt gültig) und startet neu; scheitert das, startet sie daneben.
 */
ipcMain.handle('sm:update-app', async (_e, target) => {
  try {
    const ver = String(target?.version || '').replace(/[^\w.\-]/g, '');
    if (!ver) return { error: 'keine Versionsangabe' };

    const exeDir = path.dirname(process.execPath);
    let installed = false;
    try {
      installed = fs.readdirSync(exeDir).some((f) => /^uninstall.*\.exe$/i.test(f));
    } catch { /* Ordner nicht lesbar -> portable annehmen */ }
    const url = installed ? target?.setupUrl : (target?.portableUrl || target?.setupUrl);
    if (!/^https:\/\/github\.com\//i.test(String(url || ''))) return { error: 'ungültige Download-URL' };

    // Download (GitHub leitet auf objects.githubusercontent.com um)
    const res = await fetch(url);
    if (!res.ok) return { error: 'Download fehlgeschlagen (HTTP ' + res.status + ')' };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000) return { error: 'Download unvollständig' };

    const temp = app.getPath('temp');
    const vbsPath = path.join(temp, 'secondmind-update.vbs');

    if (installed) {
      const file = path.join(temp, `secondmind-setup-${ver}.exe`);
      fs.writeFileSync(file, buf);
      fs.writeFileSync(vbsPath, [
        'WScript.Sleep 2500',
        'CreateObject("WScript.Shell").Run """' + file + '"" /S", 1, False',
      ].join('\r\n'), 'ascii');
      spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setTimeout(() => app.exit(0), 400);
      return { ok: true, mode: 'setup' };
    }

    // Portable: Download nach temp, dann nach dem Beenden überschreiben + Start
    const file = path.join(temp, `secondmind-${ver}.exe`);
    fs.writeFileSync(file, buf);
    const self = process.execPath;
    fs.writeFileSync(vbsPath, [
      'WScript.Sleep 2500',
      'On Error Resume Next',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'src = "' + file + '"',
      'dst = "' + self + '"',
      'fso.CopyFile src, dst, True',
      'If Err.Number <> 0 Then',
      '  Err.Clear',
      '  dst = fso.BuildPath(fso.GetParentFolderName(dst), fso.GetFileName(src))',
      '  fso.CopyFile src, dst, True',
      'End If',
      'CreateObject("WScript.Shell").Run """" & dst & """", 1, False',
    ].join('\r\n'), 'ascii');
    spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    setTimeout(() => app.exit(0), 400);
    return { ok: true, mode: 'portable' };
  } catch (e) {
    return { error: e?.message || 'Update fehlgeschlagen' };
  }
});

/* ---------------- Start ---------------- */

app.whenReady().then(async () => {
  app.setAppUserModelId('de.webadmin.secondmind');
  await startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (pendingAuth) { clearTimeout(pendingAuth.timer); pendingAuth = null; }
  if (server) { try { server.close(); } catch { /* egal */ } }
});
