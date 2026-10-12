/* secondmind – util.js
   Kleine Helfer: IDs, Datum, HTML-Escaping, Spring-Animationen (Apple-Physik). */

export const uid = () =>
  Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9) + Math.random().toString(36).slice(2, 6);

export const now = () => Date.now();

/** App-Version (mit package.json / build.gradle abgleichen) */
export const APP_VERSION = '1.0.17';

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Attribut-Objekt -> Klassen-String */
export const cls = (...a) => a.filter(Boolean).join(' ');

export function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

/* ---------------- Datum ---------------- */

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

export function fmtRel(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < MIN) return 'gerade eben';
  if (d < HOUR) return `vor ${Math.floor(d / MIN)} Min`;
  if (d < DAY) return `vor ${Math.floor(d / HOUR)} Std`;
  if (d < 2 * DAY) return 'gestern';
  if (d < 7 * DAY) return `vor ${Math.floor(d / DAY)} Tagen`;
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function fmtDate(ts, opts = { day: '2-digit', month: 'short', year: 'numeric' }) {
  return new Date(ts).toLocaleDateString('de-DE', opts);
}

export const yearOf = (ts) => new Date(ts).getFullYear();

/** Wochen-Montag der laufenden Woche */
export function mondayOfWeek(d = new Date()) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Mo=0
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}

export const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Index 0..6 (Mo..So) für den heutigen Wochentag */
export const todayIndex = () => (new Date().getDay() + 6) % 7;

/** Lokales Datum als YYYY-MM-DD (Kalender-Schlüssel) */
export const isoDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 'YYYY-MM-DD' -> Date (lokale Mitternacht) */
export const parseISO = (s) => {
  const [y, m, d] = String(s || '').split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
};

export const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** Zeitraum einer Woche: „12.–18. Okt 2026“ */
export function weekLabel(mon) {
  const sun = addDays(mon, 6);
  return `${mon.getDate()}.–${sun.getDate()}. ${MONTHS_SHORT[sun.getMonth()]} ${sun.getFullYear()}`;
}

/** Kalenderwoche (ISO) einer Woche, Mo-Start */
export function isoWeek(mon) {
  const d = new Date(mon);
  d.setDate(d.getDate() + 3);                     // Donnerstag der Woche
  const firstThu = new Date(d.getFullYear(), 0, 4);
  firstThu.setDate(firstThu.getDate() + 3 - ((firstThu.getDay() + 6) % 7));
  return 1 + Math.round((d - firstThu) / (7 * 86_400_000));
}

/** „14:30“ + Minuten -> „15:30“ (Endzeit eines Termins) */
export function addMinutesToTime(time, mins) {
  const [h, m] = String(time || '00:00').split(':').map(Number);
  const t = (((h || 0) * 60 + (m || 0) + (mins || 0)) % 1440 + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/* ---------------- Physik / Animation ---------------- */

export const reducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Feder-Animation im Apple-Stil (mass-spring-damper).
 * response  = wie schnell (Sekunden bis zur Grundfrequenz)
 * damping   = 1.0 kritisch (kein Überschwingen), <1 mit Bounce
 * velocity  = Startgeschwindigkeit (Einheiten/s, z.B. px/s)
 */
export function spring({ from, to, velocity = 0, response = 0.4, damping = 1.0, restDelta = 0.4, onUpdate, onComplete }) {
  if (reducedMotion()) { onUpdate?.(to); onComplete?.(); return () => {}; }

  const mass = 1;
  const k = (2 * Math.PI / response) ** 2 * mass;
  const c = 2 * damping * Math.sqrt(k * mass);

  let x = from, v = velocity, last = performance.now(), raf = 0, cancelled = false;

  const step = (t) => {
    if (cancelled) return;
    let dt = Math.min((t - last) / 1000, 0.064); // gegen Sprünge bei Tab-Wechsel
    last = t;
    // Substepping für Stabilität
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = (-k * (x - to) - c * v) / mass;
      v += a * h;
      x += v * h;
    }
    if (Math.abs(x - to) < restDelta && Math.abs(v) < restDelta * 12) {
      onUpdate?.(to);
      onComplete?.();
      return;
    }
    onUpdate?.(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);

  return () => { cancelled = true; cancelAnimationFrame(raf); };
}

/** Rubber-Banding: Widerstand am Rand (Apple's Dämpfungsformel) */
export const rubberband = (overshoot, dimension, constant = 0.55) =>
  (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));

/** Momentum-Projektion beim Loslassen (exponentieller Auslauf) */
export function project(velocity, decelerationRate = 0.998) {
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

export function haptic(ms = 8) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* egal */ }
}

/* ---------------- Icons (SVG-Strings) ---------------- */

const sv = (p, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`;

export const ICON = {
  back: sv('<path d="M15 5l-7 7 7 7"/>'),
  check: sv('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  plus: sv('<path d="M12 5v14M5 12h14"/>'),
  trash: sv('<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 12a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1l1-12"/>'),
  archive: sv('<path d="M4 8.5h16V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8.5ZM3 4.5h18v4H3v-4Zm6.5 8h5"/>'),
  memory: sv('<path d="M12 4.5c-3.6 0-6 2.3-6 5.2 0 1.7.8 3 1.9 3.9-.4 1.1-1.9 1.9-1.9 3.6 0 2.9 2.5 5.3 6 5.3s6-2.4 6-5.3c0-1.7-1.5-2.5-1.9-3.6 1.1-.9 1.9-2.2 1.9-3.9 0-2.9-2.4-5.2-6-5.2Z"/>'),
  pin: sv('<path d="M9 4h6l-1 6 3.5 3.5H6.5L10 10 9 4Zm3 9.5V20"/>'),
  /* Gemini-Sparkle (4-Zacken-Stern im Google-Gradient) */
  gemini: `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="geminiGrad" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4285F4"/><stop offset=".5" stop-color="#9B72CB"/><stop offset="1" stop-color="#D96570"/></linearGradient></defs><path fill="url(#geminiGrad)" d="M12 2c.5 5.8 4.2 9.5 10 10-5.8.5-9.5 4.2-10 10-.5-5.8-4.2-9.5-10-10 5.8-.5 9.5-4.2 10-10Z"/></svg>`,
  link: sv('<path d="M10 13.5a4 4 0 0 0 5.7.3l2.6-2.6a4 4 0 0 0-5.7-5.7L11 7.2M14 10.5a4 4 0 0 0-5.7-.3l-2.6 2.6a4 4 0 0 0 5.7 5.7L13 16.8"/>'),
  clip: sv('<path d="M20.2 11.3l-8 8a4.6 4.6 0 0 1-6.5-6.5l8.4-8.4a3.1 3.1 0 1 1 4.4 4.4l-8.4 8.4a1.6 1.6 0 0 1-2.2-2.2l7.6-7.6"/>'),
  image: sv('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m5 17 4.5-4.5L14 17m1.5-2L18 14.5"/>'),
  doc: sv('<path d="M13 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V9m-6.5-5.5L17 9m-6.5-5.5V9H17"/>'),
  more: sv('<circle cx="5.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor"/>'),
  grip: sv('<circle cx="9" cy="6" r="1.5" fill="currentColor"/><circle cx="15" cy="6" r="1.5" fill="currentColor"/><circle cx="9" cy="12" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1.5" fill="currentColor"/><circle cx="9" cy="18" r="1.5" fill="currentColor"/><circle cx="15" cy="18" r="1.5" fill="currentColor"/>'),
  close: sv('<path d="M6 6l12 12M18 6L6 18"/>'),
  note: sv('<path d="M5.5 5.5A1.5 1.5 0 0 1 7 4h7.5L19 8.5V18a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 18V5.5ZM14 4v5h5"/>'),
  list: sv('<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>'),
  sync: sv('<path d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6M4 6.5V12h5.5M20 17.5V12h-5.5"/>'),
  cloud: sv('<path d="M7.5 18.5a4.5 4.5 0 0 1-.4-9 6 6 0 0 1 11.4 1.6A3.9 3.9 0 0 1 18 18.5H7.5Z"/>'),
  offline: sv('<path d="M3 3l18 18M7.5 18.5a4.5 4.5 0 0 1-.4-9 6 6 0 0 1 8.6-3.2M18.6 10.7A3.9 3.9 0 0 1 18 18.5h-4"/>'),
  calendar: sv('<rect x="4" y="5.5" width="16" height="15" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'),
  palette: sv('<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-1 2-1.8 0-1.5-1.5-1.7-1.5-3 0-1 .8-1.7 1.9-1.7H16a4.5 4.5 0 0 0 4.5-4.5C20.5 6.3 16.7 3.5 12 3.5Z"/><circle cx="7.5" cy="11" r="1.1" fill="currentColor"/><circle cx="10.5" cy="7.5" r="1.1" fill="currentColor"/><circle cx="15" cy="7.5" r="1.1" fill="currentColor"/>'),
  tag: sv('<path d="M4 11V5.5A1.5 1.5 0 0 1 5.5 4H11l8.5 8.5a1.7 1.7 0 0 1 0 2.4l-4.6 4.6a1.7 1.7 0 0 1-2.4 0L4 11Z"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/>'),
  gear: sv('<circle cx="12" cy="12" r="3.2"/><path d="M19.2 13.3a7.6 7.6 0 0 0 0-2.6l1.8-1.3-1.9-3.3-2.1.8a7.6 7.6 0 0 0-2.6-1.5L14 3.2h-4l-.4 2.2a7.6 7.6 0 0 0-2.6 1.5l-2.1-.8-1.9 3.3 1.8 1.3a7.6 7.6 0 0 0 0 2.6l-1.8 1.3 1.9 3.3 2.1-.8a7.6 7.6 0 0 0 2.6 1.5l.4 2.2h4l.4-2.2a7.6 7.6 0 0 0 2.6-1.5l2.1.8 1.9-3.3-1.8-1.3Z" stroke-linejoin="round"/>'),
  eye: sv('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>'),
  restore: sv('<path d="M4 10a8 8 0 1 1 .7 5M4 5v5h5"/>'),
  share: sv('<path d="M12 15V4m0 0L8.5 7.5M12 4l3.5 3.5M5.5 12v6.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V12"/>'),
  bolt: sv('<path d="M13.5 3 5.5 13.5h5L10 21l8-10.5h-5L13.5 3Z"/>'),
};

/* ---------------- Tags & Farben ---------------- */

/** Farbpalette für Tags (neutral = Standardfarbe) */
export const TAG_COLORS = ['neutral', 'blue', 'green', 'yellow', 'orange', 'red', 'purple'];

/** Chip-Klasse für einen Tag: rec.tagColors = { Tag: Farbe } */
export function tagCls(rec, tag) {
  const c = rec?.tagColors?.[tag];
  return c && c !== 'neutral' ? `tag-c-${c}` : '';
}

/** Fertiger farbiger Tag-Chip */
export function tagChip(rec, tag) {
  return `<span class="chip ${tagCls(rec, tag)}">${esc(tag)}</span>`;
}

/* ---------------- Diverses ---------------- */

export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function download(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}
