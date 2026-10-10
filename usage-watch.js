// usage-watch.js: notices when an account's Claude plan usage climbs with nothing on this PC to explain it, which
// means the account is being used somewhere else (another computer, claude.ai, the phone app, the desktop app's
// Cowork, someone else). Only Claude Code sessions on this PC count as "here": they are the logs Fleet View reads.
//
// fleet-view.js feeds it two things:
//   addLocal(account, t, usd)   what each reply on this PC cost at API prices, at the reply's own time (from the
//                               logs, so a restart or a backlog of unread logs lands the cost in the right minute)
//   read(account, r, o)         each read of the usage endpoint (every 5 minutes, 2 while something looks off):
//                               r = { t, five, fiveResets, week, weekResets, credits: { used, limit, enabled } | null,
//                               breakdown: [{ name, pct }] }; o.pending: some logs are not read to the end yet
// and gets back view(now) for /state (usage) and ack(account, episode) for "I know, keep using".
//
// How it judges. Between two reads the 5-hour limit's percentage rose by d (a new window counts from 0). The spend
// on this PC over the same stretch (and the 5 minutes before it, as the meter can lag) explains part of it:
// - nothing spent here (under IDLE_USD): none of it is explained;
// - something spent, and the account's rate is known (ratio: dollars per 1% of the 5-hour limit, learned from the
//   stretches where this PC was busy): local / ratio of it is explained, with 50% to spare, rounded up;
// - something spent and no rate known yet: all of it is explained (it never guesses against you).
// The rest is from elsewhere. Reads more than 20 minutes apart are not compared (Fleet View was off).
// An episode starts when the last 30 minutes hold at least alertPct points of the 5-hour limit from elsewhere (one
// point less, for whole-percent rounding), or alertUsd of extra-usage credits spent while this PC spent nothing.
// It lasts until 45 minutes pass with nothing more from elsewhere. Each episode has its own id; acknowledging it
// hides the heads-up for that episode only, so the next burst asks again.
//
// A stretch's result is fixed once it is 10 minutes old (later logs can't change the past, and a restart, which
// forgets the cost of conversations gone from the view, can't turn old stretches into "elsewhere").
// Everything but the per-minute local spend is kept in <dir>/usage-watch.json (24 hours of reads, the last
// episodes, the acknowledged ids, the learned rate), so a restart keeps the history and the acknowledgements.
'use strict';
const fs = require('fs');
const path = require('path');

const MIN = 60e3;
const KEEP_MS = 24 * 3600e3;
const WINDOW_MS = 30 * MIN;
const QUIET_MS = 45 * MIN;
const GAP_MS = 20 * MIN;
const LAG_MS = 5 * MIN;
const FINAL_MS = 10 * MIN;
const BARS_MS = 5 * 3600e3;
const IDLE_USD = 0.25;
const LEARN_USD = 1;
const DEFAULT_PCT = 10;
const DEFAULT_USD = 5;
const PAST_MAX = 10;
const ACKS_MAX = 50;

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function createWatch(o = {}) {
  const now = o.now || Date.now;
  const file = o.file || null;
  const alertPct = () => { const v = Number(o.alertPct ? o.alertPct() : NaN); return v > 0 ? v : DEFAULT_PCT; };
  const alertUsd = () => { const v = Number(o.alertUsd ? o.alertUsd() : NaN); return v > 0 ? v : DEFAULT_USD; };
  const local = new Map(); // account -> Map(minute start -> usd)
  let saved = load();

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && typeof j === 'object' && j.accounts && typeof j.accounts === 'object') return j;
    } catch {}
    return { accounts: {} };
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(saved));
      fs.renameSync(tmp, file);
    } catch {}
  }
  const acct = (a) => saved.accounts[a] || (saved.accounts[a] = { reads: [], ratio: null, episode: null, past: [], acks: [], latest: null });

  function addLocal(a, t, usd) {
    if (!a || !Number.isFinite(t) || !Number.isFinite(usd) || !usd) return;
    if (t < now() - KEEP_MS) return;
    let m = local.get(a);
    if (!m) local.set(a, (m = new Map()));
    const k = Math.floor(t / MIN) * MIN;
    m.set(k, (m.get(k) || 0) + usd);
  }
  // this PC's spend for an account in (from, to]
  function spent(a, from, to) {
    const m = local.get(a);
    if (!m) return 0;
    let s = 0;
    for (const [k, v] of m) if (k + MIN > from && k <= to) s += v;
    return s;
  }
  function prune(t) {
    for (const m of local.values()) for (const k of m.keys()) if (k < t - KEEP_MS) m.delete(k);
  }

  // the rise of the 5-hour percentage from read p to read r, or null when it can't be told
  function rise(p, r) {
    if (num(p.five) == null || num(r.five) == null) return null;
    const newWindow = (p.fiveResets && r.fiveResets && Math.abs(r.fiveResets - p.fiveResets) > MIN) || r.five < p.five;
    return newWindow ? r.five : r.five - p.five;
  }
  // fills in r.d (rise), r.here (explained), r.away (elsewhere), r.local (usd), r.credAway (usd) from read p
  function judge(A, a, p, r) {
    r.d = null; r.here = 0; r.away = 0; r.local = 0; r.credAway = 0;
    if (!p || r.t - p.t > GAP_MS || r.t <= p.t) return;
    const d = rise(p, r);
    const usd = spent(a, p.t - LAG_MS, r.t);
    r.local = Math.round(spent(a, p.t, r.t) * 100) / 100;
    if (d != null && d > 0) {
      const explained = usd < IDLE_USD ? 0 : A.ratio ? Math.min(d, Math.ceil((usd / A.ratio) * 1.5)) : d;
      r.d = d; r.here = explained; r.away = d - explained;
    } else if (d != null) r.d = d;
    // extra-usage credits spent while nothing ran here
    const pc = p.credits && num(p.credits.used), rc = r.credits && num(r.credits.used);
    if (pc != null && rc != null && rc > pc && usd < IDLE_USD) r.credAway = Math.round((rc - pc) * 100) / 100;
  }
  // dollars per 1% of the 5-hour limit, from busy stretches in the last 24 hours (kept when there are too few)
  function learn(A) {
    let usd = 0, pts = 0;
    for (const r of A.reads) if (r.final && r.d > 0 && r.local >= LEARN_USD) { usd += r.local; pts += r.d; }
    if (pts >= 3) A.ratio = Math.round((usd / pts) * 1000) / 1000;
  }

  function read(a, r0, opts = {}) {
    const t = num(r0 && r0.t) || now();
    const A = acct(a);
    const r = {
      t, five: num(r0.five), fiveResets: num(r0.fiveResets), week: num(r0.week), weekResets: num(r0.weekResets),
      credits: r0.credits && typeof r0.credits === 'object' ? { used: num(r0.credits.used), limit: num(r0.credits.limit), enabled: !!r0.credits.enabled } : null,
    };
    A.latest = { ...r, breakdown: Array.isArray(r0.breakdown) ? r0.breakdown.slice(0, 8) : [] };
    A.reads = A.reads.filter((x) => x.t > t - KEEP_MS && x.t < t);
    A.reads.push(r);
    prune(t);
    // judge every stretch not fixed yet; a backlog of unread logs leaves them open
    for (let i = 1; i < A.reads.length; i++) {
      const x = A.reads[i];
      if (x.final) continue;
      judge(A, a, A.reads[i - 1], x);
      if (!opts.pending && t - x.t >= FINAL_MS) x.final = true;
    }
    learn(A);
    if (!opts.pending) episodes(A, t);
    save();
  }

  function episodes(A, t) {
    const recent = A.reads.filter((x) => x.t > t - WINDOW_MS);
    const away = recent.reduce((n, x) => n + (x.away || 0), 0) - 1;
    const cred = recent.reduce((n, x) => n + (x.credAway || 0), 0);
    const hit = (x) => (x.away || 0) > 0 || (x.credAway || 0) > 0;
    let e = A.episode;
    if (e && t - e.last > QUIET_MS) {
      A.past = [{ id: e.id, start: e.start, last: e.last, total: e.total, credits: e.credits }, ...A.past].slice(0, PAST_MAX);
      e = A.episode = null;
    }
    if (!e && (away >= alertPct() || cred >= alertUsd())) {
      const first = recent.find(hit);
      e = A.episode = { id: `${t.toString(36)}`, start: first ? first.t : t, last: t, total: 0, credits: 0 };
    }
    if (e) {
      const since = A.reads.filter((x) => x.t >= e.start);
      e.total = Math.max(0, since.reduce((n, x) => n + (x.away || 0), 0) - 1);
      e.credits = Math.round(since.reduce((n, x) => n + (x.credAway || 0), 0) * 100) / 100;
      const lastHit = [...since].reverse().find(hit);
      if (lastHit) e.last = Math.max(e.last, lastHit.t);
    }
  }

  function ack(a, id) {
    const A = saved.accounts[a];
    if (!A || typeof id !== 'string' || !id) return false;
    if (!A.acks.includes(id)) A.acks = [...A.acks, id].slice(-ACKS_MAX);
    save();
    return true;
  }

  // something from elsewhere in the last 30 minutes: read more often
  function suspicious() {
    const t = now();
    return Object.values(saved.accounts).some((A) => A.episode || A.reads.some((x) => x.t > t - WINDOW_MS && ((x.away || 0) > 0 || (x.credAway || 0) > 0)));
  }

  function view(t = now()) {
    const out = {};
    for (const [a, A] of Object.entries(saved.accounts)) {
      if (!A.latest) continue;
      const L = A.latest;
      const bars = A.reads.filter((x) => x.t > t - BARS_MS && x.d != null).map((x) => ({ t: x.t, here: x.here || 0, away: x.away || 0, local: x.local || 0 }));
      const away5 = Math.max(0, bars.reduce((n, x) => n + x.away, 0) - (bars.some((x) => x.away) ? 1 : 0));
      const e = A.episode;
      out[a] = {
        at: L.t,
        five: L.five != null ? { pct: L.five, resets: L.fiveResets && L.fiveResets > t ? L.fiveResets : null } : null,
        week: L.week != null ? { pct: L.week, resets: L.weekResets && L.weekResets > t ? L.weekResets : null } : null,
        credits: L.credits, breakdown: L.breakdown, ratio: A.ratio, away5, bars,
        episode: e ? { id: e.id, start: e.start, last: e.last, total: e.total, credits: e.credits, acked: A.acks.includes(e.id) } : null,
        past: A.past.slice(0, 5),
      };
    }
    return out;
  }

  return { addLocal, read, ack, view, suspicious, _saved: () => saved };
}

// the usage endpoint's reply -> the read() shape (null when it has no 5-hour or weekly figure)
function fromEndpoint(j, t) {
  if (!j || typeof j !== 'object') return null;
  const f = j.five_hour, w = j.seven_day, x = j.extra_usage;
  const pct = (v) => (v && typeof v.utilization === 'number' ? v.utilization : null);
  const when = (v) => (v && v.resets_at ? Date.parse(v.resets_at) || null : null);
  if (pct(f) == null && pct(w) == null) return null;
  let credits = null;
  if (x && typeof x === 'object' && (x.credits_ever_enabled || x.is_enabled || typeof x.used_credits === 'number')) {
    const k = Math.pow(10, Number.isInteger(x.decimal_places) ? x.decimal_places : 2);
    credits = { used: typeof x.used_credits === 'number' ? x.used_credits / k : null, limit: typeof x.monthly_limit === 'number' ? x.monthly_limit / k : null, enabled: !!x.is_enabled };
  }
  const rows = j.seven_day_breakdown && Array.isArray(j.seven_day_breakdown.rows) ? j.seven_day_breakdown.rows : [];
  const breakdown = rows.filter((r) => r && typeof r.percent === 'number' && typeof r.display_name === 'string').map((r) => ({ name: r.display_name.slice(0, 40), pct: r.percent }));
  return { t, five: pct(f), fiveResets: when(f), week: pct(w), weekResets: when(w), credits, breakdown };
}

module.exports = { createWatch, fromEndpoint, DEFAULT_PCT, DEFAULT_USD };
