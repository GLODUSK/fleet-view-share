// Switching accounts when one runs low (Henry, 2026-10-13: "if a conversation runs out of usage it uses another
// account to continue ... say it starts with claude a but claude a runs out of credits soonish it should prevent and
// swap to claude b"). The decisions only, with no side effects: fleet-view.js reads the usage, the hosted sessions and
// the setting (autoSwitchAccount in ~/.fleet-view.json, on unless false), asks plan() what to move, and has the session
// host move each one (desktop/host.js switchAccount: the same conversation, ended and resumed under the new account).
//
// - Prevent: a hosted, live conversation whose account reaches SWITCH_PCT of its 5-hour or weekly limit moves at its
//   next pause (idle between turns; never while busy or while a menu or question waits) to the roomiest other account
//   that has room: signed in, not a second letter of the same login (sameAs), its fuller limit under ROOM_PCT and
//   under the current one's. At most one move per conversation in COOLDOWN_MS.
// - Rescue: one that hit the limit anyway (Claude Code's "You've hit your session limit · resets …" API error, limitHit
//   below) moves the same way, without waiting out the cooldown, and is told "continue" there.
// - New conversations: one asked for on an account at SWITCH_PCT or more starts on the roomiest account with room
//   instead (pickNew).
// - Nothing moves when no account has room: the caller says so once (plan's stuck).
// An account with no usage read yet is never picked (its room is not known), and a conversation on one is left alone.
'use strict';

const SWITCH_PCT = 90; // a limit this full: move off the account
const ROOM_PCT = 80; // an account has room while its fuller limit is under this
const WATCH_PCT = 80; // while any account is this full, its usage is read every 2 minutes, not 5
const COOLDOWN_MS = 30 * 60e3; // one move per conversation in this long (a rescue does not wait)
const RESCUE_MS = 30 * 60e3; // a limit hit older than this is not rescued

const pctOf = (x) => (x && Number.isFinite(x.pct) ? x.pct : null);
// how full an account is: { top (the fuller of its 5-hour and weekly limits), five, week }, or null with no read.
// usage: /state's usage (usage-watch.js view)
function fullness(u) {
  const f = pctOf(u && u.five), w = pctOf(u && u.week);
  if (f == null && w == null) return null;
  return { top: Math.max(f ?? 0, w ?? 0), five: f, week: w };
}
// The account with the most usage left, by the fuller of its 5-hour and weekly limits, the weekly one breaking a tie.
// An account with no read yet comes after every one with a read; with none read, def (else the first). bots.js uses it
// for a Dynamic bot's new conversations.
function roomiest(accounts, usage, def) {
  const list = (accounts || []).filter((a) => typeof a === 'string' && a);
  if (!list.length) return def;
  const read = list.map((a) => ({ a, f: fullness(usage && usage[a]) })).filter((x) => x.f);
  if (!read.length) return list.includes(def) ? def : list[0];
  read.sort((x, y) => x.f.top - y.f.top || (x.f.week ?? 0) - (y.f.week ?? 0));
  return read[0].a;
}
// the limit that makes an account low: { limit: 'five' | 'week', pct } (the fuller one), or null
function lowOn(u) {
  const f = fullness(u);
  if (!f || f.top < SWITCH_PCT) return null;
  return (f.five ?? -1) >= (f.week ?? -1) ? { limit: 'five', pct: Math.round(f.five) } : { limit: 'week', pct: Math.round(f.week) };
}
// any account at WATCH_PCT or more (read usage more often)
const nearLimit = (usage) => Object.values(usage || {}).some((u) => { const f = fullness(u); return !!f && f.top >= WATCH_PCT; });

// the letters a conversation may go to: signed in, and not a second letter of a login another letter has
// (accounts: [{ a, signedIn, sameAs }], accounts.js view's list)
const eligible = (accounts) => (accounts || []).filter((x) => x && typeof x.a === 'string' && /^[A-Z]$/.test(x.a) && x.signedIn && !x.sameAs).map((x) => x.a);
// the roomiest account other than `from` that has room (and less of it used than from, unless from hit its limit: its
// last read may be from before), or null
function target(from, accounts, usage, hit = false) {
  const cur = hit ? null : fullness(usage && usage[from]);
  const room = eligible(accounts).filter((a) => {
    if (a === from) return false;
    const f = fullness(usage && usage[a]);
    return !!f && f.top < ROOM_PCT && (!cur || f.top < cur.top);
  });
  return room.length ? roomiest(room, usage, null) : null;
}

const limitName = (l) => (l === 'week' ? 'weekly' : '5-hour');
// why it moved, in a few words: "A at 92% of its 5-hour limit", "A hit its weekly limit"
function whyText(from, why) {
  if (!why) return `Claude ${from} is low`;
  return why.hit ? `${from} hit its ${limitName(why.limit)} limit` : `${from} at ${why.pct}% of its ${limitName(why.limit)} limit`;
}

// Claude Code's usage-limit message in a transcript: an assistant entry with isApiErrorMessage whose quotaLimits say
// rejected, or whose text says "You've hit your session limit · resets 7:20pm" (weekly: "… your weekly limit …"; older
// builds: "… usage limit reached …"). -> { limit: 'five' | 'week' } or null
const LIMIT_TEXT = /\bhit your (?:\w+ )?limit\b|\busage limit (?:was )?reached\b/i;
function limitHit(d) {
  if (!d || typeof d !== 'object' || d.type !== 'assistant' || !d.isApiErrorMessage) return null;
  const q = d.quotaLimits && typeof d.quotaLimits === 'object' ? d.quotaLimits : null;
  const c = d.message && d.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
  if (!(q && q.status === 'rejected') && !LIMIT_TEXT.test(text)) return null;
  const kind = (q && typeof q.rateLimitType === 'string' ? q.rateLimitType : '') || text;
  return { limit: /seven_day|week/i.test(kind) ? 'week' : 'five' };
}

// What to move now. o: {
//   now, on (the setting), accounts ([{ a, signedIn, sameAs }]), usage (/state's usage),
//   sessions: [{ id, account, status ('busy' | 'idle' | 'waiting' | null, the session host's), away (another device has
//     it or it is moving there), moving (a move of it is in flight), limit ({ limit, at }: a limit hit by the claude that
//     runs now, or null) }],
//   last: Map id -> { at } (its last move) }
// -> { moves: [{ id, from, to, rescue, why: { limit, pct?, hit? } }], stuck: [ids that should move but nothing has room] }
function plan(o) {
  const out = { moves: [], stuck: [] };
  if (!o || !o.on) return out;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const usage = o.usage || {}, last = o.last instanceof Map ? o.last : new Map();
  for (const s of o.sessions || []) {
    if (!s || typeof s.id !== 'string' || typeof s.account !== 'string' || s.away || s.moving) continue;
    const hit = s.limit && Number.isFinite(s.limit.at) && now - s.limit.at < RESCUE_MS ? s.limit : null;
    const low = lowOn(usage[s.account]);
    if (!hit && !low) continue;
    // at its next pause: between turns, with nothing on its screen waiting on Henry
    if (s.status !== 'idle') continue;
    const prev = last.get(s.id);
    if (!hit && prev && now - prev.at < COOLDOWN_MS) continue;
    const to = target(s.account, o.accounts, usage, !!hit);
    if (!to) { out.stuck.push(s.id); continue; }
    out.moves.push({ id: s.id, from: s.account, to, rescue: !!hit, why: hit ? { limit: hit.limit, hit: true } : low });
  }
  return out;
}

// A new conversation asked for on `account`: { account (the one to start on instead), from, why } when that one is
// at SWITCH_PCT or more and another has room, else null. o: { on, accounts, usage }
function pickNew(account, o) {
  if (!o || !o.on || typeof account !== 'string') return null;
  const low = lowOn(o.usage && o.usage[account]);
  if (!low) return null;
  const to = target(account, o.accounts, o.usage);
  return to ? { account: to, from: account, why: low } : null;
}

module.exports = { plan, pickNew, roomiest, fullness, lowOn, nearLimit, limitHit, whyText, target, SWITCH_PCT, ROOM_PCT, WATCH_PCT, COOLDOWN_MS, RESCUE_MS };
