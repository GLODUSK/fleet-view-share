// Chief model: the pure pieces of the Chief's strip in the Bots view (the briefing card, Ask the Chief and the Watch
// mode switch). chats.js draws them on the page; the phone app (phone/) imports this file as it is and draws them
// with its own views.
//
// CONTRACT (keep these names and shapes):
//   CHIEF_DEFAULTS        what a Chief starts with (chief.js DEFAULTS): { account: 'B', model, effort: 'medium' }
//   ASK_TEXT              what "Ask the Chief" puts in the chat box: 'Brief me' (nothing is sent until the user does)
//   WATCH_NOTE            the line under the switch: what Watch mode off and on mean
//   WATCH_HOLD_MS         how long a just-flipped switch wins over /state (6 s)
//   BRIEF_MS              how often the briefing reads again at most while the Chief shows (GET /chief/briefing, 60 s)
//   watchOn(state, flip, now)   the switch: flip ({ on, at } just set here, or null) while under WATCH_HOLD_MS old,
//                         else state.settings.chief.watch
//   watchBody(on)         POST /settings's body: { chief: { watch: true|false } } (the relay takes exactly that)
//   briefLines(b)         the short view: the briefing's text as its non-empty lines, [] for none
//   briefSections(b, now) the long view: [{ key: 'needs'|'work'|'done'|'dep', title, rows: [{ id (null: not a
//                         conversation), name, repo, what, when, state (deploys only) }] }], only the non-empty ones
//   briefTime(b)          when it was read, local 'HH:MM', '' for none
//   since(ms, now)        how long ago, short: 'now', '7m', '3h', '2d', '' for none
//   fixtureBriefing(state)   a briefing in GET /chief/briefing's shape, built from a /state (?fixture=1, tests)
//   Nothing here touches the DOM or window, and it imports nothing.

export const CHIEF_DEFAULTS = { account: 'B', model: 'claude-sonnet-5-5', effort: 'medium' };
export const ASK_TEXT = 'Brief me';
export const WATCH_NOTE = 'Off: the Chief acts only when you tell it. On: it checks in every 15 min at most and may nudge stalled bots.';
export const WATCH_HOLD_MS = 6000;
export const BRIEF_MS = 60000;

const NEEDS = new Set(['ASKING', 'QUESTION', 'ERROR', 'STALLED']);
const BUSY = new Set(['WORKING', 'AGENTS']);
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function watchOn(state, flip, now = Date.now()) {
  if (flip && typeof flip.on === 'boolean' && now - (flip.at || 0) < WATCH_HOLD_MS) return flip.on;
  return !!(state && state.settings && state.settings.chief && state.settings.chief.watch);
}

export const watchBody = (on) => ({ chief: { watch: !!on } });

export const briefLines = (b) => (b ? str(b.text).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()) : []);

export function since(ms, now = Date.now()) {
  if (!ms || !Number.isFinite(ms)) return '';
  const m = Math.max(0, Math.round((now - ms) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

export function briefTime(b) {
  if (!b || !Number.isFinite(b.at) || !b.at) return '';
  const d = new Date(b.at), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function briefSections(b, now = Date.now()) {
  if (!b) return [];
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const row = (x, what, at, conv = true) => ({ id: conv && typeof x.id === 'string' ? x.id : null, name: str(x.name), repo: str(x.repo), what: str(what), when: since(at, now) });
  const secs = [
    { key: 'needs', title: 'Needs you', rows: list(b.needsYou).map((x) => row(x, x.what, x.since)) },
    { key: 'work', title: 'Working', rows: list(b.working).map((x) => row(x, x.doing, x.since)) },
    { key: 'done', title: 'Finished', rows: list(b.finished).map((x) => row(x, x.summary, x.at)) },
    // a deploy row: its repo, then its state where a conversation's repo goes, then its title; no id (not a conversation)
    { key: 'dep', title: 'Deploys', rows: list(b.deploys).map((x) => ({ ...row({ name: x.repo, repo: x.state }, x.title, x.at, false), state: /^\w+$/.test(str(x.state)) ? x.state : '' })) },
  ];
  return secs.filter((s) => s.rows.length);
}

export function fixtureBriefing(state, now = Date.now()) {
  const st = state || {}, ss = st.allSessions || st.sessions || [];
  const repoOf = (s) => (s.repo && s.repo.name) || '';
  const act = (s) => (s.lastAction && s.lastAction.what ? `${s.lastAction.verb || 'working'} ${s.lastAction.what}` : s.goal || s.label || '');
  const needsYou = ss.filter((s) => NEEDS.has(s.state)).slice(0, 10).map((s) => ({
    id: s.id, name: s.name, repo: repoOf(s), since: (s.lastAction && s.lastAction.t) || now,
    what: s.state === 'ERROR' ? 'hit an error' : s.state === 'STALLED' ? 'looks stalled' : (typeof s.waitingOn === 'string' ? s.waitingOn : s.waitingOn && s.waitingOn.text) || 'asked you a question',
  }));
  const working = ss.filter((s) => BUSY.has(s.state)).slice(0, 12).map((s) => ({ id: s.id, name: s.name, repo: repoOf(s), doing: act(s), since: s.turnStart || (s.lastAction && s.lastAction.t) || now }));
  const finished = (st.finished || []).slice(0, 10).map((f) => ({ id: f.id, name: f.name, repo: (f.repo && f.repo.name) || '', summary: f.summary || '', at: f.endedAt || now }));
  const deploys = (st.deploys || []).slice(0, 6).map((d) => ({ repo: d.name || d.repo, state: d.state, title: d.title || '', at: d.readyAt || d.createdAt || now }));
  const text = [];
  if (needsYou.length) text.push(`${needsYou.length} need${needsYou.length === 1 ? 's' : ''} you: ${needsYou.slice(0, 3).map((n) => `${n.name} (${n.what})`).join(', ')}${needsYou.length > 3 ? ` and ${needsYou.length - 3} more` : ''}`);
  if (working.length) text.push(`${working.length} working: ${working.slice(0, 3).map((w) => w.name).join(', ')}${working.length > 3 ? ` and ${working.length - 3} more` : ''}`);
  if (finished.length) text.push(`${finished.length} finished: ${finished.slice(0, 2).map((f) => `${f.name} (${f.summary})`).join(', ')}`);
  for (const d of deploys.slice(0, 2)) text.push(`Deploy ${d.state}: ${d.repo}${d.title ? ` · ${d.title}` : ''}`);
  return { at: now, needsYou, working, finished, deploys, text: text.join('\n') || 'Nothing is going on.' };
}
