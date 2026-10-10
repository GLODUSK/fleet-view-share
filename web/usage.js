// Fleet View web: who is using the Claude plan. Two pieces, both fed by /state usage (usage-watch.js on the server):
//
//   The heads-up: when an account's plan usage climbs with nothing on this PC to explain it (another computer,
//   claude.ai, the phone app, someone else signed in), a small card at the bottom left says so once for that
//   episode: "I know, keep using" (POST /usage/ack) puts it away for good, and it goes by itself when the episode
//   ends (45 quiet minutes). A new burst after that is a new episode and asks again. No sound, no modal, nothing
//   that blinks; one desktop notification per episode, only while the window is not focused (and notifications on).
//
//   The Usage card: a click on the header's "week left" pill. Per account: the 5-hour and weekly limits, the last
//   5 hours as bars (this PC / elsewhere), the week by app (Claude Code, Chats, Cowork), extra-usage credits and the
//   last episodes. Esc, its × or a click outside closes it.
//
//   mountUsage({ post, notifyOn, focusWindow }) -> { update(state), toggle(), open(), close(), isOpen() }
import { esc, C, acctColor, singleAccount, isAcct } from './cards.js';
import { icon } from './icons.js';

const NOTIFIED_KEY = 'fv.usageNotified';
const readList = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeList = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v.slice(-30))); } catch {} };
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayHm = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const mins = (ms) => { const m = Math.max(1, Math.round(ms / 60e3)); return m < 90 ? `${m} min` : `${Math.round(m / 6) / 10} h`; };
const usd = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
// "Claude C", or "Your Claude account" with only one
const who = (a) => (singleAccount() ? 'Your Claude account' : `Claude ${a}`);
const tag = (a) => (singleAccount() ? '' : `<span class="acct" style="background:${acctColor(a)}">${esc(a)}</span>`);

export function mountUsage({ post, notifyOn = () => true, focusWindow = () => {} } = {}) {
  let usage = {};
  const acked = new Set(); // episode ids put away here, until /state says so too
  const notified = new Set(readList(NOTIFIED_KEY));
  let card = null;

  // ---------- the heads-up ----------
  const heads = document.createElement('div');
  heads.className = 'uw-heads';
  heads.setAttribute('aria-live', 'polite');
  document.body.appendChild(heads);

  const live = () => Object.entries(usage).filter(([a, u]) => isAcct(a) && u && u.episode && !u.episode.acked && !acked.has(u.episode.id));
  function headsText(a, e) {
    const pts = e.total > 0 ? `+${e.total}% of its 5-hour limit` : '';
    const cred = e.credits > 0 ? `${usd(e.credits)} of extra-usage credits` : '';
    const what = [pts, cred].filter(Boolean).join(' and ') || 'usage';
    return { title: `${who(a)} is being used somewhere else`, sub: `${what} in the last ${mins(Date.now() - e.start)}, not from sessions on this PC.` };
  }
  function drawHeads() {
    const list = live();
    const keep = new Set(list.map(([, u]) => u.episode.id));
    for (const el of [...heads.children]) if (!keep.has(el.dataset.ep)) el.remove();
    for (const [a, u] of list) {
      const e = u.episode, t = headsText(a, e);
      let el = heads.querySelector(`[data-ep="${CSS.escape(e.id)}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'uw-card';
        el.dataset.ep = e.id;
        el.dataset.acct = a;
        el.setAttribute('role', 'status');
        el.innerHTML = `<span class="uw-ic">${icon('alert', 15)}</span><div class="uw-body"><div class="uw-t"></div><div class="uw-s"></div></div>`
          + '<div class="uw-acts"><button type="button" class="uw-ack" data-c="ack">I know, keep using</button><button type="button" class="uw-more" data-c="more">Details</button></div>';
        heads.appendChild(el);
      }
      const ti = el.querySelector('.uw-t'), su = el.querySelector('.uw-s');
      if (ti.textContent !== t.title) ti.textContent = t.title;
      if (su.textContent !== t.sub) su.textContent = t.sub;
      notifyOnce(a, e, t);
    }
  }
  heads.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-c]');
    const el = b && b.closest('.uw-card');
    if (!el) return;
    if (b.dataset.c === 'ack') {
      acked.add(el.dataset.ep);
      el.remove();
      Promise.resolve(post('/usage/ack', { account: el.dataset.acct, episode: el.dataset.ep })).catch(() => {});
    } else open();
  });
  function notifyOnce(a, e, t) {
    if (notified.has(e.id)) return;
    notified.add(e.id);
    writeList(NOTIFIED_KEY, [...notified]);
    if (!notifyOn() || document.hasFocus() || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(t.title, { body: t.sub, tag: `fv-usage-${e.id}`, silent: true });
      n.onclick = () => { try { window.focus(); focusWindow(); } catch {} open(); n.close(); };
    } catch {}
  }

  // ---------- the Usage card ----------
  function meter(label, x) {
    if (!x) return '';
    const pct = Math.max(0, Math.min(100, x.pct));
    const col = pct >= 90 ? C.red : pct >= 75 ? C.gold : C.cyan;
    return `<div class="uw-m"><span class="uw-ml">${label}</span><span class="uw-mb"><i style="width:${pct}%;background:${col}"></i></span>`
      + `<span class="uw-mv"><b>${pct}%</b> used${x.resets ? ` · resets ${label === 'Week' ? dayHm(x.resets) : hm(x.resets)}` : ''}</span></div>`;
  }
  // the last 5 hours: one bar per read, this PC below, elsewhere on top
  // (drawn against the last read's time, so the card only changes when a read does)
  function bars(list, at) {
    if (!list || !list.length) return '<div class="uw-none">No reads in the last 5 hours yet.</div>';
    const W = 300, H = 46, end = at || Date.now(), start = end - 5 * 3600e3;
    const top = Math.max(4, ...list.map((b) => b.here + b.away));
    const bw = Math.max(2, (W / 60) - 1);
    const x = (t) => ((t - start) / (end - start)) * (W - bw);
    const rects = list.map((b) => {
      const hh = (b.here / top) * (H - 2), ha = (b.away / top) * (H - 2), X = x(b.t).toFixed(1);
      return (hh ? `<rect x="${X}" y="${(H - hh).toFixed(1)}" width="${bw}" height="${hh.toFixed(1)}" rx="1" fill="${C.cyan}" opacity="0.75"><title>${hm(b.t)}: +${b.here}% from this PC</title></rect>` : '')
        + (ha ? `<rect x="${X}" y="${(H - hh - ha).toFixed(1)}" width="${bw}" height="${ha.toFixed(1)}" rx="1" fill="${C.rose}"><title>${hm(b.t)}: +${b.away}% from elsewhere</title></rect>` : '');
    }).join('');
    return `<svg class="uw-bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="5-hour usage over the last 5 hours">`
      + `<line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="currentColor" opacity="0.15"/>${rects}</svg>`
      + `<div class="uw-axis"><span>${hm(start)}</span><span class="uw-legend"><i style="background:${C.cyan}"></i>this PC <i style="background:${C.rose}"></i>elsewhere</span><span>${hm(end)}</span></div>`;
  }
  function accountHtml(a, u) {
    const e = u.episode;
    const status = e ? `<span class="uw-chip away">used elsewhere${e.acked || acked.has(e.id) ? ' · you know' : ' now'}</span>`
      : u.away5 > 0 ? '<span class="uw-chip some">some from elsewhere</span>' : '<span class="uw-chip here">only this PC</span>';
    const lines = [];
    lines.push(u.away5 > 0 ? `From elsewhere in the last 5 hours: <b class="uw-away">+${u.away5}%</b> of the 5-hour limit.` : 'Nothing from elsewhere in the last 5 hours.');
    if (e) lines.push(`Going on since ${hm(e.start)}: +${e.total}%${e.credits ? ` and ${usd(e.credits)} of credits` : ''}, last seen ${hm(e.last)}.`);
    if (u.breakdown && u.breakdown.length) lines.push(`This week by app: ${u.breakdown.filter((r) => r.pct > 0).map((r) => `${esc(r.name)} ${r.pct}%`).join(' · ') || 'nothing yet'}.`);
    if (u.credits && u.credits.used != null) lines.push(`Extra-usage credits: ${usd(u.credits.used)}${u.credits.limit != null ? ` of ${usd(u.credits.limit)}` : ''} this month${u.credits.enabled ? '' : ' (off)'}.`);
    if (u.past && u.past.length) lines.push(`Earlier: ${u.past.slice(0, 3).map((p) => `${dayHm(p.start)}–${hm(p.last)} +${p.total}%${p.credits ? ` ${usd(p.credits)}` : ''}`).join(' · ')}.`);
    return `<section class="uw-acct"><div class="uw-ah">${tag(a)}<b>${esc(who(a))}</b>${status}</div>`
      + meter('5-hour', u.five) + meter('Week', u.week) + bars(u.bars, u.at)
      + `<div class="uw-lines">${lines.map((l) => `<div>${l}</div>`).join('')}</div></section>`;
  }
  function drawCard() {
    if (!card) return;
    const accts = Object.keys(usage).filter((a) => isAcct(a) && usage[a]).sort();
    const body = accts.length ? accts.map((a) => accountHtml(a, usage[a])).join('')
      : '<div class="uw-none">No usage read yet. It is read every 5 minutes for each account signed in with a Claude plan.</div>';
    const html = `<div class="uw-top"><span class="uw-title">${icon('cost', 14)}<b>Plan usage</b></span><span class="uw-sub">this PC vs. elsewhere</span>`
      + `<button type="button" class="uw-x" aria-label="close" title="close (Esc)">${icon('close', 13)}</button></div>`
      + `<div class="uw-list">${body}</div>`
      + '<div class="uw-foot">Elsewhere: the plan’s meter rose more than the sessions on this PC explain, so another computer, claude.ai, the phone app, the desktop app’s Cowork or someone else signed in used it. The heads-up comes at 10 points of the 5-hour limit in 30 minutes (usageAlertPct in ~/.fleet-view.json).</div>';
    if (card._html !== html) { card.innerHTML = html; card._html = html; }
  }
  function open() {
    if (card) return;
    card = document.createElement('div');
    card.className = 'uw-pop';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Plan usage');
    card.tabIndex = -1;
    document.body.appendChild(card);
    drawCard();
    card.addEventListener('click', (ev) => { if (ev.target.closest('.uw-x')) close(); });
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } });
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    document.addEventListener('keydown', escKey, true);
    card.focus({ preventScroll: true });
  }
  function close() {
    if (!card) return;
    card.remove();
    card = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escKey, true);
  }
  const outside = (ev) => { if (card && !card.contains(ev.target) && !ev.target.closest('.count.week, .uw-heads')) close(); };
  const escKey = (ev) => { if (ev.key === 'Escape' && card) { ev.stopPropagation(); ev.preventDefault(); close(); } };

  return {
    update(st) {
      usage = st && st.usage && typeof st.usage === 'object' ? st.usage : {};
      for (const id of [...acked]) if (!Object.values(usage).some((u) => u && u.episode && u.episode.id === id && !u.episode.acked)) acked.delete(id);
      drawHeads();
      drawCard();
    },
    open, close, isOpen: () => !!card, toggle: () => (card ? close() : open()),
    // an account with usage from elsewhere in the last 5 hours (the header pill's dot)
    awayNow: (a) => !!(usage[a] && (usage[a].episode || usage[a].away5 > 0)),
  };
}
