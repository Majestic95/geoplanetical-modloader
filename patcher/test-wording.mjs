// Checks for wording changes to the main page's bundle (patcher/page-text.mjs): what the guard lets through, what it
// refuses, the mod format's rules, and the literal reader against the JavaScript engine itself.
// Usage: node patcher/test-wording.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildBundle, HANDLER_POSTLUDE, MARKER } from './patch-engine.mjs';
import { readLiteral, wordingProblem, deliverable, PAGE_BUNDLE } from './page-text.mjs';
import { loadMods, FORMAT } from './mods.mjs';
import { attachAndServe } from './session.mjs';

let failures = 0;
function expect(name, fn, { throws = null, check = null } = {}) {
  let out, err = null;
  try { out = fn(); } catch (e) { err = e; }
  const ok = throws ? err && throws.test(err.message) : !err && (!check || check(out));
  if (!ok) { failures++; console.log(`FAIL ${name}: ${err ? err.message : JSON.stringify(out)?.slice(0, 300)}`); }
  else console.log(`ok   ${name}`);
}

// Shaped like the game: two flat tables, then code holding ids and a file name in strings.
const EN = String.raw`{"k.one":"Old one","k.two":"Keep \xE9 it","k.tag":"has <b>a</b> tag","k.q":${'`'}say "hi" it's${'`'},"k.single":'plain',"saves.act.delete":"Delete","quit.warn":"Unsaved","mods.publish.ok":"Publish","modal.confirm":"Confirm","modal.cancel":"Cancel","settings.saves.keep":"Archives","settings.other":"Other","pause.quit":"Quit game","menu.quit":"Quit","menu.quitter":"Leave","savesish":"Fine"}`;
const FR = String.raw`{"k.one":"Vieux","k.two":"Garde"}`;
const GAME = `var uA=1;Vt(()=>{I4A=${FR}});Vt(()=>{D4A=${EN}});var h={};var Ws={fr:I4A,en:D4A};` +
  'function f(x){if(x==="saves-retry")return o("k.one");return new Worker("a-worker.bundle.js")}';
const opts = { build: '1', bundle: PAGE_BUNDLE };
const mod = (...edits) => ({ id: 'm', version: '1', builds: ['1'], patches: [{ id: 'p', bundle: PAGE_BUNDLE, edits: edits.map(e => ({ anchor: 'k.one":"Old', ...e })) }] });
const build = (...edits) => buildBundle(GAME, [mod(...edits)], opts);
const body = r => r.text.slice(r.text.indexOf('\n') + 1, r.text.length - HANDLER_POSTLUDE.length);
const U = hex => `${String.fromCharCode(92)}u${hex}`; // a four-digit unicode escape, as source text
const REFUSED = /can only change the text of one entry/;
const NOT_PLAIN = /not plain quoted text/;

// Let through.
expect('a reword applies, with the marker and postlude', () => build({ find: 'Old one', replace: 'New wording' }),
  { check: r => r.text.startsWith(`Object.defineProperty(globalThis,"${MARKER}"`) && body(r) === GAME.replace('Old one', 'New wording') });
expect('find may carry the key for uniqueness', () => build({ find: '"k.one":"Vieux"', replace: '"k.one":"Nouveau"', anchor: 'k.two":"Garde' }),
  { check: r => body(r).includes('"k.one":"Nouveau"') });
expect('both languages, and offsets stay in step as text grows and shrinks', () => build(
  { find: 'Vieux', replace: 'Beaucoup plus long qu’avant' }, { find: 'Garde', replace: 'G' },
  { find: 'Old one', replace: 'x' }, { find: 'Keep', replace: 'Retain this much longer', anchor: 'k.two":"Keep' }, { find: "'plain'", replace: "'clear'", anchor: 'k.single' }),
{ check: r => r.report.length === 5 && runInNewContext(`var Vt=f=>f();${body(r)};Ws`).en['k.single'] === 'clear' });
expect('escapes are decoded and kept', () => build({ find: String.raw`Keep \xE9 it`, replace: String.raw`Keep \xE8\n${U('2019')}\u{1F600} it` }),
  { check: r => runInNewContext(`var Vt=f=>f();${body(r)};Ws`).en['k.two'] === 'Keep è\n’\u{1F600} it' });
expect('ampersands that are no entity, and a greater-than sign, are text', () => build({ find: 'Old one', replace: 'R&D & more > 2, it\'s fine; {name} kept' }), { check: r => r.report.length === 1 });
expect('the report names the entry changed', () => build({ find: 'Old one', replace: 'x' }), { check: r => r.report[0].entry === 'k.one' });
expect('text with a placeholder after an ampersand word is fine', () => build({ find: 'Old one', replace: 'R&D {x} and more' }), { check: r => r.report.length === 1 });
expect('other settings are not held', () => build({ find: '"Other"', replace: '"Another"', anchor: 'settings.other' }), { check: r => r.report[0].entry === 'settings.other' });
expect('a key that only starts like menu.quit is not held', () => build({ find: 'Leave', replace: 'Go', anchor: 'menu.quitter' }), { check: r => r.report[0].entry === 'menu.quitter' });
expect('a key that only starts like a held one is not held', () => build({ find: 'Fine', replace: 'Good', anchor: 'savesish' }), { check: r => r.report[0].entry === 'savesish' });
expect('an edit that changes nothing passes', () => build({ find: 'saves-retry', replace: 'saves-retry' }), { check: r => r.report.length === 1 });
expect('a tag may be taken out', () => build({ find: 'has <b>a</b> tag', replace: 'has a tag', anchor: 'k.tag' }), { check: r => body(r).includes('"k.tag":"has a tag"') });

// Refused: not wording.
expect('a string in the code (an id)', () => build({ find: 'saves-retry', replace: 'other', anchor: 'Ws={' }), { throws: REFUSED });
expect('a file name in the code', () => build({ find: 'a-worker.bundle.js', replace: 'b-worker.bundle.js', anchor: 'Ws={' }), { throws: REFUSED });
expect('code', () => build({ find: 'x==="saves', replace: 'x!=="saves', anchor: 'Ws={' }), { throws: REFUSED });
expect('an entry\'s key', () => build({ find: '"k.one":"Old', replace: '"k.on":"Old' }), { throws: REFUSED });
expect('a new entry', () => build({ find: '"Old one",', replace: '"Old one","k.new":"x",' }), { throws: REFUSED });
expect('a new entry before the first', () => build({ find: '{"k.one":"Old', replace: '{"k.new":"x","k.one":"Old' }), { throws: REFUSED });
expect('two entries in one edit', () => build({ find: 'Old one","k.two":"Keep', replace: 'New one","k.two":"Hold' }), { throws: REFUSED });
expect('an opening quote changed', () => build({ find: '"Old one"', replace: '`Old one"' }), { throws: REFUSED });
expect('a closing quote changed', () => build({ find: '"Old one"', replace: '"Old one`' }), { throws: REFUSED });
expect('code after the value', () => build({ find: 'Old one"', replace: 'Old one"+evil()+"' }), { throws: REFUSED });
expect('code before the value', () => build({ find: '"Old one', replace: 'evil()+"Old one' }), { throws: REFUSED });

// Refused: leaves the quotes from inside.
expect('ends the quotes early', () => build({ find: 'Old one', replace: 'a";evil();"b' }), { throws: NOT_PLAIN });
expect('other quote kinds leave only their own literal', () => build({ find: 'plain', replace: "a';evil();'b", anchor: 'k.single' }), { throws: NOT_PLAIN });
expect('a backtick ends a template', () => build({ find: 'say "hi" it\'s', replace: 'a`;evil();`b', anchor: 'k.q' }), { throws: NOT_PLAIN });
expect('a trailing backslash swallows the closing quote', () => build({ find: 'Old one', replace: 'Old one\\' }), { throws: NOT_PLAIN });
expect('a raw line break', () => build({ find: 'Old one', replace: 'a\nb' }), { throws: NOT_PLAIN });
expect('a substitution in a template', () => build({ find: 'say "hi" it\'s', replace: 'say ${evil()}', anchor: 'k.q' }), { throws: NOT_PLAIN });
expect('an old octal escape', () => build({ find: 'Old one', replace: String.raw`a\101` }), { throws: NOT_PLAIN });
expect('an escape outside the known list', () => build({ find: 'Old one', replace: String.raw`a\q` }), { throws: NOT_PLAIN });
expect('a line continuation', () => build({ find: 'Old one', replace: 'a\\\nb' }), { throws: NOT_PLAIN });
expect('a cut hex escape', () => build({ find: 'Old one', replace: String.raw`a\x4` }), { throws: NOT_PLAIN });

// Refused: what the text says, read after decoding.
for (const [name, replace, what] of [
  ['a tag', 'a <img src=x>', /a "<"/], ['a closing tag', 'a </div>', /a "<"/], ['a comment', 'a <!-- b', /a "<"/],
  ['a processing instruction', 'a <?x', /a "<"/], ['a tag with no end', 'a <img', /a "<"/],
  ['a tag in \\x', String.raw`a \x3cimg src=x\x3e`, /a "<"/], ['a tag in \\u', String.raw`a ${U('003c')}img`, /a "<"/],
  ['a tag in \\u{}', String.raw`a \u{3c}img`, /a "<"/], ['a tag split by an escape', String.raw`a <\x69mg`, /a "<"/],
  ['${', 'cost ${x}', /"\$\{"/], ['${ in \\x', String.raw`cost \x24{x}`, /"\$\{"/], ['${ in \\u', String.raw`cost $${U('007b')}x}`, /"\$\{"/],
  ['a double quote escaped', String.raw`say \"hi\"`, /a double quote/], ['a double quote in \\x', String.raw`say \x22hi`, /a double quote/],
  // The game expands its message syntax after this check: these become tags in the page.
  ['a tag the message syntax completes', '<{x, select, other {img src=x onerror=alert(1)}}>', /a "<"/],
  ['a "<" inside the message syntax', '{x, select, other {<}}img src=x>', /a "<"/], ['a tag from a plural', '<{n, plural, other {img src=x}}>', /a "<"/],
  ['a lone "<"', 'under 5 < 6', /a "<"/],
  ['a numeric entity', 'a &#60;img', /an HTML entity/], ['a hex entity', 'a &#x3c;img', /an HTML entity/], ['a named entity', 'a &lt;img&gt;', /an HTML entity/],
  ['an entity split by a placeholder', 'a &{x}lt;img', /an HTML entity/], ['an entity split inside its name', 'a &l{x}t;', /an HTML entity/],
  ['an entity from a select', '&{x,select,other{#60}};img', /an HTML entity/], ['an ampersand ending a select', '{x,select,other{&}}lt;img', /an HTML entity/],
  ['a bare entity', 'a &ltimg', /an HTML entity/], ['an entity in capitals', 'a &QUOT', /an HTML entity/], ['an entity in \\x', String.raw`a \x26lt;img`, /an HTML entity/],
  ['very long text, which could nest the message syntax deep enough to break the game\'s parser', '{x,select,other{'.repeat(300), /more than 4096 characters/],
]) expect(`refused: ${name}`, () => build({ find: 'Old one', replace }), { throws: what });
expect('refused: a raw double quote in a template', () => build({ find: 'it\'s', replace: 'it"s', anchor: 'k.q' }), { throws: /a double quote/ });
expect('refused: a value that keeps its tag cannot be edited', () => build({ find: 'has <b>', replace: 'had <b>', anchor: 'k.tag' }), { throws: /a "<"/ });
expect('refused: a value that keeps its double quote cannot be edited', () => build({ find: 'it\'s', replace: 'it is', anchor: 'k.q' }), { throws: /a double quote/ });
expect('typographic quotes are text', () => wordingProblem('say “hi” it\'s'), { check: p => p === null });

// Refused: text that words what the game's saves, quit, pause and mods screens and its confirmation buttons do.
for (const [find, key] of [['Delete', 'saves.act.delete'], ['Unsaved', 'quit.warn'], ['Publish', 'mods.publish.ok'], ['Confirm', 'modal.confirm'],
  ['Cancel', 'modal.cancel'], ['Archives', 'settings.saves.keep'], ['Quit game', 'pause.quit'], ['"Quit"', 'menu.quit']]) {
  expect(`refused: the entry ${key}`, () => build({ find, replace: find.replace(/\w+/, 'Back'), anchor: `"${key}"` }), { throws: new RegExp(`the entry "${key}" cannot be changed`) });
}

// The rest of the engine still applies.
expect('hazards still apply on this bundle', () => build({ find: 'Old one', replace: 'see window.x' }), { throws: /introduces DOM\/UI\/local state/ });
expect('determinismOk still answers a hazard', () => build({ find: 'Old one', replace: 'see window.x', determinismOk: 'text' }), { check: r => r.report.length === 1 });
expect('wrong build is refused', () => buildBundle(GAME, [{ ...mod({ find: 'Old one', replace: 'x' }), builds: ['2'] }], opts), { throws: /needs updating/ });
expect('a missing anchor fails by name', () => build({ find: 'Old one', replace: 'x', anchor: 'no such text' }), { throws: /mod m, patch p, edit 0 anchor: expected 1 match, found 0/ });
expect('a missing find fails by name', () => build({ find: 'No such words', replace: 'x' }), { throws: /mod m, patch p, edit 0 find: expected 1 match, found 0/ });
expect('other bundles are not held to this', () => buildBundle('function a(){x(1)};"err:a"', [{ id: 'w', version: '1', builds: ['1'], patches: [{ id: 'p', bundle: 'x-worker.bundle.js', edits: [{ find: 'x(1)', replace: 'y(2)', anchor: 'err:a' }] }] }], { build: '1', bundle: 'x-worker.bundle.js' }),
  { check: r => r.text.includes('y(2)') });

// Refused: tables not as expected (fails closed).
const edit = { find: 'Old one', replace: 'x' };
const shape = /wording tables .* are not in the shape/;
expect('no tables', () => buildBundle('"k.one":"Old one"', [mod(edit)], opts), { throws: shape });
expect('two table pairs', () => buildBundle(`${GAME};var Ys={fr:I4A,en:D4A}`, [mod(edit)], opts), { throws: shape });
expect('a table bound twice', () => buildBundle(`${GAME};D4A={}`, [mod(edit)], opts), { throws: shape });
expect('a table entry that is not text', () => buildBundle(GAME.replace('"k.two":"Keep \\xE9 it"', '"k.two":f()'), [mod(edit)], opts), { throws: shape });
expect('a table entry with a substitution', () => buildBundle(GAME.replace('"k.two":"Keep \\xE9 it"', '"k.two":`a${b}`'), [mod(edit)], opts), { throws: shape });
expect('a computed entry', () => buildBundle(GAME.replace('"k.two":"Keep \\xE9 it"', '[k]:"x"'), [mod(edit)], opts), { throws: shape });
expect('a spread in a table', () => buildBundle(GAME.replace('"k.two":"Keep \\xE9 it"', '...o'), [mod(edit)], opts), { throws: shape });

// The literal reader never disagrees with the engine: whatever it accepts is one literal there, with the same text.
const ALPHABET = ['a', 'é', ' ', '"', "'", '`', '\\', '\n', '\r', '$', '{', '}', '<', '0', '7', '8', 'x', 'u', 'n', '4', '1', 'F', ';', '+', '(', ')', ...[0x2028, 0x2029, 0xd83d].map(c => String.fromCharCode(c))];
let accepted = 0, seed = 42;
const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
const disagreements = [];
for (let round = 0; round < 60000; round++) {
  const quote = '"\'`'[random(3)];
  let s = quote;
  for (let i = random(9); i > 0; i--) s += ALPHABET[random(ALPHABET.length)];
  if (random(2)) s += quote;
  const r = readLiteral(s, 0);
  if (!r) continue;
  accepted++;
  const literal = s.slice(0, r.end);
  try {
    const value = runInNewContext(`"use strict";(${literal}\n)`);
    if (value !== r.value) disagreements.push(`${JSON.stringify(literal)} reads ${JSON.stringify(r.value)}, engine ${JSON.stringify(value)}`);
  } catch (e) {
    disagreements.push(`${JSON.stringify(literal)}: engine refuses (${e.message})`);
  }
}
expect(`the reader agrees with the engine on ${accepted} literals it accepted`, () => disagreements, { check: d => accepted > 3000 && d.length === 0 });
if (disagreements.length) console.log(disagreements.slice(0, 5).join('\n'));

// The mod format.
expect('which bundles can be delivered', () => ['simulation-worker.bundle.js', 'city-lights-worker.bundle.js', PAGE_BUNDLE, 'i18n-bootstrap.bundle.js', 'other.bundle.js'].map(deliverable),
  { check: d => d.join() === 'true,true,true,false,false' });
expect('format 3 is what this loader reads', () => FORMAT, { check: f => f === 3 });
const root = mkdtempSync(join(tmpdir(), 'gpml-wording-'));
const write = (name, format, bundle) => {
  mkdirSync(join(root, name, 'patches'), { recursive: true });
  writeFileSync(join(root, name, 'mod.json'), JSON.stringify({ id: name, name: 'N', version: '1', description: 'D', builds: ['1'], patches: ['patches/p.json'], ...(format ? { format } : {}) }));
  writeFileSync(join(root, name, 'patches', 'p.json'), JSON.stringify({ id: 'p', effect: 'E', bundle, edits: [{ anchor: 'a', find: 'b', replace: 'c' }] }));
};
const one = id => loadMods(root, { only: [id] })[0];
try {
  write('f3', 3, PAGE_BUNDLE);
  expect('format 3: a patch to the page bundle loads', () => one('f3'), { check: m => m.patches[0].bundle === PAGE_BUNDLE });
  write('f2', 2, PAGE_BUNDLE);
  expect('format 2: refused, asking for format 3', () => one('f2'), { throws: /a patch to app\.bundle\.js needs mod format 3: add "format": 3/ });
  write('f1', 0, PAGE_BUNDLE);
  expect('no format: refused, asking for format 3', () => one('f1'), { throws: /needs mod format 3/ });
  for (const bundle of ['i18n-bootstrap.bundle.js', 'other.bundle.js']) {
    for (const format of [0, 1, 2, 3]) {
      write('nope', format, bundle);
      expect(`format ${format}: ${bundle} is refused when the mod is read, not dropped later`, () => one('nope'), { throws: /cannot be patched: the loader only reaches/ });
    }
  }
  for (const format of [0, 1, 2, 3]) {
    write('wk', format, 'world-market-worker.bundle.js');
    expect(`format ${format}: a worker bundle still loads`, () => one('wk'), { check: m => m.patches.length === 1 });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// The session's timing against a stand-in for the page: `answers` are what successive looks at the page find. The last
// one repeats. `request` is when the page's request reaches the loader, in ms from the first look.
const SCRIPT_ONLY = { page: '/renderer/index.html', marker: null, done: false, tag: true };
const RAN = { page: '/renderer/index.html', marker: { build: '1' }, done: true, tag: true };
async function session({ answers, reattach = false, request = null }) {
  const handlers = new Map(), sent = [], reports = [];
  const delay = ms => new Promise(r => setTimeout(r, ms));
  let looks = 0;
  const cdp = {
    on(method, fn) { handlers.set(method, fn); },
    onClose() {},
    async send(method) {
      sent.push(method);
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', url: 'file:///x/renderer/index.html', targetId: 't' }] };
      if (method === 'Target.attachToTarget') return { sessionId: 's' };
      if (method === 'Runtime.evaluate') {
        if (looks === 0 && request !== null) delay(request).then(() => handlers.get('Fetch.requestPaused')({ requestId: 'r', request: { url: `file:///x/renderer/${PAGE_BUNDLE}` } }, 's'));
        return { result: { value: JSON.stringify(answers[Math.min(looks++, answers.length - 1)]) } };
      }
      return {};
    },
  };
  await attachAndServe(cdp, { pageUrl: /index\.html/, payloads: new Map([[PAGE_BUNDLE, 'void 0']]), log: () => {}, settleMs: 0, reattach, onSwap: r => reports.push(r.status) });
  await delay(2500);
  return { reports, reloads: sent.filter(m => m === 'Page.reload').length, served: sent.includes('Fetch.fulfillRequest') };
}
const eight = Array(8).fill(SCRIPT_ONLY);
const late = await session({ answers: [...eight, RAN], reattach: true });
expect('re-attach: patched code still loading is not called original, and nothing reloads', () => late, { check: r => r.reports.join() === 'patched' && r.reloads === 0 });
const slow = await session({ answers: [...eight, RAN], request: 1000 });
expect('first attach: a request slower than one look is served, not reloaded', () => slow, { check: r => r.served && r.reports.join() === 'patched' && r.reloads === 0 });
const stale = await session({ answers: [SCRIPT_ONLY] });
expect('first attach: a page that loaded its code before the loader is reloaded once', () => stale, { check: r => r.reloads === 1 && !r.reports.length });

console.log(failures ? `${failures} FAILED` : 'all wording checks passed');
process.exit(failures ? 1 : 0);
