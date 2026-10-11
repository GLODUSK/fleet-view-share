// Fleet View web: Housekeeping. A card under the header's broom button that says which worktrees, local branches and
// GitHub branches can go, which stay and why, and which need Henry first (housekeeping.js on the server).
//
//   GET  /housekeeping            the last report at once (busy while one is being made: polled every 2 s)
//   POST /housekeeping/refresh    a fresh report
//   POST /housekeeping/run        { ids } removes those; each gets a result line
//   POST /housekeeping/keep       { id, on } pins one: a pinned item is always kept
//   POST /housekeeping/auto       { on } the nightly clean-up switch (off by default)
//   GET  /housekeeping/log        what was removed, newest first; POST /housekeeping/restore { id } puts one back
//
// From another device run, restore and the switch answer 403 "only on the PC": shown in the card, like any
// { ok: false, message }. A server without the module (404): the card says so and nothing else happens.
//
//   mountHousekeeping({ button })  -> { open(), close(), toggle(), isOpen() }
//
// Calm by rule: it drops in once, rows never flash, and a redraw keeps the scroll where it was. Big lists stay
// usable: each group and each repo folds, and "kept" starts folded. Never window.confirm/alert/prompt (they block
// automation): "Clean up N" asks in the card itself.
import { esc } from './cards.js';
import { icon } from './icons.js';
import { agoText } from './since.js';

const POLL_MS = 2000;
const GROUPS = [
  { v: 'remove', label: 'to clean', open: true },
  { v: 'ask', label: 'need you', open: true },
  { v: 'keep', label: 'kept', open: false },
];
const KINDS = [['worktrees', 'Worktrees'], ['branches', 'Branches'], ['remoteBranches', 'GitHub branches']];
const KIND_WORD = { worktree: 'worktree', branch: 'branch', remote: 'GitHub branch' };

// "just now", "4 minutes ago", "3 days ago"
export const agoWords = (t) => {
  if (!t) return '';
  const ms = Date.now() - t;
  return ms < 45e3 ? 'just now' : `${agoText(ms)} ago`;
};
// the last two parts of a path: "worktrees\remote-web"
export const shortPath = (p) => {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('\\') || String(p || '');
};
// what Henry has to do before an 'ask' row can go
export function todo(row) {
  const out = [];
  if (row.dirty) out.push(`commit or discard the changes in ${shortPath(row.path || row.name)} first`);
  if (row.unpushed > 0) out.push(`push or drop the ${row.unpushed} unpushed commit${row.unpushed === 1 ? '' : 's'} first`);
  if (!out.length && row.pr && row.pr.state === 'OPEN') out.push(`merge or close PR #${row.pr.number} first`);
  return out.join('; ');
}

// GET or POST; answers { code, body } (body null when it is not JSON), or { code: 0 } when nothing answered
async function call(url, body) {
  try {
    const r = await fetch(url, body === undefined ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null;
    try { j = await r.json(); } catch {}
    return { code: r.status, body: j };
  } catch { return { code: 0, body: null }; }
}
const failText = (r) => {
  const m = r.body && r.body.message;
  if (r.code === 403 && /only on the PC/i.test(m || '')) return 'Only on the PC: clean-ups, Restore and the nightly switch work from the PC itself, not from another device.';
  return m || (r.code ? `Fleet View answered ${r.code}.` : 'Fleet View did not answer.');
};

export function mountHousekeeping({ button } = {}) {
  let card = null;
  let report = null; // the last GET /housekeeping
  let missing = false; // 404: this server has no housekeeping
  let log = null; // GET /housekeeping/log entries
  let note = null; // { text, bad } under the head
  let confirm = null; // { ids, rows } while "Clean up N" asks
  let results = null; // [{ id, done, message, label }] after a run
  let working = false; // a POST is out
  let pollTimer = null;
  const folded = new Map(); // group or repo key -> folded?
  const unticked = new Set(); // 'remove' ids Henry took out of the clean-up
  const restoring = new Set();
  for (const g of GROUPS) folded.set(`g:${g.v}`, !g.open);
  folded.set('log', true);

  // ---------- data ----------
  async function load() {
    const r = await call('/housekeeping');
    if (r.code === 404) { missing = true; report = null; draw(); return; }
    missing = false;
    if (r.code === 200 && r.body) report = r.body;
    else note = { text: failText(r), bad: true };
    draw();
    clearTimeout(pollTimer);
    if (card && report && report.busy) pollTimer = setTimeout(load, POLL_MS);
    else if (card && report) loadLog();
  }
  async function loadLog() {
    const r = await call('/housekeeping/log');
    if (r.code === 200 && r.body && Array.isArray(r.body.entries)) { log = r.body.entries; draw(); }
  }
  async function act(url, body) {
    working = true; draw();
    const r = await call(url, body);
    working = false;
    const ok = r.code >= 200 && r.code < 300 && r.body && r.body.ok !== false;
    if (!ok) note = { text: failText(r), bad: true };
    return ok ? r.body : null;
  }

  // every row of the report, with its repo and kind
  function allRows() {
    const out = [];
    for (const repo of (report && report.repos) || []) {
      for (const [k] of KINDS) for (const row of repo[k] || []) out.push({ repo, kind: k, row });
    }
    return out;
  }
  const findRow = (id) => allRows().find((x) => x.row.id === id) || null;
  const rowLabel = ({ repo, kind, row }) => `${kind === 'worktrees' ? shortPath(row.path) : row.name} (${repo.name}${kind === 'worktrees' ? ' worktree' : kind === 'branches' ? ' branch' : ' on GitHub'})`;
  const toClean = () => allRows().filter((x) => x.row.verdict === 'remove' && !unticked.has(x.row.id));

  // ---------- drawing ----------
  function prHtml(pr) {
    if (!pr) return '';
    const st = String(pr.state || '').toLowerCase();
    const word = st === 'merged' ? 'merged' : st === 'closed' ? 'closed' : 'open';
    const inner = `#${esc(pr.number)} ${word}`;
    return pr.url ? `<a class="hk-pr ${word}" href="${esc(pr.url)}" target="_blank" rel="noopener">${inner}</a>` : `<span class="hk-pr ${word}">${inner}</span>`;
  }
  function rowHtml({ repo, kind, row }) {
    const name = kind === 'worktrees' ? shortPath(row.path) : row.name;
    const sub = kind === 'worktrees' && row.branch ? `<span class="hk-br">${icon('branch', 11)}${esc(row.branch)}</span>` : '';
    const when = kind === 'worktrees' ? row.lastActivity : row.lastCommit;
    const reasons = (row.reasons || []).join(' · ');
    const need = row.verdict === 'ask' ? todo(row) : '';
    const tick = row.verdict === 'remove'
      ? `<input type="checkbox" class="hk-tick" data-c="tick" aria-label="clean up ${esc(name)}"${unticked.has(row.id) ? '' : ' checked'}>` : '<span class="hk-tick-sp"></span>';
    return `<div class="hk-row v-${esc(row.verdict)}" data-id="${esc(row.id)}">${tick}`
      + `<div class="hk-main"><div class="hk-l1"><span class="hk-name" title="${esc(kind === 'worktrees' ? row.path : `${repo.name}: ${row.name}`)}">${esc(name)}</span>${sub}${prHtml(row.pr)}`
      + `${when ? `<span class="hk-when">${esc(agoWords(when))}</span>` : ''}</div>`
      + `${reasons ? `<div class="hk-why">${esc(reasons)}</div>` : ''}${need ? `<div class="hk-need">${esc(need)}</div>` : ''}</div>`
      + `<button type="button" class="hk-keep${row.pinned ? ' on' : ''}" data-c="keep" aria-pressed="${row.pinned ? 'true' : 'false'}" title="${row.pinned ? 'kept by you: click to let the rules decide again' : 'always keep this'}"${working ? ' disabled' : ''}>${icon('pin', 12)}${row.pinned ? 'Kept' : 'Keep'}</button></div>`;
  }
  function groupHtml(g, rows) {
    const key = `g:${g.v}`, shut = folded.get(key);
    let body = '';
    if (!shut) {
      const byRepo = new Map();
      for (const x of rows) { const k = x.repo.root; if (!byRepo.has(k)) byRepo.set(k, []); byRepo.get(k).push(x); }
      for (const [root, list] of byRepo) {
        const rk = `r:${g.v}:${root}`, rshut = folded.get(rk) === true;
        const repo = list[0].repo;
        let inner = '';
        if (!rshut) {
          for (const [k, label] of KINDS) {
            const these = list.filter((x) => x.kind === k);
            if (these.length) inner += `<div class="hk-kind">${label} <span>${these.length}</span></div>${these.map(rowHtml).join('')}`;
          }
        }
        body += `<div class="hk-repo"><button type="button" class="hk-rh" data-c="fold" data-k="${esc(rk)}" aria-expanded="${rshut ? 'false' : 'true'}">`
          + `${icon('chevron', 11)}<b>${esc(repo.name)}</b>${repo.github ? `<span class="hk-gh">${esc(repo.github)}</span>` : ''}<span class="hk-n">${list.length}</span></button>${inner}</div>`;
      }
      if (!rows.length) body = `<div class="hk-none">${g.v === 'remove' ? 'Nothing to clean.' : g.v === 'ask' ? 'Nothing needs you.' : 'Nothing kept.'}</div>`;
    }
    return `<section class="hk-group g-${g.v}"><button type="button" class="hk-gh-btn" data-c="fold" data-k="${key}" aria-expanded="${shut ? 'false' : 'true'}">`
      + `${icon('chevron', 12)}<b>${rows.length}</b> ${g.label}</button>${body}</section>`;
  }
  function logHtml() {
    if (!log || !log.length) return '';
    const shut = folded.get('log');
    const rows = shut ? '' : log.slice(0, 50).map((e) => {
      const what = `${KIND_WORD[e.kind] || e.kind} ${e.kind === 'worktree' ? shortPath(e.path || e.name) : e.name}`;
      const right = e.restoredAt ? `<span class="hk-restored">restored ${esc(agoWords(e.restoredAt))}</span>`
        : `<button type="button" class="hk-btn" data-c="restore" data-log="${esc(e.id)}"${working || restoring.has(e.id) ? ' disabled' : ''}>${restoring.has(e.id) ? 'Restoring…' : 'Restore'}</button>`;
      return `<div class="hk-log-row"><div class="hk-main"><div class="hk-l1"><span class="hk-name">${esc(what)}</span>${e.pr ? `<span class="hk-pr merged">#${esc(e.pr)}</span>` : ''}<span class="hk-when">${esc(agoWords(e.at))}</span></div>`
        + `<div class="hk-why">${esc(e.repo || '')}${e.sha ? ` · at ${esc(String(e.sha).slice(0, 8))}` : ''}</div></div>${right}</div>`;
    }).join('');
    return `<section class="hk-group hk-log"><button type="button" class="hk-gh-btn" data-c="fold" data-k="log" aria-expanded="${shut ? 'false' : 'true'}">`
      + `${icon('chevron', 12)}Recent clean-ups <span class="hk-n">${log.length}</span></button>${rows}</section>`;
  }
  function headHtml() {
    const r = report;
    const made = missing ? '' : !r ? 'loading…' : r.busy ? (r.at ? `made ${agoWords(r.at)} · checking again…` : 'checking…') : r.at ? `made ${agoWords(r.at)}` : '';
    return `<span class="uw-title">${icon('trash', 14)}<b>Housekeeping</b></span><span class="uw-sub">${esc(made)}</span>`
      + (missing ? '' : `<button type="button" class="hk-btn" data-c="refresh"${!r || r.busy || working ? ' disabled' : ''}>Refresh</button>`)
      + `<button type="button" class="uw-x" data-c="close" aria-label="close" title="close (Esc)">${icon('close', 13)}</button>`;
  }
  function bodyHtml() {
    if (missing) return '<div class="hk-empty">Housekeeping is not available in this version of Fleet View.</div>';
    const r = report;
    let h = '';
    if (r && r.busy) h += `<div class="hk-busy">${r.at ? 'Making a fresh report' : 'Looking through the repos'}: worktrees, branches and their PRs…</div>`;
    if (r && r.error) h += `<div class="hk-note bad">${esc(r.error)}</div>`;
    if (results) {
      const done = results.filter((x) => x.done).length;
      h += `<div class="hk-results"><div class="hk-rt">Cleaned up ${done} of ${results.length}</div><div class="hk-rlist">${results.map((x) => `<div class="hk-res ${x.done ? 'ok' : 'bad'}">${icon(x.done ? 'check' : 'alert', 12)}<span><b>${esc(x.label)}</b>${x.message ? ` · ${esc(x.message)}` : ''}</span></div>`).join('')}</div>`
        + '<div class="hk-cbtns"><button type="button" class="hk-btn" data-c="results-ok">OK</button></div></div>';
    }
    if (!r || (r.busy && !r.at)) return h;
    const rows = allRows();
    if (!rows.length) h += '<div class="hk-empty">No extra worktrees or branches. Nothing to clean.</div>';
    else for (const g of GROUPS) h += groupHtml(g, rows.filter((x) => x.row.verdict === g.v));
    h += logHtml();
    return h;
  }
  function footHtml() {
    if (missing || !report || (report.busy && !report.at)) return '';
    const msg = note ? `<div class="hk-note${note.bad ? ' bad' : ''}" role="status">${esc(note.text)}</div>` : '';
    if (confirm) {
      return msg + `<div class="hk-confirm" role="group" aria-label="confirm clean-up"><div class="hk-ct">These ${confirm.rows.length} will go:</div>`
        + `<ul class="hk-clist">${confirm.rows.map((x) => `<li>${esc(rowLabel(x))}</li>`).join('')}</ul>`
        + '<div class="hk-chint">Each one is logged first, so Restore can bring it back.</div>'
        + `<div class="hk-cbtns"><button type="button" class="hk-btn danger" data-c="run"${working ? ' disabled' : ''}>${working ? 'Cleaning up…' : `Clean up ${confirm.rows.length}`}</button>`
        + `<button type="button" class="hk-btn" data-c="cancel"${working ? ' disabled' : ''}>Cancel</button></div></div>`;
    }
    const n = toClean().length;
    const auto = !!report.auto;
    const last = report.lastRun && report.lastRun.at
      ? `<div class="hk-last">Last clean-up ${esc(agoWords(report.lastRun.at))}: ${report.lastRun.removed || 0} removed${report.lastRun.failed ? `, ${report.lastRun.failed} failed` : ''}.</div>` : '';
    return msg + `<div class="hk-actions"><button type="button" class="hk-btn primary" data-c="ask"${n && !working && !report.busy ? '' : ' disabled'}>Clean up ${n}</button>`
      + `<label class="hk-switch"><button type="button" role="switch" class="hk-sw${auto ? ' on' : ''}" data-c="auto" aria-checked="${auto ? 'true' : 'false'}"${working ? ' disabled' : ''}><i></i></button>Clean up every night</label></div>`
      + '<div class="hk-hint">When no session is busy, between 2 and 5 am. Only items that pass every rule.</div>' + last;
  }
  // each part is drawn only when its html changes; the list keeps its scroll
  function put(sel, html) {
    const el = card.querySelector(sel);
    if (el && el._html !== html) { el.innerHTML = html; el._html = html; }
  }
  function draw() {
    if (!card) return;
    card.classList.toggle('hk-short', missing || !report || !allRows().length);
    put('.uw-top', headHtml());
    put('.hk-scroll', bodyHtml());
    put('.hk-foot', footHtml());
    card.querySelector('.hk-foot').hidden = !card.querySelector('.hk-foot').innerHTML;
  }

  // ---------- clicks ----------
  async function onClick(ev) {
    const b = ev.target.closest('[data-c]');
    if (!b || b.disabled) return;
    const c = b.dataset.c;
    const id = b.closest('[data-id]')?.dataset.id;
    if (c === 'close') return close();
    if (c === 'fold') { const k = b.dataset.k; folded.set(k, !(folded.get(k) === true)); return draw(); }
    if (c === 'tick') { if (b.checked) unticked.delete(id); else unticked.add(id); return draw(); }
    if (c === 'results-ok') { results = null; return draw(); }
    if (c === 'cancel') { confirm = null; return draw(); }
    note = null;
    if (c === 'refresh') {
      const r = await act('/housekeeping/refresh', {});
      if (r) { if (report) report.busy = true; results = null; }
      return load();
    }
    if (c === 'ask') {
      const rows = toClean();
      if (rows.length) confirm = { ids: rows.map((x) => x.row.id), rows };
      results = null;
      return draw();
    }
    if (c === 'run' && confirm) {
      const { ids, rows } = confirm;
      const r = await act('/housekeeping/run', { ids });
      confirm = null;
      if (r) {
        const label = new Map(rows.map((x) => [x.row.id, rowLabel(x)]));
        results = (r.results || []).map((x) => ({ ...x, label: label.get(x.id) || x.id }));
        for (const x of results) if (x.done) unticked.delete(x.id);
        return load();
      }
      return draw();
    }
    if (c === 'keep' && id) {
      const x = findRow(id);
      if (!x) return;
      const on = !x.row.pinned;
      const r = await act('/housekeeping/keep', { id, on });
      // the server says the new verdict on the next GET; until then a pin shows as kept at once
      if (r && on) Object.assign(x.row, { pinned: true, verdict: 'keep', reasons: ['kept by you'] });
      else if (r) x.row.pinned = false;
      draw();
      return load();
    }
    if (c === 'auto') {
      const on = !report.auto;
      const r = await act('/housekeeping/auto', { on });
      if (r) report.auto = typeof r.auto === 'boolean' ? r.auto : on;
      return draw();
    }
    if (c === 'restore') {
      const lid = b.dataset.log;
      restoring.add(lid); draw();
      const r = await act('/housekeeping/restore', { id: lid });
      restoring.delete(lid);
      if (r) { note = { text: r.message || 'Restored.' }; return load(); }
      return draw();
    }
  }

  // ---------- open / close ----------
  function open() {
    if (card) return;
    card = document.createElement('div');
    card.className = 'uw-pop hk-pop';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Housekeeping');
    card.tabIndex = -1;
    card.innerHTML = '<div class="uw-top"></div><div class="hk-scroll"></div><div class="hk-foot"></div>';
    document.body.appendChild(card);
    button?.setAttribute('aria-expanded', 'true');
    draw();
    card.addEventListener('click', onClick);
    card.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      if (confirm && !working) { confirm = null; draw(); } else close();
    });
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    document.addEventListener('keydown', escKey, true);
    card.focus({ preventScroll: true });
    load();
  }
  function close() {
    if (!card) return;
    card.remove();
    card = null;
    clearTimeout(pollTimer);
    confirm = null; results = null; note = null;
    button?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escKey, true);
  }
  const outside = (ev) => { if (card && !card.contains(ev.target) && !(button && button.contains(ev.target))) close(); };
  const escKey = (ev) => {
    if (ev.key !== 'Escape' || !card || card.contains(ev.target)) return;
    ev.stopPropagation(); ev.preventDefault();
    if (confirm && !working) { confirm = null; draw(); } else close();
  };
  button?.addEventListener('click', (ev) => { ev.stopPropagation(); if (card) close(); else open(); });

  return { open, close, toggle: () => (card ? close() : open()), isOpen: () => !!card };
}
