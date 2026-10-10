// Wall view: one big tile per conversation, for a second monitor. Tiles are built once and patched
// slot by slot, like the cards, and glide to their new place when the order changes (syncGrid).
import {
  C, esc, setHTML, setIcon, badge, acctTag, ctxGauge, usage, shipTrack, planSteps, prTag, progressBar, pctText,
  agentDots, runningAgents, runningList, lastAction, turnText, needsYou, isBusy, gradHex, ago, repoChip, clashNotes, linksOf,
  wirePick, setText, statusColor, waitNote, syncGrid, leadTag,
} from './cards.js';
import { icon } from './icons.js';

const SLOTS = ['icon', 'title', 'state', 'big', 'stage', 'goal', 'wait', 'bar', 'steps', 'action', 'agents', 'footL', 'footR', 'clash'];

function buildTile(id, ui) {
  const el = document.createElement('article');
  el.className = 'tile';
  el.dataset.id = id;
  el.innerHTML = `<div class="t-head"><span data-slot="icon" class="c-icon"></span><div data-slot="title" class="t-title"></div><div data-slot="state" class="t-state"></div></div>
<div class="t-top"><div data-slot="big" class="t-big"></div><div class="t-what"><div data-slot="stage" class="t-stage"></div><div data-slot="goal" class="t-goal"></div></div></div>
<div data-slot="wait" class="c-wait"></div><div data-slot="bar" class="t-bar"></div><div data-slot="steps" class="t-steps"></div>
<div data-slot="action" class="c-action"></div><div data-slot="agents" class="t-agents"></div><div data-slot="clash" class="c-clash"></div>
<div class="t-foot"><span data-slot="footL" class="t-left"></span><span data-slot="footR" class="t-right"></span></div>`;
  el._slots = {};
  for (const k of SLOTS) el._slots[k] = el.querySelector(`[data-slot="${k}"]`);
  wirePick(el, id, ui);
  return el;
}

function fillTile(el, s, state, ui, now) {
  const sl = el._slots;
  const p = s.progress || { mode: 'ship', pct: 0 };
  const pct = Math.max(0, Math.min(1, Number(p.pct) || 0));
  el.classList.toggle('picked', ui.selectedId === s.id);
  el.classList.toggle('continued', !!s.continued); // a removed conversation just continued: dim until it works
  el.classList.toggle('handing', !!s.handing); // handing off to a fresh conversation (cards.js)
  el.classList.toggle('needs', needsYou(s.state));
  el.style.setProperty('--status', statusColor(s));
  el.style.setProperty('--hue', s.hue || C.cyan);
  setIcon(sl.icon, s);
  setHTML(sl.title, `<span class="name">${esc(s.name)}</span>${acctTag(s.account)}${leadTag(s, state)}`);
  setHTML(sl.state, badge(s));
  setHTML(sl.big, `<span style="color:${p.done ? C.mint : gradHex([C.ember, C.gold, C.mint], pct)}">${pctText(s)}</span>`);
  const shipAt = (s.ship?.steps || []).find(([, v]) => v !== 'ok' && v !== 'na');
  const stage = p.mode === 'plan' ? `plan · ${p.phase || ''}${p.done ? ' · done' : ''}` : `ship · ${shipAt ? shipAt[0] : 'live'}`;
  const tt = turnText(s, now);
  setHTML(sl.stage, `<span class="t-stage-k">${icon(p.mode === 'plan' ? 'plan' : 'push', 14)}${esc(stage)}</span>${tt ? `<span class="t-turn${isBusy(s.state) ? ' busy' : ''}">${icon('clock', 12)}<span class="turn-t"></span></span>` : ''}`);
  setText(sl.stage, '.turn-t', tt);
  setHTML(sl.goal, esc(s.goal || '—'));
  sl.goal.title = s.goal || '';
  setHTML(sl.wait, waitNote(s));
  setHTML(sl.bar, progressBar(s));
  setHTML(sl.steps, p.mode === 'plan' && s.planSteps ? planSteps(s.planSteps, false) : shipTrack(s.ship, false, linksOf(s)));
  setHTML(sl.action, lastAction(s));
  const running = runningAgents(s);
  const dots = agentDots(s, 16);
  setHTML(sl.agents, dots || running.length ? `<span class="dots">${dots}</span>${running.length ? `<span class="running">${runningList(running.slice(0, 4))}${running.length > 4 ? `<span class="dim">+${running.length - 4} more</span>` : ''}</span>` : `<span class="faint">all agents done</span>`}` : '');
  setHTML(sl.clash, clashNotes(s, state));
  // links (repo, PR) and the numbers that change every second live in separate slots
  setHTML(sl.footL, `${repoChip(s)}${prTag(s)}`);
  setHTML(sl.footR, `${ctxGauge(s.context)}${usage(s)}<span class="ago" title="last activity"></span>`);
  setText(sl.footR, '.ago', ago(now - s.last));
}

export function renderWall(el, state, ui) {
  const now = Date.now();
  if (!el._built) {
    el.innerHTML = `<div class="wall grid"></div><div class="empty" hidden></div>`;
    el._grid = el.querySelector('.wall');
    el._empty = el.querySelector('.empty');
    el._tiles = new Map();
    el._built = true;
  }
  const list = state.sessions || [];
  const byId = new Map(list.map((s) => [s.id, s]));
  el._empty.hidden = list.length > 0;
  setHTML(el._empty, state.filterNote ? esc(state.filterNote) : 'no conversations need watching right now');
  syncGrid(el._grid, el._tiles, list.map((s) => s.id), (id) => buildTile(id, ui), (id, t) => fillTile(t, byId.get(id), state, ui, now), state.handoffPairs);
}
