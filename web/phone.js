// Fleet View web: the Pair an iPhone card (the phone relay, relay.js and docs/phone.md). A click on the header's "iPhone"
// button opens it under the header at the right, like the Sync card; Esc, its × or a click outside closes it. The
// routes answer on this PC only, so a remote browser never shows the button.
//
// It shows:
//   GET /relay/status    read once when the card opens, after every action, and every 3 seconds while a pairing code
//                        is on screen (never while the card is closed): signed in or not, whether the relay's socket
//                        is up, and the paired phones (name, the phone and app, last seen, its channel)
// and does:
//   Pair an iPhone       POST /relay/pair { name }: the answer's QR code (the server's SVG) is shown once and never
//                        asked for again; a countdown runs to its exp (10 minutes), then the code goes and "Make a new
//                        code" shows. Once status says that device is paired and finished: "Paired: <name>".
//   Remove               POST /relay/revoke { id }, after a second click in the card (the phone is told, then forgotten)
// Not signed in to sync: the phone signs in with the same account, so the card points to the Sync card instead.
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

export function mountPhone({ post, isRemote = () => false, fixture = false, openSync = null } = {}) {
  let card = null, timer = null, tick = null, gen = 0;
  let status = null, answered = false;
  // the code on screen: { id, name, svg, exp }; step says what the pairing section shows
  let code = null, step = 'form', pairedName = '';
  let lastName = ''; // the name field's last value, for "Make a new code"
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
  function signedIn() { return !!(status && status.enabled && status.signedIn); }
  function accountHtml() {
    if (!answered) return '<div class="sy-line sy-dim">Reading…</div>';
    if (!status) return '<div class="sy-line sy-bad">Fleet View did not answer.</div>';
    if (!status.enabled || !status.signedIn) {
      return `<div class="sy-line">${status.enabled ? 'Sync is not signed in on this PC.' : 'Sync is not set up on this PC.'}</div>`
        + '<div class="sy-line sy-dim">The phone signs in with the same Google account as conversation sync, and reaches this PC through it. Sign in to sync first.</div>'
        + (openSync ? '<div class="sy-btns"><button type="button" data-c="sync" class="sy-go">Open Sync</button></div>' : '');
    }
    return `<div class="sy-who"><span class="sy-email" title="${esc(status.email || '')}">Signed in as <b>${esc(status.email || 'your Google account')}</b></span>`
      + `<span class="uw-chip ${status.connected ? 'here' : ''}">${status.connected ? 'relay connected' : 'relay not connected'}</span></div>`;
  }
  function pairHtml() {
    if (step === 'paired') {
      return `<div class="ph-done">${icon('check', 16)}<span>Paired: <b>${esc(pairedName)}</b></span></div>`
        + '<div class="sy-btns"><button type="button" data-c="again">Pair another</button></div>';
    }
    if (step === 'code' && code) {
      return `<div class="ph-qr">${code.svg}</div>`
        + '<div class="sy-line ph-say">Scan with the Fleet View app. The code works once, for 10 minutes.</div>'
        + `<div class="sy-line sy-dim ph-left">Runs out in <b class="ph-clock">${left(code.exp - Date.now())}</b></div>`
        + '<div class="sy-line sy-dim ph-prog"></div>';
    }
    if (step === 'expired') {
      return '<div class="sy-line">The code ran out.</div>'
        + `<div class="sy-btns"><button type="button" data-c="new" class="sy-go">${icon('phone', 12)}Make a new code</button></div>`;
    }
    return '<form class="sy-form ph-form" autocomplete="off">'
      + '<input type="text" class="ph-name" maxlength="60" placeholder="iPhone" autocomplete="off" spellcheck="false" aria-label="The phone\'s name">'
      + `<button type="submit" class="sy-go">${icon('phone', 12)}Pair an iPhone</button></form>`
      + '<div class="sy-line sy-dim">The name is only for this list. A QR code shows next, for the Fleet View app to scan.</div>';
  }
  function listHtml() {
    if (!signedIn()) return '';
    const t = Date.now();
    const rows = status.devices.filter((d) => d.state === 'paired' || (d.state === 'pending' && !(code && d.id === code.id) && d.exp > t));
    if (!rows.length) return '<div class="sy-line sy-dim">No phone is paired yet.</div>';
    return rows.map((d) => {
      const what = [d.device, d.app ? `app ${d.app}` : ''].filter(Boolean).join(' · ');
      const ch = CHANNEL[d.channel] || d.channel || '';
      const sub = d.state === 'pending'
        ? `waiting for the phone, ${left(d.exp - t)} left${d.handshakes ? ' (scanned, finishing)' : ''}`
        : [d.lastSeen ? `seen ${ago(d.lastSeen)}` : 'not seen yet', ch ? `channel ${ch}${d.problem ? `: ${d.problem}` : ''}` : '', d.finished === false ? 'finishing pairing' : ''].filter(Boolean).join(' · ');
      const head = `<div class="ph-row"><span class="ph-dev">${icon('phone', 13)}<b>${esc(d.name)}</b>${what ? `<span class="sy-dim">${esc(what)}</span>` : ''}</span>`
        + (confirmId === d.id ? '' : `<button type="button" data-c="remove" data-id="${esc(d.id)}"${busy ? ' disabled' : ''}>${d.state === 'pending' ? 'Cancel' : 'Remove'}</button>`) + '</div>'
        + `<div class="sy-line sy-dim ${d.channel === 'refused' ? 'sy-bad' : ''}">${esc(sub)}</div>`;
      const conf = confirmId !== d.id ? '' : '<div class="sy-confirm"><div>'
        + (d.state === 'pending' ? `Cancel the pairing for ${esc(d.name)}? Its code stops working.` : `Remove ${esc(d.name)}? The phone is told, forgets this PC, and has to pair again.`)
        + `</div><div class="sy-btns"><button type="button" data-c="do-remove" data-id="${esc(d.id)}" class="sy-danger"${busy ? ' disabled' : ''}>${d.state === 'pending' ? 'Cancel it' : 'Remove'}</button>`
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
    const main = card.querySelector('.ph-main');
    const html = `<section class="sy-sec">${accountHtml()}</section>`;
    if (main._html !== html) { main.innerHTML = html; main._html = html; }
    const pair = card.querySelector('.ph-pair');
    const ps = signedIn() ? step : null;
    if (pair._step !== ps) {
      pair._step = ps;
      pair.hidden = !ps;
      pair.innerHTML = ps ? `<div class="sy-h">${icon('phone', 13)}<b>Pair an iPhone</b></div>${pairHtml()}` : '';
    }
    drawLive();
    const list = card.querySelector('.ph-list');
    const lh = listHtml();
    if (list._html !== lh) { list.innerHTML = lh ? `<div class="sy-h">${icon('phone', 13)}<b>Phones</b></div>${lh}` : ''; list._html = lh; list.hidden = !lh; }
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
    const my = gen;
    const r = await act('/relay/pair', name ? { name } : {});
    if (my !== gen || !card) return;
    if (r && r.ok && r.svg && r.exp) {
      code = { id: r.id, name: name || 'iPhone', svg: r.svg, exp: r.exp };
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
    if (c === 'again') { step = 'form'; note = null; }
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
    answered = false; status = null; code = null; step = 'form'; pairedName = ''; confirmId = null; busy = false; note = null;
    card = document.createElement('div');
    card.className = 'uw-pop sy-pop ph-pop';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Pair an iPhone');
    card.tabIndex = -1;
    card.innerHTML = `<div class="uw-top"><span class="uw-title">${icon('phone', 14)}<b>iPhone</b></span><span class="uw-sub">the Fleet View app, through sync</span>`
      + `<button type="button" class="uw-x" aria-label="close" title="close (Esc)">${icon('close', 13)}</button></div>`
      + '<div class="uw-scroll"><div class="ph-main"></div><div class="sy-sec ph-pair" hidden></div><div class="sy-sec ph-list" hidden></div>'
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

  // the header button shows only on this PC, where sync is set up (the phone reaches the PC through it): asked once
  if (!fixture && !isRemote()) get('/relay/status').then((st) => { if (st && st.enabled) document.body.classList.add('phone-on'); });

  return { open, close, isOpen: () => !!card, toggle: () => (card ? close() : open()) };
}
