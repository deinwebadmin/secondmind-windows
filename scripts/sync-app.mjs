// Spiegelt app/ dieses Repos in das Schwester-Repo (windows <-> android).
// Aufruf:  node scripts/sync-app.mjs ../secondmind-android          (kopieren)
//          node scripts/sync-app.mjs ../secondmind-android --check  (nur prüfen, Exit 1 bei Abweichung)
// Plattformspezifisch und deshalb ausgenommen: app/js/cap/ (Capacitor, nur Android).
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const [, , otherArg, flag] = process.argv;
if (!otherArg) { console.error('Aufruf: node scripts/sync-app.mjs <anderes-repo> [--check]'); process.exit(2); }
const check = flag === '--check';
const src = resolve('app');
const dst = resolve(otherArg, 'app');
if (!existsSync(dst)) { console.error('Zielordner fehlt: ' + dst); process.exit(2); }

const SKIP = [`js${sep}cap`];
const skipped = (rel) => SKIP.some((s) => rel === s || rel.startsWith(s + sep));
function walk(dir, base = dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const rel = relative(base, p);
    if (skipped(rel)) continue;
    if (statSync(p).isDirectory()) walk(p, base, out); else out.push(rel);
  }
  return out;
}

const a = new Set(walk(src));
const b = new Set(walk(dst));
const diffs = [];
for (const f of a) {
  if (!b.has(f) || !readFileSync(join(src, f)).equals(readFileSync(join(dst, f)))) diffs.push(['~', f]);
}
for (const f of b) if (!a.has(f)) diffs.push(['-', f]);

if (!diffs.length) { console.log('app/ ist identisch.'); process.exit(0); }
for (const [m, f] of diffs) console.log(m, f);
if (check) { console.error(diffs.length + ' Abweichung(en).'); process.exit(1); }
for (const [m, f] of diffs) {
  if (m === '-') { rmSync(join(dst, f)); continue; }
  mkdirSync(join(dst, f, '..'), { recursive: true });
  writeFileSync(join(dst, f), readFileSync(join(src, f)));
}
console.log(diffs.length + ' Datei(en) synchronisiert.');
