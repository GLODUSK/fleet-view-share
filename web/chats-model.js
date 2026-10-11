// Chats model: turns the page's state into the Chats tab's contact list (chats.js draws it). Pure functions plus a
// small localStorage store; no DOM.
//
// CONTRACT (chats.js builds on it; keep these names and shapes):
//   buildContacts(state, opts) -> Contact[] (unsorted)
//       state: the derived state the shell hands every view (allSessions, finishedSessions, pending, teams, ...), or
//              raw GET /state (no allSessions: rawToContactsState turns it into those lists; the phone app passes it)
//       opts:  { chiefId?: string|null, chains?: ChainStore, now?: number, chiefPlaceholder?: boolean }
//              chiefPlaceholder: with no Chief conversation, add a pinned Chief row { key: 'chief', kind: 'chief', id: null,
//              ids: [], state: 'NEW', preview: 'Not started yet' } so the tab can start one
//   sortContacts(list) -> Contact[]   Chief first, then needs-you (longest waiting first), then newest activity
//   teamThread(team, state) -> [{ t, from, fromName, to, toName, text }]   a team's messages, oldest first
//   createChainStore(storage = localStorage) -> ChainStore
//       ChainStore: { keyFor(id) -> string, link(fromId, toId), save() }. A conversation that picked up another's
//       handoff (s.pickedUpFrom.id) gets the same chain key, so one bot keeps one row across its handoffs.
//   unread(contact, seen) -> boolean  seen: { [contact.key]: ms the user last opened it }
//   rawToContactsState(st) -> { ...st, sessions, allSessions, finishedSessions, pending, teams }   raw GET /state to
//       the lists above (buildContacts calls it by itself when state has no allSessions)
//   Nothing here touches the DOM or window at import time, so the phone app (phone/) imports it as it is.
//
//   Contact = {
//     key,            stable row key: 'chief', 'team:<team id>', or the chain key (its first conversation's id)
//     kind,           'chief' | 'bot' | 'team'
//     id,             the conversation the row opens now (the chain's newest); for a team, null
//     ids,            every conversation id in the chain, oldest first (a team: its members)
//     name, account, repo ({ name, root, color } | null), state, label, statusColor,
//     preview,        one line: what it is doing now, the question it asks, or its last reply
//     at,             ms of its latest activity (for sorting and the time on the row)
//     needsYou, busy, pinned (Chief), teamId (team rows), members (team rows: [{ id, name, lead }])
//   }
const NEEDS = new Set(['ASKING', 'QUESTION', 'ERROR', 'STALLED']);
const BUSY = new Set(['WORKING', 'AGENTS']);
const KEY = 'fv.chats.chains';
const CAP = 2000;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const lastOf = (s) => s.last || s.endedAt || s.lastActive || 0;
const oneLine = (t, n = 140) => {
  const x = String(t || '').replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1).trimEnd() + '…' : x;
};
const short = (id) => String(id == null ? '' : id).slice(0, 8);

// { conversation id: chain key }, kept in storage; the newest links sit last, so the cap drops the oldest
export function createChainStore(storage) {
  let st = storage;
  if (st === undefined) { try { st = globalThis.localStorage; } catch { st = null; } }
  const map = {};
  try {
    const j = JSON.parse(st.getItem(KEY));
    if (j && typeof j === 'object' && !Array.isArray(j)) for (const k of Object.keys(j)) if (typeof j[k] === 'string') map[k] = j[k];
  } catch {}
  let dirty = false;
  const set = (id, key) => {
    if (has(map, id) && map[id] === key) return;
    delete map[id]; // re-insert so it counts as the newest
    map[id] = key;
    dirty = true;
  };
  return {
    keyFor: (id) => (has(map, id) ? map[id] : id),
    link(fromId, toId) {
      if (!fromId || !toId || fromId === toId) return;
      const key = has(map, fromId) ? map[fromId] : fromId;
      set(fromId, key);
      set(toId, key);
    },
    save() {
      if (!dirty) return;
      const ks = Object.keys(map);
      if (ks.length > CAP) for (const k of ks.slice(0, ks.length - CAP)) delete map[k];
      try { st.setItem(KEY, JSON.stringify(map)); dirty = false; } catch {}
    },
  };
}

// the first line that says something: not a heading, a code fence, a table border or a rule
function replyLine(text) {
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim();
    if (!l || /^#{1,6}(\s|$)/.test(l) || /^```/.test(l) || /^\|/.test(l) || /^[\s:|-]+$/.test(l) || /^[-*_=]{3,}$/.test(l)) continue;
    const t = l.replace(/^(?:[-*+>]|\d+[.)])\s+/, '').replace(/[*_`]+/g, '').trim();
    if (t) return t;
  }
  return '';
}

// "edit FlameCanvas.tsx", or "build:phone-skia edit FlameCanvas.tsx" for a subagent
const actionText = (a) => (a ? [a.who && a.who !== 'main' ? a.who + ':' : '', a.verb, a.what].filter(Boolean).join(' ') : '');

function previewOf(s) {
  if (NEEDS.has(s.state)) {
    const q = s.waitingOn || replyLine(s.lastReply);
    if (q) return oneLine(q);
  }
  if (BUSY.has(s.state)) {
    const a = actionText(s.lastAction);
    if (a) return oneLine(a);
  }
  return oneLine(replyLine(s.lastReply) || s.goal || '');
}

// the conversations the tab may list, like projects.js: shown, new and finished ones (hidden or removed ones are in
// none of those lists); a handoff stand-in (in sessions) wins over the raw copy of the same id
function listed(state) {
  const base = state.sessions || state.allSessions || [];
  const seen = new Set();
  const out = [];
  for (const s of base.concat(state.pending || [], state.finishedSessions || [])) {
    if (!s || s.id == null || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

// a conversation's name, following its handoffs to the one that carries on
function nameIn(id, known) {
  let s = known.get(id);
  if (!s) return null;
  for (let n = 0; n < 50 && s.handoff && s.handoff.next && known.has(s.handoff.next); n++) s = known.get(s.handoff.next);
  return s.name || null;
}

// raw GET /state (the phone app; anything without the page's derived lists) -> the lists buildContacts reads, the way
// app.js derive() makes them: sessions = live ones, finishedSessions = DONE ones /state lists in finished (not one
// that handed off to a next), allSessions = all of them, no pending. Hidden ones (settings.hidden) are left out unless
// they worked again after being hidden (app.js isHidden). Pure: no DOM, no storage.
export function rawToContactsState(st) {
  const s = st || {};
  const all = (Array.isArray(s.sessions) ? s.sessions : []).filter((x) => x && x.id != null);
  const hid = new Map();
  for (const h of (s.settings && Array.isArray(s.settings.hidden) ? s.settings.hidden : [])) if (h && typeof h.id === 'string') hid.set(h.id, Number(h.at) || 0);
  const activeAt = (x) => (Number.isFinite(x.active) ? x.active : x.last || 0);
  const hidden = (x) => hid.has(x.id) && !(x.state !== 'DONE' && x.state !== 'QUESTION' && activeAt(x) > hid.get(x.id));
  const fin = new Set((Array.isArray(s.finished) ? s.finished : []).filter((f) => f && f.id).map((f) => f.id));
  const shown = all.filter((x) => !hidden(x));
  return {
    ...s,
    sessions: shown.filter((x) => x.state !== 'DONE'),
    allSessions: all,
    finishedSessions: shown.filter((x) => x.state === 'DONE' && fin.has(x.id) && !(x.handoff && x.handoff.next)),
    pending: Array.isArray(s.pending) ? s.pending : [],
    teams: Array.isArray(s.teams) ? s.teams : [],
  };
}

export function buildContacts(input, opts = {}) {
  // the page's derived state has allSessions; anything else is taken as raw GET /state
  const state = input && Array.isArray(input.allSessions) ? input : rawToContactsState(input);
  const chains = opts.chains || createChainStore(null);
  const list = listed(state);
  // links come from every conversation the state knows, listed or not
  const known = new Map();
  for (const s of (state.allSessions || []).concat(list)) if (s && s.id != null) known.set(s.id, s);
  const pairs = [];
  const prev = new Map();
  for (const s of known.values()) {
    if (s.pickedUpFrom && s.pickedUpFrom.id) { pairs.push([s.pickedUpFrom.id, s.id]); prev.set(s.id, s.pickedUpFrom.id); }
    if (s.handoff && s.handoff.next) { pairs.push([s.id, s.handoff.next]); if (!prev.has(s.handoff.next)) prev.set(s.handoff.next, s.id); }
  }
  const depth = (id) => { let d = 0; for (let c = prev.get(id), n = 0; c && n < 500; c = prev.get(c), n++) d++; return d; };
  pairs.sort((a, b) => depth(a[0]) - depth(b[0])); // oldest links first, so a key spreads down a chain in one pass
  for (const [f, t] of pairs) chains.link(f, t);
  chains.save();

  const groups = new Map();
  for (const s of list) {
    const k = chains.keyFor(s.id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const chiefKey = opts.chiefId ? chains.keyFor(opts.chiefId) : null;
  const out = [];
  const byKey = new Map(); // chain key -> its row
  let hasChief = false;
  for (const [k, members] of groups) {
    members.sort((a, b) => (depth(a.id) - depth(b.id)) || (lastOf(a) - lastOf(b)));
    const live = members.filter((m) => m.state !== 'DONE');
    const pool = live.length ? live : members;
    const s = pool.reduce((best, m) => (lastOf(m) >= lastOf(best) ? m : best), pool[0]);
    const ren = members.filter((m) => m.renamed && m.name).sort((a, b) => lastOf(b) - lastOf(a))[0];
    const isChief = !!opts.chiefId && (k === chiefKey || members.some((m) => m.id === opts.chiefId));
    if (isChief) hasChief = true;
    const row = {
      key: isChief ? 'chief' : k, kind: isChief ? 'chief' : 'bot', id: s.id, ids: members.map((m) => m.id),
      name: ren ? ren.name : isChief ? 'Chief' : s.name || short(s.id),
      account: s.account, repo: s.repo || null, state: s.state, label: s.label, statusColor: s.stateColor,
      preview: previewOf(s), at: Math.max(...members.map(lastOf)), needsYou: NEEDS.has(s.state), busy: BUSY.has(s.state), pinned: isChief,
    };
    out.push(row);
    byKey.set(k, row);
  }
  if (!hasChief && opts.chiefPlaceholder) {
    out.push({
      key: 'chief', kind: 'chief', id: null, ids: [], name: 'Chief', account: null, repo: null, state: 'NEW', label: 'NEW',
      statusColor: null, preview: 'Not started yet', at: 0, needsYou: false, busy: false, pinned: true,
    });
  }
  for (const t of state.teams || []) {
    const rows = [];
    const members = [];
    const leadRow = t.lead ? byKey.get(chains.keyFor(t.lead)) : null;
    for (const id of t.members || []) {
      const r = byKey.get(chains.keyFor(id));
      if (!r || rows.includes(r)) continue;
      rows.push(r);
      members.push({ id: r.id, name: r.name, lead: r === leadRow });
    }
    if (!rows.length) continue;
    const m = t.messages && t.messages.length ? t.messages[t.messages.length - 1] : null;
    out.push({
      key: 'team:' + t.id, kind: 'team', id: null, ids: members.map((x) => x.id), name: t.name, account: null, repo: null,
      state: 'TEAM', label: 'GROUP', statusColor: t.color,
      preview: oneLine(m ? `${nameIn(m.from, known) || short(m.from)}: ${m.text}` : t.order),
      at: m ? m.t : t.at || 0, needsYou: rows.some((r) => r.needsYou), busy: rows.some((r) => r.busy), pinned: false, teamId: t.id, members,
    });
  }
  return out;
}

export function sortContacts(list) {
  return list.slice().sort((a, b) => {
    const ac = a.kind === 'chief' || !!a.pinned, bc = b.kind === 'chief' || !!b.pinned;
    if (ac !== bc) return ac ? -1 : 1;
    if (!!a.needsYou !== !!b.needsYou) return a.needsYou ? -1 : 1;
    if (a.needsYou) return (a.at || 0) - (b.at || 0);
    return (b.at || 0) - (a.at || 0);
  });
}

export function teamThread(team, state) {
  const known = new Map();
  const st = state || {};
  for (const s of (st.allSessions || []).concat(st.sessions || [], st.finishedSessions || [])) if (s && s.id != null) known.set(s.id, s);
  const nm = (id) => nameIn(id, known) || short(id);
  return (team.messages || []).slice().sort((a, b) => (a.t || 0) - (b.t || 0))
    .map((m) => ({ t: m.t, from: m.from, fromName: nm(m.from), to: m.to, toName: nm(m.to), text: m.text }));
}

export const unread = (c, seen) => !!(c.at && (!seen || !seen[c.key] || seen[c.key] < c.at));
