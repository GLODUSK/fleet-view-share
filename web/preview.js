// Preview tab: the conversation's running dev server, its page shown next to the chat, like the Claude desktop
// app's preview pane. The server side is preview.js (GET /preview/urls, POST /preview/start and /preview/stop).
//
// detail.js calls renderPreviewPane(pane, s, opts) about once a second while the tab shows. The first call builds
// the pane: a toolbar (back, forward, reload, the address box, the list of found servers, Open in browser,
// Screenshot to chat), a quiet note line, and the page in an <iframe> below. Every call is cheap; while the calls
// keep coming the pane asks GET /preview/urls every POLL_MS (faster while a server starts) and stops asking when
// they stop. The list: the local addresses the conversation used or printed (http://localhost:<port> and the
// like, from its transcript, newest first, each marked up or not), then the configurations in its folder's
// .claude/launch.json, which Start and Stop run and end.
//
// Which page: the one picked for this conversation last time (localStorage fv.preview.<id>), else the newest
// address that answers. Picking one from the list, typing one in the address box (localhost:3000, or just 3000)
// or a page the preview moves to by itself becomes the new one. Only local dev servers show here (http on
// localhost, 127.0.0.1 or [::1], never Fleet View's own port).
//
// The frame: sandboxed (scripts, forms, its own origin's storage and cookies, popups, alert/confirm); it can
// never navigate the Fleet View page itself (no allow-top-navigation). In the desktop window (window.fleetDesktop)
// main.js strips X-Frame-Options and CSP frame-ancestors from these frames' responses, so any dev server shows;
// links that open a new window go to the default browser; fleetDesktop.onPreviewNav tells the pane where the
// frame went (a click on a link, a redirect, an app's own routing), which the address box then shows. Back and
// forward go through that list (they load the earlier address again; the frame's own history isn't reachable
// across origins). In Edge the frame shows only pages that allow framing: the server checks the current one's
// headers (frame=1) and the note says so when it doesn't, with Open in browser.
//
// Nothing found: the pane offers the launch.json configurations (Start) or, without any, "Ask Claude to start
// it", which hands Claude a message (handto.js, sent at once). Screenshot to chat (desktop window only, where
// fleetDesktop.capture exists) captures the frame's area of the window as a PNG and hands it to the chat box
// with a line naming the address, unsent, so you can add a question.
import { esc, ago } from './cards.js';
import { icon } from './icons.js';
import { handToChat } from './handto.js';

const POLL_MS = 5000;
const FAST_MS = 1500; // while a server starts, or the page waits for one
const STALE_MS = 3000; // no renderPreviewPane call for this long: the tab is hidden, stop asking
const START_WAIT_MS = 90000; // "Starting…" gives up after this long
const REDIRECT_MS = 2500; // a frame move this soon after loading an address replaces it (a redirect), not a new step
const HIST_MAX = 50;
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals';
const ASK_TEXT = "Start this project's dev server in the background (run_in_background) and tell me its local URL.";
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const desk = () => window.fleetDesktop || null;
const canCapture = () => typeof desk()?.capture === 'function';
const panes = new Set();

// a reload arrow in icons.js's style (icons.js has none)
const RELOAD = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V8H16"/></svg>';

// ---------- addresses ----------
function localUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' || !LOCAL_HOSTS.includes(u.hostname) || !u.port || u.port === '4777' || u.port === location.port) return null;
  return u;
}
// what was typed in the address box, as an address: "3000", ":3000/x", "localhost:3000", "http://127.0.0.1:5173/a"
export function toUrl(text) {
  let t = String(text || '').trim();
  if (!t) return null;
  if (/^\d{2,5}(\/.*)?$/.test(t)) t = `localhost:${t}`;
  else if (/^:\d{2,5}/.test(t)) t = `localhost${t}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `http://${t}`;
  const u = localUrl(t);
  return u ? u.href : null;
}
const norm = (u) => { try { return new URL(u).href; } catch { return String(u || ''); } };
const same = (a, b) => !!a && !!b && norm(a) === norm(b);
const portOf = (u) => { try { return new URL(u).port; } catch { return ''; } };
const shortUrl = (u) => String(u || '').replace(/^http:\/\//, '').replace(/\/$/, '');

// ---------- remembered address, per conversation ----------
const memKey = (id) => `fv.preview.${id}`;
function recall(id) { try { return localStorage.getItem(memKey(id)) || ''; } catch { return ''; } }
function remember(id, url) { try { if (url) localStorage.setItem(memKey(id), url); else localStorage.removeItem(memKey(id)); } catch {} }

// ---------- the pane ----------
function build(pane) {
  pane.innerHTML = `
<div class="pv-bar">
  <button type="button" class="pv-ib pv-back" data-pv="back" title="Back" aria-label="Back">${icon('chevron', 15)}</button>
  <button type="button" class="pv-ib" data-pv="fwd" title="Forward" aria-label="Forward">${icon('chevron', 15)}</button>
  <button type="button" class="pv-ib" data-pv="reload" title="Reload" aria-label="Reload">${RELOAD}</button>
  <form class="pv-addr" autocomplete="off"><span class="pv-dot" aria-hidden="true"></span><input class="pv-url" type="text" spellcheck="false" placeholder="localhost:3000" aria-label="Address"></form>
  <button type="button" class="pv-ib pv-pick" data-pv="pick" title="Dev servers this conversation used" aria-label="Dev servers" aria-haspopup="menu" aria-expanded="false">${icon('chevron', 15)}</button>
  <button type="button" class="pv-ib" data-pv="open" title="Open in browser" aria-label="Open in browser">${icon('external', 15)}</button>
  <button type="button" class="pv-ib" data-pv="shot" title="Screenshot to chat" aria-label="Screenshot to chat" hidden>${icon('image', 15)}</button>
</div>
<div class="pv-menu" role="menu" hidden></div>
<div class="pv-note" hidden></div>
<div class="pv-body"><div class="s-cardbox pv-card"></div><iframe class="pv-frame" name="fv-preview" title="Preview" sandbox="${SANDBOX}" referrerpolicy="no-referrer" hidden></iframe></div>`;
  const q = (sel) => pane.querySelector(sel);
  const st = pane._pv = {
    id: null, cwd: '', url: '', hist: [], fwd: [], list: [], loaded: false, cur: null, loadAt: 0, moved: false,
    lastRender: 0, lastPoll: 0, polling: false, timer: null, starting: null, err: '', menu: false, busy: '',
    el: {
      back: q('[data-pv="back"]'), fwd: q('[data-pv="fwd"]'), reload: q('[data-pv="reload"]'), pick: q('[data-pv="pick"]'),
      open: q('[data-pv="open"]'), shot: q('[data-pv="shot"]'), addr: q('.pv-addr'), input: q('.pv-url'), dot: q('.pv-dot'),
      menu: q('.pv-menu'), note: q('.pv-note'), card: q('.pv-card'), frame: q('.pv-frame'),
    },
  };
  const E = st.el;
  E.addr.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = toUrl(E.input.value);
    if (!url) { st.err = 'Only a local dev server shows here: localhost, 127.0.0.1 or [::1] with a port, like localhost:3000.'; draw(pane); return; }
    E.input.blur();
    go(pane, url);
  });
  E.input.addEventListener('focus', () => E.input.select());
  E.input.addEventListener('blur', () => { E.input.value = st.url; });
  // the view's single-key shortcuts stay out of the address box and the list
  pane.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && st.menu) { e.preventDefault(); e.stopPropagation(); closeMenu(pane); E.pick.focus(); return; }
    if (e.target === E.input) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); E.input.value = st.url; E.input.blur(); }
    }
  });
  pane.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pv]');
    if (!b || b.disabled) return;
    const what = b.dataset.pv;
    if (what !== 'pick' && st.menu && !e.target.closest('.pv-menu')) closeMenu(pane);
    if (what === 'back' && st.hist.length) { st.fwd.push(st.url); step(pane, st.hist.pop()); }
    else if (what === 'fwd' && st.fwd.length) { st.hist.push(st.url); step(pane, st.fwd.pop()); }
    else if (what === 'reload' && st.url) load(pane, st.url);
    else if (what === 'pick') { if (st.menu) closeMenu(pane); else openMenu(pane); }
    else if (what === 'open' && st.url) window.open(st.url, '_blank', 'noopener');
    else if (what === 'shot') screenshot(pane);
    else if (what === 'go' && b.dataset.url) { closeMenu(pane); go(pane, b.dataset.url); }
    else if (what === 'start') start(pane, b.dataset.name);
    else if (what === 'stop') stop(pane, b.dataset.name);
    else if (what === 'ask') ask(pane);
    else if (what === 'dismiss') { st.err = ''; draw(pane); }
  });
  // a click anywhere else closes the list (a click inside the frame never reaches this page: blur does)
  document.addEventListener('pointerdown', (e) => { if (st.menu && !pane.contains(e.target)) closeMenu(pane); }, true);
  window.addEventListener('blur', () => { if (st.menu && document.activeElement === E.frame) closeMenu(pane); });
  panes.add(pane);
}

export function renderPreviewPane(pane, s, opts = {}) {
  if (!pane._pv) build(pane);
  const st = pane._pv;
  st.lastRender = Date.now();
  if (st.id !== s.id) switchTo(pane, s);
  st.cwd = s.cwd || (s.links && s.links.repoFolder) || '';
  if (!st.timer) st.timer = setInterval(() => tick(pane), 500);
  if (!st.lastPoll) poll(pane);
  draw(pane);
}

// another conversation: its own address, list and history
function switchTo(pane, s) {
  const st = pane._pv;
  const prev = st.id, prevUrl = st.url;
  st.id = s.id;
  st.hist = []; st.fwd = []; st.list = []; st.loaded = false; st.cur = null; st.starting = null; st.err = ''; st.lastPoll = 0;
  closeMenu(pane);
  let url = recall(s.id);
  // a new session that just got its conversation id keeps what it showed
  if (!url && prev && /^new-/.test(prev) && prevUrl) { url = prevUrl; remember(s.id, url); }
  st.url = url && localUrl(url) ? url : '';
  if (st.url) load(pane, st.url); else unload(pane);
}

function tick(pane) {
  const st = pane._pv;
  const now = Date.now();
  if (now - st.lastRender > STALE_MS) { clearInterval(st.timer); st.timer = null; closeMenu(pane); return; }
  if (st.starting && now - st.starting.at > START_WAIT_MS) { st.starting = null; draw(pane); }
  const every = st.starting || (st.url && st.cur && !st.cur.up) ? FAST_MS : POLL_MS;
  if (!st.polling && now - st.lastPoll >= every) poll(pane);
}

async function poll(pane) {
  const st = pane._pv;
  const id = st.id, url = st.url;
  if (!id) return;
  st.polling = true;
  st.lastPoll = Date.now();
  const q = new URLSearchParams({ id, cwd: st.cwd });
  if (url) { q.set('current', url); if (!desk()) q.set('frame', '1'); }
  let j = null;
  try { const r = await fetch(`/preview/urls?${q}`, { cache: 'no-store' }); if (r.ok) j = await r.json(); } catch {}
  st.polling = false;
  if (!j || st.id !== id) return;
  st.list = Array.isArray(j.urls) ? j.urls : [];
  st.loaded = true;
  if (st.url !== url) return draw(pane); // the address changed meanwhile: its own poll comes
  const was = st.cur;
  st.cur = j.current && same(j.current.url, url) ? j.current : null;
  if (!st.url) {
    // nothing picked yet: the newest address that answers
    const pick = st.list.find((x) => x.up && x.url && !x.launch) || st.list.find((x) => x.up && x.url);
    if (pick) go(pane, pick.url, { push: false });
  } else if (st.cur && st.cur.up && was && !was.up) {
    load(pane, st.url); // it just came up: the frame still shows the error page
  }
  if (st.starting && st.cur && st.cur.up) st.starting = null;
  draw(pane);
}

// ---------- moving between addresses ----------
function go(pane, url, { push = true } = {}) {
  const st = pane._pv;
  if (push && st.url && !same(st.url, url)) { st.hist.push(st.url); if (st.hist.length > HIST_MAX) st.hist.shift(); st.fwd = []; }
  st.url = url;
  st.err = '';
  remember(st.id, url);
  load(pane, url);
  pollSoon(pane);
  draw(pane);
}
// back or forward: the history lists were already moved
function step(pane, url) {
  const st = pane._pv;
  st.url = url;
  remember(st.id, url);
  load(pane, url);
  pollSoon(pane);
  draw(pane);
}
function pollSoon(pane) {
  const st = pane._pv;
  st.cur = null;
  if (!st.polling) poll(pane); else st.lastPoll = 0;
}
function load(pane, url) {
  const st = pane._pv;
  st.loadAt = Date.now();
  st.moved = false;
  st.el.frame.hidden = false;
  st.el.frame.src = url; // setting it again reloads, even when it is the same address
}
function unload(pane) {
  const f = pane._pv.el.frame;
  f.hidden = true;
  if (f.getAttribute('src')) f.src = 'about:blank';
}

// the desktop window reports where a preview frame went by itself (links, redirects, an app's own routing)
desk()?.onPreviewNav?.((url) => {
  if (!localUrl(url)) return;
  for (const pane of panes) {
    const st = pane._pv;
    if (!st || !st.url || st.el.frame.hidden || same(url, st.url)) continue;
    // the first move just after loading an address is its redirect: it replaces the address instead of adding a step
    const redirect = !st.moved && Date.now() - st.loadAt < REDIRECT_MS;
    st.moved = true;
    if (!redirect) { st.hist.push(st.url); if (st.hist.length > HIST_MAX) st.hist.shift(); st.fwd = []; }
    st.url = url;
    remember(st.id, url);
    draw(pane);
  }
});

// ---------- launch.json, and asking Claude ----------
async function post(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    return j || { ok: false, message: `the server answered ${r.status}` };
  } catch { return { ok: false, message: "Fleet View's server did not answer" }; }
}
async function start(pane, name) {
  const st = pane._pv, id = st.id;
  if (!name || st.busy) return;
  st.busy = name; st.err = '';
  draw(pane);
  const r = await post('/preview/start', { cwd: st.cwd, name });
  st.busy = '';
  if (st.id !== id) return;
  if (!r.ok) { st.err = r.message || 'could not start it'; draw(pane); return; }
  closeMenu(pane);
  if (!r.already) st.starting = { name, url: r.url || '', at: Date.now() };
  if (r.url && !same(r.url, st.url)) go(pane, r.url); else { pollSoon(pane); draw(pane); }
}
async function stop(pane, name) {
  const st = pane._pv, id = st.id;
  if (!name || st.busy) return;
  st.busy = name; st.err = '';
  draw(pane);
  const r = await post('/preview/stop', { cwd: st.cwd, name });
  st.busy = '';
  if (st.id !== id) return;
  if (!r.ok) st.err = r.message || 'could not stop it';
  if (st.starting && st.starting.name === name) st.starting = null;
  pollSoon(pane);
  draw(pane);
}
function ask(pane) {
  const st = pane._pv;
  if (st.id) handToChat(st.id, { text: ASK_TEXT, send: true });
}

// ---------- Screenshot to chat ----------
async function screenshot(pane) {
  const st = pane._pv, id = st.id, url = st.url;
  const f = st.el.frame;
  if (!canCapture() || !url || f.hidden || st.capturing) return;
  closeMenu(pane);
  const r = f.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return;
  st.capturing = true;
  draw(pane);
  let bytes = null;
  try { bytes = await desk().capture({ x: r.left, y: r.top, width: r.width, height: r.height }); } catch {}
  st.capturing = false;
  draw(pane);
  if (!bytes || !bytes.byteLength) { st.err = 'Could not take the screenshot.'; draw(pane); return; }
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: 'image/png' });
  handToChat(id, { images: [{ blob, name: 'preview.png' }], text: `Screenshot of the preview at ${url}:` });
}

// ---------- the list ----------
function openMenu(pane) {
  const st = pane._pv;
  st.menu = true;
  st.el.pick.setAttribute('aria-expanded', 'true');
  pollSoon(pane);
  draw(pane);
}
function closeMenu(pane) {
  const st = pane._pv;
  if (!st || !st.menu) return;
  st.menu = false;
  st.el.pick.setAttribute('aria-expanded', 'false');
  st.el.menu.hidden = true;
}
const dot = (up) => `<span class="pv-dot ${up ? 'up' : 'down'}" aria-hidden="true"></span>`;
function launchBtn(st, c) {
  const busy = st.busy === c.name;
  return c.running || (st.starting && st.starting.name === c.name)
    ? `<button type="button" class="pv-small" data-pv="stop" data-name="${esc(c.name)}"${busy ? ' disabled' : ''}>${icon('stop', 13)}<span>Stop</span></button>`
    : `<button type="button" class="pv-small go" data-pv="start" data-name="${esc(c.name)}"${busy || c.up ? ' disabled' : ''}${c.up ? ' title="Something already answers on its port"' : ''}>${icon('live', 13)}<span>Start</span></button>`;
}
function menuHtml(st) {
  const found = st.list.filter((x) => !x.launch && x.url);
  const launch = st.list.filter((x) => x.launch);
  const now = Date.now();
  let h = '';
  if (found.length) {
    h += '<div class="pv-mh">Found in this conversation</div>';
    for (const x of found) {
      const on = same(x.url, st.url);
      h += `<button type="button" class="pv-row${on ? ' on' : ''}" role="menuitem" data-pv="go" data-url="${esc(x.url)}">${dot(x.up)}`
        + `<span class="pv-rt mono">${esc(shortUrl(x.url))}</span><span class="pv-rs">${x.up ? 'answering' : 'not answering'}${x.at ? ` · ${esc(ago(now - x.at))} ago` : ''}</span></button>`;
    }
  }
  if (launch.length) {
    h += '<div class="pv-mh">.claude/launch.json</div>';
    for (const c of launch) {
      const row = `${dot(c.up)}<span class="pv-rt">${esc(c.name)}</span><span class="pv-rs mono">${esc(c.url ? shortUrl(c.url) : c.port ? `port ${c.port}` : 'no port given')}</span>`;
      h += `<div class="pv-lrow">${c.url ? `<button type="button" class="pv-row${same(c.url, st.url) ? ' on' : ''}" role="menuitem" data-pv="go" data-url="${esc(c.url)}">${row}</button>` : `<div class="pv-row static">${row}</div>`}${launchBtn(st, c)}</div>`;
    }
  }
  if (!found.length && !launch.length) {
    h += `<div class="pv-mempty">${st.loaded ? 'No dev server found in this conversation yet.' : 'Looking…'}</div>`;
  }
  if (!launch.length) h += `<button type="button" class="pv-row pv-ask" role="menuitem" data-pv="ask">${icon('ask', 14)}<span class="pv-rt">Ask Claude to start it</span></button>`;
  return h;
}

// ---------- drawing ----------
function setHtml(el, html) { if (el._html !== html) { el.innerHTML = html; el._html = html; } el.hidden = !html; }

function launchFor(st, url) {
  const p = portOf(url);
  return p ? st.list.find((x) => x.launch && x.url && portOf(x.url) === p) : null;
}
function noteHtml(st) {
  if (st.err) return `<span class="pv-err">${icon('error', 14)}<span>${esc(st.err)}</span></span><button type="button" class="pv-small" data-pv="dismiss" aria-label="Dismiss">${icon('close', 12)}</button>`;
  if (!st.url) return '';
  if (st.starting) {
    return `<span class="spin"></span><span>Starting <b>${esc(st.starting.name)}</b>… waiting for <span class="mono">${esc(shortUrl(st.starting.url || st.url))}</span></span>`
      + `<button type="button" class="pv-small" data-pv="stop" data-name="${esc(st.starting.name)}">${icon('stop', 13)}<span>Stop</span></button>`;
  }
  if (st.cur && st.cur.up === false) {
    const c = launchFor(st, st.url);
    let origin = st.url;
    try { origin = new URL(st.url).host; } catch {}
    return `<span>Nothing answers at <span class="mono">${esc(origin)}</span> right now.</span>`
      + (c && !c.running ? `<button type="button" class="pv-small go" data-pv="start" data-name="${esc(c.name)}"${st.busy ? ' disabled' : ''}>${icon('live', 13)}<span>Start ${esc(c.name)}</span></button>`
        : c ? '' : `<button type="button" class="pv-small" data-pv="ask">${icon('ask', 13)}<span>Ask Claude to start it</span></button>`);
  }
  if (!desk() && st.cur && st.cur.frame === false) {
    return `<span class="dim">This page doesn't allow being shown inside another page, so it stays blank here. The desktop window shows it.</span>`
      + `<button type="button" class="pv-small" data-pv="open">${icon('external', 13)}<span>Open in browser</span></button>`;
  }
  return '';
}
function cardHtml(st) {
  if (st.url) return '';
  const launch = st.list.filter((x) => x.launch);
  const down = st.list.filter((x) => !x.launch && x.url && !x.up);
  if (!st.loaded) return `<div class="s-card"><div class="s-ic">${icon('web', 20)}</div><div class="s-title">Looking for a dev server…</div></div>`;
  let h = `<div class="s-card"><div class="s-ic">${icon('web', 20)}</div><div class="s-title">No dev server running</div>`
    + '<div class="s-text">When this conversation starts a dev server, its page shows here by itself. You can also type an address above, like <span class="mono">localhost:3000</span>.</div>';
  if (down.length) {
    h += `<div class="s-text">Used before, not answering now: ${down.slice(0, 3).map((x) => `<button type="button" class="pv-link mono" data-pv="go" data-url="${esc(x.url)}">${esc(shortUrl(x.url))}</button>`).join(', ')}</div>`;
  }
  h += '<div class="s-actions">';
  if (launch.length) {
    for (const c of launch) {
      const going = st.busy === c.name;
      h += c.running || c.up
        ? `<button type="button" class="btn s-go" data-pv="go" data-url="${esc(c.url || '')}"${c.url ? '' : ' disabled'}>${icon('web', 15)}<span>Show ${esc(c.name)}</span></button>`
        : `<button type="button" class="btn primary s-go" data-pv="start" data-name="${esc(c.name)}"${going ? ' disabled' : ''}>${icon('live', 15)}<span>${going ? 'Starting' : 'Start'} ${esc(c.name)}</span></button>`;
    }
  } else {
    h += `<button type="button" class="btn primary s-go" data-pv="ask">${icon('ask', 15)}<span>Ask Claude to start it</span></button>`;
  }
  return `${h}</div></div>`;
}

function draw(pane) {
  const st = pane._pv, E = st.el;
  E.back.disabled = !st.hist.length;
  E.fwd.disabled = !st.fwd.length;
  E.reload.disabled = !st.url;
  E.open.disabled = !st.url;
  E.shot.hidden = !canCapture();
  E.shot.disabled = !st.url || st.capturing;
  if (document.activeElement !== E.input && E.input.value !== st.url) E.input.value = st.url;
  const state = !st.url ? '' : st.starting ? 'wait' : st.cur ? (st.cur.up ? 'up' : 'down') : '';
  if (E.dot.dataset.s !== state) { E.dot.dataset.s = state; E.dot.className = `pv-dot${state ? ` ${state}` : ''}`; }
  E.dot.title = state === 'up' ? 'answering' : state === 'down' ? 'not answering' : state === 'wait' ? 'starting' : '';
  setHtml(E.note, noteHtml(st));
  setHtml(E.card, cardHtml(st));
  E.frame.hidden = !st.url;
  if (st.menu) { setHtml(E.menu, menuHtml(st)); E.menu.hidden = false; } else E.menu.hidden = true;
}
