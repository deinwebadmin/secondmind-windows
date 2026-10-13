/* secondmind – pairing.js
   Vierstufige Schlüsselübergabe (D.5). Feste Regel: das Gerät ohne Kamera
   ZEIGT den QR-Code, das Gerät mit Kamera SCANNT – welches Gerät neu ist,
   ändert nur den Inhalt des Codes, nicht die Rollen.

   Stufe 1  Direkt-QR (offline)     : „smk1:<DEK>"          – Empfänger scannt
   Stufe 2  Webcam (offline)        : wie 1, aber der PC scannt selbst
   Stufe 3  LAN ohne Backend        : „smp1:<Secret>:<Port>:<IPs>" – das
            haltende Gerät sendet die DEK per POST (AES-GCM mit dem Secret),
            beide zeigen denselben 6-stelligen SAS-Code
   Stufe 4  .smkey-Datei            : Export/Import, optional mit Passwort

   Kein Kanal über Google-Dienste: dort läge der Schlüssel im Klartext. */

import * as db from './db.js';
import * as C from './crypto.js';
import * as S from './sheets.js';
import { platform, scanQr as bridgeScanQr, pairSend as bridgePairSend } from './bridge.js';

/* ---------------- QR-Generator (gelieferte kleine Dependency) ---------------- */

const QRGEN = typeof qrcode !== 'undefined' ? qrcode : null;
if (QRGEN?.stringToBytesFuncs?.['UTF-8']) QRGEN.stringToBytes = QRGEN.stringToBytesFuncs['UTF-8'];

export const hasQrGenerator = () => !!QRGEN;

export function qrDataUrl(text, cellSize = 5) {
  if (!QRGEN) throw new Error('QR-Generator nicht geladen');
  const qr = QRGEN(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cellSize, 4);
}

/* ---------------- Payloads ---------------- */

export const payloadGiveKey = (dekB64) => `smk1:${dekB64}`;
export const payloadLanOffer = (secret, port, ips) => `smp1:${secret}:${port}:${(ips || []).join(',')}`;

export function parsePayload(text) {
  const s = String(text || '').trim();
  if (s.startsWith('smk1:')) return { kind: 'key', key: s.slice(5).trim() };
  if (s.startsWith('smp1:')) {
    const parts = s.split(':');
    return {
      kind: 'lan',
      secret: parts[1] || '',
      port: Number(parts[2]) || 0,
      ips: String(parts[3] || '').split(',').map((x) => x.trim()).filter(Boolean),
    };
  }
  return { kind: 'raw', text: s };
}

/* ---------------- Scannen (native Kamera oder Webcam) ---------------- */

/**
 * QR-Code scannen. Reihenfolge: erst native Kamera (Android-Plugin), sonst
 * Webcam im Renderer (Rechner ohne Kamera-Plugin).
 * @returns {Promise<string|null>} der gescannte Text
 */
export async function scanCode({ onStatus } = {}) {
  try {
    const nativ = await bridgeScanQr(60_000);
    if (nativ) return nativ;
  } catch (e) { console.warn('Kamera-Plugin', e); }
  return scanWebcam({ onStatus });
}

/** Webcam-Scan (Stufe 2): Video aufnehmen, bis jsQR einen Code erkennt. */
export function scanWebcam({ onStatus = () => {}, timeoutMs = 60_000 } = {}) {
  return new Promise(async (resolve) => {
    let stream = null;
    let raf = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* egal */ }
      overlay.remove();
      resolve(value);
    };

    const overlay = document.createElement('div');
    overlay.className = 'scan-overlay';
    overlay.innerHTML = `
      <div class="scan-box">
        <video playsinline muted autoplay></video>
        <div class="scan-frame"></div>
      </div>
      <div class="scan-hint">QR-Code ins Bild nehmen</div>
      <button class="btn secondary scan-cancel" type="button">Abbrechen</button>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.scan-cancel').addEventListener('click', () => finish(null));

    if (!navigator.mediaDevices?.getUserMedia) { finish(null); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (e) {
      overlay.remove();
      S.toast('Keine Kamera verfügbar: ' + (e?.message || ''), { type: 'error' });
      finish(null);
      return;
    }

    const video = overlay.querySelector('video');
    video.srcObject = stream;
    await video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    const tick = () => {
      if (done) return;
      if (video.readyState >= 2 && video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const decoder = typeof jsQR !== 'undefined' ? jsQR : null;
        if (decoder) {
          const found = decoder(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (found?.data) { onStatus('erkannt'); finish(found.data); return; }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();

    setTimeout(() => { if (!done) { onStatus('timeout'); finish(null); } }, Math.max(5_000, timeoutMs));
  });
}

/* ---------------- Stufe 1/2: Schlüssel als QR übergeben bzw. übernehmen ---------------- */

/** Ich habe den Schlüssel -> QR-Code mit der DEK anzeigen (Stufe 1). */
export function showKeyQr(container) {
  if (!C.hasKey()) throw new Error('Kein Schlüssel vorhanden');
  const payload = payloadGiveKey(C.exportKey());
  container.innerHTML = `<img class="qr-img" src="${qrDataUrl(payload)}" alt="QR-Code mit dem secondmind-Schlüssel">
    <div class="qr-caption">Vom anderen Gerät scannen – der Schlüssel wird dann übernommen.</div>`;
}

/**
 * Ich bin neu -> gescannten Code übernehmen.
 * Inhalt 'smk1' = Schlüssel direkt (Stufe 1/2), 'smp1' = LAN-Session, die ich
 * mit meinem Schlüssel beantworte (Stufe 3, Senderrolle).
 * @returns {Promise<{ok:boolean, sas?:string, fingerprint?:string, lan?:object, error?:string}>}
 */
export async function acceptScanned(text) {
  const p = parsePayload(text);
  if (p.kind === 'lan') return { ok: true, lan: p, mode: 'send' };

  // Falsche Rollen: derjenige, der den fremden Schlüssel anzeigt? -> Fehler
  if (p.kind !== 'key') return { ok: false, error: 'Unbekannter QR-Code' };
  const fp = await adoptKeyNow(p.key);
  return { ok: true, fingerprint: fp, mode: 'receive' };
}

/** Fremden Schlüssel übernehmen und lokale Daten damit neu wegschreiben. */
export async function adoptKeyNow(dekB64) {
  await db.adoptKey(dekB64);                 // lokal neu verschlüsseln
  await C.fingerprint(dekB64);
  return C.fingerprint();
}

/* ---------------- Stufe 3: LAN-Pairing ---------------- */

/** Empfänger (Rechner): LAN-Session starten und QR zeigen. */
export async function startLanOffer(container) {
  const res = await bridgePairSend({ action: 'begin' });   // gleiche Bridge, anderes Kommando
  if (!res?.ok) throw new Error(res?.error || 'Netzwerk-Session nicht möglich');
  const payload = payloadLanOffer(res.secret, res.port, res.ips);
  container.innerHTML = `<img class="qr-img" src="${qrDataUrl(payload)}" alt="QR-Code für die Netzwerk-Verbindung">
    <div class="qr-caption">Auf dem Gerät <b>mit</b> dem Schlüssel „QR-Code scannen" wählen.<br>
      <span class="qr-sub">Hinweis: Beim ersten Mal muss Windows den Netzwerkzugriff erlauben.</span></div>`;
  return res;
}

/** Empfänger: auf die eingehende Übergabe warten (max. 120 s). */
export async function waitLanOffer() {
  const res = await bridgePairSend({ action: 'wait' });
  if (!res?.ok) return { ok: false, error: res?.error || 'Zeitüberschreitung' };
  const dekB64 = await C.openSealedSession(res.payload, res.secret || '');
  const fp = await adoptKeyNow(dekB64);
  return { ok: true, fingerprint: fp, sas: await C.sasCode(res.secret, dekB64) };
}

/** Sender (hält den Schlüssel): gescannte LAN-Session beantworten. */
export async function sendViaLan(lan) {
  const dek = C.exportKey();
  const payload = await C.sealForSession(dek, lan.secret);
  const body = JSON.stringify(payload);
  const res = await bridgePairSend({ action: 'send', ips: lan.ips, port: lan.port, body });
  if (!res?.ok) return { ok: false, error: res?.error || 'PC nicht erreichbar' };
  return { ok: true, sas: await C.sasCode(lan.secret, dek) };
}

/* ---------------- Stufe 4: .smkey-Datei ---------------- */

export async function exportKeyFile(password = '') {
  const obj = await C.makeKeyFile(password);
  const name = `secondmind-schluessel-${new Date().toISOString().slice(0, 10)}.smkey`;
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  await db.setSetting('keyBackupDone', true);      // D.6: Sicherung erledigt
  return name;
}

/** .smkey-Datei einlesen und Schlüssel übernehmen. */
export async function importKeyFile(file, password = '') {
  const obj = JSON.parse(await file.text());
  const dekB64 = await C.readKeyFile(obj, password);
  const fp = await adoptKeyNow(dekB64);
  return { ok: true, fingerprint: fp };
}

/* ---------------- Hilfen für die Oberfläche ---------------- */

export const isLanReceiver = () => platform === 'windows';   // nur der Rechner bietet LAN an
export const hasCamera = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

/** Empfohlene Aktion je Gerät („Gerät ohne Kamera zeigt"). */
export function recommend() {
  if (!C.hasKey()) return 'receive';
  return hasCamera() ? 'give-scan' : 'give';
}
