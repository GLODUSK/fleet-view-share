// Fleet View web: "Since you looked". A frosted card at the top centre of the page (the detail panel's look)
// that says what happened while you were away: PRs merged and live, what failed, which conversations
// finished, who needs you now, what it cost by account, and which conversations were busiest.
//
//   mountSince({ fetchJson, onPick, fallback })  -> { open(t?), close(), isOpen(), toggle(), seen() }
//     fetchJson(url) -> Promise<json|null>   the shell's GET (GET /since?t=<ms>)
//     onPick(id)                             a row was clicked: pick that conversation (the panel opens)
//     fallback(t) -> /since-shaped object    used when GET /since does not answer (?fixture=1 has no server)
//
// When it opens by itself: the page comes back into view (visibilitychange) after 30 minutes or more hidden.
// Opened by hand: the header's clock button or the key w. Either way it starts from "last seen", the time the
// page was last in view (kept in localStorage fv.lastSeen, written every 30 s while the page is in view and when
// it goes out of view; every access in try/catch, so it works without storage: then it starts an hour back).
// The 1h / 6h / 24h chips in its head look further back. Esc, its × or a click outside closes it.
//
// Calm by rule, like everything here: it drops in once (180 ms), rows never flash, nothing counts up.
import { esc, fmtCost, clockTime, ago, C } from './cards.js';
import { icon } from './icons.js';

const KEY = 'fv.lastSeen';
const AWAY_MS = 30 * 60e3; // hidden this long: it opens by itself when the page comes back
const TICK_MS = 30e3;
const readSeen = () => { try { const v = Number(localStorage.getItem(KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; } };
const writeSeen = (t) => { try { localStorage.setItem(KEY, String(t)); } catch {} };
// "a minute", "12 minutes", "1 hour", "1.5 hours", "14 hours", "3 days" (no "1.0 hours")
const plural = (v, one) => `${v} ${one}${v === 1 ? '' : 's'}`;
export const agoText = (ms) => {
  if (ms < 90e3) return 'a minute';
  if (ms < 3600e3) return plural(Math.min(59, Math.round(ms / 60e3)), 'minute');
  if (ms < 48 * 3600e3) { const h = ms / 3600e3; return plural(h < 10 ? Math.round(h * 10) / 10 : Math.round(h), 'hour'); }
  return plural(Math.round(ms / 86400e3), 'day');
};
// the same failure many times over (an agent that failed four times): one row, "×4", at its newest time
export function groupFailed(list) {
  const by = new Map();
  for (const x of list || []) {
    if (!x) continue;
    const k = `${x.sid || ''}|${x.name || ''}|${x.text || x.kind || ''}`;
    const g = by.get(k);
    if (!g) by.set(k, { ...x, count: 1 });
    else { g.count++; if ((x.t || 0) > (g.t || 0)) g.t = x.t; }
  }
  return [...by.values()];
}

export function mountSince({ fetchJson, onPick, fallback } = {}) {
  let el = null, openNow = false, from = null, data = null, loading = false, reqSeq = 0;
  // a section shows its newest SHOW rows; "Show N more" opens the rest (until it closes)
  const SHOW = 5;
  let more = new Set();
  // the time the page was last in view before this visit: what "since you looked" means when opened by hand
  let lastLook = readSeen();
  let hiddenAt = document.hidden ? Date.now() : null;

  const visible = () => !document.hidden;
  setInterval(() => { if (visible()) writeSeen(Date.now()); }, TICK_MS);
  document.addEventListener('visibilitychange', () => {
    const now = Date.now();
    if (document.hidden) { hiddenAt = now; writeSeen(now); return; }
    const seen = readSeen() ?? hiddenAt;
    const away = seen ? now - seen : 0;
    lastLook = seen || lastLook;
    hiddenAt = null;
    if (seen && away >= AWAY_MS) open(seen);
    writeSeen(now);
  });
  window.addEventListener('pagehide', () => writeSeen(Date.now()));
  // the first look at a page opened fresh after a long time away
  if (visible() && lastLook && Date.now() - lastLook >= AWAY_MS) setTimeout(() => open(lastLook), 1500);
  if (visible()) writeSeen(Date.now());

  function ensure() {
    if (el) return el;
    el = document.createElement('section');
    el.id = 'since';
    el.className = 'since';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Since you looked');
    el.hidden = true;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('.sn-x')) { close(); return; }
      const mo = e.target.closest('[data-more]');
      if (mo) { more.add(mo.dataset.more); draw(); return; }
      const chip = e.target.closest('[data-back]');
      if (chip) { open(Date.now() - Number(chip.dataset.back) * 3600e3); return; }
      const row = e.target.closest('[data-sid]');
      if (row && onPick) { try { onPick(row.dataset.sid); } catch (err) { console.error(err); } }
    });
    el.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-sid]')) { e.preventDefault(); e.target.click(); }
    });
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.addEventListener('pointerdown', (e) => { if (openNow && el && !el.contains(e.target) && !e.target.closest?.('#since-btn')) close(); });
    return el;
  }

  // under the header as it is drawn now: it wraps to two rows (or three) on a narrow window, which --top-h
  // (one row) doesn't know
  function place() {
    if (!el) return;
    const head = document.querySelector('header.top');
    const b = head ? head.getBoundingClientRect().bottom : NaN;
    if (Number.isFinite(b) && b > 0) {
      el.style.top = `${Math.round(b + 14)}px`;
      el.style.maxHeight = `calc(100vh - ${Math.round(b + 80)}px)`;
    } else { el.style.top = ''; el.style.maxHeight = ''; }
  }
  window.addEventListener('resize', () => { if (openNow) place(); });

  async function open(t) {
    ensure();
    from = Number.isFinite(t) && t > 0 ? t : lastLook || Date.now() - 3600e3;
    if (Date.now() - from < 60e3) from = Date.now() - 3600e3; // "since a moment ago" says nothing: the last hour
    openNow = true;
    more = new Set();
    el.hidden = false;
    place();
    loading = true; data = null;
    draw();
    const seq = ++reqSeq;
    let r = null;
    try { r = await fetchJson(`/since?t=${Math.round(from)}`); } catch { r = null; }
    if (seq !== reqSeq || !openNow) return;
    if (!r || !r.ok) r = fallback ? fallback(from) : null;
    loading = false; data = r;
    draw();
  }
  function close() {
    if (!openNow) return;
    openNow = false;
    reqSeq++;
    if (el) { el.hidden = true; el.innerHTML = ''; }
    writeSeen(Date.now());
    lastLook = Date.now();
  }

  const row = (sid, dot, main, side, title = '') => `<div class="sn-row"${sid ? ` data-sid="${esc(sid)}" tabindex="0" role="button"` : ''}${title ? ` title="${esc(title)}"` : ''}>`
    + `<span class="sn-dot" style="background:${esc(dot)}"></span><span class="sn-main">${main}</span><span class="sn-side">${side || ''}</span></div>`;
  // rows (newest first, see byNew): SHOW of them until "Show N more"
  const section = (ic, color, title, rows) => {
    if (!rows.length) return '';
    const list = rows;
    const all = more.has(title) || list.length <= SHOW + 1;
    return `<div class="sn-sec"><div class="sn-h"><span class="sn-ic" style="color:${esc(color)}">${icon(ic, 13)}</span>${esc(title)}<span class="sn-n">${rows.length}</span></div>`
      + (all ? list : list.slice(0, SHOW)).join('')
      + (all ? '' : `<button type="button" class="sn-more" data-more="${esc(title)}">Show ${list.length - SHOW} more</button>`) + '</div>';
  };
  const when = (t) => (t ? clockTime(t, false) : '');

  function draw() {
    if (!el) return;
    const head = `<div class="sn-top"><span class="sn-title">${icon('clock', 15)}<b>Since you looked</b></span>`
      + `<span class="sn-from">${from ? `${esc(clockTime(from, false))} · ${esc(agoText(Date.now() - from))} ago` : ''}</span>`
      + `<span class="sn-chips">${[1, 6, 24].map((h) => `<button type="button" class="sn-chip" data-back="${h}" title="the last ${h} hour${h > 1 ? 's' : ''}">${h}h</button>`).join('')}</span>`
      + `<button type="button" class="sn-x" aria-label="close" title="close (Esc)">${icon('close', 14) || '×'}</button></div>`;
    if (loading) { el.innerHTML = `${head}<div class="sn-body"><div class="sn-empty">loading…</div></div>`; return; }
    const d = data;
    if (!d) { el.innerHTML = `${head}<div class="sn-body"><div class="sn-empty">Could not reach Fleet View.</div></div>`; return; }
    const pr = (x) => `${x.pr ? `PR #${esc(x.pr)}` : ''}${x.repo ? ` <span class="faint">${esc(String(x.repo).split('/').pop())}</span>` : ''}`;
    const byNew = (list) => (list || []).slice().sort((a, b) => (b.t || 0) - (a.t || 0));
    const merged = byNew(d.merged).map((x) => row(x.sid, C.mint, `<b>${esc(x.name || '')}</b> ${pr(x)}`, when(x.t)));
    const live = byNew(d.live).map((x) => row(x.sid, C.mint, `<b>${esc(x.name || '')}</b> ${pr(x)}`, when(x.t)));
    const failed = byNew(groupFailed(d.failed)).map((x) => row(x.sid, C.red, `<b>${esc(x.name || '')}</b> <span class="sn-t">${esc(x.text || x.kind || '')}</span>`
      + (x.count > 1 ? ` <span class="sn-count" title="${esc(x.count)} times">×${esc(x.count)}</span>` : ''), when(x.t)));
    const finished = byNew(d.finished).map((x) => row(x.id, C.dim, `<b>${esc(x.name || '')}</b>${x.summary ? ` <span class="sn-t">${esc(x.summary)}</span>` : ''}`, when(x.t), x.summary || ''));
    const needs = (d.needsYou || []).map((x) => row(x.id, C.gold, `<b>${esc(x.name || '')}</b> <span class="sn-t">${esc(String(x.state || '').toLowerCase())}</span>`, x.since ? `waiting ${esc(ago(Date.now() - x.since))}` : ''));
    const busiest = (d.busiest || []).slice(0, 5).map((x) => row(x.id, C.cyan, `<b>${esc(x.name || '')}</b>`, `${esc(x.calls)} calls`));
    const cost = d.cost || {};
    const by = cost.byAccount || {};
    const costLine = `<div class="sn-cost">${icon('cost', 13)}<b>${esc(fmtCost(cost.total || 0))}</b><span class="faint">at API prices</span>`
      + ['A', 'B'].map((a) => `<span class="acct acct-${a}">${a}</span><span>${esc(fmtCost(by[a] || 0))}</span>`).join('') + '</div>';
    const body = [
      section('waiting', C.gold, 'Needs you', needs),
      section('error', C.red, 'Failed', failed),
      section('merge', C.mint, 'Merged', merged),
      section('live', C.mint, 'Live', live),
      section('checks', C.dim, 'Finished', finished),
      section('agent', C.cyan, 'Busiest', busiest),
    ].join('');
    el.innerHTML = `${head}<div class="sn-body">${body || '<div class="sn-empty">Nothing happened. Quiet.</div>'}${costLine}</div>`;
  }

  return {
    open, close,
    isOpen: () => openNow,
    toggle: () => (openNow ? close() : open()),
    // tests: the time it counts from, and what it shows
    get from() { return from; },
    get data() { return data; },
  };
}

// A /since-shaped answer from a /state alone (no server: ?fixture=1). Ships come from state.alerts (merged, live,
// failed), finished from state.finished, needs you from the sessions; cost is everything known (no frames).
export function sinceFromState(st, t) {
  const now = Date.now();
  const al = (st?.alerts || []).filter((a) => a && a.t > t);
  const ses = st?.sessions || [];
  const NEED = new Set(['ASKING', 'QUESTION', 'ERROR', 'STALLED']);
  const total = ses.reduce((n, s) => n + (Number(s.cost) || 0), 0);
  const byAccount = { A: 0, B: 0 };
  for (const s of ses) if (s.account === 'A' || s.account === 'B') byAccount[s.account] += Number(s.cost) || 0;
  const pr = (a) => { const m = /PR #(\d+)/.exec(a.text || ''); return m ? Number(m[1]) : null; };
  return {
    ok: true, since: t, now,
    merged: al.filter((a) => a.kind === 'merged').map((a) => ({ pr: pr(a), repo: null, sid: a.sid, name: a.name, t: a.t })),
    live: al.filter((a) => a.kind === 'live').map((a) => ({ pr: pr(a), repo: null, sid: a.sid, name: a.name, t: a.t })),
    failed: al.filter((a) => ['error', 'deployFail', 'checks', 'agentFail', 'stuckAgent', 'conflict'].includes(a.kind)).map((a) => ({ kind: a.kind, sid: a.sid, name: a.name, text: a.text, t: a.t })),
    finished: (st?.finished || []).filter((f) => f.endedAt > t).map((f) => ({ id: f.id, name: f.name, t: f.endedAt, summary: f.summary || '' })),
    cost: { total, byAccount },
    needsYou: ses.filter((s) => NEED.has(s.state)).map((s) => ({ id: s.id, name: s.name, state: s.state, since: s.last })),
    busiest: ses.filter((s) => s.calls20).sort((a, b) => b.calls20 - a.calls20).slice(0, 5).map((s) => ({ id: s.id, name: s.name, calls: s.calls20 })),
  };
}
