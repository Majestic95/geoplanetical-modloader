// Unit checks for patch-engine.mjs, mods.mjs and the launcher's mod choice (launcher/core.mjs chooseMods).
// Usage: node patcher/test-engine.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatches, buildBundle, hazardsIn, HANDLER_POSTLUDE, MARKER, HANDLER_MARKER } from './patch-engine.mjs';
import { loadMods, scanMods, orderMods, requirementProblem, FORMAT } from './mods.mjs';
import { chooseMods } from '../launcher/core.mjs';

let failures = 0;
function expect(name, fn, { throws = null, check = null } = {}) {
  let out, err = null;
  try { out = fn(); } catch (e) { err = e; }
  const ok = throws ? err && throws.test(err.message) : !err && (!check || check(out));
  if (!ok) { failures++; console.log(`FAIL ${name}: ${err ? err.message : JSON.stringify(out)?.slice(0, 200)}`); }
  else console.log(`ok   ${name}`);
}

const T = 'function a(){x(1)};throw "err:a";function b(){x(1)}';
const mod = (id, edits, builds = ['1']) => ({ id, version: '1', builds, patches: [{ id: `${id}-p`, bundle: 'f.bundle.js', edits }] });
const opts = { build: '1', bundle: 'f.bundle.js' };

expect('repeated find', () => buildBundle(T, [mod('m', [{ find: 'x(1)', replace: 'y', anchor: 'err:a' }])], opts), { throws: /expected 1 match, found 2\+/ });
expect('unique find applied, marker first', () => buildBundle(T, [mod('m', [{ find: 'a(){x(1)}', replace: 'a(){x(2)}', anchor: 'err:a' }])], opts),
  { check: r => r.text.startsWith(`Object.defineProperty(globalThis,"${MARKER}"`) && r.text.endsWith('function a(){x(2)};throw "err:a";function b(){x(1)}' + HANDLER_POSTLUDE) });
expect('missing anchor', () => buildBundle(T, [mod('m', [{ find: 'a(){x(1)}', replace: 'z', anchor: 'err:zz' }])], opts), { throws: /anchor: expected 1 match, found 0/ });
expect('far anchor', () => buildBundle(T, [mod('m', [{ find: 'a(){x(1)}', replace: 'z', anchor: 'err:a', near: 3 }])], opts), { throws: /chars from the edit/ });
expect('wrong build', () => buildBundle(T, [mod('m', [{ find: 'a(){x(1)}', replace: 'z', anchor: 'err:a' }], ['2'])], opts), { throws: /needs updating/ });
expect('no mod for bundle gives null', () => buildBundle(T, [mod('m', [{ find: 'a', replace: 'b', anchor: 'err:a' }])], { build: '1', bundle: 'other.bundle.js' }), { check: r => r === null });
expect('hazard rejected', () => buildBundle(T, [mod('m', [{ find: 'a(){x(1)}', replace: 'a(){x(Math.random())}', anchor: 'err:a' }])], opts), { throws: /Math\.random/ });
expect('hazard assembled from surrounding text', () => buildBundle('function a(){return Math.max(0,1)};throw "err:a"', [mod('m', [{ find: 'max(0,1)', replace: 'random(0,1)', anchor: 'err:a' }])], opts), { throws: /introduces Math\.random/ });
expect('existing hazard nearby is not blamed on the edit', () => buildBundle('function a(){return Math.random()+1};throw "err:a"', [mod('m', [{ find: '+1}', replace: '+2}', anchor: 'err:a' }])], opts), { check: r => r.text.includes('+2}') });
expect('postlude records the handler', () => {
  const r = buildBundle('globalThis.onmessage=function h(){};throw "err:a"', [mod('m', [{ find: 'h(){}', replace: 'h(){return 1}', anchor: 'err:a' }])], opts);
  const g = {}; const run = new Function('globalThis', r.text.replace('throw "err:a"', '0')); run(g); return g;
}, { check: g => typeof g[HANDLER_MARKER] === 'function' && g[HANDLER_MARKER] === g.onmessage && HANDLER_MARKER === '__gpModLoaderOnmessage' });
expect('hazard allowed with determinismOk', () => buildBundle(T, [mod('m', [{ find: 'a(){x(1)}', replace: 'a(){x(Date.now())}', anchor: 'err:a', determinismOk: 'test only' }])], opts), { check: r => r.text.includes('Date.now()') });
expect('conflict names the earlier mod', () => buildBundle(T, [
  mod('first', [{ find: 'a(){x(1)}', replace: 'a(){x(5)}', anchor: 'err:a' }]),
  mod('second', [{ find: 'a(){x(1)}', replace: 'a(){x(6)}', anchor: 'err:a' }])], opts),
{ throws: /mod second, patch second-p, edit 0 find: expected 1 match, found 0\. .*mod first \(patch first-p\) already changed that code: first and second conflict/ });
expect('conflict on a removed anchor names the earlier mod', () => buildBundle(T, [
  mod('first', [{ find: 'throw "err:a"', replace: 'throw "err:b"', anchor: 'function b(' }]),
  mod('second', [{ find: 'a(){x(1)}', replace: 'a(){x(6)}', anchor: 'err:a' }])], opts),
{ throws: /second, patch second-p, edit 0 anchor: expected 1 match, found 0\. .*mod first \(patch first-p\)/ });
expect('conflict when an earlier mod repeats the find text', () => buildBundle(T, [
  mod('first', [{ find: 'b(){x(1)}', replace: 'b(){a(){x(1)}}', anchor: 'err:a' }]),
  mod('second', [{ find: 'a(){x(1)}', replace: 'a(){x(6)}', anchor: 'err:a' }])], opts),
{ throws: /found 2\+\. .*mod first \(patch first-p\)/ });
expect('overlapping patches of one mod are named as such', () => buildBundle(T, [{ id: 'm', version: '1', builds: ['1'], patches: [
  { id: 'one', bundle: 'f.bundle.js', edits: [{ find: 'a(){x(1)}', replace: 'a(){x(5)}', anchor: 'err:a' }] },
  { id: 'two', bundle: 'f.bundle.js', edits: [{ find: 'a(){x(1)}', replace: 'a(){x(6)}', anchor: 'err:a' }] }] }], opts),
{ throws: /patch one of the same mod already changed that code: the mod's patches overlap/ });
expect('overlapping edits of one patch are named as such', () => buildBundle(T, [mod('m', [
  { find: 'a(){x(1)}', replace: 'a(){x(5)}', anchor: 'err:a' }, { find: 'a(){x(1)}', replace: 'a(){x(6)}', anchor: 'err:a' }])], opts),
{ throws: /edit 0 of the same patch already changed that code: the patch's edits overlap/ });
expect('a conflict names the mod that broke the code for good, not one that broke it for a while', () => buildBundle(T, [
  mod('detour', [{ find: 'a(){x(1)}', replace: 'a(){x(2)}', anchor: 'err:a' }, { find: 'a(){x(2)}', replace: 'a(){x(1)}', anchor: 'err:a' }]),
  mod('takes', [{ find: 'a(){x(1)}', replace: 'a(){x(3)}', anchor: 'err:a' }]),
  mod('wants', [{ find: 'a(){x(1)}', replace: 'a(){x(4)}', anchor: 'err:a' }])], opts),
{ throws: /mod takes \(patch takes-p\) already changed that code: takes and wants conflict/ });
expect('an edit that never fit is a plain error, not a conflict', () => {
  try {
    buildBundle(T, [mod('first', [{ find: 'a(){x(1)}', replace: 'a(){x(5)}', anchor: 'err:a' }]),
      mod('second', [{ find: 'nowhere()', replace: 'z', anchor: 'err:a' }])], opts);
  } catch (e) { return e.message; }
  return null;
}, { check: msg => msg === 'mod second, patch second-p, edit 0 find: expected 1 match, found 0' });
expect('compatible mods editing nearby code both apply', () => buildBundle(T, [
  mod('first', [{ find: 'a(){x(1)}', replace: 'a(){x(5)}', anchor: 'err:a' }]),
  mod('second', [{ find: 'b(){x(1)}', replace: 'b(){x(6)}', anchor: 'err:a' }])], opts),
{ check: r => r.text.includes('a(){x(5)}') && r.text.includes('b(){x(6)}') && r.loaded.map(m => m.id).join() === 'first,second' });
expect('marker lists mods and patches', () => {
  const r = buildBundle(T, [mod('m', [{ find: 'a(){x(1)}', replace: 'a(){x(2)}', anchor: 'err:a' }])], opts);
  const g = {}; new Function('globalThis', r.text.split('\n')[0])(g); return g[MARKER];
}, { check: m => m.build === '1' && m.mods[0].id === 'm' && m.mods[0].patches[0] === 'm-p' && Object.isFrozen(m) });
expect('hazard patterns', () => [hazardsIn('performance.now()'), hazardsIn('x.toLocaleString()'), hazardsIn('Math.max(1)')],
  { check: ([a, b, c]) => a[0] === 'wall-clock time' && b[0] === 'locale formatting' && c.length === 0 });
expect('applyPatches edit-level', () => applyPatches(T, [{ id: 'p', bundle: 'f.bundle.js', builds: ['1'], edits: [{ find: 'b(){x(1)}', replace: 'b(){}', anchor: 'err:a' }] }], opts),
  { check: r => r.text.endsWith('function b(){}') && r.report.length === 1 });

// Loader validation on throwaway folders.
const root = mkdtempSync(join(tmpdir(), 'gpml-mods-'));
const writeMod = (name, modJson, patch) => {
  mkdirSync(join(root, name, 'patches'), { recursive: true });
  writeFileSync(join(root, name, 'mod.json'), JSON.stringify(modJson));
  if (patch) writeFileSync(join(root, name, 'patches', 'p.json'), JSON.stringify(patch));
};
const goodMod = id => ({ id, name: 'N', version: '1.0.0', description: 'D', builds: ['26296134'], patches: ['patches/p.json'] });
const goodPatch = { id: 'p', finding: null, effect: 'E', bundle: 'simulation-worker.bundle.js', edits: [{ anchor: 'a', find: 'b', replace: 'c' }] };
try {
  writeMod('ok-b', goodMod('ok-b'), goodPatch);
  writeMod('ok-a', goodMod('ok-a'), goodPatch);
  expect('loads mods in id order', () => loadMods(root).map(m => m.id), { check: ids => ids.join() === 'ok-a,ok-b' });
  expect('--mod order respected', () => loadMods(root, { only: ['ok-b', 'ok-a'] }).map(m => m.id), { check: ids => ids.join() === 'ok-b,ok-a' });
  expect('unknown mod id', () => loadMods(root, { only: ['nope'] }), { throws: /no mod "nope"/ });
  writeMod('bad-field', { ...goodMod('bad-field'), extra: 1 }, goodPatch);
  expect('unknown mod field', () => loadMods(root), { throws: /unknown field "extra"/ });
  rmSync(join(root, 'bad-field'), { recursive: true });
  writeMod('bad-edit', goodMod('bad-edit'), { ...goodPatch, edits: [{ anchor: 'a', find: 'b' }] });
  expect('missing edit field', () => loadMods(root), { throws: /missing field "replace"/ });
  rmSync(join(root, 'bad-edit'), { recursive: true });
  writeMod('bad-bundle', goodMod('bad-bundle'), { ...goodPatch, bundle: '../x.js' });
  expect('bundle name checked', () => loadMods(root), { throws: /not a game bundle name/ });
  writeMod('broken', { id: 'broken' }, null);
  expect('broken unselected mod does not block a selected one', () => loadMods(root, { only: ['ok-a'] }).map(m => m.id), { check: ids => ids.join() === 'ok-a' });
  expect('broken mod blocks loading all', () => loadMods(root), { throws: /missing field/ });
  expect('selecting the broken mod reports its error', () => loadMods(root, { only: ['broken'] }), { throws: /missing field/ });
  rmSync(join(root, 'broken'), { recursive: true });
  writeMod('escape', { ...goodMod('escape'), patches: ['../ok-a/patches/p.json'] }, goodPatch);
  expect('patch path cannot leave the mod folder', () => loadMods(root), { throws: /leaves the mod folder/ });
  rmSync(join(root, 'escape'), { recursive: true });
  writeMod('numbuild', { ...goodMod('numbuild'), builds: [26296134] }, goodPatch);
  expect('build ids must be strings', () => loadMods(root), { throws: /builds must list Steam build ids/ });
  rmSync(join(root, 'numbuild'), { recursive: true });
  rmSync(join(root, 'bad-bundle'), { recursive: true });

  // Ids are text: a value the ID pattern would accept once turned into text (123, null, true) is refused, and so are
  // lists and objects.
  for (const [label, bad] of [['123', 123], ['null', null], ['true', true], ['[]', []], ['{}', {}], ['["ok-a"]', ['ok-a']]]) {
    writeMod('id-type', { ...goodMod('id-type'), id: bad }, goodPatch);
    expect(`a mod id that is not text is refused: ${label}`, () => scanMods(root),
      { check: r => !r.mods.some(x => x.dir === join(root, 'id-type')) &&
        r.broken.some(b => b.folder === 'id-type' && /id .* must be text, in quotes/.test(b.error) && b.id === null) });
    writeMod('id-type', goodMod('id-type'), { ...goodPatch, id: bad });
    expect(`a patch id that is not text is refused: ${label}`, () => loadMods(root, { only: ['id-type'] }), { throws: /id-type\/patches\/p\.json: id .* must be text, in quotes/ });
    // (requires entries were already checked as text: a guard that they stay so)
    writeMod('id-type', { ...goodMod('id-type'), requires: [bad] }, goodPatch);
    expect(`a requires entry that is not text is refused: ${label}`, () => loadMods(root, { only: ['id-type'] }), { throws: /requires must be a list of mod ids/ });
  }
  writeMod('id-type', { ...goodMod('id-type'), id: 123 }, goodPatch);
  expect('loading every mod names the mod whose id is not text', () => loadMods(root), { throws: /id 123 must be text, in quotes/ });
  writeMod('id-type', goodMod('id-type'), { ...goodPatch, bundle: ['simulation-worker.bundle.js'] });
  expect('a broken mod with a text id keeps it (an install finds the copy to replace by it)', () => scanMods(root).broken,
    { check: b => b.length === 1 && b[0].id === 'id-type' && b[0].folder === 'id-type' });
  expect('a bundle written as a list is refused', () => loadMods(root, { only: ['id-type'] }), { throws: /bundle \["simulation-worker\.bundle\.js"\] is not a game bundle name/ });
  writeMod('id-type', { ...goodMod('id-type'), id: 'Bad' }, goodPatch);
  expect('a text id that does not match keeps its message, and is not kept as the broken mod\'s id', () => scanMods(root).broken,
    { check: b => b.length === 1 && /id "Bad" must match/.test(b[0].error) && b[0].id === null });
  writeMod('id-type', { ...goodMod('id-type'), id: ['x'.repeat(500)] }, goodPatch);
  expect('a long value is cut in the message', () => scanMods(root).broken,
    { check: b => b.length === 1 && b[0].error.length < 400 && /\.\.\. must be text/.test(b[0].error) });
  let deep = '"x"';
  for (let i = 0; i < 20000; i++) deep = `[${deep}]`;
  writeFileSync(join(root, 'id-type', 'mod.json'), JSON.stringify({ ...goodMod('id-type'), id: 0 }).replace('"id":0', `"id":${deep}`));
  expect('a value nested too deep to write out is named by its kind', () => scanMods(root).broken,
    { check: b => b.length === 1 && /id \(a list\) must be text/.test(b[0].error) });
  writeMod('id-type', goodMod('id-type'), goodPatch);
  expect('a text id still loads', () => loadMods(root, { only: ['id-type'] })[0].id, { check: id => id === 'id-type' });
  rmSync(join(root, 'id-type'), { recursive: true });

  // Format, author, optional finding.
  const { finding, ...noFinding } = goodPatch;
  writeMod('fmt1', { ...goodMod('fmt1'), format: 1, author: 'Someone' }, noFinding);
  expect('format 1, author and a patch without finding load', () => loadMods(root, { only: ['fmt1'] })[0],
    { check: m => m.author === 'Someone' && m.format === 1 && !('finding' in m.patches[0]) });
  writeMod('fmt2', { ...goodMod('fmt2'), format: FORMAT + 1, newField: true }, goodPatch);
  expect('a newer format asks for a newer loader before checking fields', () => loadMods(root, { only: ['fmt2'] }),
    { throws: new RegExp(`needs a newer Geoplanetical Mod Loader \\(mod format ${FORMAT + 1}; this loader reads format ${FORMAT}\\)`) });
  writeMod('fmt2', { ...goodMod('fmt2'), format: '1' }, goodPatch);
  expect('format must be a number', () => loadMods(root, { only: ['fmt2'] }), { throws: /format must be a whole number/ });
  writeMod('fmt2', { ...goodMod('fmt2'), author: '' }, goodPatch);
  expect('author must not be empty', () => loadMods(root, { only: ['fmt2'] }), { throws: /author: must be a non-empty string/ });
  rmSync(join(root, 'fmt2'), { recursive: true });

  // Format 2: page scripts.
  const script = (name, file, text) => { mkdirSync(join(root, name, ...file.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(root, name, file), text); };
  const { patches: _p, ...noPatches } = goodMod('x');
  const scriptMod = (id, extra = {}) => ({ ...noPatches, id, format: 2, scripts: ['page/s.js'], ...extra });
  const one = id => loadMods(root, { only: [id] })[0];
  const fresh = (id, json, files = { 'page/s.js': 'window.__s = 1;' }, patch = null) => {
    rmSync(join(root, id), { recursive: true, force: true });
    writeMod(id, json, patch);
    for (const [f, t] of Object.entries(files)) script(id, f, t);
  };
  fresh('sc-only', scriptMod('sc-only'));
  expect('format 2: a mod with only scripts loads', () => one('sc-only'),
    { check: m => m.patches.length === 0 && m.scripts.length === 1 && m.scripts[0].path === 'page/s.js' && m.scripts[0].text === 'window.__s = 1;' });
  fresh('sc-both', scriptMod('sc-both', { patches: ['patches/p.json'] }), undefined, goodPatch);
  expect('format 2: scripts and patches together', () => one('sc-both'), { check: m => m.patches.length === 1 && m.scripts.length === 1 });
  fresh('sc-f1', { ...scriptMod('sc-f1'), format: 1 });
  expect('scripts need format 2', () => one('sc-f1'), { throws: /scripts need mod format 2: add "format": 2/ });
  fresh('sc-nof', (({ format, ...r }) => r)(scriptMod('sc-nof')));
  expect('scripts without a format need format 2', () => one('sc-nof'), { throws: /scripts need mod format 2/ });
  fresh('sc-none', { ...noPatches, id: 'sc-none', format: 2 }, {});
  expect('format 2 still needs patches or scripts', () => one('sc-none'), { throws: /missing field "patches" \(a format-2 mod may have "scripts" instead\)$/ });
  fresh('f1-none', { ...noPatches, id: 'f1-none' }, {});
  expect('format 1: patches still required, same message', () => one('f1-none'), { throws: /mod\.json: missing field "patches"$/ });
  fresh('sc-empty', scriptMod('sc-empty', { scripts: [] }));
  expect('scripts must not be empty', () => one('sc-empty'), { throws: /scripts must be a non-empty array/ });
  fresh('sc-twice', scriptMod('sc-twice', { scripts: ['page/s.js', 'page/s.js'] }));
  expect('a script listed twice', () => one('sc-twice'), { throws: /scripts lists a file twice/ });
  fresh('sc-case', scriptMod('sc-case', { scripts: ['page/s.js', 'Page/S.js'] }));
  expect('a script listed twice in another case', () => one('sc-case'), { throws: /scripts lists a file twice/ });
  // Paths are plain segments: nothing in one can leave the folder or end the comment it is written into.
  for (const bad of ['../sc-only/page/s.js', 'page/../page/s.js', './page/s.js', '/page/s.js', 'page\\s.js', 'page//s.js', 'page/s.txt',
    'page/s.js\n;evil()//x.js', 'page/s\u2028.js', 'page/s .js', 'C:/x.js', 'page/.s.js']) {
    fresh('sc-path', scriptMod('sc-path', { scripts: [bad] }));
    expect(`a script path is refused: ${JSON.stringify(bad)}`, () => one('sc-path'), { throws: /script path .* must be a \.js file path of letters/ });
  }
  fresh('sc-many', scriptMod('sc-many', { scripts: Array.from({ length: 21 }, (_, i) => `page/s${i}.js`) }));
  expect('at most 20 scripts', () => one('sc-many'), { throws: /more than 20 scripts/ });
  const mb15 = `//${'x'.repeat(1.5 * 1024 * 1024)}`;
  fresh('sc-total', scriptMod('sc-total', { scripts: ['a.js', 'b.js', 'c.js'] }), { 'a.js': mb15, 'b.js': mb15, 'c.js': mb15 });
  expect('at most 4 MB of scripts per mod', () => one('sc-total'), { throws: /scripts are larger than 4 MB together/ });
  fresh('sc-link', scriptMod('sc-link', { scripts: ['out/s.js'] }), {});
  mkdirSync(join(root, 'outside-folder'), { recursive: true });
  writeFileSync(join(root, 'outside-folder', 's.js'), 'window.x = 1;');
  symlinkSync(join(root, 'outside-folder'), join(root, 'sc-link', 'out'), 'junction');
  expect('a script reached through a link outside the mod folder', () => one('sc-link'), { throws: /outside the mod folder \(a link\)/ });
  fresh('sc-html', scriptMod('sc-html'), { 'page/s.js': '--> an HTML close comment, at the start\nwindow.x = 1;' });
  expect('a script is checked as the page will run it (no leading line break)', () => one('sc-html'), { throws: /does not parse as a script/ });
  fresh('sc-esc', scriptMod('sc-esc'), { 'page/s.js': '}).call(globalThis)}catch(e){}} window.everywhere = 1; if(0){try{(function(){' });
  expect('a script that closes the wrapper early does not parse', () => one('sc-esc'), { throws: /does not parse as a script/ });
  fresh('sc-ext', scriptMod('sc-ext', { scripts: ['page/s.txt'] }), { 'page/s.txt': 'x' });
  expect('a script must be a .js file', () => one('sc-ext'), { throws: /must be a \.js file path/ });
  fresh('sc-miss', scriptMod('sc-miss', { scripts: ['page/none.js'] }), {});
  expect('a missing script is named', () => one('sc-miss'), { throws: /sc-miss\/page\/none\.js: ENOENT/ });
  fresh('sc-syn', scriptMod('sc-syn'), { 'page/s.js': 'function (' });
  expect('a script that does not parse lists the mod as broken', () => one('sc-syn'), { throws: /sc-syn\/page\/s\.js: does not parse as a script/ });
  fresh('sc-utf', scriptMod('sc-utf'), { 'page/s.js': Buffer.from([0x2f, 0x2f, 0xff, 0xfe]) });
  expect('a script must be UTF-8', () => one('sc-utf'), { throws: /not UTF-8 text/ });
  fresh('sc-big', scriptMod('sc-big'), { 'page/s.js': `//${'x'.repeat(2 * 1024 * 1024)}` });
  expect('a script over 2 MB', () => one('sc-big'), { throws: /larger than 2 MB/ });
  fresh('sc-ret', scriptMod('sc-ret'), { 'page/s.js': '"use strict";\nif (window.top !== window) return;\nwindow.__s = 1;' });
  expect('a script runs as a function body: top-level return and "use strict" are allowed', () => one('sc-ret').scripts.length, { check: n => n === 1 });
  for (const id of ['sc-only', 'sc-both', 'sc-f1', 'sc-nof', 'sc-none', 'f1-none', 'sc-empty', 'sc-twice', 'sc-case', 'sc-path', 'sc-many',
    'sc-total', 'sc-link', 'outside-folder', 'sc-html', 'sc-esc', 'sc-ext', 'sc-miss', 'sc-syn', 'sc-utf', 'sc-big', 'sc-ret']) {
    rmSync(join(root, id), { recursive: true, force: true });
  }
  writeMod('f1-shape', goodMod('f1-shape'), goodPatch);
  expect('format 1 mods load with an empty scripts list', () => one('f1-shape'), { check: m => Array.isArray(m.scripts) && !m.scripts.length && !('scripts' in JSON.parse(readFileSync(join(root, 'f1-shape', 'mod.json'), 'utf8'))) });
  rmSync(join(root, 'f1-shape'), { recursive: true });

  // Requirements: validation, load order, missing requirements.
  const badReq = { 'req-self': ['req-self'], 'req-twice': ['ok-a', 'ok-a'], 'req-bad': ['Not An Id'] };
  for (const [id, requires] of Object.entries(badReq)) {
    writeMod(id, { ...goodMod(id), requires }, goodPatch);
    expect(`requires rejected: ${id}`, () => loadMods(root, { only: [id] }), { throws: /cannot require itself|lists a mod twice|list of mod ids/ });
    rmSync(join(root, id), { recursive: true });
  }
  writeMod('needs-a', { ...goodMod('needs-a'), requires: ['ok-a'] }, goodPatch);
  expect('a required mod loads first even when named later', () => loadMods(root, { only: ['needs-a', 'ok-b', 'ok-a'] }).map(m => m.id),
    { check: ids => ids.join() === 'ok-a,needs-a,ok-b' });
  expect('loading all puts requirements first', () => loadMods(root).map(m => m.id),
    { check: ids => ids.indexOf('ok-a') < ids.indexOf('needs-a') });
  expect('a requirement left out is named', () => loadMods(root, { only: ['needs-a'] }),
    { throws: /N needs N \(ok-a\) loaded with it/ });
  writeMod('needs-x', { ...goodMod('needs-x'), requires: ['not-here'] }, goodPatch);
  expect('a requirement not installed is named', () => loadMods(root, { only: ['needs-x'] }),
    { throws: /needs the mod "not-here", which is not in the mods folder/ });
  writeMod('not-here', { ...goodMod('not-here'), format: 9 }, goodPatch);
  expect('a requirement installed but broken is named with its error', () => loadMods(root, { only: ['needs-x'] }),
    { throws: /needs the mod "not-here", which is installed but cannot load: .*needs a newer Geoplanetical Mod Loader/ });
  rmSync(join(root, 'not-here'), { recursive: true });
  rmSync(join(root, 'needs-x'), { recursive: true });
} finally {
  rmSync(root, { recursive: true, force: true });
}

// Order and choice without files.
const m = (id, requires, builds = ['1']) => ({ id, name: id.toUpperCase(), requires, builds, patches: [] });
expect('order keeps the given order without requirements', () => orderMods([m('c'), m('a'), m('b')]).map(x => x.id),
  { check: ids => ids.join() === 'c,a,b' });
expect('order follows a requirement chain', () => orderMods([m('c', ['b']), m('b', ['a']), m('a')]).map(x => x.id),
  { check: ids => ids.join() === 'a,b,c' });
expect('a requirement cycle is an error', () => orderMods([m('a', ['b']), m('b', ['a'])]), { throws: /in a circle: a -> b -> a/ });
expect('a cycle message shows only the circle', () => orderMods([m('c', ['x']), m('x', ['y']), m('y', ['x'])]),
  { throws: /in a circle: x -> y -> x$/ });
expect('no problem when requirements are chosen', () => requirementProblem([m('a'), m('b', ['a'])]), { check: p => p === null });
const settings = { enabled: { off: false } };
expect('choose: on and fitting, requirements first', () => chooseMods([m('b', ['a']), m('a'), m('old', [], ['0'])], settings, { build: '1' }),
  { check: r => !r.error && r.chosen.map(x => x.id).join() === 'a,b' });
expect('choose: a required mod switched off is named', () => chooseMods([m('b', ['off']), m('off')], settings, { build: '1' }),
  { check: r => r.error === 'B needs OFF (off) loaded with it: switch OFF on too.' });
expect('choose: a required mod for another build is named', () => chooseMods([m('b', ['old']), m('old', [], ['0'])], settings, { build: '1' }),
  { check: r => r.error === 'B needs OLD, which is not made for this game version yet.' });
expect('choose: nothing on is an empty choice', () => chooseMods([m('off')], settings, { build: '1' }),
  { check: r => !r.error && r.chosen.length === 0 });

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
