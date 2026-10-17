// Fleet View web: where a workspace's work stays (fleet-view.js hostRules, host-rules.js; Henry, 2026-10-12: Blender
// work stays on BlackBox). Every chat stays on the machine that runs it (Henry, 2026-10-13; 2026-10-17: chats never
// move between machines, so nothing in the page offers to continue one on another); a rule's pin says why it is there.
//
//   openKeeps({ root, name, color, rules(), save(list), toast? }): the sheet "Never continue on another machine…" on a workspace's
//     right-click menu (app.js) opens, for that workspace's one rule (id ws-<slug of its folder's name>, or the rule its
//     repo already has, like the configurator's default). Its fields: the machine (this device and every one sync knows,
//     by name; the rule keeps both its name, host, and its sync device id, hostDevice), the files that stay (globs, one
//     per line), the tools that pin a chat (one per line, a trailing * for a prefix), "Pin a chat when it…" (pinOn in
//     plain words) and a note. Save puts the whole list through save (POST /settings { hostRules }: it syncs as the
//     hostRules group); "Stop keeping it on a machine" takes the rule out. A live line under the fields says what the
//     draft would do here: "Would pin 2 chats, keeps 48 files" (GET /rules/preview, 350 ms after the last change).
//     Rules with no repo (the Blender one: its tools in any workspace) are not a workspace's: each sheet lists them,
//     read only, under "Also in every workspace".
//   setRules(list): the rules as /state's settings.hostRules has them now (app.js, every poll), for pinText
//   pinText(pin) -> "Stays on BlackBox: it used Blender (mcp__blender__execute_blender_code), 2 h ago": why a chat is
//     pinned, from /state's workspace.pin ({ rule, host, why?, manual? }; why only where it runs: elsewhere the synced
//     rule's note, tools or paths say it)
//   setPin(id, mode) -> Promise { ok, message? }: POST /sync/pin { id, mode: 'free' | 'stay' | 'clear' } (the page's
//     "Unpin and continue on this machine" used it; nothing calls it now that chats never move, Henry 2026-10-17)
// Controls use data-kp, never data-c or data-act (app.js takes those clicks).
import { esc } from './cards.js';
import { icon } from './icons.js';

const PREVIEW_MS = 350;
const PIN_ON = [
  { k: 'tools', label: 'uses these tools' },
  { k: 'edits', label: 'uses these tools or edits these files' },
  { k: 'any', label: 'uses them, edits them, or names them in a command' },
  { k: 'none', label: 'never: only the files stay' },
];
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const lines = (v) => [...new Set(String(v || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];
const lower = (s) => String(s || '').toLowerCase();

// ---------- why a chat is pinned ----------
let rulesNow = [];
export function setRules(list) { rulesNow = Array.isArray(list) ? list : []; }
function agoText(t) {
  const s = Math.max(0, Math.round((Date.now() - Number(t)) / 1000));
  if (!Number(t)) return '';
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}
// a tool's name as said: an MCP tool by its server ("Blender (mcp__blender__…)"), the rest as they are
function toolText(t) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(String(t || ''));
  if (!m) return String(t || '');
  const srv = m[1].replace(/[-_]+/g, ' ').trim();
  return `${srv.charAt(0).toUpperCase()}${srv.slice(1)} (${t})`;
}
export function pinWhy(pin) {
  if (!pin) return '';
  if (pin.manual) return 'you chose to keep it there';
  const w = pin.why;
  if (w) {
    const when = agoText(w.at);
    const what = w.kind === 'write' && w.path ? `it edited ${w.path}` : w.kind === 'shell' && w.path ? `it named ${w.path} in a command`
      : w.path ? `it worked on ${w.path}` : `it used ${toolText(w.tool)}`;
    return when ? `${what}, ${when}` : what;
  }
  const r = rulesNow.find((x) => x && x.id === pin.rule);
  if (r && r.note) return r.note;
  if (r && r.tools && r.tools.length) return `it used ${r.tools.join(', ')}`;
  if (r && r.paths && r.paths.length) return `it works on ${r.paths.slice(0, 2).join(', ')}${r.paths.length > 2 ? '…' : ''}`;
  return 'a stays-on rule keeps it there';
}
export const pinText = (pin) => (pin ? `Stays on ${pin.host}: ${pinWhy(pin)}` : '');

// ---------- a chat's own choice ----------
export async function setPin(id, mode) {
  try {
    const r = await fetch('/sync/pin', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, mode }) });
    const j = await r.json().catch(() => null);
    return r.ok && j && j.ok ? { ok: true, ...j } : { ok: false, message: (j && j.message) || `Fleet View answered ${r.status}` };
  } catch { return { ok: false, message: 'Fleet View did not answer' }; }
}

// ---------- the sheet ----------
async function getJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json().catch(() => null);
    return r.ok && j && j.ok ? j : null;
  } catch { return null; }
}
let cssAdded = false;
function addCss() {
  if (cssAdded) return;
  cssAdded = true;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = 'keeps.css';
  l.onerror = () => l.remove();
  document.head.appendChild(l);
}
let open = null; // the sheet on show: { card, close }

export function openKeeps(o) {
  if (open) open.close();
  addCss();
  const card = document.createElement('div');
  card.className = 'uw-pop sy-pop kp-pop';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', `Never continue on another machine: ${o.name}`);
  card.tabIndex = -1;
  document.body.appendChild(card);
  let ws = null, busy = false, timer = 0, gen = 0, preview = null, closed = false;
  const rules = () => (typeof o.rules === 'function' ? o.rules() || [] : []);
  const mine = () => (ws ? rules().find((r) => r.id === ws.rule) || null : null);
  const close = () => { if (closed) return; closed = true; clearTimeout(timer); card.remove(); document.removeEventListener('mousedown', outside, true); if (open && open.card === card) open = null; };
  const outside = (ev) => { if (!card.contains(ev.target)) close(); };
  open = { card, close };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  card.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } ev.stopPropagation(); });
  card.addEventListener('click', onClick);
  card.addEventListener('input', () => schedule());
  card.addEventListener('change', () => schedule());

  const head = () => `<div class="uw-top"><span class="uw-title">${icon('pin', 14)}<b>Never continue on another machine</b><span class="sy-dim kp-ws">${esc(o.name)}</span></span>`
    + `<button type="button" class="uw-x" data-kp="close" aria-label="close" title="close (Esc)">${icon('close', 13)}</button></div>`;
  card.innerHTML = `${head()}<div class="uw-scroll"><div class="sy-sec"><div class="sy-line sy-dim">Reading this workspace…</div></div></div>`;

  // the machines: this one first, then every other one sync knows; the rule's own host is always there
  let machines = [];
  function machineOptions(r) {
    machines = [];
    if (ws.me) machines.push({ id: ws.me.id, name: ws.me.name, me: true });
    for (const m of ws.machines || []) machines.push(m);
    const isIt = (m) => !!r && (r.hostDevice && m.id ? lower(m.id) === lower(r.hostDevice) : lower(m.name) === lower(r.host));
    if (r && !machines.some(isIt)) machines.push({ id: r.hostDevice || null, name: r.host });
    const pick = Math.max(0, machines.findIndex(isIt));
    return machines.map((m, i) => `<option value="${i}"${i === pick ? ' selected' : ''}>${esc(m.me ? `This machine (${m.name})` : m.name)}</option>`).join('');
  }
  function draw() {
    if (closed) return;
    const r = mine();
    const on = (r && r.pinOn) || 'any';
    const everywhere = rules().filter((x) => x && !x.repo);
    const evHtml = everywhere.length ? `<div class="sy-sec"><div class="sy-h"><b>Also in every workspace</b></div>`
      // its note, then what it keeps (the host too, unless the note already names it)
      + everywhere.map((x) => `<div class="sy-line kp-ev"><span>${esc(x.note || x.id)}</span> <span class="sy-dim">${[
        ...(x.note && lower(x.note).includes(lower(x.host)) ? [] : [`on ${x.host}`]), ...x.tools, ...x.paths].map(esc).join(' · ')}</span></div>`).join('')
      + '</div>' : '';
    if (!ws.repo) {
      card.innerHTML = `${head()}<div class="uw-scroll"><div class="sy-sec"><div class="sy-line">This folder is in no repo, so it has nothing to keep on one machine.</div></div>${evHtml}</div>`;
      return;
    }
    card.innerHTML = `${head()}<div class="uw-scroll"><div class="sy-sec kp-form">`
      + `<label class="kp-f"><span class="sy-dim">Machine</span><select class="kp-host">${machineOptions(r)}</select></label>`
      + `<label class="kp-f kp-col"><span class="sy-dim">Files that stay there, one per line</span><textarea class="kp-paths" rows="3" spellcheck="false" placeholder="assets/vehicles/**&#10;**/*.blend">${esc(r ? r.paths.join('\n') : '')}</textarea></label>`
      + `<label class="kp-f kp-col"><span class="sy-dim">Tools that pin a chat there, one per line</span><textarea class="kp-tools" rows="2" spellcheck="false" placeholder="mcp__blender*">${esc(r ? r.tools.join('\n') : '')}</textarea></label>`
      + `<label class="kp-f kp-col"><span class="sy-dim">Pin a chat there when it</span><select class="kp-on">${PIN_ON.map((p) => `<option value="${p.k}"${p.k === on ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>`
      + `<label class="kp-f"><span class="sy-dim">Note</span><input type="text" class="kp-note" maxlength="300" placeholder="why it stays there" value="${esc((r && r.note) || '')}"></label>`
      + '<div class="sy-line kp-prev" aria-live="polite"></div>'
      + `<div class="sy-btns"><button type="button" data-kp="save" class="sy-go"${busy ? ' disabled' : ''}>Save</button><button type="button" data-kp="close">Cancel</button>`
      + (r ? `<button type="button" data-kp="stop" class="sy-danger kp-stop"${busy ? ' disabled' : ''}>Stop keeping it on a machine</button>` : '') + '</div>'
      + '<div class="sy-line sy-bad kp-msg" hidden></div>'
      + '</div>' + evHtml + '</div>'
      + '<div class="uw-foot">A pinned chat stays on that machine: what you type to it elsewhere goes there. The files stay there too.</div>';
    drawPreview();
    schedule(0);
  }
  // the draft as the fields say it, or null with no paths and no tools
  function draft() {
    const q = (c) => card.querySelector(c);
    if (!q('.kp-host')) return null;
    const m = machines[Number(q('.kp-host').value)] || machines[0] || null;
    const paths = lines(q('.kp-paths').value).slice(0, 20), tools = lines(q('.kp-tools').value).slice(0, 20);
    const on = q('.kp-on').value, text = q('.kp-note').value.trim();
    return {
      id: ws.rule || ws.id, repo: ws.repo, paths, tools, host: m ? m.name : '', ...(m && m.id ? { hostDevice: m.id } : {}),
      ...(on && on !== 'any' ? { pinOn: on } : {}), ...(text ? { note: text.slice(0, 300) } : {}),
    };
  }
  function drawPreview() {
    const el = card.querySelector('.kp-prev');
    if (!el) return;
    const d = draft();
    if (d && !d.paths.length && !d.tools.length) { el.innerHTML = '<span class="sy-dim">Give it files or tools to keep there.</span>'; return; }
    if (!preview) { el.innerHTML = '<span class="sy-dim">Counting…</span>'; return; }
    const p = preview;
    const pins = d && d.pinOn === 'none' ? 'Pins no chat' : `Would pin ${n(p.pins, 'chat', 'chats')}`;
    const files = p.files == null ? 'the files can\'t be counted here' : `keeps ${p.more ? `${p.files}+` : p.files} ${p.files === 1 && !p.more ? 'file' : 'files'}`;
    const names = (p.chats || []).map((c) => c.name).filter(Boolean);
    el.innerHTML = `<b>${esc(pins)}, ${esc(files)}</b>`
      + (names.length ? `<div class="sy-dim kp-chats">${esc(names.join(', '))}${p.pins > names.length ? ` and ${p.pins - names.length} more` : ''}</div>` : '');
  }
  function schedule(ms = PREVIEW_MS) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const d = draft();
      if (!d || closed) return;
      if (!d.paths.length && !d.tools.length) { preview = null; drawPreview(); return; }
      const my = ++gen;
      const j = await getJson(`/rules/preview?rule=${encodeURIComponent(JSON.stringify(d))}&root=${encodeURIComponent(o.root)}`);
      if (my !== gen || closed) return;
      preview = j || { pins: 0, chats: [], files: null };
      drawPreview();
    }, ms);
  }
  // a line under the buttons saying what is wrong (the fields keep what was typed)
  function say(text) {
    const el = card.querySelector('.kp-msg');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }
  function save(list, done) {
    busy = true;
    say('');
    Promise.resolve(o.save(list)).then(() => { busy = false; done(); }, (e) => { busy = false; say((e && e.message) || 'It was not saved'); });
  }
  function onClick(ev) {
    const b = ev.target.closest('[data-kp]');
    if (!b) return;
    const c = b.dataset.kp;
    if (c === 'close') { close(); return; }
    if (busy) return;
    if (c === 'save') {
      const d = draft();
      if (!d) return;
      if (!d.host) { say('Pick a machine'); return; }
      if (!d.paths.length && !d.tools.length) { say('Give it files or tools to keep there'); return; }
      if (d.tools.some((t) => !/^[A-Za-z0-9_.*-]{1,80}$/.test(t))) { say('A tool is a name like mcp__blender*: letters, digits, _ . - and a trailing *'); return; }
      const now = rules();
      const list = now.some((r) => r.id === d.id) ? now.map((r) => (r.id === d.id ? d : r)) : [...now, d];
      save(list, () => { close(); if (o.toast) o.toast(`${o.name}: kept on ${d.host}`); });
      return;
    }
    if (c === 'stop') {
      const r = mine();
      if (!r) return;
      save(rules().filter((x) => x.id !== r.id), () => { close(); if (o.toast) o.toast(`${o.name} is no longer kept on a machine`); });
    }
  }
  getJson(`/rules/workspace?root=${encodeURIComponent(o.root)}`).then((j) => {
    if (closed) return;
    if (!j) { card.querySelector('.uw-scroll').innerHTML = '<div class="sy-sec"><div class="sy-line sy-bad">Fleet View did not answer: try again.</div></div>'; return; }
    ws = j;
    draw();
    const f = card.querySelector('.kp-host');
    if (f) f.focus(); else card.focus();
  });
  return { close };
}
