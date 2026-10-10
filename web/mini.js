// Fleet View mini view (mini.html): polls GET /state once a second. The main window goes into it (it hides while
// this shows) and comes back out of it: the expand button or Esc brings the main window back as it was, and a
// click on a row brings it back with that conversation picked (window.fleetDesktop.showMain, desktop/preload.js).
// Three short sections, each only when it has rows:
//   Needs you      a question, an API error, a stall: most urgent and longest waiting first, with what it asks
//   Working        every conversation at work, newest action first: its progress ring, repo and last action
//   Just finished  the last hour's finished ones, newest first (up to 3): how far it shipped, or its reply
// With nothing at all, a calm "Nothing going on" line. The window's height follows the rows: up to 8 show, more
// scroll (fleetDesktop.fitMini). Nothing pulses, blinks or brightens; names wrap, only the second line is cut.

const $ = (id) => document.getElementById(id);
const desk = window.fleetDesktop && window.fleetDesktop.isDesktop ? window.fleetDesktop : null;
const list = $('list'), bar = $('bar');

let icon = () => '';
import('./icons.js').then((m) => { if (typeof m.icon === 'function') { icon = m.icon; draw(); } }).catch(() => {});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (ms) => (ms < 60e3 ? `${Math.max(0, Math.round(ms / 1e3))}s` : ms < 3600e3 ? `${Math.round(ms / 60e3)}m` : `${(ms / 3600e3).toFixed(1)}h`);
const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const NEEDS = { ASKING: 0, QUESTION: 1, ERROR: 1, STALLED: 2 };
const COLOR = { WORKING: '#3fd8ff', AGENTS: '#a47bff', ASKING: '#ffc24a', QUESTION: '#ffc24a', STALLED: '#a07d39', ERROR: '#ff4d5e', DONE: '#3dffa8' };
const ICON = { ASKING: 'ask', QUESTION: 'ask', ERROR: 'error', STALLED: 'waiting' };
const HEX = /^#[0-9a-f]{3,8}$/i;
const colorOf = (s) => COLOR[s.state] || (typeof s.stateColor === 'string' && HEX.test(s.stateColor) ? s.stateColor : '#8a92b2');
const acct = (a) => (typeof a === 'string' && /^[A-Z]$/.test(a) && !(state && Array.isArray(state.accounts) && state.accounts.length === 1) ? `<span class="acct acct-${a}" title="Claude account ${a}">${a}</span>` : '');
const FINISHED_MS = 3600e3, FINISHED_MAX = 3;

let state = null, skew = 0, offline = false;
const now = () => Date.now() + skew;

// ---------- drawing ----------
function countsHtml() {
  if (offline && !state) return '<span class="cnt off">connecting…</span>';
  if (offline) return '<span class="cnt off">reconnecting…</span>';
  const c = (state && state.counts) || {};
  const live = c.live || 0, waiting = c.waiting || 0;
  return `<span class="cnt" title="${live} live conversation${live === 1 ? '' : 's'}"><b>${live}</b> live</span>`
    + `<span class="cnt${waiting ? ' wait' : ''}" title="${waiting} waiting on you"><b>${waiting}</b> waiting</span>`;
}

// the repo: a dot in its colour and its name
function repoBit(s) {
  const r = s.repo && typeof s.repo === 'object' ? s.repo : null;
  if (!r || !r.name) return '';
  const c = typeof r.color === 'string' && HEX.test(r.color) ? r.color : '#8a92b2';
  return `<span class="repo"><span class="rdot" style="background:${esc(c)}"></span>${esc(r.name)}</span>`;
}
// a ring that fills with the conversation's progress (its plan's or its ship's), a plain dot without one
function ring(s) {
  const col = esc(colorOf(s));
  const p = s.progress && Number.isFinite(s.progress.pct) ? Math.max(0, Math.min(1, s.progress.pct)) : null;
  if (p === null) return `<span class="st" style="color:${col}"><span class="dot"></span></span>`;
  const C = 2 * Math.PI * 7;
  const tip = `${Math.round(p * 100)}%${s.progress.phase ? ` · ${s.progress.phase}` : ''}`;
  return `<span class="st" style="color:${col}" title="${esc(tip)}"><svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">`
    + `<circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-opacity=".22" stroke-width="2"/>`
    + `<circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" transform="rotate(-90 9 9)" stroke-dasharray="${(p * C).toFixed(2)} ${C.toFixed(2)}"/>`
    + `<circle cx="9" cy="9" r="2.6" fill="currentColor"/></svg></span>`;
}
function stIcon(s) {
  const name = ICON[s.state];
  const svg = name ? icon(name, 15) : '';
  return `<span class="st" style="color:${esc(colorOf(s))}">${svg || '<span class="dot"></span>'}</span>`;
}
function head(s, t, what) {
  const age = t ? `<span class="age" title="${esc(what)} ${esc(ago(now() - t))} ago">${esc(ago(now() - t))}</span>` : '';
  return `<span class="l1"><span class="name">${esc(s.name)}</span>${acct(s.account)}${age}</span>`;
}

// what a waiting row says on its second line
function waitText(s) {
  if (s.waitingOn) return oneLine(s.waitingOn);
  if (s.state === 'ERROR') return 'API error: retry in the conversation';
  if (s.state === 'STALLED') return 'quiet for a while mid-turn, maybe a permission prompt';
  return s.label || s.state;
}
function waitingRow(s) {
  const text = waitText(s);
  return `${stIcon(s)}<span class="body">${head(s, s.endedAt || s.last || now(), 'waiting since')}`
    + `<span class="l2" title="${esc(text)}">${repoBit(s)}${esc(text)}</span></span>`;
}
function workingRow(s) {
  const a = s.lastAction && typeof s.lastAction === 'object' ? s.lastAction : null;
  const who = a && a.who && a.who !== 'main' ? `<span class="who">${esc(a.who)}</span> ` : '';
  const line = a ? `${who}<span class="verb">${esc(a.verb || '')}</span> ${esc(a.what || '')}` : esc(s.goal || s.label || '');
  const plain = a ? `${a.who && a.who !== 'main' ? a.who + ' ' : ''}${a.verb || ''} ${a.what || ''}`.trim() : String(s.goal || '');
  const run = Array.isArray(s.agents) ? s.agents.filter((x) => x && x.state === 'run').length : 0;
  const agents = run ? `<span class="tag" title="${run} agent${run === 1 ? '' : 's'} running">${run} agent${run === 1 ? '' : 's'}</span>` : '';
  return `${ring(s)}<span class="body">${head(s, (a && a.t) || s.last, 'last action')}`
    + `<span class="l2" title="${esc(plain)}">${repoBit(s)}${agents}${line}</span></span>`;
}
// how far a finished one shipped: its furthest step that went through, else the start of its last reply
function shipText(s) {
  const steps = s.ship && Array.isArray(s.ship.steps) ? s.ship.steps : [];
  const done = steps.filter((x) => Array.isArray(x) && x[1] === 'ok').map((x) => x[0]);
  const pr = s.ship && s.ship.pr ? ` #${s.ship.pr}` : '';
  if (done.includes('live')) return `merged${pr} · live`;
  if (done.includes('merged')) return `merged${pr}`;
  if (done.includes('PR')) return `PR${pr} open`;
  return oneLine(s.lastReply).slice(0, 200) || 'finished';
}
function finishedRow(s) {
  const text = shipText(s);
  return `<span class="st" style="color:${COLOR.DONE}">${icon('checks', 14) || '<span class="dot"></span>'}</span><span class="body">${head(s, s.endedAt || s.last, 'finished')}`
    + `<span class="l2" title="${esc(text)}">${repoBit(s)}${esc(text)}</span></span>`;
}

// keyed rows: a row keeps its element (and its hover and focus) while its content changes
const rowEls = new Map();
function rowEl(id) {
  let el = rowEls.get(id);
  if (!el) {
    el = document.createElement('button');
    el.type = 'button';
    el.className = 'row';
    el.dataset.id = id;
    rowEls.set(id, el);
  }
  return el;
}
function setRows(items) {
  // items: [{ id, tip, html }] rows, or [{ key, cls, html }] for the calm line and the section heads
  const keep = new Set();
  const els = items.map((it) => {
    let el;
    if (it.id) { el = rowEl(it.id); el.title = it.tip || ''; } else {
      el = rowEls.get(it.key);
      if (!el) { el = document.createElement('div'); rowEls.set(it.key, el); }
      el.className = it.cls;
    }
    keep.add(it.id || it.key);
    if (el._html !== it.html) { el.innerHTML = it.html; el._html = it.html; }
    return el;
  });
  for (const [k, el] of rowEls) if (!keep.has(k)) { el.remove(); rowEls.delete(k); }
  els.forEach((el, i) => { if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null); });
}

function draw() {
  const counts = $('counts');
  const ch = countsHtml();
  if (counts._html !== ch) { counts.innerHTML = ch; counts._html = ch; }
  drawClock();
  if (!state) { setRows([{ key: '_note', cls: 'note', html: offline ? 'Waiting for Fleet View…' : 'Loading…' }]); fit(); return; }
  const sessions = (Array.isArray(state.sessions) ? state.sessions : []).filter((s) => s && s.id);
  const t = now();
  const waiting = sessions.filter((s) => s.state in NEEDS)
    .sort((a, b) => NEEDS[a.state] - NEEDS[b.state] || (a.endedAt || a.last || 0) - (b.endedAt || b.last || 0));
  const working = sessions.filter((s) => s.state === 'WORKING' || s.state === 'AGENTS')
    .sort((a, b) => ((b.lastAction && b.lastAction.t) || b.last || 0) - ((a.lastAction && a.lastAction.t) || a.last || 0));
  const finished = sessions.filter((s) => s.state === 'DONE' && t - (s.endedAt || s.last || 0) < FINISHED_MS)
    .sort((a, b) => (b.endedAt || b.last || 0) - (a.endedAt || a.last || 0)).slice(0, FINISHED_MAX);
  const tip = (s) => `${s.name}: ${s.label || s.state}. Click to open it in Fleet View`;
  const items = [];
  const section = (key, title, rows, rowHtml) => {
    if (!rows.length) return;
    items.push({ key, cls: 'sub', html: `${esc(title)}<span class="n">${rows.length}</span>` });
    for (const s of rows) items.push({ id: s.id, tip: tip(s), html: rowHtml(s) });
  };
  section('_needs', 'Needs you', waiting, waitingRow);
  section('_work', 'Working', working, workingRow);
  section('_done', 'Just finished', finished, finishedRow);
  if (!waiting.length) items.unshift({ key: '_calm', cls: 'calm', html: `<span class="ic">${icon('checks', 15)}</span><span>${working.length ? 'Nothing needs you' : 'Nothing going on'}</span>` });
  setRows(items);
  fit();
}

function drawClock() {
  const t = new Date(now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const el = $('clock');
  if (el.textContent !== t) el.textContent = t;
}

// ---------- the window's height follows the rows: up to 8, then the list scrolls ----------
const MAX_ROWS = 8;
let lastFit = 0;
function fit() {
  if (!desk || typeof desk.fitMini !== 'function') return;
  const kids = [...list.children];
  if (!kids.length) return;
  let seen = 0, cut = kids[kids.length - 1];
  for (const el of kids) { if (el.classList.contains('row') && ++seen === MAX_ROWS) { cut = el; break; } }
  const top = list.getBoundingClientRect().top;
  const pad = parseFloat(getComputedStyle(list).paddingBottom) || 0;
  const listH = cut.getBoundingClientRect().bottom - top + list.scrollTop + pad;
  const want = Math.ceil(bar.getBoundingClientRect().height + listH);
  if (Math.abs(want - lastFit) < 1) return;
  lastFit = want;
  desk.fitMini(want);
}
window.addEventListener('resize', () => { lastFit = 0; fit(); });

// ---------- clicks ----------
list.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row || !row.dataset.id) return;
  if (desk) desk.showMain(row.dataset.id);
  else location.href = `/?select=${encodeURIComponent(row.dataset.id)}`; // a browser tab: the main view, that one picked
});
$('b-main').addEventListener('click', () => { if (desk) desk.showMain(null); else location.href = '/'; });

// ---------- polling ----------
let busy = false;
async function poll() {
  if (busy) return;
  busy = true;
  try {
    const r = await fetch('/state', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    if (Number.isFinite(j.now)) skew = j.now - Date.now();
    state = j;
    offline = false;
  } catch {
    offline = true;
  } finally {
    busy = false;
    draw();
  }
}
setInterval(poll, 1000);
setInterval(drawClock, 1000);
draw();
poll();
