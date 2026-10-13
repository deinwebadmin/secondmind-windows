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

/* ---------------- Pairing-Server (Stufe 3, LAN) ----------------
   Kein Backend, kein Google: Für genau eine Session öffnet secondmind
   einen eigenen Port auf 0.0.0.0, damit das Gerät im selben WLAN die
   Schlüsselübergabe per POST vornehmen kann.
   - zufälliger Port, genau eine Session, Stopp nach 120 s oder bei Erfolg
   - der Server sieht nur AES-GCM-Chiffretext; das Session-Secret steht im
     QR-Code und bleibt im Renderer, die DEK wird hier nie im Klartext gehalten
   - für den QR-Code sammeln wir alle RFC1918-Adressen (alle Kandidaten,
     das empfangende Gerät probiert sie der Reihe nach mit 2 s Timeout) */

const os = require('os');
const nodeCrypto = require('crypto');

let pairSrv = null;
let pairState = null;   // { secret, port, srv, received, resolver, timer }

function privateIPv4() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const net of ifs[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const ip = net.address;
      // RFC1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
      if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) out.push(ip);
    }
  }
  return out;
}

function stopPairing() {
  if (!pairState) return;
  if (pairState.timer) clearTimeout(pairState.timer);
  if (pairState.resolver) {
    const r = pairState.resolver;
    pairState.resolver = null;
    r({ ok: false, error: 'abgebrochen' });
  }
  if (pairState.srv) { try { pairState.srv.close(); } catch { /* egal */ } }
  pairState = null;
  pairSrv = null;
}

function beginPairing() {
  stopPairing();
  const secret = nodeCrypto.randomBytes(32).toString('base64');   // 256 Bit
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, cors).end(); return; }

      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(raw); } catch { payload = null; }
        if (!payload?.iv || !payload?.ct) { res.writeHead(400, cors).end(); return; }

        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        if (!pairState) return;
        const state = pairState;
        state.received = { ok: true, payload, secret: state.secret };
        if (state.resolver) { const r = state.resolver; state.resolver = null; r(state.received); }
      });
    });

    srv.on('error', () => {
      pairState = null;
      pairSrv = null;
      resolve({ ok: false, error: 'Netzwerk-Port nicht verfügbar' });
    });

    srv.listen(0, '0.0.0.0', () => {
      const port = srv.address().port;
      pairSrv = srv;
      pairState = {
        secret,
        port,
        srv,
        received: null,
        resolver: null,
        timer: setTimeout(() => {
          if (pairState?.resolver) {
            const r = pairState.resolver;
            pairState.resolver = null;
            r({ ok: false, error: 'timeout' });
          }
          stopPairing();
        }, 120_000),
      };
      resolve({ ok: true, secret, port, ips: privateIPv4() });
    });
  });
}

function waitPairing() {
  if (!pairState) return Promise.resolve({ ok: false, error: 'keine Session' });
  if (pairState.received) return Promise.resolve(pairState.received);
  return new Promise((resolve) => { pairState.resolver = resolve; });
}

/** Sendende Seite: alle IPv4-Kandidaten der Reihe nach, je mit 2 s Timeout. */
async function sendPairing({ ips, port, body }) {
  const liste = (Array.isArray(ips) ? ips : []).filter((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(x)));
  const p = Number(port) || 0;
  if (!liste.length || !p || typeof body !== 'string') return { ok: false, error: 'keine Zieladresse im QR-Code' };
  for (const ip of liste) {
    try {
      const res = await fetch(`http://${ip}:${p}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body,
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return { ok: true };
    } catch { /* nächster Kandidat */ }
  }
  return { ok: false, error: 'nicht_erreichbar' };
}

ipcMain.handle('sm:pair', async (_e, cmd) => {
  const action = cmd?.action;
  if (action === 'begin') return beginPairing();
  if (action === 'wait') return waitPairing();
  if (action === 'cancel') { stopPairing(); return { ok: true }; }
  if (action === 'send') return sendPairing(cmd);
  return { ok: false, error: 'unbekanntes Pairing-Kommando' };
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
  stopPairing();
  if (server) { try { server.close(); } catch { /* egal */ } }
});
