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

/** Kamera/Galerie: Datei-Eingabe ist plattformübergreifend identisch. */
export const supportsFilePicker = true;
