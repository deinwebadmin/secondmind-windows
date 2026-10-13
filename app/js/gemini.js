/* secondmind – gemini.js
   Optionale Google-Gemini-Integration.

   Datenschutz-Kern: Anfragen gehen direkt von hier zu Google. Gesendet werden
   nur exponierte Listen/Notizen (Modus „custom") bzw. – auf ausdrückliche
   Wahl des Nutzers – alle aktiven Einträge (Modus „full"). Nichts anderes
   verlässt das Gerät. */

import * as db from './db.js';

const GEMINI_MODEL = 'gemini-3.8-flash';   // Fallback, falls nichts eingestellt

/** Verfügbare Text-Modelle (Stand 10/2026) – Reihenfolge = Empfehlung. */
export const GEMINI_MODELS = [
  { v: 'gemini-3.8-flash', l: 'Gemini 3.8 Flash – empfohlen' },
  { v: 'gemini-3.7-flash', l: 'Gemini 3.7 Flash' },
  { v: 'gemini-3.6-flash', l: 'Gemini 3.6 Flash' },
  { v: 'gemini-3.5-flash', l: 'Gemini 3.5 Flash' },
  { v: 'gemini-3.5-flash-lite', l: 'Gemini 3.5 Flash-Lite – schnell & günstig' },
  { v: 'gemini-3.1-flash-lite', l: 'Gemini 3.1 Flash-Lite – schnell & günstig' },
  { v: 'gemini-3-flash-preview', l: 'Gemini 3 Flash – Vorschau' },
  { v: 'gemini-3.1-pro-preview', l: 'Gemini 3.1 Pro – Vorschau, stärkstes Modell' },
];

/** Aktuell gewähltes Modell (Settings-Dropdown bzw. Fallback). */
export function currentModel() {
  const m = String(db.state.settings.geminiModel || '').trim();
  if (m && GEMINI_MODELS.some((x) => x.v === m)) return m;
  return GEMINI_MODEL;
}
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Integration eingeschaltet und API-Key vorhanden? */
export function isGeminiReady() {
  const s = db.state.settings;
  return !!(s.geminiEnabled && s.geminiApiKey && s.geminiApiKey.trim());
}

/** Ist diese Karte (Liste/Notiz) für Gemini freigegeben? */
export function isExposed(kind, id) {
  const s = db.state.settings;
  if (s.geminiMode === 'full') return true;
  const arr = kind === 'list' ? s.geminiExposedLists : s.geminiExposedNotes;
  return Array.isArray(arr) && arr.includes(id);
}

/** Freigabe umschalten; gibt den neuen Zustand (true = freigegeben) zurück. */
export function toggleExposed(kind, id) {
  const key = kind === 'list' ? 'geminiExposedLists' : 'geminiExposedNotes';
  const arr = Array.isArray(db.state.settings[key]) ? [...db.state.settings[key]] : [];
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(id);
  db.setSetting(key, arr);
  return i < 0;
}

/** Kurze Übersicht der aktuellen Freigabe (für Einstellungen & Chat). */
export function exposureSummary() {
  const s = db.state.settings;
  if (s.geminiMode === 'full') return 'Zugriff: alle aktiven Einträge.';
  const l = (s.geminiExposedLists || []).length;
  const n = (s.geminiExposedNotes || []).length;
  return `Zugriff: ${l} Liste(n) und ${n} Notiz(en) exponiert.`;
}

/** Freigegebene Inhalte als Text für die Anfrage. */
export function collectContext() {
  const s = db.state.settings;
  const full = s.geminiMode === 'full';
  const lset = new Set(s.geminiExposedLists || []);
  const nset = new Set(s.geminiExposedNotes || []);
  const itemsByList = new Map();
  const teile = [];

  for (const it of db.state.records.values()) {
    if (it.kind !== 'item' || it.deleted || it.state !== 'active') continue;
    if (!itemsByList.has(it.listId)) itemsByList.set(it.listId, []);
    itemsByList.get(it.listId).push(it);
  }

  for (const list of db.state.records.values()) {
    if (list.kind !== 'list' || list.deleted || list.archived) continue;
    if (!full && !lset.has(list.id)) continue;
    const alle = itemsByList.get(list.id) || [];
    const rows = [];
    for (const it of alle) {
      if (it.parentId) continue;
      const mark = it.done ? 'x' : ' ';
      const tags = it.tags?.length ? ` #${it.tags.join(' #')}` : '';
      const termin = it.plan?.date ? ` (geplant ${it.plan.date}${it.plan.time ? ' ' + it.plan.time : ''})` : '';
      rows.push(`- [${mark}] ${it.text || '(ohne Text)'}${tags}${termin}`);
      for (const sub of alle) {
        if (sub.parentId !== it.id) continue;
        rows.push(`  - [${sub.done ? 'x' : ' '}] ${sub.text || '(ohne Text)'}`);
      }
    }
    teile.push(`### Liste: ${list.title || 'Ohne Titel'}${list.tags?.length ? ` #${list.tags.join(' #')}` : ''}\n${rows.join('\n') || '(leer)'}`);
  }

  for (const note of db.state.records.values()) {
    if (note.kind !== 'note' || note.deleted || note.archived) continue;
    if (!full && !nset.has(note.id)) continue;
    teile.push(`### Notiz: ${note.title || 'Ohne Titel'}\n${String(note.text || '').slice(0, 6000)}`);
  }

  return teile.join('\n\n');
}

/** Anfrage an Gemini senden; wirft bei Fehlern mit verständlicher Meldung. */
export async function askGemini(prompt, { system } = {}) {
  if (!isGeminiReady()) throw new Error('Gemini ist nicht eingerichtet (Schalter aus oder API-Key fehlt).');

  const context = collectContext();
  const body = {
    systemInstruction: {
      parts: [{
        text: system
          || 'Du bist der KI-Assistent in secondmind (Notizen und To-Dos). Antworte auf Deutsch, präzise und freundlich. Nutze ausschließlich die mitgelieferten Inhalte als Kontext und erfinde keine weiteren Daten.',
      }],
    },
    contents: [{
      role: 'user',
      parts: [{ text: (context ? `<secondmind-inhalte>\n${context}\n</secondmind-inhalte>\n\n` : '') + prompt }],
    }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
  };

  const res = await fetch(`${GEMINI_BASE}/${currentModel()}:generateContent?key=${encodeURIComponent(db.state.settings.geminiApiKey.trim())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let msg = res.statusText;
    try {
      const err = await res.json();
      msg = err.error?.message || msg;
    } catch { /* Text-Fehlerseite ignorieren */ }
    let hinweis = '';
    if (/api.?key|API_KEY_INVALID/i.test(msg)) {
      hinweis = ' Der API-Key wurde von Google nicht akzeptiert – bitte in den Einstellungen prüfen (muss mit „AIza“ beginnen, keine Leerzeichen).';
    } else if (res.status === 403) {
      hinweis = ' Zugriff verweigert – evtl. ist die „Google Generative Language API“ im Google-Projekt noch nicht aktiviert.';
    } else if (res.status === 404) {
      hinweis = ' Das gewählte Modell steht bei Google gerade nicht zur Verfügung – bitte in den Einstellungen ein anderes auswählen.';
    }
    throw new Error(`Gemini-Fehler (${res.status}): ${msg}${hinweis}`);
  }

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini hat keine Antwort geliefert.');
  return text;
}
