// Fleet View web: who is using the Claude plan. Two pieces, both fed by /state usage (usage-watch.js on the server):
//
//   The heads-up: when an account's plan usage climbs with nothing on this PC to explain it (another computer,
//   claude.ai, the phone app, someone else signed in), a small card at the bottom left says so once for that
//   episode: "I know, keep using" (POST /usage/ack) puts it away for good, and it goes by itself when the episode
//   ends (45 quiet minutes). A new burst after that is a new episode and asks again. No sound, no modal, nothing
//   that blinks; one desktop notification per episode, only while the window is not focused (and notifications on).
//
//   The Usage card: a click on the header's "week left" pill (or its Accounts button). At the top the Accounts list:
//   each account with who it is signed in as, Switch login, Remove, and Add account (/state accountList, POST
//   /accounts/*). Then per account: the 5-hour and weekly limits, the last 5 hours as bars (this PC / elsewhere), the
//   week by app (Claude Code, Chats, Cowork), extra-usage credits and the last episodes. Esc, its × or a click
//   outside closes it.
//
//   mountUsage({ post, notifyOn, focusWindow, refreshSoon, isHosted, endSessions })
//     -> { update(state), toggle(), open(), openAccounts(), close(), isOpen(), emailOf(a), awayNow(a) }
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

export function mountUsage({ post, notifyOn = () => true, focusWindow = () => {}, refreshSoon = () => {}, isHosted = () => false, endSessions = () => {} } = {}) {
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
      : u.away5 > 0 ? '<span class="uw-chip some">some from elsewhere</span>' : '<span class="uw-chip here">This PC</span>';
    const lines = [];
    lines.push(u.away5 > 0 ? `From elsewhere in the last 5 hours: <b class="uw-away">+${u.away5}%</b> of the 5-hour limit.` : 'Nothing from elsewhere in the last 5 hours.');
    if (e) lines.push(`Going on since ${hm(e.start)}: +${e.total}%${e.credits ? ` and ${usd(e.credits)} of credits` : ''}, last seen ${hm(e.last)}.`);
    if (u.breakdown && u.breakdown.length) lines.push(`This week by app: ${u.breakdown.filter((r) => r.pct > 0).map((r) => `${esc(r.name)} ${r.pct}%`).join(' · ') || 'nothing yet'}.`);
    if (u.credits && u.credits.used != null) lines.push(`Extra-usage credits: ${usd(u.credits.used)}${u.credits.limit != null ? ` of ${usd(u.credits.limit)}` : ''} this month${u.credits.enabled ? '' : ' (off)'}.`);
    if (u.past && u.past.length) lines.push(`Earlier: ${u.past.slice(0, 3).map((p) => `${dayHm(p.start)}–${hm(p.last)} +${p.total}%${p.credits ? ` ${usd(p.credits)}` : ''}`).join(' · ')}.`);
    const email = emailOf(a);
    return `<section class="uw-acct"><div class="uw-ah">${tag(a)}<b>${esc(who(a))}</b>${email ? `<span class="uw-email">${esc(email)}</span>` : ''}${status}</div>`
      + meter('5-hour', u.five) + meter('Week', u.week) + bars(u.bars, u.at)
      + `<div class="uw-lines">${lines.map((l) => `<div>${l}</div>`).join('')}</div></section>`;
  }
  // ---------- the Accounts list (accounts.js on the server) ----------
  // A row per account folder: who it is signed in as, Switch login (or Sign in) and Remove. "Add account" makes the
  // next letter and signs it in. A sign-in opens claude.ai in the browser and finishes by itself; the form below the
  // list shows how it goes, with the link (for a private window) and a box for the code claude.ai then shows.
  // The list is drawn again with every /state; the form is its own element, drawn only when its step changes, so
  // what is typed in it stays.
  let accts = { list: [], jobs: {} };
  let form = null; // { a: letter or null (add, not started yet), el, step }
  let confirmRm = null; // { a, live: [{ id, name }] | null }
  let note = null; // { text, bad }
  let busy = false;
  const letterTag = (a) => `<span class="acct" style="background:${acctColor(a)}">${esc(a)}</span>`;
  const emailOf = (a) => (accts.list.find((x) => x.a === a) || {}).email || null;
  const jobOf = (a) => (a && accts.jobs[a]) || null;
  function accountsHtml() {
    const rows = accts.list.map(({ a, email, signedIn, sameAs }) => {
      const j = jobOf(a);
      const chip = j && j.status === 'waiting' ? '<span class="uw-chip some">signing in…</span>'
        : sameAs ? `<span class="uw-chip">same login as ${esc(sameAs)}</span>` : !signedIn ? '<span class="uw-chip away">not signed in</span>' : '';
      let row = `<div class="ua-row" data-a="${esc(a)}">${letterTag(a)}<span class="ua-who" title="${esc(email || '')}">${esc(email || 'no login')}</span>${chip}`
        + `<span class="ua-btns"><button type="button" data-c="login"${j && j.status === 'waiting' ? ' disabled' : ''}>${signedIn ? 'Switch login' : 'Sign in'}</button>`
        + `<button type="button" data-c="remove" class="ua-rm" title="Remove Claude ${esc(a)}" aria-label="Remove Claude ${esc(a)}">${icon('trash', 14)}</button></span></div>`;
      if (confirmRm && confirmRm.a === a) {
        const live = confirmRm.live || [];
        const hosted = live.filter((s) => isHosted(s.id));
        row += `<div class="ua-confirm">${live.length
          ? `<div>Still running on Claude ${esc(a)}: ${live.map((s) => `<b>${esc(s.name)}</b>`).join(', ')}.${hosted.length < live.length ? ' Close the ones in a terminal first.' : ''}</div>`
            + `<div class="ua-cbtns">${hosted.length === live.length ? `<button type="button" data-c="end-rm" class="ua-danger">End ${live.length === 1 ? 'it' : `all ${live.length}`} and remove</button>` : ''}<button type="button" data-c="keep">Keep</button></div>`
          : `<div>Remove Claude ${esc(a)}${email ? ` (${esc(email)})` : ''}? ${a === 'B' ? 'It is signed out' : 'Its folder is moved aside'}; its login is saved in a backup first, and conversations stay.</div>`
            + `<div class="ua-cbtns"><button type="button" data-c="do-rm" class="ua-danger">Remove</button><button type="button" data-c="keep">Keep</button></div>`}</div>`;
      }
      return row;
    }).join('');
    return `<div class="ua-h"><b>Accounts</b><button type="button" class="ua-add" data-c="add"${form ? ' disabled' : ''}>${icon('plus', 12)}Add account</button></div>`
      + rows + (note ? `<div class="ua-note${note.bad ? ' bad' : ''}">${esc(note.text)}</div>` : '');
  }
  // the form's step: asking (an email, optional), waiting on the browser, or how it ended
  function formStep() {
    if (!form) return null;
    if (!form.started) return 'ask';
    const j = jobOf(form.a);
    return !j ? null : j.status === 'waiting' ? 'wait' : 'end';
  }
  function drawForm() {
    if (!card) return;
    const step = formStep();
    let el = card.querySelector('.ua-form');
    if (!step) { form = null; if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'ua-form'; card.querySelector('.ua').after(el); }
    const j = jobOf(form.a);
    const key = `${step}|${form.a}|${j ? j.status + (j.url ? 1 : 0) : ''}`;
    if (el._key !== key) {
      el._key = key;
      const who = form.a ? `Claude ${esc(form.a)}` : 'a new account';
      if (step === 'ask') {
        el.innerHTML = `<div class="ua-ft">Sign in ${who}</div>`
          + '<input type="email" class="ua-email" placeholder="email (optional, fills in the sign-in page)" autocomplete="off" spellcheck="false">'
          + '<div class="ua-cbtns"><button type="button" data-c="go" class="ua-go">Sign in</button><button type="button" data-c="close-form">Cancel</button></div>'
          + '<div class="ua-hint">claude.ai opens in your browser and signs in with the account the browser is on. For a different account, sign out of claude.ai there first, or copy the link into a private window.</div>';
        setTimeout(() => el.querySelector('.ua-email')?.focus(), 0);
      } else if (step === 'wait') {
        el.innerHTML = `<div class="ua-ft">Signing in ${who}…</div><div class="ua-msg"></div>`
          + (j.url ? '<div class="ua-cbtns"><button type="button" data-c="open-link">Open the link again</button><button type="button" data-c="copy-link">Copy link</button></div>' : '')
          + '<div class="ua-code"><input type="text" class="ua-code-in" placeholder="code from claude.ai, if it shows one" autocomplete="off" spellcheck="false"><button type="button" data-c="send-code">Send</button></div>'
          + '<div class="ua-cbtns"><button type="button" data-c="stop">Stop</button></div>';
      } else {
        el.innerHTML = `<div class="ua-ft ${j.status === 'done' ? 'ok' : 'bad'}">${j.status === 'done' ? 'Signed in' : j.status === 'same' ? 'Already here' : 'Not signed in'}</div><div class="ua-msg"></div>`
          + '<div class="ua-cbtns"><button type="button" data-c="close-form">OK</button></div>';
      }
    }
    const msg = el.querySelector('.ua-msg');
    if (msg && j && msg.textContent !== (j.message || '')) msg.textContent = j.message || '';
  }
  async function act(url, body) {
    busy = true;
    const r = await Promise.resolve(post(url, body)).catch(() => null);
    busy = false;
    if (!r) note = { text: 'Fleet View did not answer.', bad: true };
    return r;
  }
  async function onAccounts(ev) {
    const b = ev.target.closest('button[data-c]');
    if (!b || busy) return;
    const c = b.dataset.c, a = b.closest('[data-a]')?.dataset.a || null;
    note = null;
    if (c === 'add') { form = { a: null }; confirmRm = null; }
    else if (c === 'login') { form = { a }; confirmRm = null; }
    else if (c === 'close-form') form = null;
    else if (c === 'keep') confirmRm = null;
    else if (c === 'remove') { confirmRm = { a, live: null }; form = null; }
    else if (c === 'go') {
      const email = card.querySelector('.ua-email')?.value.trim() || '';
      const r = await act(form.a ? '/accounts/login' : '/accounts/add', { account: form.a, email });
      if (r && r.ok) { form = { a: r.account, started: true }; accts.jobs[r.account] = { status: 'waiting', message: 'Your browser is opening claude.ai to sign in.' }; refreshSoon(); }
      else if (r) note = { text: r.message, bad: true };
    } else if (c === 'stop' && form) { await act('/accounts/cancel', { account: form.a }); refreshSoon(); }
    else if (c === 'send-code' && form) {
      const code = card.querySelector('.ua-code-in')?.value.trim() || '';
      const r = await act('/accounts/code', { account: form.a, code });
      if (r && !r.ok) note = { text: r.message, bad: true };
      refreshSoon();
    } else if ((c === 'open-link' || c === 'copy-link') && form) {
      const url = jobOf(form.a)?.url;
      if (url && c === 'open-link') window.open(url, '_blank', 'noopener');
      if (url && c === 'copy-link') { try { await navigator.clipboard.writeText(url); note = { text: 'Link copied: paste it into a private window, then paste the code it shows here.' }; } catch { note = { text: url }; } }
    } else if (c === 'do-rm' || c === 'end-rm') await removeAccount(confirmRm.a, c === 'end-rm');
    drawAccounts();
  }
  // remove; with end, the Fleet View sessions running on it are ended first and the remove is tried again until
  // their claude processes are gone (the server sees that within a few seconds)
  async function removeAccount(a, end) {
    if (end && confirmRm.live) endSessions(confirmRm.live.map((s) => s.id));
    for (let i = 0; i < (end ? 12 : 1); i++) {
      if (i) { await new Promise((r) => setTimeout(r, 1500)); }
      const r = await act('/accounts/remove', { account: a });
      if (!r) return;
      if (r.ok) { confirmRm = null; note = { text: r.message }; refreshSoon(); return; }
      if (!r.live) { note = { text: r.message, bad: true }; return; }
      confirmRm = { a, live: r.live };
      if (!end) return;
      drawAccounts();
    }
    note = { text: `Sessions are still ending on Claude ${a}; try Remove again in a moment.`, bad: true };
  }
  function drawAccounts() {
    if (!card) return;
    const el = card.querySelector('.ua');
    const html = accountsHtml();
    if (el && el._html !== html) { el.innerHTML = html; el._html = html; }
    drawForm();
  }

  function drawCard() {
    if (!card) return;
    const ids = Object.keys(usage).filter((a) => isAcct(a) && usage[a]).sort();
    const body = ids.length ? ids.map((a) => accountHtml(a, usage[a])).join('')
      : '<div class="uw-none">No usage read yet. It is read every 5 minutes for each account signed in with a Claude plan.</div>';
    const html = `<div class="uw-list">${body}</div>`;
    const el = card.querySelector('.uw-list-wrap');
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    drawAccounts();
  }
  function open() {
    if (card) return;
    // a sign-in going on shows how it goes at once
    const waiting = Object.keys(accts.jobs).find((a) => accts.jobs[a].status === 'waiting');
    if (!form && waiting) form = { a: waiting, started: true };
    card = document.createElement('div');
    card.className = 'uw-pop';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Plan usage and accounts');
    card.tabIndex = -1;
    card.innerHTML = `<div class="uw-top"><span class="uw-title">${icon('cost', 14)}<b>Plan usage</b></span><span class="uw-sub">this PC vs. elsewhere</span>`
      + `<button type="button" class="uw-x" aria-label="close" title="close (Esc)">${icon('close', 13)}</button></div>`
      + '<div class="uw-scroll"><div class="ua"></div><div class="uw-list-wrap"></div></div>'
      + '<div class="uw-foot">Elsewhere: the plan’s meter rose more than the sessions on this PC explain, so another computer, claude.ai, the phone app, the desktop app’s Cowork or someone else signed in used it. The heads-up comes at 10 points of the 5-hour limit in 30 minutes (usageAlertPct in ~/.fleet-view.json).</div>';
    document.body.appendChild(card);
    drawCard();
    card.addEventListener('click', (ev) => { if (ev.target.closest('.uw-x')) close(); else if (ev.target.closest('.ua, .ua-form')) onAccounts(ev); });
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
      if (ev.key === 'Enter' && ev.target.matches('.ua-email, .ua-code-in')) { ev.preventDefault(); card.querySelector(ev.target.matches('.ua-email') ? '[data-c="go"]' : '[data-c="send-code"]')?.click(); }
    });
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    document.addEventListener('keydown', escKey, true);
    card.focus({ preventScroll: true });
  }
  function close() {
    if (!card) return;
    card.remove();
    card = null;
    // a sign-in goes on without the card; what was being asked or confirmed does not
    if (form && formStep() !== 'wait') form = null;
    confirmRm = null;
    note = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escKey, true);
  }
  const outside = (ev) => { if (card && !card.contains(ev.target) && !ev.target.closest('.count.week, .count.accts, .uw-heads')) close(); };
  const escKey = (ev) => { if (ev.key === 'Escape' && card) { ev.stopPropagation(); ev.preventDefault(); close(); } };

  return {
    update(st) {
      usage = st && st.usage && typeof st.usage === 'object' ? st.usage : {};
      const al = st && st.accountList;
      if (al && Array.isArray(al.list)) accts = { list: al.list.filter((x) => x && isAcct(x.a)), jobs: al.jobs && typeof al.jobs === 'object' ? al.jobs : {} };
      for (const id of [...acked]) if (!Object.values(usage).some((u) => u && u.episode && u.episode.id === id && !u.episode.acked)) acked.delete(id);
      drawHeads();
      drawCard();
    },
    open, close, isOpen: () => !!card, toggle: () => (card ? close() : open()),
    // the header's Accounts button: the card, with "Add account" asked at once when there is no sign-in going on
    openAccounts() { open(); if (!form) { form = { a: null }; confirmRm = null; drawAccounts(); } },
    emailOf,
    // an account with usage from elsewhere in the last 5 hours (the header pill's dot)
    awayNow: (a) => !!(usage[a] && (usage[a].episode || usage[a].away5 > 0)),
  };
}
