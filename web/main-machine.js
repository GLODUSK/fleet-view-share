// Fleet View web: the main computer (GET /sync/main, fleet-view.js syncMain; the setting travels in sync-prefs.js
// mainMachine). With one picked, chats run on it: the other computer shows them and types into them. Picked in the
// Sync card (sync.js); the rest of the page asks here.
//
//   mainMachine() -> Promise of { ok, main: { id, name } | null, me: { id, name } | null, isMain, online } (online: the
//     main computer's as seen from here, true on it, null while not known), or null (no answer, or sync not set up
//     here). Read again at most every 5 s; never throws
//   onMainMachine(fn) -> unsubscribe: fn(answer) when it changes (the main computer, this machine, isMain or online).
//     Read every 15 s while anyone listens
//   noteMainMachine(answer): POST /sync/main's answer (the Sync card), so the listeners hear it at once
const FRESH_MS = 5e3, WATCH_MS = 15e3;
let last = null, lastAt = 0, flight = null, lastSig = '', watch = null;
const fns = new Set();
const sigOf = (a) => (a ? JSON.stringify([a.main && a.main.id, a.main && a.main.name, a.me && a.me.id, !!a.isMain, a.online]) : '');
const cleanAnswer = (j) => (j && j.ok === true && 'main' in j ? j : null);

function took(a) {
  last = a; lastAt = Date.now();
  const s = sigOf(a);
  if (s === lastSig) return;
  lastSig = s;
  for (const fn of [...fns]) { try { fn(a); } catch {} }
}
export function mainMachine() {
  if (lastAt && Date.now() - lastAt < FRESH_MS) return Promise.resolve(last);
  if (!flight) {
    flight = (async () => {
      let a = null;
      try { const r = await fetch('/sync/main', { cache: 'no-store' }); a = r.ok ? cleanAnswer(await r.json()) : null; } catch {}
      flight = null;
      took(a);
      return a;
    })();
  }
  return flight;
}
export function onMainMachine(fn) {
  if (typeof fn !== 'function') return () => {};
  fns.add(fn);
  if (!watch) watch = setInterval(() => { mainMachine(); }, WATCH_MS);
  mainMachine();
  return () => {
    fns.delete(fn);
    if (!fns.size && watch) { clearInterval(watch); watch = null; }
  };
}
export function noteMainMachine(answer) {
  const a = cleanAnswer(answer);
  if (a) took(a);
}
