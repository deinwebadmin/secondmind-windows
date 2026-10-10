/* secondmind – router.js
   Minimaler Hash-Router: #/ , #/liste/<id> , #/notiz/<id> , #/archiv , #/memory , #/einstellungen */

const routes = [];
let current = null;

export function parse(hash = location.hash) {
  const h = (hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home', params: {} };
  const [head, ...rest] = parts;
  if (head === 'liste') return { name: 'liste', params: { id: rest[0] } };
  if (head === 'notiz') return { name: 'notiz', params: { id: rest[0] } };
  if (head === 'archiv') return { name: 'archiv', params: {} };
  if (head === 'memory') return { name: 'memory', params: {} };
  if (head === 'einstellungen') return { name: 'einstellungen', params: {} };
  if (head === 'suche') return { name: 'suche', params: { q: decodeURIComponent(rest.join('/') || '') } };
  return { name: 'home', params: {} };
}

export function navigate(hash, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
}

export function onRoute(cb) {
  routes.push(cb);
  cb(current || parse());
}

export function currentRoute() { return current; }

window.addEventListener('hashchange', () => {
  current = parse();
  for (const cb of routes) cb(current);
});

export function start() {
  current = parse();
  for (const cb of routes) cb(current);
}
