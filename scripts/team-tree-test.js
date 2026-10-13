// team-tree-test.js: a check of team-tree.js, how teams nest (a leader of leaders). A mid-level lead is a plain
// member of the team above and leads its own: teamOf gives the one above, ledOf its own, teamsOf both. A loop (a lead
// reporting to itself) is found. enforce (fleet-view.js cleanTeams, for settings and another device's teams) keeps a
// nested set as it is and the old one-team-each shape too, drops a second plain seat and a second team led, and
// breaks a loop at its latest team. relation heads a message ("your lead", "teammate") across both teams of a
// mid-level lead. carryOn swaps a handed-off member in each of its two teams, and refuses a swap that clashes or loops.
// Run: node scripts/team-tree-test.js (exit 0 = all pass)
'use strict';
const path = require('path');
const TT = require(path.join(__dirname, '..', 'team-tree.js'));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), `${n}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const team = (id, members, lead = null) => ({ id, members: [...members], lead });
const ids = (list) => list.map((t) => (t ? t.id : null));
// top: T leads A and B; ta: A leads a1, a2; tb: B leads b1
const tree = () => [team('top', ['T', 'A', 'B'], 'T'), team('ta', ['A', 'a1', 'a2'], 'A'), team('tb', ['B', 'b1'], 'B')];

// ---------- helpers ----------
{
  const ts = tree();
  eq(ids([TT.upperOf(ts, 'A'), TT.ledOf(ts, 'A')]), ['top', 'ta'], 'a mid-level lead: the team above, the one it leads');
  eq(ids(TT.teamsOf(ts, 'A')), ['top', 'ta'], 'teamsOf: both, the one above first');
  eq(ids([TT.teamOf(ts, 'A'), TT.teamOf(ts, 'T'), TT.teamOf(ts, 'a1'), TT.teamOf(ts, 'zz')]), ['top', 'top', 'ta', null], 'teamOf: the one above, else the one it leads');
  eq(ids(TT.teamsOf(ts, 'T')), ['top'], 'the top lead is in one team');
  eq(ids([TT.parentOf(ts, ts[1]), TT.parentOf(ts, ts[0])]), ['top', null], 'parentOf: the team its lead reports in');
  eq(TT.cycleIn(ts), null, 'a tree has no loop');
  const loop = tree();
  loop[1].members.push('T'); // T reports to A, who reports to T
  const c = TT.cycleIn(loop);
  ok(c && c.includes('T') && c.includes('A'), `a loop is found with its leads: ${JSON.stringify(c)}`);
  const peers = [team('p', ['A', 'B']), team('ta', ['A', 'a1'], 'A')];
  eq([TT.cycleIn(peers), ids(TT.teamsOf(peers, 'A'))], [null, ['p', 'ta']], 'a lead can be a peer in a team of peers above');
}

// ---------- enforce (cleanTeams) ----------
{
  eq(TT.enforce(tree()).map((t) => [t.id, t.members, t.lead]), tree().map((t) => [t.id, t.members, t.lead]), 'a nested set stays as it is');
  const old = [team('t1', ['a', 'b'], 'a'), team('t2', ['c', 'd'])];
  eq(TT.enforce(old.map((t) => ({ ...t, members: [...t.members] }))).map((t) => [t.id, t.members, t.lead]), old.map((t) => [t.id, t.members, t.lead]), 'the old one-team shape stays as it is');
  // a plain seat twice: the later team loses it (as before nesting); one left alone goes
  eq(TT.enforce([team('t1', ['a', 'b']), team('t2', ['b', 'c', 'd'])]).map((t) => t.members), [['a', 'b'], ['c', 'd']], 'a second plain seat is dropped');
  eq(ids(TT.enforce([team('t1', ['a', 'b']), team('t2', ['b', 'a'])])), ['t1'], 'a team left with one member goes');
  // leading two: the later team has no lead, and keeps it as a plain member when it has no plain seat yet
  eq(TT.enforce([team('t1', ['a', 'b'], 'a'), team('t2', ['a', 'c'], 'a')]).map((t) => [t.members, t.lead]), [[['a', 'b'], 'a'], [['a', 'c'], null]], 'a second team led: no lead there, a plain member');
  eq(TT.enforce([team('t0', ['a', 'z']), team('t1', ['a', 'b'], 'a'), team('t2', ['a', 'c', 'd'], 'a')]).map((t) => [t.members, t.lead]),
    [[['a', 'z'], null], [['a', 'b'], 'a'], [['c', 'd'], null]], '... and dropped there when it has a plain seat already');
  // a loop: the latest team in it loses its lead's plain seat above
  const lp = TT.enforce([team('top', ['T', 'A', 'B'], 'T'), team('ta', ['A', 'T', 'a1'], 'A')]);
  eq(lp.map((t) => [t.id, t.members, t.lead]), [['top', ['T', 'B'], 'T'], ['ta', ['A', 'T', 'a1'], 'A']], 'a loop is broken at its latest team');
  const lp2 = TT.enforce([team('x', ['X', 'Y'], 'X'), team('y', ['Y', 'X'], 'Y')]);
  eq(lp2.map((t) => [t.id, t.members]), [['y', ['Y', 'X']]], 'two leads in each other\'s teams: the earlier loses the later\'s lead, and goes with one left');
  eq(TT.cycleIn(lp2), null, '... and no loop is left');
}

// ---------- relation (api.js message heads) ----------
{
  const ts = tree();
  const rel = (from, to) => TT.relation(TT.teamsOf(ts, from), from, to);
  eq([rel('A', 'a1'), rel('T', 'A'), rel('A', 'T'), rel('A', 'B'), rel('a1', 'A'), rel('a1', 'a2'), rel('A', 'b1')],
    ['lead', 'lead', 'mate', 'mate', 'mate', 'mate', null], 'your lead down each level, teammate across and up, nothing outside');
  eq(TT.relation(null, 'A', 'a1'), null, 'no teams: no relation');
}

// ---------- carryOn (pruneTeams) ----------
{
  // the mid-level lead hands off: its successor takes both places, and leads its team
  const ts = tree();
  eq([TT.carryOn(ts, ts[0], 'A', 'A2'), TT.carryOn(ts, ts[1], 'A', 'A2')], ['swapped', 'swapped'], 'a mid-level lead\'s successor takes both places');
  eq([ts[0].members, ts[1].members, ts[1].lead, ids(TT.teamsOf(ts, 'A2'))], [['T', 'A2', 'B'], ['A2', 'a1', 'a2'], 'A2', ['top', 'ta']], '... the lead stays the lead');
  // the top lead hands off
  eq([TT.carryOn(ts, ts[0], 'T', 'T2'), ts[0].lead], ['swapped', 'T2'], 'the top lead\'s successor leads');
  // one already in the team: the old one just goes
  eq([TT.carryOn(ts, ts[1], 'a2', 'a1'), ts[1].members], ['merged', ['A2', 'a1']], 'a successor in the team already: the old one goes');
  // clashes: a successor with a plain seat elsewhere, a successor that leads another team
  const c = tree();
  eq([TT.carryOn(c, c[1], 'a1', 'b1'), c[1].members], [null, ['A', 'a1', 'a2']], 'a successor with a plain seat elsewhere is not swapped in');
  eq([TT.carryOn(c, c[2], 'B', 'A'), c[2].lead], [null, 'B'], 'a successor that leads another team does not take a lead');
  // a swap that would loop is refused and undone
  eq([TT.carryOn(c, c[1], 'a1', 'T'), c[1].members, TT.cycleIn(c)], [null, ['A', 'a1', 'a2'], null], 'a swap that would loop is refused');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
