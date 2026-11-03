// Regression test for tools/port-patches.mjs on fixture bundles: the minified names a test file keeps inside strings
// (search strings, stub parameters of new Function, template text, error text) are renamed on a port, and quoted
// fixture ids and words are not. Cases from the 26311815 -> 26318758 port, which needed hand fixes.
// Usage: node tools/test-port-patches.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('./port-patches.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'port-test-'));
// The same code in two builds, every game name renamed (old -> new): JLB->zLB, A9B->r9B, VAg->CBg, wa->ra, p1->m1,
// or->xr, hLB->xLB, OLB->SLB, qnA->FnA; kmA unchanged.
const game = n => `var ${n.A9B}=.25,kmA=7;function ${n.JLB}(A,B){return A>B?A-B*.31:0}function ${n.VAg}(A){let B=A*.6;return 1-${n.A9B}*B}` +
  `function ${n.wa}(A){return A+19.5}function ${n.p1}(){return"plant-x"}function ${n.or}(A,B){return A||B||83}` +
  `function ${n.hLB}(A,B){A.q=B}function ${n.OLB}(A,B){A.w=B*2}function ${n.qnA}(A){A.z=4}` +
  `function host(A,B,Q){let r={},g=Q;B&&(${n.hLB}(r,g),${n.OLB}(r,g),${n.qnA}(r));return r}`;
const OLD = { JLB: 'JLB', A9B: 'A9B', VAg: 'VAg', wa: 'wa', p1: 'p1', or: 'or', hLB: 'hLB', OLB: 'OLB', qnA: 'qnA' };
const NEW = { JLB: 'zLB', A9B: 'r9B', VAg: 'CBg', wa: 'ra', p1: 'm1', or: 'xr', hLB: 'xLB', OLB: 'SLB', qnA: 'FnA' };
for (const [b, n] of [['1', OLD], ['2', NEW]]) {
  mkdirSync(join(dir, 'decompiled', `app-${b}`, 'renderer'), { recursive: true });
  writeFileSync(join(dir, 'decompiled', `app-${b}`, 'renderer', 'simulation-worker.bundle.js'), game(n));
}
mkdirSync(join(dir, 'mod'), { recursive: true });
writeFileSync(join(dir, 'mod', 'mod.json'), JSON.stringify({ patches: [] }));
mkdirSync(join(dir, 'tests'), { recursive: true });
const testSrc = [
  "const s = text.indexOf('function JLB('), b = text.indexOf(':0}', s) + 3;",
  "if (s < 0) throw new Error('user-cost rate function (JLB) not found');",
  "const f = new Function(`${text.slice(s, b)};return {bYB: JLB, rates: null};`)();",
  "const c = text.indexOf('A9B='), i = text.indexOf('function VAg(', c);",
  "const src = text.slice(i, text.indexOf('}', text.indexOf('return 1-A9B', i)) + 1);",
  "const g = new Function('A9B', 'wa', 'or', `return (${src})`)(0.25, x => x, (a, b) => a || b);",
  "const k = text.indexOf('B&&(hLB(r,g),OLB(r,g),qnA(r)');",
  "const plant = { id: 'p1', fuel: 'or' }, msg = 'one or two plants (p1) failed', key = 'kmA';",
  "const h = new Function('wa', 'return wa(1)');",
  "const note = `${who}'s debt rose by the bond`;",
  "const pick = new Function('A9B', 'JLB', 'return A>1?A9B:JLB;');",
  "const stub = new Function('p1', 'return p1()');",
  "const P = new Function('JLB', 'A9B', 'return {snap:1,JLB,A9B}');",
  "const src2 = fnSrc(text, 'VAg');",
  "const lo = new Function('or', 'p1', 'return x||or||2*p1');",
  "const blk = new Function('A9B', 'return function(){return 1,A9B}');",
  "const tb = new Function('or', `return x||or`);",
].join('\n') + '\n';
writeFileSync(join(dir, 'tests', 'case.test.mjs'), testSrc);

const out = join(dir, 'out');
let report;
try {
  report = execFileSync(process.execPath, [tool, '1', '2', join(dir, 'mod'), out, join(dir, 'tests')],
    { env: { ...process.env, PORT_DECOMPILED: join(dir, 'decompiled') }, encoding: 'utf8' });
} catch (e) { console.log(e.stdout, e.stderr); rmSync(dir, { recursive: true, force: true }); process.exit(1); }
const got = readFileSync(join(out, 'tests', 'case.test.mjs'), 'utf8');
rmSync(dir, { recursive: true, force: true });

let failures = 0, checks = 0;
const has = (text, what) => { checks++; if (!got.includes(text)) { failures++; console.log(`FAIL ${what}: missing ${text}`); } };
const lacks = (text, what) => { checks++; if (got.includes(text)) { failures++; console.log(`FAIL ${what}: still ${text}`); } };
has("text.indexOf('function zLB(')", 'search string with a function name');
has('(zLB) not found', 'error text names the function (a3-c17)');
has('return {bYB: zLB, rates: null};', 'template text: a name followed by a comma (a3-c17); the key stays');
has("text.indexOf('r9B=')", 'search string with an assignment');
has("text.indexOf('return 1-r9B', i)", 'search string with a name after an operator (e13)');
has("new Function('r9B', 'ra', 'xr',", 'stub parameters, lower-case ones included (c6, a5-c9)');
has("text.indexOf('B&&(xLB(r,g),SLB(r,g),FnA(r)')", 'a piece of the bundle becomes the new piece');
has("{ id: 'p1', fuel: 'or' }", 'a quoted fixture id and word stay (e4), even when the file uses the name as code');
has("'one or two plants (p1) failed'", 'message text: a lower-case word stays; a name never seen as code stays');
has("key = 'kmA'", 'an unchanged name stays');
has("new Function('ra', 'return ra(1)')", 'a quoted body: its parameter list and the call inside it');
has("`${who}'s debt rose by the bond`", "template text starting with ' is not a quoted string (w3)");
has("new Function('r9B', 'zLB', 'return A>1?r9B:zLB;')", 'a ternary in a stub body: the name before : is code, not a key');
has("new Function('m1', 'return m1()')", 'a name with a digit is renamed where it is code');
has("'return {snap:1,JLB:zLB,A9B:r9B}'", 'a shorthand property keeps its key');
has("fnSrc(text, 'CBg')", 'a name passed as a string argument of a call is renamed (k4)');
has("new Function('xr', 'm1', 'return x||xr||2*m1')", 'lower-case stub parameters are renamed in their body too');
has("new Function('xr', `return x||xr`)", 'a template-literal body: its lower-case parameter is renamed inside it');
has("'return function(){return 1,r9B}'", 'a name in a function body is not taken for a shorthand property');
lacks("('JLB'", 'no old stub name left');
console.log(report.trim().split('\n').filter(l => l.startsWith('tests/') || l.startsWith('  ')).join('\n'));
console.log(failures ? `${failures} of ${checks} checks FAILED` : `all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
