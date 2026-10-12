// host-rules-test.js: a check of host-rules.js, what pins a conversation to a stays-on rule's host. Only a tool the rule
// names, a write tool's file, or a path word of a shell command pins: a .gitignore edit adding *.blend1, a doc
// mentioning .blend, a read or a search under assets/vehicles, a prompt, a heredoc's text or a commit message never
// does. A tool rule with no repo holds in any workspace; two rules for two repos each hold in their own; the pins are
// worked out again when the rules change; the old single default becomes the pair; the pathspecs.
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
eq(H.pinsOf(w.seen, RULES).get('configurator-3d'), { tool: 'Write', path: 'models/x.blend', at: 1000 }, 'the pin keeps its evidence (the path from the repo\'s top)');
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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
