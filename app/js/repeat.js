/* secondmind – repeat.js
   Wiederkehrende To-Dos: Regeln (täglich / wöchentlich / monatlich), Fällig-
   keitsrechnung und An/Aus-Schalter – verknüpft mit der Kalenderübersicht.

   Modell: Ein wiederkehrender Punkt ist ein ganz normales item mit
   repeat: { freq, interval, weekday?, day?, start, enabled, lastDone }.
   „Erledigt" heißt: lastDone deckt alle Vorkommen bis heute ab. */

import * as db from './db.js';
import { isoDate, parseISO, addDays, WEEKDAYS, WEEKDAYS_SHORT } from './util.js';

/** Date.getDay() (So=0) auf die Mo=0-Ordnung der WEEKDAYS-Arrays umrechnen. */
export const wdIdx = (g) => (g + 6) % 7;

/** Seed-Liste „Wiederkehrend" (template 'repeat') – wird beim ersten Start
    angelegt. Auch gelöschte Listen zählen, damit sie nicht erneut
    automatisch auftaucht. */
export function ensureRepeatList() {
  for (const r of db.state.records.values()) {
    if (r.kind === 'list' && r.template === 'repeat') return r.id;
  }
  const l = db.create('list', { title: 'Wiederkehrend', template: 'repeat' });
  return l.id;
}

/** ID der aktuell sichtbaren Wiederkehrend-Liste (null, falls gelöscht). */
export function repeatListId() {
  for (const r of db.state.records.values()) {
    if (r.kind === 'list' && r.template === 'repeat' && !r.deleted) return r.id;
  }
  return null;
}

/** Ist dieser Punkt ein wiederkehrender? */
export const isRepeatItem = (it) => !!(it && it.kind === 'item' && it.repeat);

/** Regel passt auf Datum D? (inkl. Start-/Enddatum und Intervall) */
export function matchesDate(rep, date) {
  if (!rep || !rep.start) return false;
  const start = parseISO(rep.start);
  if (!start) return false;
  // Tagesbasis: Uhrzeiten ausblenden, damit Intervalle exakt greifen
  const s0 = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const d0 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (d0 < s0) return false;
  if (rep.until) {
    const u = parseISO(rep.until);
    if (u && d0 > new Date(u.getFullYear(), u.getMonth(), u.getDate())) return false;
  }
  const iv = Math.max(1, Number(rep.interval) || 1);
  if (rep.freq === 'daily') {
    const days = Math.round((d0 - s0) / 86400000);
    return days % iv === 0;
  }
  if (rep.freq === 'weekly') {
    if (d0.getDay() !== (Number(rep.weekday) || 0)) return false;
    const days = Math.round((d0 - s0) / 86400000);
    return Math.floor(days / 7) % iv === 0;
  }
  if (rep.freq === 'monthly') {
    if (d0.getDate() !== (Number(rep.day) || s0.getDate())) return false;
    const months = (d0.getFullYear() - s0.getFullYear()) * 12 + (d0.getMonth() - s0.getMonth());
    return months % iv === 0;
  }
  return false;
}

/** Ersten Regel-Termin nach (exclusive) „after“ finden – sonst null. */
export function nextDateAfter(rep, after, limitDays = 400) {
  let d = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (let i = 1; i <= limitDays; i++) {
    d = addDays(d, 1);
    if (matchesDate(rep, d)) return d;
  }
  return null;
}

/** Ist der Punkt für den aktuellen Zyklus erledigt (lastDone deckt ab)? */
export function isDoneForCycle(it, today = new Date()) {
  const rep = it?.repeat;
  if (!rep || !rep.lastDone) return false;
  const ld = parseISO(rep.lastDone);
  if (!ld) return false;
  const nx = nextDateAfter(rep, ld);
  return !nx || nx > today;
}

/** Ist heute ein offenes Vorkommen (Punkt ist fällig)? */
export function isDueToday(it, today = new Date()) {
  const rep = it?.repeat;
  if (!rep || rep.enabled === false) return false;
  if (!matchesDate(rep, today)) return false;
  if (rep.lastDone) {
    const ld = parseISO(rep.lastDone);
    if (ld) {
      const l0 = new Date(ld.getFullYear(), ld.getMonth(), ld.getDate());
      const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      if (l0 >= t0) return false;          // heute bereits erledigt
    }
  }
  return true;
}

/** Nächstes fälliges Datum (heute, wenn fällig; sonst der nächste Termin).
    null, wenn pausiert oder keine Termine mehr. */
export function nextDueDate(it, today = new Date()) {
  const rep = it?.repeat;
  if (!rep || rep.enabled === false) return null;
  if (isDueToday(it, today)) return today;
  let base = today;
  if (rep.lastDone) {
    const ld = parseISO(rep.lastDone);
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (ld && ld > t0) base = ld;          // Termin in der Zukunft? (sonst ab heute)
  }
  return nextDateAfter(rep, base);
}

/** Punkt abhaken (lastDone = heute) bzw. zurücksetzen. */
export function markDone(it) {
  db.update(it.id, { repeat: { ...it.repeat, enabled: it.repeat?.enabled !== false, lastDone: isoDate() } });
}
export function resetDone(it) {
  db.update(it.id, { repeat: { ...it.repeat, enabled: it.repeat?.enabled !== false, lastDone: null } });
}

/** Wiederholung an/aus (pausieren). */
export function setEnabled(it, on) {
  db.update(it.id, { repeat: { ...it.repeat, enabled: on } });
}

/** Beschriftung der Regel: „Täglich“, „Jeden Montag“, „Alle 2 Wochen (Mi)“, … */
export function freqLabel(rep) {
  const iv = Math.max(1, Number(rep.interval) || 1);
  if (rep.freq === 'daily') return iv === 1 ? 'Täglich' : `Alle ${iv} Tage`;
  if (rep.freq === 'weekly') {
    const i = wdIdx(Number(rep.weekday) || 0);
    return iv === 1 ? `Jeden ${WEEKDAYS[i]}` : `Alle ${iv} Wochen (${WEEKDAYS_SHORT[i]})`;
  }
  if (rep.freq === 'monthly') {
    const day = Number(rep.day) || 1;
    return iv === 1 ? `Monatlich am ${day}.` : `Alle ${iv} Monate am ${day}.`;
  }
  return 'Wiederkehrend';
}

/** Lesbare Fälligkeit: „heute“, „morgen“, „Mo 14.10.“ */
export function dueLabel(d, today = new Date()) {
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((d0 - t0) / 86400000);
  if (diff === 0) return 'heute';
  if (diff === 1) return 'morgen';
  if (diff === -1) return 'gestern';
  return `${WEEKDAYS[wdIdx(d.getDay())]} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}

/** Alle aktiven Wiederholungs-Punkte, die an Datum D im Kalender sichtbar
    sind (Regel passt, aktiv, Start erreicht, noch nicht erledigt). */
export function repeatsOn(date) {
  const out = [];
  for (const it of db.state.records.values()) {
    if (it.kind !== 'item' || it.deleted || (it.state || 'active') !== 'active') continue;
    if (!isRepeatItem(it) || it.repeat.enabled === false) continue;
    const list = db.byId(it.listId);
    if (!list || list.deleted || list.archived) continue;
    if (!matchesDate(it.repeat, date)) continue;
    if (it.repeat.lastDone) {
      const ld = parseISO(it.repeat.lastDone);
      if (ld && date <= ld) continue;        // bereits erledigte Vorkommen ausblenden
    }
    out.push(it);
  }
  return out.sort((a, b) => (a.text || '').localeCompare(b.text || ''));
}
