// host-rules-test.js: a check of host-rules.js, what pins a conversation to a stays-on rule's host. Only a tool the rule
// names, a write tool's file, or a path word of a shell command pins: a .gitignore edit adding *.blend1, a doc
// mentioning .blend, a read or a search under assets/vehicles, a prompt, a heredoc's text or a commit message never
// does. A tool rule with no repo holds in any workspace; two rules for two repos each hold in their own; the pins are
// worked out again when the rules change; the old single default becomes the pair; the pathspecs. Then a rule's pinOn
// (a shell mention, a write, a tool), whose machine a host is (hostDevice, else the name), a chat's own choice (free,
// stay), and the "Never continue on another machine…" sheet's preview: the chats a draft pins and the files its paths keep in a checkout.
// Run: node scripts/host-rules-test.js (exit 0 = all pass)
'use strict';
const path = require('path');
const H = require(path.join(__dirname, '..', 'host-rules.js'));
const P = require(path.join(__dirname, '..', 'sync-prefs.js'));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), `${n}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const RULES = H.DEFAULT_RULES.map((r) => P.cleanHostRule(r));
const WEB = 'Z:/Github/detailforge-web';
// relOf as fleet-view.js does it: a path in the checkout, from its top
const relOf = (p) => { const s = p.replace(/\\/g, '/'); return s.toLowerCase().startsWith(WEB.toLowerCase() + '/') ? s.slice(WEB.length + 1) : s; };
// the rules a list of calls pins, by id; applies: the repo check (fleet-view.js repoMatches), by default the web repo
function pinsFor(calls, rules = RULES, repo = 'detailforge-web') {
  const seen = H.createSeen();
  calls.forEach((c, i) => H.note(seen, c, 1000 + i, { relOf, rules }));
  const applies = (r) => !r.repo || r.repo.name === repo;
  const first = H.firstPin(seen, rules, applies);
  return { ids: [...H.pinsOf(seen, rules).keys()], first: first ? first.id : null, seen };
}
const call = (name, input) => ({ name, input });

// ---------- never pins ----------
eq(pinsFor([call('Edit', { file_path: `${WEB}/.gitignore`, old_string: 'node_modules/', new_string: 'node_modules/\n*.blend1\n' })]).first, null, '.gitignore edit adding *.blend1');
eq(pinsFor([call('Write', { file_path: `${WEB}/docs/configurator.md`, content: 'The meshes live in assets/vehicles/0001/coupe.blend (and .blend1 backups).' })]).first, null, 'a doc mentioning .blend and assets/vehicles');
eq(pinsFor([call('Edit', { file_path: `${WEB}\\docs\\x.md`, old_string: 'a .blend file', new_string: 'the coupe.blend in assets/vehicles/0001' })]).first, null, 'an Edit of a doc whose text names a .blend');
eq(pinsFor([call('Read', { file_path: `${WEB}/assets/vehicles/0001/manifest.json` })]).first, null, 'a Read of a manifest under assets/vehicles');
eq(pinsFor([call('Grep', { pattern: 'coupe', path: `${WEB}/assets/vehicles`, glob: '*.blend' }), call('Glob', { pattern: 'assets/vehicles/**/*.blend' })]).first, null, 'Grep and Glob under assets/vehicles');
eq(pinsFor([call('Agent', { prompt: 'Open assets/vehicles/0001/coupe.blend and fix the wheels' })]).first, null, 'an Agent prompt naming a .blend');
eq(pinsFor([call('Bash', { command: "echo '*.blend1' >> .gitignore" })]).first, null, 'Bash adding *.blend1 to .gitignore');
eq(pinsFor([call('Bash', { command: 'git commit -m "Ignore coupe.blend backups in assets/vehicles"' })]).first, null, 'a commit message naming a .blend');
eq(pinsFor([call('Bash', { command: "cat > notes.md <<'EOF'\nsee assets/vehicles/0001/coupe.blend\nEOF\ngit add notes.md" })]).first, null, 'a heredoc body naming a .blend');
eq(pinsFor([call('PowerShell', { command: "$t = @'\nassets/vehicles/0001/coupe.blend\n'@\nSet-Content notes.md $t" })]).first, null, 'a PowerShell here-string naming a .blend');
eq(pinsFor([call('Bash', { command: 'grep -rn ".blend" docs/ && curl -sO https://example.com/x.blend' })]).first, null, 'a grep for .blend, and a URL');
eq(pinsFor([call('Bash', { command: 'python -c "import bpy\nbpy.ops.wm.open_mainfile(filepath=\'a.blend\')"' })]).first, null, 'a multi-line -c script');

// ---------- pins ----------
const w = pinsFor([call('Write', { file_path: `${WEB}/models/x.blend`, content: '' })]);
eq([w.first, w.ids], ['configurator-3d', ['configurator-3d']], 'a Write of x.blend in detailforge-web');
eq(H.pinsOf(w.seen, RULES).get('configurator-3d'), { tool: 'Write', path: 'models/x.blend', at: 1000, kind: 'write' }, 'the pin keeps its evidence (the path from the repo\'s top)');
eq(pinsFor([call('Edit', { file_path: 'Z:\\Github\\detailforge-web\\assets\\vehicles\\0001\\manifest.json', old_string: 'a', new_string: 'b' })]).first, 'configurator-3d', 'an Edit under assets/vehicles (Windows spelling)');
eq(pinsFor([call('Bash', { command: 'blender -b assets/vehicles/0001/coupe.blend --python fix.py' })]).first, 'configurator-3d', 'Bash blender -b assets/vehicles/0001/coupe.blend');
eq(pinsFor([call('PowerShell', { command: '& "Z:\\Github\\detailforge-web\\assets\\vehicles\\0001 x\\coupe.blend"' })]).first, 'configurator-3d', 'PowerShell naming a quoted path with a space');
eq(pinsFor([call('Bash', { command: 'cp /Users/henry/code/detailforge-web/assets/vehicles/0002/a.glb /tmp/' })]).first, 'configurator-3d', 'a Mac path in a log from the other machine');
eq(pinsFor([call('Bash', { command: 'blender --render-output=out/x.blend1' })]).first, 'configurator-3d', 'a path after = in a flag');
// a tool rule holds in any workspace (no repo)
const b = pinsFor([call('mcp__blender__execute_blender_code', { code: 'print(1)' })], RULES, null);
eq([b.first, b.ids], ['blender', ['blender']], 'mcp__blender__execute_blender_code in the home folder');
eq(pinsFor([call('mcp__blender__get_objects_summary', {})], RULES, 'fleet-view').first, 'blender', 'a Blender tool in another repo');
// the repo check: the files rule does not hold in another repo
eq(pinsFor([call('Write', { file_path: 'Z:/Github/fleet-view/x.blend', content: '' })], RULES, 'fleet-view').first, null, 'a .blend written in another repo: the configurator rule does not hold');

// ---------- two rules for two repos ----------
const TWO = [
  P.cleanHostRule({ id: 'game-art', repo: { origin: 'GLODUSK/game', name: 'game' }, paths: ['art/**'], tools: [], host: 'Mac' }),
  P.cleanHostRule({ id: 'configurator-3d', repo: { origin: 'GLODUSK/detailforge-web', name: 'detailforge-web' }, paths: ['**/*.blend', 'art/**'], tools: [], host: 'BlackBox' }),
];
const calls2 = [call('Write', { file_path: 'art/a.png', content: '' })];
eq(pinsFor(calls2, TWO, 'game').first, 'game-art', 'two rules: the game repo\'s');
eq(pinsFor(calls2, TWO, 'detailforge-web').first, 'configurator-3d', 'two rules: the first rule (another repo\'s) does not block the web repo\'s');
eq(pinsFor(calls2, TWO, 'detailforge-web').ids, ['game-art', 'configurator-3d'], 'two rules: every matching rule is kept');

// ---------- the rules change: the pins are worked out again ----------
{
  const seen = H.createSeen();
  H.note(seen, call('Write', { file_path: `${WEB}/scenes/a.fbx`, content: '' }), 5, { relOf, rules: RULES });
  eq(H.pinsOf(seen, RULES).size, 0, 'rule change: no rule names .fbx yet');
  const more = [...RULES, P.cleanHostRule({ id: 'fbx', repo: null, paths: ['**/*.fbx'], tools: [], host: 'BlackBox' })];
  eq([...H.pinsOf(seen, more).keys()], ['fbx'], 'rule change: a new list finds the earlier write');
  eq(H.pinsOf(seen, RULES).size, 0, 'rule change: and back');
}

// ---------- pinOn: what pins a chat ----------
{
  const base = { id: 'r', repo: null, paths: ['**/*.blend'], tools: ['mcp__blender*'], host: 'BlackBox' };
  const as = (pinOn) => [P.cleanHostRule({ ...base, pinOn })];
  const named = [call('Bash', { command: 'blender -b scenes/a.blend' })];
  const wrote = [call('Write', { file_path: 'scenes/b.blend', content: '' })];
  const used = [call('mcp__blender__execute_blender_code', { code: '' })];
  const pins = (calls, rules) => pinsFor(calls, rules, null).ids;
  eq([pins(named, as('any')), pins(wrote, as('any')), pins(used, as('any'))], [['r'], ['r'], ['r']], 'pinOn any: a shell mention, a write and a tool each pin');
  eq([pins(named, as('edits')), pins(wrote, as('edits')), pins(used, as('edits'))], [[], ['r'], ['r']], 'pinOn edits: a shell mention does not pin, a write and a tool do');
  eq([pins(named, as('tools')), pins(wrote, as('tools')), pins(used, as('tools'))], [[], [], ['r']], 'pinOn tools: only the rule\'s tools');
  eq([pins(named, as('none')), pins(wrote, as('none')), pins(used, as('none'))], [[], [], []], 'pinOn none: nothing pins');
  // the kind of each path is kept, so a pinOn change works the pins out again without reading the log
  const seen = H.createSeen();
  H.note(seen, call('Bash', { command: 'blender -b scenes/a.blend' }), 10, { rules: as('any') });
  eq(H.pinsOf(seen, as('any')).get('r'), { tool: 'Bash', path: 'scenes/a.blend', at: 10, kind: 'shell' }, 'pinOn: a shell mention\'s evidence says shell');
  eq(H.pinsOf(seen, as('edits')).size, 0, 'pinOn: any -> edits, the shell mention no longer pins');
  H.note(seen, call('Edit', { file_path: 'scenes/a.blend', old_string: 'a', new_string: 'b' }), 20, { rules: as('edits') });
  eq(H.pinsOf(seen, as('edits')).get('r'), { tool: 'Edit', path: 'scenes/a.blend', at: 20, kind: 'write' }, 'pinOn edits: a later write of the same path pins, with its own evidence');
  eq(H.pinsOf(seen, as('any')).get('r').at, 10, 'pinOn any: still by the first mention');
  // a path kept before kinds were (an entry with no kind) goes by its tool
  const old = H.createSeen();
  old.paths.set('x/c.blend', { tool: 'Write', at: 3 }); old.n++;
  old.paths.set('x/d.blend', { tool: 'Bash', at: 4 }); old.n++;
  eq(H.pinsOf(old, as('edits')).get('r'), { tool: 'Write', path: 'x/c.blend', at: 3, kind: 'write' }, 'an entry with no kind: a write tool\'s is a write');
  old.paths.delete('x/c.blend'); old.n++;
  eq(H.pinsOf(old, as('edits')).size, 0, 'an entry with no kind: a shell tool\'s is a shell mention');
  ok(H.PIN_ON.join() === 'any,edits,tools,none' && H.pinOnOf({}) === 'any' && H.pinOnOf({ pinOn: 'x' }) === 'any', 'pinOnOf: any by default');
}

// ---------- the default, and the migration ----------
eq(H.migrate([P.cleanHostRule(H.OLD_DEFAULT)]).map((r) => r.id), ['configurator-3d', 'blender'], 'migrate: the old single default becomes the pair');
eq(H.migrate([P.cleanHostRule(H.OLD_DEFAULT)]).map((r) => P.cleanHostRule(r)), RULES, 'migrate: the pair is clean as it is');
const edited = { ...P.cleanHostRule(H.OLD_DEFAULT), paths: ['assets/vehicles/**'] };
eq(H.migrate([edited]), [edited], 'migrate: a rule Henry edited is left alone');
const two = [P.cleanHostRule(H.OLD_DEFAULT), TWO[0]];
eq(H.migrate(two), two, 'migrate: a list with more rules is left alone');
ok(RULES.every(Boolean) && RULES[1].repo === null && RULES[1].tools[0] === 'mcp__blender*' && !RULES[0].tools.length, 'default: a repo-scoped files rule and a tools rule for any workspace');

// ---------- pathspecs ----------
eq(H.excludeSpecs(['assets/vehicles/**', '**/*.blend']), [':(exclude,top,glob,icase)**/assets/vehicles/**', ':(exclude,top,glob,icase)**/*.blend'], 'excludeSpecs: a leading **/ for the tail match');
eq(H.pickSpecs(['*.blend1']), [':(top,glob,icase)**/*.blend1'], 'pickSpecs');
eq(H.excludeSpecs(null), [], 'excludeSpecs: none');

// ---------- whose machine: hostDevice, else the name ----------
{
  const PCID = '11111111-1111-4111-8111-111111111111', MACID = '22222222-2222-4222-8222-222222222222';
  const byName = P.cleanHostRule({ id: 'a', repo: null, paths: [], tools: ['x'], host: 'BlackBox' });
  const byId = P.cleanHostRule({ id: 'b', repo: null, paths: [], tools: ['x'], host: 'BlackBox', hostDevice: PCID.toUpperCase() });
  ok(H.hostIs(byName, { id: PCID, name: 'blackbox' }) && !H.hostIs(byName, { id: PCID, name: 'Mac' }), 'hostIs: no hostDevice, by name (any case)');
  ok(H.hostIs(byId, { id: PCID, name: 'renamed PC' }), 'hostIs: hostDevice wins over a renamed device');
  ok(!H.hostIs(byId, { id: MACID, name: 'BlackBox' }), 'hostIs: another device that took the same name is not the host');
  ok(H.hostIs(byId, { name: 'BlackBox' }) && !H.hostIs(byId, null) && !H.hostIs(null, { name: 'BlackBox' }), 'hostIs: a device with no id goes by name; nothing is no host');
}

// ---------- a chat's own choice ----------
{
  const id = 'aaaaaaaa-0000-4000-8000-000000000001';
  eq(H.overridePin(null), undefined, 'overridePin: no choice, the rules decide');
  eq(H.overridePin(P.cleanPinOverride({ id, mode: 'free', host: 'BlackBox', at: 1 })), null, 'overridePin: free is never pinned (its host only says where it was)');
  eq(H.overridePin(P.cleanPinOverride({ id, mode: 'stay', host: 'BlackBox', hostDevice: '11111111-1111-4111-8111-111111111111', at: 1 })),
    { id: 'manual', repo: null, paths: [], tools: [], host: 'BlackBox', hostDevice: '11111111-1111-4111-8111-111111111111', manual: true }, 'overridePin: stay is a rule of its own, with no evidence needed');
  ok(H.hostIs(H.overridePin({ mode: 'stay', host: 'Mac' }), { name: 'mac' }), 'overridePin: a stay\'s host is matched like a rule\'s');
}

// ---------- the sheet's preview: which chats a draft pins ----------
{
  const draft = P.cleanHostRule({ id: 'ws-detailforge-web', repo: null, paths: ['scenes/**'], tools: [], host: 'BlackBox', pinOn: 'edits' });
  const seen = H.createSeen();
  H.note(seen, call('Write', { file_path: 'scenes/a.fbx', content: '' }), 1, { rules: RULES });
  const before = H.pinsOf(seen, RULES);
  ok(H.draftPins(seen, RULES, draft), 'draftPins: a write under the draft\'s paths pins');
  ok(H.pinsOf(seen, RULES) === before && seen.cache.rules === RULES, 'draftPins: the chat\'s own cached pins are left as they were');
  ok(!H.draftPins(seen, RULES, { ...draft, pinOn: 'tools' }), 'draftPins: a pinOn change in the draft counts');
  eq(H.withDraft(RULES, { ...RULES[1], tools: ['other'] }).map((r) => r.tools[0] || null), [null, 'other'], 'withDraft: in place of the rule with its id');
  eq(H.withDraft(RULES, draft).map((r) => r.id), ['configurator-3d', 'blender', 'ws-detailforge-web'], 'withDraft: a new one after the rest');
}

// ---------- the sheet's preview: how many files the paths keep ----------
(async () => {
  const fs = require('fs'), os = require('os');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-keep-'));
  try {
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', windowsHide: true });
    git('init', '-q');
    const put = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
    put('.gitignore', '*.blend1\nbuild/\n');
    put('assets/vehicles/0001/coupe.blend'); put('assets/vehicles/0001/manifest.json'); put('models/Truck.BLEND'); put('src/app.js');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
    put('scenes/new.blend'); put('scenes/new.blend1'); put('build/out.blend');
    const globs = ['assets/vehicles/**', '**/*.blend'];
    eq(await H.countKept(dir, globs), { files: 4, more: false }, 'countKept: tracked and untracked, any case, the ignored left out');
    eq(await H.countKept(dir, globs, { cap: 2 }), { files: 2, more: true }, 'countKept: at most cap, and says there are more');
    eq(await H.countKept(dir, []), { files: 0, more: false }, 'countKept: no paths keep nothing');
    eq(await H.countKept(null, globs), { files: null, more: false }, 'countKept: no checkout here: not known');
    eq(await H.countKept(path.join(dir, 'nope'), globs), { files: null, more: false }, 'countKept: not a checkout: not known');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
