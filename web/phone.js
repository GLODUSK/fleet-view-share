// Fleet View web: the Pair an iPhone card (the phone relay, relay.js and docs/phone.md). A click on the header's "iPhone"
// button opens it under the header at the right, like the Sync card; Esc, its × or a click outside closes it. The
// routes answer on this PC only, so a remote browser never shows the button.
//
// A phone reaches this PC one of two ways, picked here before the code is made (the phone's start screen asks the same):
//   On this Wi-Fi      (mode 'local') the phone on the same network, straight to this PC (relay-lan.js, port 4779);
//                      no sync and no sign-in, so it is there on every install. The card says the phone must be on
//                      this Wi-Fi, and that Windows may ask once to let Fleet View (node.exe) on the network: allow it
//                      on Private networks
//   Through Blackbox   (mode 'relay') through the sync's Supabase project, from anywhere; offered only while sync is
//                      set up and signed in (the phone signs in with the same Google account). Sync set up but signed
//                      out: a line pointing to the Sync card instead
//
// It shows:
//   GET /relay/status    read once when the card opens, after every action, and every 3 seconds while a pairing code
//                        is on screen (never while the card is closed): the sync sign-in, the Wi-Fi addresses, and the
//                        paired phones (name, Wi-Fi or Blackbox, the phone and app, last seen, connected or not)
// Laid out as the Sync card (sync.css): the two ways as selectable cards with an icon tile and a radio mark, what the
// picked way needs in a soft panel, the name field and Pair as one row, the QR in a framed panel with the countdown as
// a pill under it, "Paired" as a success state, and the phones as rows (a phone icon, the name with a dot for its
// connection, the details on a second line, Remove at the right).
//
// and does:
//   Pair an iPhone       POST /relay/pair { name, mode }: the answer's QR code (the server's SVG) is shown once and
//                        never asked for again; a countdown runs to its exp (10 minutes), then the code goes and "Make
//                        a new code" shows. Once status says that device is paired and finished: "Paired: <name>".
//   Remove               POST /relay/revoke { id }, after a second click in the card (the phone is told, then forgotten)
//
//   mountPhone({ post, isRemote, fixture, openSync }) -> { open(), close(), toggle(), isOpen() }
import { esc } from './cards.js';
import { icon } from './icons.js';

const POLL_MS = 3000;
const ago = (t) => {
  t = typeof t === 'number' ? t : Date.parse(t || '');
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 360) / 10} h ago` : `${Math.round(s / 86400)} d ago`;
};
const left = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const CHANNEL = { joined: 'connected', joining: 'connecting…', closed: 'not connected', refused: 'refused' };
const MODE = {
  local: { label: 'On this Wi-Fi', short: 'Wi-Fi', icon: 'wifi', sub: 'Same network as this PC. No sign-in, nothing goes through the internet.' },
  relay: { label: 'Through Blackbox', short: 'Blackbox', icon: 'cloud', sub: 'Works away from home, through sync. The phone signs in with the same Google account.' },
};

export function mountPhone({ post, isRemote = () => false, fixture = false, openSync = null } = {}) {
  let card = null, timer = null, tick = null, gen = 0;
  let status = null, answered = false;
  // the code on screen: { id, name, svg, exp, mode }; step says what the pairing section shows
  let code = null, step = 'form', pairedName = '';
  let lastName = ''; // the name field's last value, for "Make a new code"
  let mode = null; // the way picked in the card (null: not yet; the default follows the status)
  let confirmId = null, busy = false;
  let note = null; // { text, bad }

  async function get(url) {
    if (fixture) return null;
    try { const r = await fetch(url, { cache: 'no-store' }); return await r.json(); } catch { return null; }
  }

  async function refresh() {
    const my = gen;
    const st = await get('/relay/status');
    if (my !== gen || !card) return;
    answered = true;
    status = st && Array.isArray(st.devices) ? st : null;
    if (code && step === 'code' && status) {
      const dv = status.devices.find((d) => d.id === code.id);
      if (dv && dv.state === 'paired' && dv.finished) { pairedName = dv.name || code.name; drop('paired'); }
      // gone before its time: revoked from the CLI, or tried too many times
      else if (!dv && Date.now() < code.exp) { drop('expired'); note = { text: 'That code no longer works.', bad: true }; }
    }
    draw();
  }
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!card || step !== 'code') return;
    timer = setTimeout(async () => { await refresh(); schedule(); }, POLL_MS);
  }
  // the code leaves memory as soon as it is not on screen
  function drop(next) {
    code = null;
    step = next;
    clearInterval(tick);
    tick = null;
  }

  // ---------- what the card says ----------
  const canRelay = () => !!(status && status.enabled && status.signedIn);
  // the way a new code is made: what was picked, else Blackbox while sync allows it (it works away from home), else Wi-Fi
  const modeNow = () => (mode === 'relay' && canRelay() ? 'relay' : mode === 'local' ? 'local' : canRelay() ? 'relay' : 'local');
  const lanAddrs = () => (status && status.lan && Array.isArray(status.lan.addresses) ? status.lan.addresses : []);
  function modesHtml() {
    const m = modeNow(), ways = canRelay() ? ['local', 'relay'] : ['local'];
    const btn = (k) => `<button type="button" data-c="mode" data-m="${k}" class="ph-mode${k === m ? ' on' : ''}" role="radio" aria-checked="${k === m}">`
      + `<span class="ph-mic">${icon(MODE[k].icon, 17)}</span><span class="ph-mt"><b>${MODE[k].label}</b><span class="sy-dim">${esc(MODE[k].sub)}</span></span>`
      + '<span class="ph-radio" aria-hidden="true"></span></button>';
    return `<div class="ph-modes" role="radiogroup" aria-label="How the phone reaches this PC">${ways.map(btn).join('')}</div>`;
  }
  // what the picked way needs, in a line or two
  function needsHtml() {
    if (!answered) return '<div class="sy-line sy-dim">Reading…</div>';
    if (!status) return '<div class="sy-line sy-bad">Fleet View did not answer.</div>';
    const m = modeNow();
    if (m === 'relay') {
      const email = status.email || 'your Google account';
      return `<div class="sy-acct"><span class="sy-av" aria-hidden="true">${esc(email.trim()[0].toUpperCase())}</span>`
        + `<span class="sy-acct-t"><span class="sy-email" title="${esc(status.email || '')}"><span class="sy-vh">Signed in to sync as </span>${esc(email)}</span>`
        + `<span class="uw-chip ${status.connected ? 'here' : ''}">${status.connected ? 'relay connected' : 'relay not connected'}</span></span></div>`;
    }
    const lines = [`<div class="sy-line ph-say-wifi">${icon('wifi', 13)}<span>The phone has to be on the same Wi-Fi as this PC.</span></div>`,
      '<div class="sy-line sy-dim">Windows may ask once whether Fleet View (node.exe) may use the network: allow it on <b>Private networks</b>.</div>'];
    if (!lanAddrs().length) lines.push('<div class="sy-line sy-bad">This PC is not on a home network right now (Wi-Fi or a cable). Connect it, then make the code.</div>');
    // sync set up but signed out: the other way is one sign-in away
    if (status.enabled && !status.signedIn) {
      lines.push('<div class="sy-line sy-dim">To reach this PC away from home too, sign in to sync: the phone can then pair through Blackbox.</div>'
        + (openSync ? '<div class="sy-btns"><button type="button" data-c="sync">Open Sync</button></div>' : ''));
    }
    return lines.join('');
  }
  function pairHtml() {
    if (step === 'paired') {
      return `<div class="ph-done"><span class="ph-done-ic">${icon('check', 22)}</span><span class="ph-done-t">Paired</span>`
        + `<span class="ph-done-n"><span class="sy-vh">Paired: </span><b>${esc(pairedName)}</b> can reach this PC now.</span>`
        + '<div class="sy-btns"><button type="button" data-c="again">Pair another</button></div></div>';
    }
    if (step === 'code' && code) {
      const how = code.mode === 'local' ? 'Scan with the Fleet View app on a phone on this Wi-Fi.' : 'Scan with the Fleet View app.';
      return `<div class="ph-qrbox"><div class="ph-qr">${code.svg}</div>`
        + `<span class="ph-left">${icon('clock', 12)}Runs out in <b class="ph-clock">${left(code.exp - Date.now())}</b></span>`
        + '<div class="sy-line ph-prog"></div></div>'
        + `<div class="sy-line ph-say">${how} The code works once, for 10 minutes.</div>`
        + (code.mode === 'local' ? '<div class="sy-line sy-dim">If Windows asks whether Fleet View (node.exe) may use the network, allow it on Private networks, or the phone can\'t reach this PC.</div>' : '');
    }
    if (step === 'expired') {
      return `<div class="ph-done ph-gone"><span class="ph-done-ic">${icon('clock', 20)}</span><span class="ph-done-t">The code ran out</span>`
        + '<span class="ph-done-n">Codes work for 10 minutes. Make a new one and scan it.</span>'
        + `<div class="sy-btns"><button type="button" data-c="new" class="sy-go">${icon('phone', 12)}Make a new code</button></div></div>`;
    }
    const blocked = !status || (modeNow() === 'local' && !lanAddrs().length);
    return '<form class="sy-form ph-form" autocomplete="off">'
      + '<input type="text" class="ph-name" maxlength="60" placeholder="iPhone" autocomplete="off" spellcheck="false" aria-label="The phone\'s name">'
      + `<button type="submit" class="sy-go"${blocked ? ' disabled' : ''}>${icon('phone', 12)}Pair</button></form>`
      + '<div class="sy-line sy-dim">The name is only for this list. A QR code shows next, for the Fleet View app to scan; pick the same way on the phone.</div>';
  }
  function listHtml() {
    if (!status) return '';
    const t = Date.now();
    // (another of Henry's computers, linked in the Sync card, is a device of the relay too: not listed here)
    const rows = status.devices.filter((d) => d.kind !== 'computer' && (d.state === 'paired' || (d.state === 'pending' && !(code && d.id === code.id) && d.exp > t)));
    if (!rows.length) return '<div class="sy-line sy-dim">No phone is paired yet.</div>';
    return rows.map((d) => {
      const way = MODE[d.mode === 'local' ? 'local' : 'relay'];
      const what = [way.short, d.device, d.app ? `app ${d.app}` : ''].filter(Boolean).join(' · ');
      const ch = CHANNEL[d.channel] || d.channel || '';
      const sub = d.state === 'pending'
        ? `waiting for the phone, ${left(d.exp - t)} left${d.handshakes ? ' (scanned, finishing)' : ''}`
        : [d.lastSeen ? `seen ${ago(d.lastSeen)}` : 'not seen yet', ch ? `${d.mode === 'local' ? 'Wi-Fi' : 'channel'} ${ch}${d.problem ? `: ${d.problem}` : ''}` : '', d.finished === false ? 'finishing pairing' : ''].filter(Boolean).join(' · ');
      // the dot: connected mint, connecting or waiting gold, refused rose, else dim
      const dot = d.state === 'pending' ? 'warn' : d.channel === 'joined' ? 'on' : d.channel === 'joining' ? 'warn' : d.channel === 'refused' ? 'bad' : 'off';
      const dotTip = d.state === 'pending' ? 'waiting for the phone' : ch || 'not seen yet';
      const head = `<div class="ph-row"><span class="ph-ic">${icon('phone', 16)}</span>`
        + `<span class="ph-dt"><span class="ph-dn"><b>${esc(d.name)}</b><span class="ph-dot ${dot}" title="${esc(dotTip)}" aria-label="${esc(dotTip)}" role="img"></span></span>`
        + `${what ? `<span class="sy-dim ph-what">${esc(what)}</span>` : ''}`
        + `<span class="sy-dim ph-sub ${d.channel === 'refused' ? 'sy-bad' : ''}">${esc(sub)}</span></span>`
        + (confirmId === d.id ? '' : `<button type="button" data-c="remove" data-id="${esc(d.id)}"${busy ? ' disabled' : ''}>${d.state === 'pending' ? 'Cancel' : 'Remove'}</button>`) + '</div>';
      const conf = confirmId !== d.id ? '' : '<div class="sy-confirm danger" role="group">'
        + (d.state === 'pending' ? `<div class="sy-ct">Cancel the pairing for ${esc(d.name)}?</div><div class="sy-cb">Its code stops working.</div>`
          : `<div class="sy-ct">Remove ${esc(d.name)}?</div><div class="sy-cb">The phone is told, forgets this PC, and has to pair again.</div>`)
        + `<div class="sy-btns"><button type="button" data-c="do-remove" data-id="${esc(d.id)}" class="sy-danger"${busy ? ' disabled' : ''}>${d.state === 'pending' ? 'Cancel it' : 'Remove'}</button>`
        + '<button type="button" data-c="keep">Keep</button></div></div>';
      return `<div class="ph-item">${head}${conf}</div>`;
    }).join('');
  }
  // the countdown and the scan line change in place: the QR and the name field are drawn again only when the step does
  function drawLive() {
    if (!card || !code) return;
    const ms = code.exp - Date.now();
    if (ms <= 0) { drop('expired'); clearTimeout(timer); timer = null; draw(); return; }
    const c = card.querySelector('.ph-clock');
    if (c) c.textContent = left(ms);
    const p = card.querySelector('.ph-prog');
    const dv = status && status.devices.find((d) => d.id === code.id);
    const t = dv && (dv.state === 'paired' ? 'The phone is pairing…' : dv.handshakes ? 'The phone scanned it; finishing…' : '');
    if (p && p.textContent !== (t || '')) p.textContent = t || '';
  }
  function draw() {
    if (!card) return;
    const pair = card.querySelector('.ph-pair');
    // the way, what it needs, and the form (or the code): drawn again only when one of them changes, so typing stays
    const key = JSON.stringify([step, modeNow(), canRelay(), answered, !!status, lanAddrs().length, status && status.enabled && !status.signedIn, status && status.connected, status && status.email, busy && step !== 'code']);
    if (pair._key !== key) {
      const name = pair.querySelector('.ph-name');
      const typed = name ? name.value : lastName;
      pair._key = key;
      pair.innerHTML = `<div class="sy-h">${icon('phone', 13)}<b>Pair an iPhone</b></div>`
        + (step === 'form' ? modesHtml() + `<div class="ph-needs">${needsHtml()}</div>` : '')
        + pairHtml();
      const n2 = pair.querySelector('.ph-name');
      if (n2) n2.value = typed;
    }
    drawLive();
    const list = card.querySelector('.ph-list');
    const lh = listHtml();
    const many = status ? status.devices.filter((d) => d.kind !== 'computer' && d.state === 'paired').length : 0;
    if (list._html !== lh) { list.innerHTML = lh ? `<div class="sy-h">${icon('phone', 13)}<b>Phones</b>${many ? `<span class="sy-count">${many}</span>` : ''}</div>${lh}` : ''; list._html = lh; list.hidden = !lh; }
    const nt = card.querySelector('.sy-note');
    const text = note ? note.text : '';
    if (nt.textContent !== text) nt.textContent = text;
    nt.className = `sy-note${note && note.bad ? ' bad' : ''}`;
    nt.hidden = !note;
  }

  // ---------- what it does ----------
  async function act(url, body) {
    busy = true;
    draw();
    const r = await Promise.resolve(post(url, body)).catch(() => null);
    busy = false;
    if (!r) note = { text: 'Fleet View did not answer.', bad: true };
    return r;
  }
  async function pair(name) {
    if (busy || !card) return;
    note = null;
    const my = gen, m = modeNow();
    const r = await act('/relay/pair', { ...(name ? { name } : {}), mode: m });
    if (my !== gen || !card) return;
    if (r && r.ok && r.svg && r.exp) {
      code = { id: r.id, name: name || 'iPhone', svg: r.svg, exp: r.exp, mode: r.mode || m };
      step = 'code';
      clearInterval(tick);
      tick = setInterval(drawLive, 1000);
      await refresh();
      schedule();
      return;
    }
    if (r) note = { text: r.message || 'No code was made.', bad: true };
    draw();
  }
  async function onClick(ev) {
    const b = ev.target.closest('button[data-c]');
    if (!b || !card) return;
    const c = b.dataset.c;
    if (c === 'sync') { close(); openSync?.(); return; }
    if (c === 'new') { await pair(lastName); return; }
    if (c === 'mode') { mode = b.dataset.m === 'relay' ? 'relay' : 'local'; note = null; }
    else if (c === 'again') { step = 'form'; note = null; }
    else if (c === 'remove') { confirmId = b.dataset.id; note = null; }
    else if (c === 'keep') confirmId = null;
    else if (c === 'do-remove') {
      if (busy) return;
      const id = b.dataset.id;
      const r = await act('/relay/revoke', { id });
      if (!card) return;
      confirmId = null;
      if (r && r.ok) note = { text: 'Removed.' };
      else if (r) note = { text: r.message || 'It was not removed.', bad: true };
      await refresh();
    }
    draw();
  }
  async function onSubmit(ev) {
    ev.preventDefault();
    const f = ev.target.closest('.ph-form');
    if (!f || busy) return;
    lastName = f.querySelector('.ph-name').value.trim();
    await pair(lastName);
  }

  function open() {
    if (card) return;
    gen++;
    answered = false; status = null; code = null; step = 'form'; pairedName = ''; confirmId = null; busy = false; note = null; mode = null;
    card = document.createElement('div');
    card.className = 'uw-pop sy-pop ph-pop';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Pair an iPhone');
    card.tabIndex = -1;
    card.innerHTML = `<div class="uw-top"><span class="uw-title">${icon('phone', 14)}<b>iPhone</b></span><span class="uw-sub">the Fleet View app</span>`
      + `<button type="button" class="uw-x" aria-label="close" title="close (Esc)">${icon('close', 13)}</button></div>`
      + '<div class="uw-scroll"><div class="sy-sec ph-pair"></div><div class="sy-sec ph-list" hidden></div>'
      + '<div class="sy-note" hidden aria-live="polite"></div></div>'
      + '<div class="uw-foot">Each phone gets its own key with this PC when it pairs; Remove forgets it here and on the phone.</div>';
    document.body.appendChild(card);
    draw();
    card.addEventListener('click', (ev) => { if (ev.target.closest('.uw-x')) close(); else onClick(ev); });
    card.addEventListener('submit', onSubmit);
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } });
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    document.addEventListener('keydown', escKey, true);
    card.focus({ preventScroll: true });
    refresh();
  }
  function close() {
    if (!card) return;
    clearTimeout(timer);
    timer = null;
    drop('form');
    gen++;
    card.remove();
    card = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escKey, true);
  }
  const outside = (ev) => { if (card && !card.contains(ev.target) && !ev.target.closest('.count.phone')) close(); };
  const escKey = (ev) => { if (ev.key === 'Escape' && card) { ev.stopPropagation(); ev.preventDefault(); close(); } };

  // the header button shows only on this PC (the routes answer nowhere else), with or without sync: a phone can always
  // pair on this Wi-Fi. Asked once
  if (!fixture && !isRemote()) get('/relay/status').then((st) => { if (st && Array.isArray(st.devices)) document.body.classList.add('phone-on'); });

  return { open, close, isOpen: () => !!card, toggle: () => (card ? close() : open()) };
}
