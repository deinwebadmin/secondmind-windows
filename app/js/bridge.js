/* secondmind – bridge.js
   Einheitliche Schnittstelle zu den nativen Schalen:
   Windows = Electron (Preload-API "sm"), Android = Capacitor-Plugin "SecondMind".
   Reiner Browser = eingeschränkter Fallback (manuelle OAuth-Eingabe, Klartext-Token). */

/* ---------------- Plattform-Erkennung ---------------- */

const cap = window.Capacitor || null;

export const platform =
  (window.sm && window.sm.platform) ||
  (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()
    ? (cap.getPlatform?.() === 'android' ? 'android' : 'native')
    : null) ||
  'web';

export const isNative = platform !== 'web';

/* ---------------- Capacitor-Plugin (lazy) ---------------- */

let _pluginPromise; // undefined = noch nicht versucht

async function nativePlugin() {
  if (_pluginPromise !== undefined) return _pluginPromise;

  _pluginPromise = (async () => {
    try {
      if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;

      // 1) Variante: @capacitor/core (im App-Bundle mitgeliefert) -> registerPlugin
      try {
        const mod = await import('./cap/index.js');
        if (mod?.registerPlugin) return mod.registerPlugin('SecondMind');
      } catch (e) {
        console.warn('registerPlugin nicht möglich', e);
      }

      // 2) Variante: Plugins-Map der injizierten Bridge
      if (cap.Plugins?.SecondMind) return cap.Plugins.SecondMind;
    } catch (e) {
      console.warn('Native Bridge nicht verfügbar', e);
    }
    return null;
  })();

  return _pluginPromise;
}

/* ---------------- sicherer Speicher ---------------- */

async function enc(plain) {
  try {
    if (window.sm?.encrypt) return await window.sm.encrypt(plain);
    const p = await nativePlugin();
    if (p?.encrypt) return (await p.encrypt({ value: plain })).value;
  } catch (e) { console.warn('encrypt fehlgeschlagen', e); }
  // Fallback: Obfuscation (nur Browser-Dev)
  return 'b64:' + btoa(unescape(encodeURIComponent(plain)));
}

async function dec(cipher) {
  if (!cipher) return null;
  try {
    if (window.sm?.decrypt) return await window.sm.decrypt(cipher);
    const p = await nativePlugin();
    if (p?.decrypt) return (await p.decrypt({ value: cipher })).value;
  } catch (e) { console.warn('decrypt fehlgeschlagen', e); }
  if (cipher.startsWith('b64:')) {
    try { return decodeURIComponent(escape(atob(cipher.slice(4)))); } catch { return null; }
  }
  return null;
}

export async function secureSet(key, value) {
  const cipher = await enc(JSON.stringify(value));
  localStorage.setItem('sm.sec.' + key, cipher);
}
export async function secureGet(key) {
  const raw = localStorage.getItem('sm.sec.' + key);
  if (!raw) return null;
  try { return JSON.parse(await dec(raw)); } catch { return null; }
}
export function secureDel(key) { localStorage.removeItem('sm.sec.' + key); }

/* ---------------- OAuth-Loopback ---------------- */

/**
 * Öffnet den System-Browser und wartet auf den Loopback-Redirect
 * (http://127.0.0.1:PORT). Liefert { code, redirectUri } oder { error }.
 */
export async function openAuth(url, timeoutMs = 300_000) {
  try {
    if (window.sm?.openAuth) {
      const res = await window.sm.openAuth(url, timeoutMs);
      return res || { error: 'keine Antwort vom System' };
    }
    const p = await nativePlugin();
    if (p?.openAuth) {
      const res = await p.openAuth({ url, timeoutMs });
      return res || { error: 'keine Antwort vom System' };
    }
  } catch (e) {
    return { error: e?.message || 'OAuth-Komponente nicht verfügbar' };
  }

  // Web-Fallback: Fenster öffnen, Nutzer meldet die Redirect-URL zurück.
  const w = window.open(url, 'secondmind-oauth', 'width=480,height=700,noopener');
  if (!w) return { error: 'popup-blockiert' };
  return { needsManual: true, hint: 'Nach der Anmeldung die Adresse (http://127.0.0.1:…) kopieren und hier einfügen.' };
}

/** Baut aus einer eingefügten Redirect-URL den Auth-Code. */
export function parseRedirect(input) {
  try {
    const u = new URL(input.trim());
    // Exakt derselbe Redirect-URI wie in der Auth-Anfrage (ohne Pfad/Slash)
    return {
      code: u.searchParams.get('code'),
      error: u.searchParams.get('error'),
      redirectUri: `${u.protocol}//${u.host}`,
    };
  } catch {
    return { error: 'ungültige URL' };
  }
}

/** Externe Links in der Standard-App öffnen. */
export function openExternal(url) {
  if (window.sm?.openExternal) { window.sm.openExternal(url); return; }
  nativePlugin().then((p) => {
    if (p?.openExternal) p.openExternal({ url });
    else window.open(url, '_blank', 'noopener');
  });
}

/**
 * Update installieren.
 * Windows (Electron): main.js lädt Setup/Portable und startet sie.
 * Android (Capacitor): Plugin lädt die APK und öffnet den System-Installer.
 * Liefert { ok } oder { error } bzw. { needsPermission }.
 */
export async function applyUpdate(target) {
  try {
    if (window.sm?.updateApp) return await window.sm.updateApp(target);
    const p = await nativePlugin();
    if (p?.installApk && target?.url) {
      try {
        return await p.installApk({ url: target.url });
      } catch (e) {
        const msg = String(e?.message || e || '');
        if (msg.includes('permission')) return { needsPermission: true };
        return { error: msg || 'Installation nicht möglich' };
      }
    }
    return { error: 'Updates werden auf dieser Plattform nicht unterstützt' };
  } catch (e) {
    return { error: e?.message || 'Update nicht möglich' };
  }
}

/** Kamera/Galerie: Datei-Eingabe ist plattformübergreifend identisch. */
export const supportsFilePicker = true;

/* ---------------- Pairing (Schlüsselübergabe) ---------------- */

/**
 * QR-Code mit der nativen Kamera scannen (Android-Plugin).
 * Liefert den gescannten Text oder null – dann scannen wir über die Webcam
 * im Renderer (Rechner ohne eigenes Kamera-Plugin).
 */
export async function scanQr(timeoutMs = 60_000) {
  try {
    if (window.sm?.scanQr) return (await window.sm.scanQr(timeoutMs)) || null;
    const p = await nativePlugin();
    if (p?.scanQr) return (await p.scanQr({ timeoutMs }))?.value ?? null;
  } catch (e) {
    console.warn('scanQr', e);
  }
  return null;
}

/**
 * Pairing-Transport (Stufe 3, LAN ohne Backend und ohne Google-Dienste).
 *   { action:'begin' }                  -> { ok, secret, port, ips }
 *   { action:'wait' }                   -> { ok, payload:{iv,ct}, secret } | { ok:false, error }
 *   { action:'cancel' }                 -> { ok }
 *   { action:'send', ips, port, body }  -> { ok } | { ok:false, error }
 *
 * Das Senden läuft auf Android über das Plugin: dort lädt die WebView die App
 * von https://localhost und darf von dort aus keine http-Anfrage stellen.
 */
export async function pairSend(cmd) {
  try {
    if (cmd?.action === 'send' && platform === 'android') {
      const p = await nativePlugin();
      if (p?.pairSend) return await p.pairSend({ ips: cmd.ips, port: cmd.port, body: cmd.body });
      return { ok: false, error: 'Netzwerk-Pairing nicht verfügbar' };
    }
    if (window.sm?.pair) return await window.sm.pair(cmd);
    if (cmd?.action === 'send') return await sendViaFetch(cmd);
  } catch (e) {
    console.warn('pairSend', e);
    return { ok: false, error: e?.message || 'Pairing nicht möglich' };
  }
  return { ok: false, error: 'Netzwerk-Pairing wird auf dieser Plattform nicht unterstützt' };
}

/** Senden ohne Plugin (Browser/Electron-Renderer): alle Kandidaten je 2 s. */
async function sendViaFetch({ ips, port, body }) {
  const liste = (Array.isArray(ips) ? ips : []).filter((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(x)));
  const p = Number(port) || 0;
  if (!liste.length || !p || typeof body !== 'string') return { ok: false, error: 'keine Zieladresse im QR-Code' };
  for (const ip of liste) {
    try {
      const res = await fetch(`http://${ip}:${p}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },   // text/plain: kein CORS-Preflight
        body,
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return { ok: true };
    } catch { /* nächster Kandidat */ }
  }
  return { ok: false, error: 'nicht_erreichbar' };
}
