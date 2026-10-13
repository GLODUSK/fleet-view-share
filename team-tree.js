// team-tree.js: how teams nest (fleet-view.js teams; Henry, 2026-10-12: "leader of leaders"). A conversation is a
// plain member (not its lead) of at most one team, its upper team, where it reports, and leads at most one team, its
// own. So a lead can be a plain member of a team above, led by another lead: a tree of teams, top lead -> mid leads ->
// their members. It never loops: following "X leads T, T has plain member Y, Y leads U, ..." never comes back to X.
// A team here is anything with { members: [ids], lead: id | null } (ids lower case, lead one of the members).
//
//   upperOf(teams, id) -> the team id is a plain member of, or null
//   ledOf(teams, id) -> the team id leads, or null
//   teamsOf(teams, id) -> [upper, own]: both, upper first (one, or none)
//   teamOf(teams, id) -> upper, else own: the one team of a conversation in one (as before nesting)
//   parentOf(teams, t) -> the team t's lead is a plain member of (the team above t), or null
//   cycleIn(teams) -> the leads around a loop (the first found), or null
//   enforce(list) -> the list with the invariant held, for teams read from settings or another device: in list order,
//     a plain seat after the first is dropped, a second team's lead is no lead there (a plain member, if it has no
//     plain seat yet), and a loop is broken by dropping the plain seat of the lead of the latest team in it; a team
//     left with fewer than 2 members goes. Teams are changed in place (members, lead).
//   relation(fromTeams, from, to) -> 'lead' (from leads a team to is in), 'mate' (they share a team otherwise) or
//     null; fromTeams: from's teams (teamsOf). How a message or a question from one is headed for the other (api.js)
//   carryOn(teams, t, m, to) -> to takes m's place in t (m handed off or ran /clear, to carries on: fleet-view.js
//     pruneTeams), lead if m led it: 'swapped', 'merged' (to was in t already: m just goes), or null when to holds that
//     kind of place in another team already (a plain seat, a team it leads) or it would loop (t is left as it was)
'use strict';

const upperOf = (teams, id) => (id ? teams.find((t) => t.members.includes(id) && t.lead !== id) || null : null);
const ledOf = (teams, id) => (id ? teams.find((t) => t.lead === id && t.members.includes(id)) || null : null);
function teamsOf(teams, id) {
  const up = upperOf(teams, id), own = ledOf(teams, id);
  return [up, own].filter((t, i, a) => t && a.indexOf(t) === i);
}
const teamOf = (teams, id) => upperOf(teams, id) || ledOf(teams, id);
const parentOf = (teams, t) => (t && t.lead ? upperOf(teams, t.lead) : null);

function cycleIn(teams) {
  for (const t of teams) {
    const seen = [t];
    for (let p = parentOf(teams, t); p; p = parentOf(teams, p)) {
      if (p === t) return seen.map((x) => x.lead);
      if (seen.includes(p)) break; // a loop above t, not through it: found from one of its own teams
      seen.push(p);
    }
  }
  return null;
}

function enforce(list) {
  const plain = new Set(), leads = new Set();
  let out = [];
  for (const t of list) {
    const lead = t.lead && t.members.includes(t.lead) && !leads.has(t.lead) ? t.lead : null;
    t.members = t.members.filter((m) => m === lead || !plain.has(m));
    t.lead = lead;
    if (t.members.length < 2) continue;
    for (const m of t.members) (m === lead ? leads : plain).add(m);
    out.push(t);
  }
  for (let c = cycleIn(out); c; c = cycleIn(out)) {
    // the latest team in the loop: its lead's plain seat goes
    const late = out.filter((t) => c.includes(t.lead)).pop();
    const up = upperOf(out, late.lead);
    up.members = up.members.filter((m) => m !== late.lead);
    out = out.filter((t) => t.members.length >= 2 && (!t.lead || t.members.includes(t.lead)));
  }
  return out;
}

function relation(fromTeams, from, to) {
  const both = (fromTeams || []).filter((t) => t && t.members.includes(to));
  return to !== from && both.some((t) => t.lead === from) ? 'lead' : both.length ? 'mate' : null;
}

function carryOn(teams, t, m, to) {
  const lead = t.lead === m, inT = t.members.includes(to);
  const other = lead ? ledOf(teams, to) : inT ? null : upperOf(teams, to);
  if (other && other !== t) return null;
  const back = [t.members, t.lead];
  t.members = inT ? t.members.filter((x) => x !== m) : t.members.map((x) => (x === m ? to : x));
  if (lead) t.lead = to;
  if (cycleIn(teams)) { [t.members, t.lead] = back; return null; }
  return inT ? 'merged' : 'swapped';
}

module.exports = { upperOf, ledOf, teamsOf, teamOf, parentOf, cycleIn, enforce, relation, carryOn };
