// Detail panel: everything about one conversation, in a panel on the right. Built once, then patched
// section by section on every poll, so its scroll position (and the reply box's) stays where you left it.
// Links inside it ([data-act]) are handled by the shell in app.js, like the ones in cards and tiles.
// Two tabs: Session (the live Claude Code session, term.js) and Details (everything below). In the desktop
// window every conversation opens on Session (Edge, which can't run one, opens on Details); the tab picked
// stays until another conversation is shown, and nothing is remembered per conversation. A pick by click
// (ui.takeIntent) starts the session there by itself, as a preview: see term.js. Three buttons place the panel
// (kept per user): docked on the left, floating (the default), or docked on the right. Floating, it is a card beside
// the conversation that was picked, over the view: its header moves it and its edges and corners resize it. Docked,
// its inner edge sets its width. Both sizes are kept per user.
import {
  C, esc, setHTML, setIcon, badge, acctTag, ctxGauge, shipTrack, planSteps, needsYou, isBusy, ago, fmtTok, fmtCost,
  repoChip, linksOf, urlLink, revealLink, turnText, clockTime, setText, statusColor, waitNote, modelName, handoffBits,
} from './cards.js';
import { icon, verbIcon } from './icons.js';
import { renderSessionPane, isHosted, isPreview, openElsewhere, endPreviews, termApi, ensureLive, onRekey } from './term.js';
import { renderChatPane, copyBtn, copyText } from './chat.js';
import { renderChangesPane } from './changes.js';
import { renderPreviewPane } from './preview.js';
import { mapNodes } from './map.js';

const SLOTS = ['icon', 'head', 'meta', 'note', 'wait', 'replyk', 'plan', 'ship', 'files', 'calls', 'usage'];
const REPLY_MAX = 4000;
// minutes only, so the list is not rewritten every second (a click mid-rewrite would be lost)
const coarseAgo = (ms) => (ms < 60e3 ? 'now' : ago(ms));

// a new conversation got its id (after its first message): still the same one, so the panel stays on its tab and
// where it was scrolled, instead of starting over as if another conversation had been picked
const built = new Set();
onRekey((oldKey, id) => { for (const el of built) if (el._id === oldKey) el._id = id; });

function build(el, ui) {
  el.innerHTML = `<div class="d-top"><span data-slot="icon" class="c-icon"></span><div data-slot="head" class="d-head"></div>
<button type="button" class="d-close" data-close title="close (Esc)" aria-label="close the panel">${icon('close', 16)}</button></div>
<div class="d-tabs" role="tablist" aria-label="panel">
  <button type="button" role="tab" class="d-tab" data-tab="chat"><span class="d-tab-t">Chat</span></button>
  <button type="button" role="tab" class="d-tab" data-tab="session"><span class="d-tab-t">Session</span><span class="d-here" title="running in Fleet View" hidden></span></button>
  <button type="button" role="tab" class="d-tab" data-tab="changes"><span class="d-tab-t">Changes</span></button>
  <button type="button" role="tab" class="d-tab" data-tab="preview"><span class="d-tab-t">Preview</span></button>
  <button type="button" role="tab" class="d-tab" data-tab="details"><span class="d-tab-t">Details</span></button>
  <span class="grow"></span>
  <span class="d-preview" hidden>preview — closes when you move on unless you type</span>
  <span class="d-place" role="group" aria-label="where the panel goes">${PLACES.map(([p, ic, t]) => `<button type="button" class="d-wide" data-place="${p}" title="${t}" aria-label="${t}">${icon(ic, 14)}</button>`).join('')}</span>
</div>
<div class="d-chat" role="tabpanel" hidden></div>
<div class="d-session" role="tabpanel" hidden></div>
<div class="d-changes" role="tabpanel" hidden></div>
<div class="d-previewpane" role="tabpanel" hidden></div>
<div class="d-body" role="tabpanel">
  <div data-slot="meta" class="d-meta"></div>
  <div class="d-open"><button type="button" class="btn primary d-open-btn" data-open>${icon('open', 15)}<span>Open conversation</span></button><span data-slot="note" class="d-note"></span></div>
  <div data-slot="wait" class="c-wait d-wait"></div>
  <section class="d-sec d-reply-sec"><div data-slot="replyk" class="d-hslot"></div><div class="cp-box d-reply-box"><div class="d-reply md" tabindex="0"></div>${copyBtn('reply', 'Copy reply')}</div></section>
  <section data-slot="plan" class="d-sec"></section>
  <section data-slot="ship" class="d-sec"></section>
  <section data-slot="files" class="d-sec"></section>
  <section data-slot="calls" class="d-sec"></section>
  <section data-slot="usage" class="d-sec"></section>
</div>${GRIPS.map((d) => `<div class="d-grip d-grip-${d}" data-grip="${d}" aria-hidden="true"></div>`).join('')}`;
  el._slots = {};
  for (const k of SLOTS) el._slots[k] = el.querySelector(`[data-slot="${k}"]`);
  el._body = el.querySelector('.d-body');
  el._reply = el.querySelector('.d-reply');
  el._replySec = el.querySelector('.d-reply-sec');
  el._session = el.querySelector('.d-session');
  el._chat = el.querySelector('.d-chat');
  el._changes = el.querySelector('.d-changes');
  el._previewPane = el.querySelector('.d-previewpane');
  // review comments (Changes) or a screenshot (Preview) handed to the chat box: show the Chat tab (see handto.js)
  window.addEventListener('fv-handto', (e) => { if (e.detail && e.detail.id === el._id) { el._tab = 'chat'; el._tabPicked = true; ui.showDetail(el._id); } });
  el._tabs = [...el.querySelectorAll('.d-tab')];
  el._here = el.querySelector('.d-here');
  el._placeBtns = [...el.querySelectorAll('[data-place]')];
  el._previewHint = el.querySelector('.d-preview');
  // the title renames the conversation in place: a double-click on it, its pencil, or F2 anywhere in the panel
  // but the live terminal (whose keys are Claude's)
  el._slots.head.addEventListener('dblclick', (e) => { if (e.target.closest('.name')) { e.preventDefault(); startRename(el, ui); } });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'F2' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.target.closest?.('.term-host')) return;
    e.preventDefault();
    startRename(el, ui);
  });
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-rename]')) { startRename(el, ui); return; }
    const tab = e.target.closest('[data-tab]');
    const cp = e.target.closest('[data-cp="reply"]');
    if (cp) copyText(el._replyFull || '', cp);
    else if (e.target.closest('[data-close]')) ui.showDetail(null);
    else if (e.target.closest('[data-open]') && el._id) (ui.openTerminal || ui.open)(el._id);
    else if (tab) { el._tab = tab.dataset.tab; el._tabPicked = true; ui.showDetail(el._id); if (el._tab === 'session') focusTerm(el); else if (el._tab === 'chat') focusCompose(el); }
    else if (e.target.closest('[data-place]')) { setPlace(e.target.closest('[data-place]').dataset.place); el._placed = null; ui.showDetail(el._id); }
  });
  // the floating card moves by its header (not by its buttons or links), and stays inside the area under the header
  el.querySelector('.d-top').addEventListener('pointerdown', (e) => {
    const work = el.closest('.work');
    if (!float || e.button !== 0 || !work || e.target.closest('button, a, input, textarea, [data-act]')) return;
    e.preventDefault();
    const wr = work.getBoundingClientRect(), r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const top = e.currentTarget;
    top.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const move = (m) => {
      const x = Math.max(EDGE, Math.min(m.clientX - dx - wr.left, wr.width - r.width - EDGE));
      const y = Math.max(EDGE, Math.min(m.clientY - dy - wr.top, wr.height - r.height - EDGE));
      el.style.setProperty('--fx', `${Math.round(x)}px`);
      el.style.setProperty('--fy', `${Math.round(y)}px`);
    };
    const end = () => { el.classList.remove('dragging'); top.removeEventListener('pointermove', move); top.removeEventListener('pointerup', end); top.removeEventListener('pointercancel', end); };
    top.addEventListener('pointermove', move);
    top.addEventListener('pointerup', end);
    top.addEventListener('pointercancel', end);
  });
  // an edge or a corner resizes the floating card, the opposite side staying put, inside the area under the header.
  // Docked, only the inner edge shows a grip, and it sets the panel's width (--detail-w on .work)
  el.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    const work = el.closest('.work');
    if (!grip || e.button !== 0 || !work) return;
    e.preventDefault();
    const d = grip.dataset.grip;
    const wr = work.getBoundingClientRect(), r = el.getBoundingClientRect();
    const x0 = r.left - wr.left, y0 = r.top - wr.top, x1 = r.right - wr.left, y1 = r.bottom - wr.top;
    grip.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    work.classList.add('detail-sizing');
    const dock = (m) => {
      // the docked card sits 12px in from the window's edge and is 22px narrower than --detail-w
      const w = left ? m.clientX - wr.left + 10 : wr.right - m.clientX + 10;
      dockW = Math.round(Math.max(DOCK_MIN, Math.min(w, wr.width * 0.8)));
      work.style.setProperty('--detail-w', `${dockW}px`);
    };
    const move = float ? (m) => {
      const px = m.clientX - wr.left, py = m.clientY - wr.top;
      let l = x0, t = y0, rt = x1, b = y1;
      if (d.includes('w')) l = Math.max(EDGE, Math.min(px, x1 - MIN_W));
      if (d.includes('e')) rt = Math.min(wr.width - EDGE, Math.max(px, x0 + MIN_W));
      if (d.includes('n')) t = Math.max(EDGE, Math.min(py, y1 - MIN_H));
      if (d.includes('s')) b = Math.min(wr.height - EDGE, Math.max(py, y0 + MIN_H));
      el.style.setProperty('--fx', `${Math.round(l)}px`);
      el.style.setProperty('--fy', `${Math.round(t)}px`);
      el.style.setProperty('--fw', `${Math.round(rt - l)}px`);
      el.style.setProperty('--fh', `${Math.round(b - t)}px`);
      floatSize = { w: Math.round(rt - l), h: Math.round(b - t) };
    } : dock;
    const end = () => {
      el.classList.remove('dragging');
      work.classList.remove('detail-sizing');
      try { if (float) localStorage.setItem('fv.floatSize', JSON.stringify(floatSize)); else if (dockW) localStorage.setItem('fv.dockW', String(dockW)); } catch {}
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', end); grip.removeEventListener('pointercancel', end);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });
  el._built = true;
  built.add(el);
}

// where the panel goes: 'left' or 'right' (docked, full height) or 'float' (the card beside the picked conversation),
// remembered in this window's storage (per user; Edge and the desktop window each keep their own). The older
// fv.detailFloat / fv.detailLeft keys seed it once.
const PLACES = [
  ['left', 'panelLeft', 'dock the panel on the left of the window'],
  ['float', 'floatWin', 'float the panel beside the conversation you pick'],
  ['right', 'panelRight', 'dock the panel on the right of the window'],
];
let place = 'float';
try {
  const v = localStorage.getItem('fv.detailPlace');
  place = v === 'left' || v === 'right' || v === 'float' ? v
    : localStorage.getItem('fv.detailFloat') === '0' ? (localStorage.getItem('fv.detailLeft') === '1' ? 'left' : 'right') : 'float';
} catch {}
let float = place === 'float', left = place === 'left';
function setPlace(p) {
  place = p; float = p === 'float'; left = p === 'left';
  try { localStorage.setItem('fv.detailPlace', p); } catch {}
}
// the docked panel's width, as last dragged by its inner edge (null: the default --detail-w)
const DOCK_MIN = 380;
let dockW = null;
try { const v = Number(localStorage.getItem('fv.dockW')); if (v >= DOCK_MIN) dockW = v; } catch {}
// the floating card's size as last resized by hand, remembered the same way
let floatSize = null;
try { const v = JSON.parse(localStorage.getItem('fv.floatSize') || 'null'); if (v && v.w > 0 && v.h > 0) floatSize = v; } catch {}
// where the last press was: a pick by mouse puts the card right where you clicked
let lastPress = null;
document.addEventListener('pointerdown', (e) => { lastPress = { x: e.clientX, y: e.clientY, t: performance.now() }; }, true);
const FLOAT_W = 460, FLOAT_H = 600, GAP = 10, EDGE = 8, MIN_W = 320, MIN_H = 240;
const GRIPS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
// put the floating card next to where the conversation was picked: beside the click (a pick by mouse), else
// beside its map node, card, tile or row (right of it if it fits, else left); kept inside the area under the header
function anchorOf(el, id, byMouse) {
  if (byMouse && lastPress && performance.now() - lastPress.t < 1500) return { left: lastPress.x - 16, right: lastPress.x + 16, top: lastPress.y - 24 };
  const node = document.querySelector('#view-map:not([hidden])') && mapNodes().find((n) => n.sid === id && !n.ghost);
  if (node) return { left: node.cx - 22, right: node.cx + 22, top: node.cy - 40 };
  const sel = `[data-id="${CSS.escape(id)}"]`;
  const a = [...document.querySelectorAll(`main .view:not([hidden]) ${sel}, #finished ${sel}`)].find((x) => x.getClientRects().length && !el.contains(x));
  return a?.getBoundingClientRect() || null;
}
function placeFloat(el, work, id, byMouse) {
  const wr = work.getBoundingClientRect();
  const w = Math.min(floatSize?.w || FLOAT_W, wr.width - 2 * EDGE), h = Math.min(floatSize?.h || FLOAT_H, wr.height - 2 * EDGE);
  const r = anchorOf(el, id, byMouse);
  let x, y;
  if (!r) { x = wr.width - w - EDGE; y = EDGE; } else {
    x = r.right + GAP + w <= wr.right - EDGE ? r.right + GAP - wr.left : r.left - GAP - w >= wr.left + EDGE ? r.left - GAP - w - wr.left : r.right + GAP - wr.left;
    y = r.top - wr.top;
  }
  x = Math.max(EDGE, Math.min(x, wr.width - w - EDGE));
  y = Math.max(EDGE, Math.min(y, wr.height - h - EDGE));
  el.style.setProperty('--fx', `${Math.round(x)}px`);
  el.style.setProperty('--fy', `${Math.round(y)}px`);
  el.style.setProperty('--fw', `${Math.round(w)}px`);
  el.style.setProperty('--fh', `${Math.round(h)}px`);
  el._placed = id;
}
const focusCompose = (el) => requestAnimationFrame(() => el._chat.querySelector('.chat-compose textarea')?.focus());
const focusTerm = (el) => requestAnimationFrame(() => el._session.querySelector('.term-host textarea')?.focus());

const head = (ic, text, extra = '') => `<h4>${icon(ic, 13)}<span>${text}</span>${extra ? ` <span class="h-extra">${extra}</span>` : ''}</h4>`;
const STATE_WORD = { done: ['ad-done', 'done', 'mint'], fail: ['ad-fail', 'failed', 'red'], run: ['ad-run', 'running', 'violet'] };
const CHECKS = { ok: ['checks passed', 'mint', 'checks'], pending: ['checks running', 'gold', 'clock'], fail: ['checks failed', 'red', 'error'] };

// ---------- the reply, as light markdown ----------
// **bold**, *italic*, `code`, headings (# to ###), - and 1. lists, ``` blocks and line breaks. Every piece
// of text goes through esc(); the only markup is the tags written here.
function inline(t) {
  const re = /`([^`\n]+)`|\*\*(?=\S)(.+?)\*\*|(?<![\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/g;
  let out = '', i = 0, m;
  while ((m = re.exec(t))) {
    out += esc(t.slice(i, m.index));
    if (m[1] != null) out += `<code>${esc(m[1])}</code>`;
    else if (m[2] != null) out += `<strong>${inline(m[2])}</strong>`;
    else out += `<em>${esc(m[3])}</em>`;
    i = re.lastIndex;
  }
  return out + esc(t.slice(i));
}
export function mdHtml(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [], list = null, fence = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ''}>${list.items.join('')}</${list.tag}>`); list = null; } };
  for (const line of lines) {
    if (fence) {
      if (/^\s*```/.test(line)) { out.push(`<pre>${esc(fence.join('\n'))}</pre>`); fence = null; } else fence.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { flushPara(); flushList(); fence = []; continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    let m;
    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      flushPara(); flushList();
      out.push(`<div class="md-h md-h${Math.min(3, m[1].length)}">${inline(m[2])}</div>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const ol = !ul && /^(\s*)(\d{1,4})[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      const depth = Math.min(3, Math.floor((ul || ol)[1].replace(/\t/g, '  ').length / 2));
      if (!list || list.tag !== tag) { flushList(); list = { tag, start: ol ? +ol[2] : 1, items: [] }; }
      list.items.push(`<li${depth ? ` class="d${depth}"` : ''}>${inline(ul ? ul[2] : ol[3])}</li>`);
      continue;
    }
    // a line that continues a list item (indented under it)
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] = list.items[list.items.length - 1].replace(/<\/li>$/, `<br>${inline(line.trim())}</li>`);
      continue;
    }
    flushList();
    // indented lines and table rows keep their columns
    if (/^\s{2,}\S/.test(line) || /^\s*\|.*\|\s*$/.test(line)) { flushPara(); out.push(`<div class="md-pre">${esc(line)}</div>`); continue; }
    para.push(inline(line));
  }
  if (fence) out.push(`<pre>${esc(fence.join('\n'))}</pre>`);
  flushPara(); flushList();
  return out.join('');
}

// ---------- sections ----------
function metaRows(s) {
  const rows = [];
  const row = (ic, k, v) => v && rows.push(`<span class="d-k">${icon(ic, 13)}<span>${k}</span></span><span class="d-v">${v}</span>`);
  row('workspace', 'repo', repoChip(s) || '<span class="dim">no workspace</span>');
  const l = linksOf(s);
  if (s.branch) row('branch', 'branch', `<span class="mono">${urlLink(l.branch, esc(s.branch), `open branch ${s.branch} on GitHub`)}</span>`);
  if (s.worktree) row('worktree', 'worktree', `<span class="mono">${esc(s.worktree)}</span>`);
  if (s.model) row('model', 'model', `<span class="mono">${esc(modelName(s.model))}</span>`);
  if (s.context?.limit) row('tokens', 'context', ctxGauge(s.context, true));
  for (const [k, v] of handoffBits(s)) row('open', k.replace(/ →$/, ''), v);
  // the turn's timer is filled in by turnOf, so the rows (and the links in them) aren't rewritten every second
  row('clock', 'turn', `<span class="num d-turn${isBusy(s.state) ? ' cyan' : ''}"></span>`);
  return rows.join('');
}
const turnOf = (s, now) => turnText(s, now)
  || (s.endedAt ? `finished ${ago(now - s.endedAt)} ago, at ${clockTime(s.endedAt, false)}` : `last active ${ago(now - s.last)} ago`);

function planHtml(s) {
  const agents = s.agents || [];
  if (!s.planSteps?.length && !agents.length) return '';
  const p = s.progress || {};
  let h = head('plan', 'Plan', p.mode === 'plan' ? `${Math.round((Number(p.pct) || 0) * 100)}%` : '');
  if (s.planSteps?.length) h += `<div class="d-line">${planSteps(s.planSteps)}</div>`;
  if (agents.length) {
    h += '<div class="d-agents">' + agents.map((a) => {
      const [cls, word, col] = STATE_WORD[a.state] || STATE_WORD.run;
      return `<i class="ad ${cls}" aria-hidden="true"></i><span class="d-agent">${esc(a.label)}</span><span class="faint">${esc(a.phase || '')}</span><span class="d-aw ${col}">${word}</span>`;
    }).join('') + '</div>';
  }
  return h;
}

function shipHtml(s) {
  const l = linksOf(s);
  const steps = s.ship?.steps || [];
  const pr = s.ship?.pr;
  let h = head('push', 'Ship') + `<div class="d-line">${shipTrack(s.ship, false, l)}</div>`;
  const bits = [];
  if (pr) bits.push(urlLink(l.pr, `<span class="d-link${s.ship.fresh ? ' dim' : ''}">${icon('pr', 13)}${s.ship.fresh ? 'last ' : ''}PR #${pr}${l.pr ? icon('external', 11) : ''}</span>`, `open PR #${pr} on GitHub`));
  const checks = steps.find(([k]) => k === 'checks');
  if (pr && checks && CHECKS[checks[1]]) {
    const [word, col, ic] = CHECKS[checks[1]];
    bits.push(urlLink(l.pr ? `${l.pr}/checks` : null, `<span class="d-link ${col}">${icon(ic, 13)}${word}</span>`, 'open the checks on GitHub'));
  }
  if (l.deploy) bits.push(urlLink(l.deploy, `<span class="d-link mint">${icon('live', 13)}deploy${icon('external', 11)}</span>`, `open the deploy: ${l.deploy}`));
  if (bits.length) h += `<div class="d-links">${bits.join('')}</div>`;
  else if (!steps.some(([, v]) => v !== 'none' && v !== 'na')) h += '<div class="d-empty">nothing pushed yet</div>';
  return h;
}

function filesHtml(s, now) {
  const files = [...(s.files || [])].sort((a, b) => b.t - a.t);
  if (!files.length) return '';
  return head('folder', 'Files touched', String(files.length)) + `<div class="d-files">` + files.map((f) => {
    const mark = f.wrote ? `<span class="d-fic gold" title="edited">${icon('edit', 13)}</span>` : `<span class="d-fic" title="read">${icon('file', 13)}</span>`;
    const slash = f.rel.lastIndexOf('/');
    const name = `<span class="d-path">${slash >= 0 ? `<span class="d-dir">${esc(f.rel.slice(0, slash + 1))}</span>` : ''}${esc(f.rel.slice(slash + 1))}</span>`;
    return `${mark}${revealLink('file', f.abs, name, f.abs ? `open in VS Code: ${f.abs}` : '')}<span class="d-ago">${coarseAgo(now - f.t)}</span>`;
  }).join('') + '</div>';
}

function callsHtml(s) {
  const calls = (s.calls || []).slice(0, 30);
  if (!calls.length) return '';
  return head('shell', 'Recent tool calls') + `<div class="d-calls">` + calls.map((c) => {
    const who = c.who && c.who !== 'main' ? `<span class="who">${esc(c.who)}</span>` : '';
    const what = `<span class="what">${esc(c.what)}</span>`;
    return `<span class="d-time">${clockTime(c.t)}</span><span class="d-cic">${verbIcon(c.verb, 13)}</span>`
      + `<span class="d-call">${who}<span class="verb">${esc(c.verb)}</span>${revealLink('file', c.file, what)}</span>`;
  }).join('') + '</div>';
}

function usageHtml(s) {
  if (!s.tokens && !s.usagePending) return '';
  return head('cost', 'Tokens and cost') + `<div class="d-usage">`
    + `<div class="d-stat"><span class="d-big">${fmtTok(s.tokens)}</span><span class="dim">tokens</span></div>`
    + `<div class="d-stat"><span class="d-big">${fmtCost(s.cost)}${s.usagePending ? '…' : ''}</span><span class="dim">at API prices${s.usagePending ? ', still counting' : ''}</span></div></div>`;
}

// The title as a text box, the name selected: Enter (or a click elsewhere) saves through ui.rename (app.js: POST
// /rename, and "/rename <name>" into Claude Code when it is idle here), Esc puts it back as it was. Empty goes back
// to Claude Code's own title. A new session (no id yet) can't be renamed.
function startRename(el, ui) {
  const s = el._s, head = el._slots.head;
  const nameEl = head.querySelector('.name');
  if (!s || s.pending || el._renaming || !nameEl || !ui.rename) return;
  el._renaming = s.id;
  const box = document.createElement('input');
  box.type = 'text';
  box.className = 'd-ren-in path-input';
  box.value = s.name || '';
  box.maxLength = 80;
  box.spellcheck = false;
  box.autocomplete = 'off';
  box.placeholder = 'empty: Claude Code\'s own title';
  box.setAttribute('aria-label', 'rename the conversation (Enter saves, Esc cancels)');
  nameEl.replaceWith(box);
  head.classList.add('renaming');
  try { box.focus({ preventScroll: true }); box.select(); } catch {}
  let busy = false;
  const end = () => {
    if (el._renaming !== s.id) return;
    el._renaming = null;
    head.classList.remove('renaming');
    head._html = null; // drawn afresh with the name
    ui.refresh ? ui.refresh() : ui.showDetail(el._id);
  };
  // (a failed save on a click elsewhere puts the title back: the box doesn't take the keyboard back)
  const save = async (blurred = false) => {
    if (busy || el._renaming !== s.id) return;
    busy = true;
    box.readOnly = true;
    const err = await ui.rename(s.id, box.value);
    busy = false;
    if (err && !blurred && el._renaming === s.id && box.isConnected) {
      // it stays a box, with why
      box.readOnly = false;
      box.classList.add('err');
      box.title = err;
      try { box.focus({ preventScroll: true }); } catch {}
      return;
    }
    end();
  };
  box.addEventListener('keydown', (e) => {
    // every key is the box's own: none reaches the page's shortcuts (v, /, Esc closing the panel…)
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); end(); }
    else if (e.key === 'F2') e.preventDefault();
    box.classList.remove('err');
  });
  box.addEventListener('blur', () => { if (!busy && box.isConnected && el._renaming === s.id) save(true); });
  box.addEventListener('dblclick', (e) => e.stopPropagation());
}

// el: the panel; s: the session (or null to close); gone: s is the last copy of one that left the list
export function renderDetail(el, s, ui, gone = false) {
  const open = !!s;
  el.classList.toggle('open', open);
  el.setAttribute('aria-hidden', String(!open));
  const work = el.closest('.work');
  work?.classList.toggle('detail-left', left);
  work?.classList.toggle('detail-float', float);
  if (dockW) work?.style.setProperty('--detail-w', `${dockW}px`);
  // the panel closed or moved on: the preview sessions it started end (after the switch, never the one shown)
  if (!open) { el._id = null; el._placed = null; if (el._renaming) { el._renaming = null; el._slots.head._html = null; } endPreviews(null); return; }
  if (!el._built) build(el, ui);
  const now = Date.now();
  const sl = el._slots;
  const desk = !!termApi();
  // how this conversation was just picked, once: 'preview' (a click), 'explicit' (Enter, a double-click),
  // 'keys' (arrows: shown, never started), or null (a redraw)
  const intent = ui.takeIntent ? ui.takeIntent(s.id) : null;
  if (el._id !== s.id) {
    // a different conversation: start at the top, on Chat
    el._id = s.id;
    el._body.scrollTop = 0;
    el._reply.scrollTop = 0;
    el._tab = 'chat';
    endPreviews(s.id);
  }
  // a tab asked for once (the Projects view's Session / Details buttons), else Chat for a pick. An explicit open (Enter, a
  // double-click) also starts the live session in the background, so the chat box is ready to send at once
  const wantTab = ui.takeTab ? ui.takeTab(s.id) : null;
  if (wantTab === 'details' || wantTab === 'chat' || wantTab === 'changes' || wantTab === 'preview' || (wantTab === 'session' && desk)) el._tab = wantTab;
  else if (intent) el._tab = 'chat';
  // the floating card moves to each new pick (arrow keys too); a redraw leaves it where it is
  if (float && work && (intent || el._placed !== s.id)) placeFloat(el, work, s.id, intent === 'preview' || intent === 'explicit');
  if (intent === 'explicit' && desk && !openElsewhere(s)) ensureLive(s, { sizeEl: el._chat }).catch(() => {});
  drawTabs(el, s, ui, work, intent === 'preview' || intent === 'explicit' ? intent : null);
  // a click, Enter or a double-click (and a new session or Fork) puts the keyboard straight in the chat box;
  // arrow keys leave it on the list
  if ((intent === 'preview' || intent === 'explicit') && el._tab === 'chat') focusCompose(el);
  el.style.setProperty('--hue', s.hue || C.cyan);
  el.style.setProperty('--status', statusColor(s));
  setIcon(sl.icon, s);
  el._s = s;
  // the title being renamed stays a text box until Enter, Esc or a click elsewhere (another conversation: dropped)
  if (el._renaming && el._renaming !== s.id) { el._renaming = null; sl.head._html = null; }
  if (!el._renaming) {
    const ren = s.pending ? '' : `<button type="button" class="d-ren" data-rename title="Rename (F2)" aria-label="rename the conversation">${icon('edit', 13)}</button>`;
    setHTML(sl.head, `<span class="d-name-row"><span class="name"${s.pending ? '' : ' title="double-click to rename"'}>${esc(s.name)}</span>${ren}</span><span class="d-sub">${acctTag(s.account)}${badge(s)}</span>`);
  }
  setHTML(sl.meta, metaRows(s));
  setText(sl.meta, '.d-turn', turnOf(s, now));
  setHTML(sl.note, gone ? 'no longer in the list' : openElsewhere(s) ? 'it is open in another window' : '');

  // the question it waits on, unless the reply below already holds it
  const reply = s.lastReply ? String(s.lastReply).slice(0, REPLY_MAX) : '';
  el._replyFull = s.lastReply ? String(s.lastReply) : '';
  const showWait = needsYou(s.state) && s.waitingOn && !reply.includes(String(s.waitingOn).trim());
  setHTML(sl.wait, showWait ? waitNote(s) : '');
  el._replySec.hidden = !reply;
  setHTML(sl.replyk, head('reply', s.state === 'QUESTION' ? 'Its question' : s.state === 'DONE' ? 'Final reply' : 'Last reply'));
  if (el._reply._text !== reply) {
    const top = el._reply.scrollTop;
    el._reply.innerHTML = mdHtml(reply + (s.lastReply && s.lastReply.length > REPLY_MAX ? '…' : ''));
    el._reply._text = reply;
    el._reply.scrollTop = top;
  }
  setHTML(sl.plan, planHtml(s));
  setHTML(sl.ship, shipHtml(s));
  setHTML(sl.files, filesHtml(s, now));
  setHTML(sl.calls, callsHtml(s));
  setHTML(sl.usage, usageHtml(s));
}

function drawTabs(el, s, ui, work, auto) {
  const tab = ['session', 'chat', 'changes', 'preview'].includes(el._tab) ? el._tab : 'details';
  for (const b of el._tabs) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  const hosted = isHosted(s.id);
  el._here.hidden = !hosted;
  el._body.hidden = tab !== 'details';
  el._session.hidden = tab !== 'session';
  el._chat.hidden = tab !== 'chat';
  el._changes.hidden = tab !== 'changes';
  el._previewPane.hidden = tab !== 'preview';
  el.classList.toggle('on-session', tab !== 'details');
  for (const b of el._placeBtns) b.setAttribute('aria-pressed', String(b.dataset.place === place));
  // the terminal starts a preview by itself only while it shows; the chat reads the log and starts one on Send
  renderSessionPane(el._session, s, { ui, visible: tab === 'session', auto: tab === 'session' ? auto : null, onOpened: () => { if (el._tab !== 'chat') el._tab = 'session'; ui.refresh?.(); } });
  if (tab === 'chat') renderChatPane(el._chat, s, { visible: true });
  if (tab === 'changes') renderChangesPane(el._changes, s, { ui });
  if (tab === 'preview') renderPreviewPane(el._previewPane, s, { ui });
  // after the pane (an auto-open there may have just made it a preview)
  el._previewHint.hidden = !(tab === 'session' && isPreview(s.id));
}
