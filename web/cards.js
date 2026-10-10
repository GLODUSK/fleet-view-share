// Cards view, plus the small pieces the Wall view and the detail panel share (state label, ship track,
// plan steps, gauges, links). Cards are built once per session and then patched slot by slot, so the busy
// ring keeps turning smoothly and nothing redraws (or flickers) when its content did not change.
// Styles live in views.css. Motion: when the order changes, cards glide to their new place (FLIP); new
// cards fade and rise in once; cards that leave fade out. Nothing pulses, blinks or brightens.
import { icon, verbIcon } from './icons.js';

export const C = {
  bg: '#0a0c13', panel: '#11141e', line: '#262c42', text: '#eef0fa', dim: '#8a92b2', faint: '#4c5372',
  ember: '#ff6a2b', gold: '#ffc24a', rose: '#ff4d8d', violet: '#a47bff', cyan: '#3fd8ff', mint: '#3dffa8', red: '#ff4d5e',
  agent: '#71a9ff', acctA: '#3fb950', acctB: '#d97757', acctC: '#58a6ff',
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const isBusy = (st) => st === 'WORKING' || st === 'AGENTS';
export const needsYou = (st) => st === 'ASKING' || st === 'QUESTION' || st === 'ERROR' || st === 'STALLED';
export const ago = (ms) => (ms < 60e3 ? `${Math.max(0, Math.round(ms / 1e3))}s` : ms < 3600e3 ? `${Math.round(ms / 60e3)}m` : `${(ms / 3600e3).toFixed(1)}h`);
export const fmtTok = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n || 0}`);
export const fmtCost = (c) => '$' + (c >= 100 ? Math.round(c).toLocaleString('en-US') : (c || 0).toFixed(2));
export const lastParts = (rel, n = 2) => String(rel || '').split('/').filter(Boolean).slice(-n).join('/');
export const clockTime = (t, secs = true) => new Date(t).toLocaleTimeString([], secs ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

// ---------- links ----------
// The shell (app.js) catches clicks on [data-act] before a card or tile sees them, so clicking a link
// opens it without picking the card under it.
export const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
// a web link (PR, branch, deploy); plain text when there is no https URL
export function urlLink(url, html, title = '', cls = '') {
  if (!isHttps(url)) return html;
  return `<a class="lnk${cls ? ' ' + cls : ''}" data-act="url" data-url="${esc(url)}" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title || url)}">${html}</a>`;
}
// a file (VS Code) or a folder (Explorer) on this machine; plain text when the path is unknown
export function revealLink(kind, p, html, title = '', cls = '') {
  if (!p) return html;
  const tip = title || `${kind === 'file' ? 'open in VS Code' : 'open in Explorer'}: ${p}`;
  return `<a class="lnk${cls ? ' ' + cls : ''}" data-act="reveal" data-kind="${kind}" data-path="${esc(p)}" href="#" title="${esc(tip)}">${html}</a>`;
}
// a session's links; the PR URL is built from the ship track when the server left it out
export function linksOf(s) {
  const l = s?.links || {};
  const shipPr = s?.ship?.pr && /^[\w.-]+\/[\w.-]+$/.test(s.ship.repo || '') ? `https://github.com/${s.ship.repo}/pull/${s.ship.pr}` : null;
  return {
    pr: isHttps(l.pr) ? l.pr : shipPr,
    branch: isHttps(l.branch) ? l.branch : null,
    deploy: isHttps(l.deploy) ? l.deploy : null,
    repoFolder: l.repoFolder || s?.repo?.root || null,
  };
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16) || 0);
const toHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
export const mixHex = (a, b, t) => { const x = hex(a), y = hex(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
export function gradHex(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const s = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(s));
  return mixHex(stops[i], stops[i + 1], s - i);
}

// write HTML into an element only when it changed
export function setHTML(el, html) {
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}

// ---------- status ----------
// one colour per state, used for the strip down a card's left edge, its label and its icon
const STATUS = {
  WORKING: C.cyan, AGENTS: C.violet, ASKING: C.gold, QUESTION: C.gold,
  STALLED: mixHex(C.gold, '#121520', 0.4), ERROR: C.red, DONE: C.faint,
};
export const statusColor = (s) => STATUS[s?.state] || s?.stateColor || C.dim;
const STATUS_ICON = { ASKING: 'ask', QUESTION: 'ask', ERROR: 'error', STALLED: 'waiting', DONE: 'checks', HANDOFF: 'open' };

// ---------- small pieces ----------
// a thin ring that turns (rotation only, steady colour); every ring shares one phase so they move together
export const spinner = (color) => `<span class="spin" style="--spin:${esc(color)};animation-delay:-${Date.now() % 1100}ms"></span>`;
export const statusIcon = (s) => (isBusy(s.state)
  ? spinner(statusColor(s))
  : `<span class="st-ic" style="color:${esc(statusColor(s))}">${icon(STATUS_ICON[s.state] || 'dot', 15)}</span>`);
// the icon is rebuilt only when what it shows changes, so a turning ring is never restarted
export function setIcon(el, s) {
  const key = `${isBusy(s.state)}|${s.state}|${statusColor(s)}`;
  if (el._key !== key) { el.innerHTML = statusIcon(s); el._key = key; }
}
// the state as a small text label (the coloured strip carries it visually; the label keeps it readable)
export const badge = (s) => `<span class="state" style="color:${esc(statusColor(s))}">${esc(s.label || s.state)}</span>`;
export const stateLabel = badge;
// a conversation that runs live in Fleet View's own window (its Session tab)
export const hereTag = () => `<span class="here-tag" title="running here, in Fleet View" aria-label="running here, in Fleet View">${icon('shell', 12)}<span>here</span></span>`;
// "★ leads" in its team's colour, for the lead of a team (state.teams[].lead): the others report to it
export function leadTag(s, state) {
  const t = (state && Array.isArray(state.teams) ? state.teams : []).find((x) => x && x.lead === s.id && (x.members || []).includes(s.id));
  if (!t) return '';
  const n = t.members.length - 1, tip = `leads team "${t.name}": ${n === 1 ? 'the other one reports' : `${n} report`} to it`;
  const col = /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : C.violet;
  return `<span class="lead-tag" style="--tc:${col}" title="${esc(tip)}" aria-label="${esc(tip)}">★<span>leads</span></span>`;
}
// with one Claude account on this machine (state.accounts), no conversation shows a letter
let oneAccount = false;
export const setAccounts = (list) => { oneAccount = Array.isArray(list) && list.length === 1; };
export const singleAccount = () => oneAccount;
// each Claude account's colour, the same as its Windows Terminal tab (A green, B orange, C blue, then D, E, F); grey past F
const ACCT_COLORS = { A: C.acctA, B: C.acctB, C: C.acctC, D: '#bc8cff', E: '#e3b341', F: '#f778ba' };
export const acctColor = (a) => ACCT_COLORS[a] || C.dim;
// an account letter: one capital letter (A, B, C, ...)
export const isAcct = (a) => typeof a === 'string' && /^[A-Z]$/.test(a);
export const acctTag = (a) => (isAcct(a) && !oneAccount ? `<span class="acct acct-${a}" style="background:${acctColor(a)}" title="Claude account ${a}">${a}</span>` : '');
export const ctxColor = (f) => (f > 0.9 ? C.red : f >= 0.7 ? C.gold : C.mint);

// withHandoff: also the quiet "182k / 200k" against the size the session hands off at (ctx.handoff, handoff.js)
export function ctxGauge(ctx, withHandoff = false) {
  if (!ctx || !ctx.limit) return '';
  const f = Math.max(0, Math.min(1, ctx.used / ctx.limit));
  const col = ctxColor(f);
  const ho = withHandoff && ctx.handoff > 0
    ? `<span class="ctx-n" title="it hands off to a fresh conversation at ${fmtTok(ctx.handoff)} tokens of context">${fmtTok(ctx.used)} / ${fmtTok(ctx.handoff)}</span>` : '';
  return `<span class="ctx" title="context ${fmtTok(ctx.used)} of ${fmtTok(ctx.limit)} tokens"><span class="ctx-k">ctx</span><span class="ctx-bar"><span style="width:${(f * 100).toFixed(1)}%;background:${col}"></span></span><span class="ctx-v" style="color:${col}">${Math.round(f * 100)}%</span>${ho}</span>`;
}

// ---------- handoffs ----------
// A link that shows another conversation (the shell's data-act="session": picks it, or opens its panel when it
// has finished). The name wraps inside its chip, never cut; the full id is in the tooltip.
export const sessionLink = (id, name, cls = '') => `<a class="lnk${cls ? ' ' + cls : ''}" data-act="session" data-id="${esc(id)}" href="#" title="show ${name ? `${esc(name)} (${esc(id)})` : esc(id)}">${esc(name || String(id).slice(0, 8))}</a>`;
// "Chat" / "Summary": a picked-up conversation's previous one, under its chat in the panel (the shell's
// data-act="peek", detail.js openPeek): that chat read only, or the handoff summary
const peekLink = (forId, kind, label, title) => `<a class="lnk ho-x" data-act="peek" data-for="${esc(forId)}" data-kind="${kind}" href="#" title="${esc(title)}">${label}</a>`;
// "handed off → <next>" / "picked up from <old> · Chat · Summary" (the server's s.handoff / s.pickedUpFrom); [] when neither
export function handoffBits(s) {
  const out = [];
  const h = s?.handoff, p = s?.pickedUpFrom;
  if (h) out.push(h.next ? ['handed off →', sessionLink(h.next, h.nextName, 'ho-n')] : ['handed off', '<span class="ho-n dim">waiting for its pickup</span>']);
  if (p && p.id) out.push(['picked up from', `${sessionLink(p.id, p.name, 'ho-n')} ${peekLink(s.id, 'chat', 'Chat', 'read its chat under this one (read only)')}${p.file ? ` ${peekLink(s.id, 'summary', 'Summary', `read the handoff summary under this chat: ${p.file}`)}` : ''}`]);
  return out;
}

export function sparkSvg(values, hue, w = 84, h = 16) {
  const v = Array.isArray(values) ? values.slice(-20) : [];
  if (!v.length) return '';
  const max = Math.max(4, ...v), bw = w / v.length;
  let bars = '';
  v.forEach((x, i) => {
    const bh = x > 0 ? Math.max(1.5, (x / max) * h) : 1;
    const col = x > 0 ? mixHex('#2a3048', hue || C.cyan, 0.3 + 0.7 * (i / v.length)) : '#262c42';
    bars += `<rect x="${(i * bw + 0.5).toFixed(2)}" y="${(h - bh).toFixed(2)}" width="${(bw - 1.4).toFixed(2)}" height="${bh.toFixed(2)}" rx="1" fill="${col}"/>`;
  });
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="tool calls per minute, last 20 minutes"><title>tool calls per minute, last 20 minutes</title>${bars}</svg>`;
}

// tokens and cost: "18.4M tok  $41.27"
export function usage(s) {
  if (!s.tokens && !s.usagePending) return '';
  return `<span class="usage"><span class="tok" title="tokens, this conversation and its agents">${icon('tokens', 12)}${fmtTok(s.tokens)}</span>`
    + `<span class="cost" title="what it would cost at API prices">${icon('cost', 12)}${fmtCost(s.cost)}${s.usagePending ? '…' : ''}</span></span>`;
}

// the ship track: push, PR, checks, merged, live, with an icon each and a line between them
const SHIP_ICON = { push: 'push', PR: 'pr', checks: 'checks', merged: 'merge', live: 'live' };
const STEP_CLASS = { ok: 'ok', pending: 'cur', fail: 'fail', na: 'na', none: 'off' };
// with links (from linksOf), PR and checks open the PR on GitHub and a done live step opens the deploy
export function shipTrack(ship, tight = false, links = null) {
  const steps = ship?.steps || [];
  if (!steps.length) return '';
  return `<span class="track ship${tight ? ' tight' : ''}">` + steps.map(([label, st], i) => {
    const cls = STEP_CLASS[st] || 'off';
    const ic = st === 'fail' ? icon('error', 13) : icon(SHIP_ICON[label] || 'dot', 13);
    const join = i ? `<span class="join${st === 'ok' ? ' ok' : ''}" aria-hidden="true"></span>` : '';
    let text = `<span class="lbl">${esc(label)}</span>`;
    if (links && st !== 'none' && st !== 'na') {
      if (label === 'PR' && links.pr) text = urlLink(links.pr, text, `open PR #${ship.pr} on GitHub`);
      else if (label === 'checks' && links.pr) text = urlLink(`${links.pr}/checks`, text, `open the checks of PR #${ship.pr} on GitHub`);
      else if (label === 'live' && st === 'ok' && links.deploy) text = urlLink(links.deploy, text, `open the deploy: ${links.deploy}`);
    }
    const word = { ok: 'done', pending: 'in progress', fail: 'failed', na: 'not used', none: 'not yet' }[st] || '';
    return `${join}<span class="step ${cls}" title="${esc(label)}: ${word}">${ic}${text}</span>`;
  }).join('') + '</span>';
}

// the plan's phases: done ones ticked, the current one ringed, later ones hollow
export function planSteps(steps, tight = false) {
  if (!steps || !steps.length) return '';
  return `<span class="track plan${tight ? ' tight' : ''}">` + steps.map((p, i) => {
    const cls = p.state === 'past' ? 'ok' : p.state === 'current' ? 'cur' : 'off';
    const mark = `<span class="pmark" aria-hidden="true">${p.state === 'past' ? icon('checks', 13) : ''}</span>`;
    const join = i ? `<span class="join${p.state === 'past' ? ' ok' : ''}" aria-hidden="true"></span>` : '';
    return `${join}<span class="step ${cls}">${mark}<span class="lbl">${esc(p.name)}</span></span>`;
  }).join('') + '</span>';
}

export function prTag(s) {
  const pr = s.ship?.pr;
  if (!pr) return '';
  return urlLink(linksOf(s).pr, `<span class="pr${s.ship.fresh ? ' dim' : ''}">${icon('pr', 13)}${s.ship.fresh ? 'last ' : ''}#${pr}</span>`, `open PR #${pr} on GitHub`);
}

// the track: plan or ship progress, gradient ember -> gold -> mint, mint once done
export function progressBar(s) {
  const p = s.progress || { mode: 'ship', pct: 0, done: false };
  const pct = Math.max(0, Math.min(1, Number(p.pct) || 0));
  return `<span class="bar${p.done ? ' done' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}"><span class="bar-rest" style="width:${((1 - pct) * 100).toFixed(2)}%"></span></span>`;
}
export const pctText = (s) => `${Math.round(Math.max(0, Math.min(1, Number(s.progress?.pct) || 0)) * 100)}%`;

// one small dot per agent: filled mint when done, violet ring while running, red when it failed
export function agentDots(s, max = 14) {
  const list = (s.agents || []).slice(-max);
  return list.map((a) => {
    const st = a.state === 'done' ? 'done' : a.state === 'fail' ? 'fail' : 'run';
    const word = st === 'done' ? 'done' : st === 'fail' ? 'failed' : 'running';
    return `<i class="ad ad-${st}" title="${esc(a.label)} ${word}"></i>`;
  }).join('');
}
export const runningAgents = (s) => (s.agents || []).filter((a) => a.state === 'run').map((a) => a.label);
export const runningList = (labels) => labels.map((l) => `<span class="ag">${icon('agent', 12)}${esc(l)}</span>`).join('');

export function lastAction(s) {
  const a = s.lastAction;
  if (!a) return `<span class="act-ic">${icon('clock', 14)}</span><span class="act-verb dim">quiet</span>`;
  // the newest call carries the file the last action touched, when it was one
  const c = (s.calls || [])[0];
  const file = c && c.file && c.verb === a.verb && c.what === a.what ? c.file : null;
  // a tool of the main loop still running (the fleet-view-feed mod says so): how long it has been at it
  const run = (s.running || []).find((r) => !r.agent);
  return `<span class="act-ic">${verbIcon(a.verb, 14)}</span>${a.who && a.who !== 'main' ? `<span class="who">${esc(a.who)}</span>` : ''}`
    + `<span class="verb">${esc(a.verb)}</span>${revealLink('file', file, `<span class="what">${esc(a.what)}</span>`)}`
    + (run ? `<span class="dim" title="${esc(run.tool)} running since ${new Date(run.at).toLocaleTimeString()}"> · ${ago(Date.now() - run.at)}</span>` : '');
}

// "working 14m" while a turn runs, "waiting 3m" while it waits on you
export function turnText(s, now) {
  if (isBusy(s.state) && s.turnStart) return `working ${ago(now - s.turnStart)}`;
  if (needsYou(s.state)) return `waiting ${ago(now - s.last)}`;
  return '';
}

// what a session that needs you is waiting on: its question, its error or its last words
export function waitNote(s, text = s.waitingOn) {
  if (!needsYou(s.state) || !text) return '';
  const k = s.state === 'ERROR' ? 'error' : s.state === 'STALLED' ? 'last said' : 'asks';
  const ic = s.state === 'ERROR' ? 'error' : s.state === 'STALLED' ? 'waiting' : 'ask';
  return `<span class="w-ic">${icon(ic, 15)}</span><span class="w-body"><span class="k">${k}</span><span class="v">${esc(text)}</span></span>`;
}

// "also editing brain.ts with texting-compliance…": every clash this session is part of
export function clashNotes(s, state) {
  const names = new Map((state.allSessions || state.sessions || []).map((x) => [x.id, x.name]));
  const out = [];
  for (const c of state.allClashes || state.clashes || []) {
    const me = c.sessions.find((x) => x.id === s.id);
    if (!me) continue;
    const others = c.sessions.filter((x) => x.id !== s.id).map((x) => names.get(x.id) || x.id.slice(0, 8));
    if (!others.length) continue;
    const verb = me.wrote ? 'also editing' : 'also reading';
    const abs = (s.files || []).find((f) => f.key === c.key)?.abs || null;
    out.push(`<div class="clash ${c.writers >= 2 ? 'clash-red' : 'clash-amber'}" title="${esc(c.rel)}">${icon('alert', 14)}<span>${verb} ${revealLink('file', abs, `<b class="mono">${esc(lastParts(c.rel))}</b>`)} with ${others.map((n) => `<b>${esc(n)}</b>`).join(', ')}</span></div>`);
  }
  return out.join('');
}

// the repo chip opens the repo folder in Explorer
export function repoChip(s) {
  if (!s.repo) return '';
  const inner = `<span class="dot" style="background:${esc(s.repo.color)}"></span>${esc(s.repo.name)}`;
  const folder = linksOf(s).repoFolder;
  return folder ? revealLink('folder', folder, inner, `open ${folder} in Explorer`, 'chip') : `<span class="chip" title="${esc(s.repo.root)}">${inner}</span>`;
}
// the branch name opens the branch on GitHub
export function branchChip(s) {
  if (!s.branch && !s.worktree) return '';
  const wt = s.worktree && s.worktree !== s.branch && !String(s.branch || '').endsWith('/' + s.worktree) ? ` <span class="faint">· ${esc(s.worktree)}</span>` : '';
  const url = s.branch ? linksOf(s).branch : null;
  const name = url ? urlLink(url, esc(s.branch), `open branch ${s.branch} on GitHub`) : esc(s.branch || s.worktree);
  return `<span class="chip mono" title="branch${s.worktree ? ' (worktree ' + esc(s.worktree) + ')' : ''}">${icon('branch', 12)}${name}${wt}</span>`;
}
export const modelName = (m) => String(m || '').replace(/^claude-/, '');
export const modelChip = (s) => (s.model ? `<span class="chip mono model">${icon('model', 12)}${esc(modelName(s.model))}</span>` : '');

// the quiet line under a card: branch, worktree, model, tokens and cost (all also in the detail panel)
export function metaLine(s) {
  const bits = [];
  if (s.branch) {
    const url = linksOf(s).branch;
    bits.push(`<span class="m" title="branch">${icon('branch', 12)}<span class="mono">${url ? urlLink(url, esc(s.branch), `open branch ${s.branch} on GitHub`) : esc(s.branch)}</span></span>`);
  }
  if (s.worktree && s.worktree !== s.branch && !String(s.branch || '').endsWith('/' + s.worktree)) bits.push(`<span class="m" title="worktree">${icon('worktree', 12)}<span class="mono">${esc(s.worktree)}</span></span>`);
  if (s.model) bits.push(`<span class="m" title="model">${icon('model', 12)}<span class="mono">${esc(modelName(s.model))}</span></span>`);
  for (const [k, v] of handoffBits(s)) bits.push(`<span class="m ho">${icon('open', 12)}<span class="ho-k">${k}</span>${v}</span>`);
  if (s.tokens || s.usagePending) {
    bits.push(`<span class="m" title="tokens, this conversation and its agents">${icon('tokens', 12)}<span class="num">${fmtTok(s.tokens)}</span></span>`);
    bits.push(`<span class="m" title="what it would cost at API prices">${icon('cost', 12)}<span class="num">${fmtCost(s.cost)}${s.usagePending ? '…' : ''}</span></span>`);
  }
  return bits.join('');
}

// ---------- motion: glide to a new place, fade in, fade out ----------
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const GLIDE = 'transform 280ms var(--ease, cubic-bezier(.2,.8,.2,1))';

// Puts the items of `store` (Map id -> element) into `grid` in the order of `ids`. When the order or the
// set of items changed, items that stay glide from where they were (FLIP), new ones fade and rise in once,
// and ones that left fade out where they were. `fill(id)` patches an item's content; it runs between the
// two measurements, so a change in height that moves the others glides too. `make(id)` builds a new one.
// `pairs` (old id -> new id, state.handoffPairs): a conversation that handed off dissolves into its pickup,
// which comes in on the same spot, instead of the plain fade out and rise in.
export function syncGrid(grid, store, ids, make, fill, pairs = null) {
  const pickups = new Set(pairs ? pairs.values() : []);
  const order = ids.join('\n');
  const changed = grid._order !== undefined && grid._order !== order;
  const visible = grid.offsetParent !== null && grid.getBoundingClientRect().width > 0;
  // only changes seen on screen move: coming back to a view (its order changed while another view was
  // shown) puts everything in its place at once instead of shuffling the whole grid
  const wasVisible = !!grid._visible;
  grid._visible = visible;
  const animate = changed && visible && wasVisible && !reduced();
  const first = new Map();
  const keep = new Set(ids);
  const leaving = [];
  if (animate) {
    for (const [id, el] of store) first.set(id, el.getBoundingClientRect());
    for (const [id, el] of store) if (!keep.has(id)) leaving.push([el, el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight]);
    // stop glides still under way; their start is where they are now (measured above)
    for (const el of store.values()) { el.style.transition = 'none'; el.style.transform = ''; }
  }
  let prev = null;
  for (const id of ids) {
    let el = store.get(id);
    if (!el) {
      el = make(id);
      store.set(id, el);
      // a new item fades and rises in, once: on the page's first draw, or while its view is on screen
      if (visible && (grid._order === undefined || wasVisible)) {
        if (!reduced()) {
          const cls = pickups.has(id) ? 'is-picking' : 'is-entering';
          el.classList.add(cls);
          const end = (e) => { if (!e || e.target === el) el.classList.remove(cls); };
          el.addEventListener('animationend', end);
          setTimeout(end, 1600); // in case the animation never ran (a hidden view)
        }
      }
    }
    fill(id, el);
    const want = prev ? prev.nextSibling : grid.firstChild;
    if (want !== el) grid.insertBefore(el, want);
    prev = el;
  }
  for (const [id, el] of [...store]) {
    if (keep.has(id)) continue;
    store.delete(id);
    const ghost = leaving.find((x) => x[0] === el);
    if (!ghost) { el.remove(); continue; }
    // out of the flow, where it was, fading out while the others close the gap
    const [, x, y, w, h] = ghost;
    Object.assign(el.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, margin: '0', pointerEvents: 'none', transition: '', transform: '' });
    el.classList.remove('is-entering', 'is-picking');
    el.removeAttribute('data-id');
    grid.appendChild(el);
    // handed off: a light sweeps across it and it dissolves into its pickup, which rises on the same spot
    if (pairs && pairs.has(id) && ids.includes(pairs.get(id))) {
      el.classList.add('is-handing');
      setTimeout(() => el.remove(), 900);
      continue;
    }
    // a moved element starts with no style to transition from: settle it at full opacity, then fade
    void getComputedStyle(el).opacity;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 340);
  }
  grid._order = order;
  if (!animate) return;
  const moved = [];
  for (const [id, el] of store) {
    const a = first.get(id);
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) { el.style.transition = ''; continue; }
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    moved.push(el);
  }
  if (!moved.length) return;
  void grid.offsetWidth; // commit the inverted positions before letting them go
  for (const el of moved) {
    el.style.transition = GLIDE;
    el.style.transform = '';
    const token = (el._glide = {});
    const done = () => {
      el.removeEventListener('transitionend', onEnd);
      if (el._glide === token) el.style.transition = '';
    };
    const onEnd = (e) => { if (e.target === el && e.propertyName === 'transform') done(); };
    el.addEventListener('transitionend', onEnd);
    setTimeout(done, 600); // a glide that never ran (a hidden view) still lets go of its transition
  }
}

// ---------- the Cards view ----------
const SLOTS = ['icon', 'title', 'right', 'goal', 'wait', 'action', 'bar', 'steps', 'chips', 'meta', 'clash'];

function buildCard(id, ui) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = id;
  el.innerHTML = `<div class="c-head"><span data-slot="icon" class="c-icon"></span><div data-slot="title" class="c-title"></div><div data-slot="right" class="c-right"></div></div>
<div data-slot="goal" class="c-goal"></div><div data-slot="wait" class="c-wait"></div><div data-slot="action" class="c-action"></div>
<div data-slot="bar" class="c-bar"></div><div data-slot="steps" class="c-steps"></div><div data-slot="chips" class="c-chips"></div>
<div data-slot="meta" class="c-meta"></div><div data-slot="clash" class="c-clash"></div>`;
  el._slots = {};
  for (const k of SLOTS) el._slots[k] = el.querySelector(`[data-slot="${k}"]`);
  wirePick(el, id, ui);
  return el;
}

// Click picks (and opens the detail panel), double-click opens. The second click of a double-click belongs
// to the card or tile the first one hit: opening the panel narrows the view, so another one can be under
// the pointer by then. Used by the Wall too. Ctrl+click (Cmd+click) adds the card to the multi-selection or takes
// it out (ui.toggleMulti; the shell outlines selected cards and tiles with .multi); a plain click picks one card
// and clears the multi-selection.
let lastPick = null; // { id, t }
export function wirePick(el, id, ui) {
  el.addEventListener('click', (e) => {
    if ((e.ctrlKey || e.metaKey) && typeof ui.toggleMulti === 'function') { e.preventDefault(); ui.toggleMulti(id); return; }
    if (ui.multi?.length && typeof ui.clearMulti === 'function') ui.clearMulti();
    const now = performance.now();
    if (e.detail >= 2 && lastPick && lastPick.id !== id && now - lastPick.t < 700) return;
    lastPick = { id, t: now };
    ui.setSelected(id);
  });
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    ui.open(lastPick && performance.now() - lastPick.t < 700 ? lastPick.id : id);
  });
}
// a text that changes every second (a timer) is written into its own element, so the slot around it (and
// any link in it) is not rewritten every second under the pointer
export function setText(slot, sel, text) {
  const t = slot.querySelector(sel);
  if (t && t.textContent !== text) t.textContent = text;
}

function fillCard(el, s, state, ui, now) {
  const sl = el._slots;
  const compact = !!ui.compact;
  const needs = needsYou(s.state);
  el.classList.toggle('picked', ui.selectedId === s.id);
  el.classList.toggle('needs', needs);
  el.classList.toggle('continued', !!s.continued); // a removed conversation just continued: dim until it works
  el.classList.toggle('handing', !!s.handing); // handing off to a fresh conversation: a slow light runs across it
  el.style.setProperty('--status', statusColor(s));
  el.style.setProperty('--hue', s.hue || C.cyan);
  setIcon(sl.icon, s);
  setHTML(sl.title, `<span class="name">${esc(s.name)}</span>${acctTag(s.account)}${leadTag(s, state)}${ui.isHosted?.(s.id) ? hereTag() : ''}`);
  setHTML(sl.right, `${badge(s)}${sparkSvg(s.spark, statusColor(s))}<span class="ago" title="last activity"></span>`);
  setText(sl.right, '.ago', ago(now - s.last));
  setHTML(sl.goal, compact ? '' : esc(s.goal || '—'));
  setHTML(sl.wait, waitNote(s));
  setHTML(sl.action, lastAction(s));
  const p = s.progress || {};
  const running = runningAgents(s);
  const dots = agentDots(s);
  setHTML(sl.bar, `<span class="k">${esc(p.mode || 'ship')}</span>${progressBar(s)}<span class="pct${p.done ? ' done' : ''}">${pctText(s)}</span>`
    + (dots ? `<span class="dots">${dots}</span>` : '') + (running.length ? `<span class="running">${runningList(running)}</span>` : ''));
  setHTML(sl.steps, compact ? '' : `${p.mode === 'plan' && s.planSteps ? planSteps(s.planSteps) + '<span class="sep" aria-hidden="true"></span>' : ''}${shipTrack(s.ship, false, linksOf(s))}<span class="grow"></span>${prTag(s)}`);
  const tt = turnText(s, now);
  setHTML(sl.chips, compact ? '' : `${repoChip(s)}${ctxGauge(s.context, true)}${tt ? `<span class="turn${isBusy(s.state) ? ' busy' : ''}">${icon('clock', 12)}<span class="turn-t"></span></span>` : ''}`);
  setText(sl.chips, '.turn-t', tt);
  setHTML(sl.meta, compact ? '' : metaLine(s));
  setHTML(sl.clash, clashNotes(s, state));
}

function feedRow(e, s, now) {
  const k = Math.max(0.35, 1 - (now - e.t) / 300e3); // older lines fade, by age only
  const time = new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `<div class="f-row" style="opacity:${k.toFixed(3)}"><span class="f-time">${time}</span><span class="f-dot" style="background:${esc(s.hue)}"></span><span class="f-name">${esc(s.name)}</span>${e.who && e.who !== 'main' ? `<span class="who">${esc(e.who)}</span>` : '<span></span>'}<span class="verb">${verbIcon(e.verb, 13)}${esc(e.verb)}</span><span class="what">${esc(e.what)}</span></div>`;
}

export function renderCards(el, state, ui) {
  const now = Date.now();
  if (!el._built) {
    el.innerHTML = `<div class="cards grid"></div><div class="empty" hidden></div><section class="stream"><h3>${icon('live', 13)}<span>Stream</span></h3><div class="f-list"></div></section>`;
    el._grid = el.querySelector('.cards');
    el._empty = el.querySelector('.empty');
    el._feed = el.querySelector('.f-list');
    el._cards = new Map();
    el._built = true;
  }
  const list = state.sessions || [];
  const byId = new Map(list.map((s) => [s.id, s]));
  el._grid.classList.toggle('compact', !!ui.compact);
  el._empty.hidden = list.length > 0;
  setHTML(el._empty, state.filterNote ? esc(state.filterNote) : 'no sessions active in the window, waiting for agents…');
  syncGrid(el._grid, el._cards, list.map((s) => s.id), (id) => buildCard(id, ui), (id, c) => fillCard(c, byId.get(id), state, ui, now), state.handoffPairs);

  const rows = (state.feed || []).filter((e) => byId.has(e.sid)).slice(-60).reverse();
  setHTML(el._feed, rows.length ? rows.map((e) => feedRow(e, byId.get(e.sid), now)).join('') : '<div class="dim">no tool calls yet</div>');
}
