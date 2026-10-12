// Bot notes: a small card at the top right when a bot or the Chief finishes a turn or needs you, on any view but the
// Bots tab (app.js feeds it from state.alerts; Henry, 2026-10-12). Its face (mascot.js, smiling when done, the "?"
// bubble when it needs you), its name and the line it ended on. A click opens its chat; the x (on hover) closes it.
// Up to three stack, newest on top; a new note from the same bot takes over its card. Each leaves after 6 s, but not
// while the pointer is on it or while the window is in the background: it waits for you to come back. Motion is
// transform and opacity only (botnote.css): in from the right with the mascot's hop, out to the right, and the
// others glide to their new places; with prefers-reduced-motion it holds still.
//
// CONTRACT (app.js builds on it):
//   mountBotNotes({ open(sid) }) -> { push(note), clear() }
//     note: { key, sid, name, face, kind, text, color }   key: one card per bot; face: mascotSVG markup; kind: 'done' |
//     'needs' | 'error' (the small word by the name); text: one line, shown on at most two

import { esc } from './cards.js';
import { mascotAck } from './mascot.js';

const SHOW_MS = 6000, MAX = 3, OUT_MS = 240;
const WORD = { done: 'done', needs: 'needs you', error: 'error' };

export function mountBotNotes({ open = () => {} } = {}) {
  const box = document.createElement('div');
  box.className = 'bn-stack';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  document.body.appendChild(box);

  const cards = () => [...box.children].filter((c) => !c._out);
  const away = () => document.hidden || !document.hasFocus();

  // the others glide from where they were to where they are now (FLIP), as one comes or goes
  function glide(change) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { change(); return; }
    const before = new Map(cards().map((c) => [c, c.getBoundingClientRect().top]));
    change();
    for (const [c, top] of before) {
      if (!c.isConnected || c._out) continue;
      const dy = top - c.getBoundingClientRect().top;
      if (!dy) continue;
      c.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
  }

  function leave(c) {
    if (c._out) return;
    c._out = true;
    c.classList.add('out');
    setTimeout(() => glide(() => c.remove()), OUT_MS);
  }

  // one clock for all: time only runs down while the window is in front and the pointer is not on the card
  let tick = null;
  function run() {
    if (tick) return;
    let last = performance.now();
    tick = setInterval(() => {
      const now = performance.now(), dt = now - last;
      last = now;
      if (!box.children.length) { clearInterval(tick); tick = null; return; }
      if (away()) return;
      for (const c of cards()) if (!c.matches(':hover') && (c._left -= dt) <= 0) leave(c);
    }, 200);
  }

  function fill(c, n) {
    c._key = n.key;
    c._sid = n.sid;
    c._left = SHOW_MS;
    c.style.setProperty('--bc', n.color || '#58a6ff');
    c.className = `bn bn-${WORD[n.kind] ? n.kind : 'done'}`;
    c.setAttribute('aria-label', `${n.name}: ${n.text || WORD[n.kind] || ''}. Open its chat`);
    c.innerHTML = `<span class="bn-av">${n.face || ''}</span>`
      + `<span class="bn-b"><span class="bn-h"><span class="bn-n">${esc(n.name || 'Bot')}</span><span class="bn-k">${esc(WORD[n.kind] || 'done')}</span></span>`
      + (n.text ? `<span class="bn-t">${esc(n.text)}</span>` : '') + '</span>'
      + '<button type="button" class="bn-x" tabindex="-1" aria-label="Dismiss"><svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>';
  }

  function push(n) {
    if (!n || !n.sid) return;
    const same = cards().find((c) => c._key === n.key);
    glide(() => {
      const c = same || document.createElement('div');
      fill(c, n);
      c.tabIndex = 0;
      c.setAttribute('role', 'button');
      box.prepend(c);
    });
    const c = box.firstElementChild;
    mascotAck(c.querySelector('.bn-av'));
    for (const old of cards().slice(MAX)) leave(old);
    run();
  }

  box.addEventListener('click', (e) => {
    const c = e.target.closest('.bn');
    if (!c || c._out) return;
    if (!e.target.closest('.bn-x')) open(c._sid);
    leave(c);
  });
  box.addEventListener('keydown', (e) => {
    const c = e.target.closest('.bn');
    if (!c || c._out) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(c._sid); leave(c); }
    else if (e.key === 'Escape') { e.preventDefault(); leave(c); }
  });

  return { push, clear: () => { for (const c of cards()) leave(c); } };
}
