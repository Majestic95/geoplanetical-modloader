// Unit checks for patch-engine.mjs, mods.mjs and the launcher's mod choice (launcher/core.mjs chooseMods).
// Usage: node patcher/test-engine.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatches, buildBundle, hazardsIn, HANDLER_POSTLUDE, MARKER, HANDLER_MARKER } from './patch-engine.mjs';
import { loadMods, orderMods, requirementProblem } from './mods.mjs';
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

  // Format, author, optional finding.
  const { finding, ...noFinding } = goodPatch;
  writeMod('fmt1', { ...goodMod('fmt1'), format: 1, author: 'Someone' }, noFinding);
  expect('format 1, author and a patch without finding load', () => loadMods(root, { only: ['fmt1'] })[0],
    { check: m => m.author === 'Someone' && m.format === 1 && !('finding' in m.patches[0]) });
  writeMod('fmt2', { ...goodMod('fmt2'), format: 2, newField: true }, goodPatch);
  expect('a newer format asks for a newer loader before checking fields', () => loadMods(root, { only: ['fmt2'] }),
    { throws: /needs a newer Geoplanetical Mod Loader \(mod format 2; this loader reads format 1\)/ });
  writeMod('fmt2', { ...goodMod('fmt2'), format: '1' }, goodPatch);
  expect('format must be a number', () => loadMods(root, { only: ['fmt2'] }), { throws: /format must be a whole number/ });
  writeMod('fmt2', { ...goodMod('fmt2'), author: '' }, goodPatch);
  expect('author must not be empty', () => loadMods(root, { only: ['fmt2'] }), { throws: /author: must be a non-empty string/ });
  rmSync(join(root, 'fmt2'), { recursive: true });

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
