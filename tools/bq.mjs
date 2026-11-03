// Bundle query: the questions a review asks of the game's simulation bundle, answered from its syntax tree, with
// offsets that every reviewer shares. Read-only; output is always bounded (--max characters per item, default 400).
// Usage: node --max-old-space-size=8000 <loader>/tools/bq.mjs [--build <id>] [--max N] <command> <argument>
//   def <name>        every definition named <name> (function, arrow or method): offset, top-level or local, head
//   src <name|@off>   the whole source of the definition (by name when it is the only top-level one, or at an offset)
//   find <text>       every exact occurrence of <text> (up to 40), with the enclosing function and context
//   at <offset>       the text at an offset (--max characters)
//   in <offset>       the named functions around an offset, innermost first
//   refs <name>       the named functions that mention <name> as a name (not `x.name`, not an object key), and any
//                     mentions outside named functions by offset
// Run from your mod workspace (docs/authoring.md). The build is --build, else the workspace's tools/GAME_BUILD, else
// the installed game's build; the bundle is read from the workspace's .modding/decompiled/app-<build>/renderer/ (set
// GEO_DECOMPILED=<dir holding app-<build>> to override).
// Quote names that contain `$` in a shell (`'vo$gp'`). Never use grep -o or wide prints on the bundle: it is one line
// of about 97 MB.
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { existsSync } from 'node:fs';
import { workspaceBuild, bundlePath } from '../patcher/build.mjs';

const DECODER_OPTIONS = { fatal: true, ignoreBOM: true };

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = name => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const build = opt('--build') || workspaceBuild();
const MAX = Math.max(40, Number(opt('--max') || 400) || 400);
const [cmd, ...rest] = argv;
const what = rest.join(' ');
const usage = () => { console.error('usage: node <loader>/tools/bq.mjs [--build <id>] [--max N] def|src|find|at|in|refs <argument>'); process.exit(2); };
if (!cmd || !what) usage();

let src;
try {
  if (!build) throw new Error('no game build: pass --build <id>, write it to tools/GAME_BUILD, or install the game');
  const file = bundlePath(build, 'simulation-worker.bundle.js');
  if (!existsSync(file)) throw new Error(`${file} is missing`);
  src = new TextDecoder('utf-8', DECODER_OPTIONS).decode(readFileSync(file));
} catch (e) {
  console.error(`bq: build ${build} not readable: ${e.message} (extract it with tools/asar_extract.py)`);
  process.exit(2);
}
const clip = (a, b) => { const t = src.slice(Math.max(0, a), Math.min(src.length, b)); return t.length > MAX ? `${t.slice(0, MAX)}…` : t; };
const label = `${build}`;

// text-only commands need no parse
const offset = t => { const n = Number(String(t).replace('@', '')); if (!Number.isInteger(n) || n < 0 || n >= src.length) { console.error(`bq: not an offset in this file: ${t}`); process.exit(2); } return n; };
if (cmd === 'at') {
  const at = offset(what);
  console.log(`${label} @${at}: ${clip(at, at + MAX)}`);
  process.exit(0);
}

// named functions with their nesting: { name, start, end, parent }
const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
const fns = [];
const nameFor = (node, parent) => {
  if (node.id?.name) return node.id.name;
  if (!parent) return null;
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
  if (parent.type === 'AssignmentExpression') return parent.left.type === 'Identifier' ? parent.left.name : (!parent.left.computed && parent.left.property?.name) || null;
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && !parent.computed) return parent.key.name ?? (typeof parent.key.value === 'string' ? parent.key.value : null);
  return null;
};
// Every function is tracked, named or not: `up` is the nearest enclosing function of any kind, so a function inside an
// unnamed callback or IIFE is not mistaken for a top-level one. Only named ones are reported.
const refs = new Map();   // named function index -> identifiers it mentions as names (not `x.name`, not object keys)
const outside = [];       // mentions of the queried name in no named function (top-level code, unnamed functions)
const wantRefs = cmd === 'refs';
const all = [];           // every function: { start, end, parent, named (index in fns or -1) }
const isName = (node, parent) => !(parent && ((parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
  || ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key === node && !parent.computed)));
const work = [[ast, null, false]], stack = [];   // stack: indexes into `all`
while (work.length) {
  const [node, parent, leave] = work.pop();
  if (leave) { stack.pop(); continue; }
  if (!node || typeof node.type !== 'string') continue;
  if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) {
    const name = nameFor(node, parent);
    const up = stack.length ? stack.at(-1) : -1;
    let named = -1;
    if (name) {
      named = fns.length;
      fns.push({ name, start: node.start, end: node.end, up, idNode: node.id || null,
        kind: parent?.type === 'MethodDefinition' || parent?.type === 'Property' ? 'method' : 'function' });
    }
    all.push({ start: node.start, end: node.end, parent: up, named });
    stack.push(all.length - 1);
    work.push([null, null, true]);
  }
  if (wantRefs && node.type === 'Identifier' && isName(node, parent)) {
    // the innermost named function around the mention; none: listed by offset
    let i = stack.length - 1;
    while (i >= 0 && all[stack[i]].named < 0) i--;
    const owner = i >= 0 ? all[stack[i]].named : -1;
    if (owner >= 0 && fns[owner].idNode === node) { /* the function's own name */ }
    else if (owner >= 0) { if (!refs.has(owner)) refs.set(owner, new Set()); refs.get(owner).add(node.name); }
    else if (node.name === what) outside.push(node.start);
  }
  const kids = [];
  for (const k in node) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') kids.push(x); }
    else if (v && typeof v.type === 'string') kids.push(v);
  }
  for (let i = kids.length - 1; i >= 0; i--) work.push([kids[i], node, false]);
}
// The bundle's own wrapper (an unnamed function around almost the whole file) does not count as an enclosing function.
const isWrapper = k => all[k].named < 0 && all[k].end - all[k].start > src.length * 0.9;
// where a named function sits: top level (only the wrapper around it), or inside a named or an unnamed function
for (const f of fns) {
  let k = f.up;
  while (k >= 0 && isWrapper(k)) k = all[k].parent;
  f.top = k < 0;
  f.inside = k < 0 ? null : all[k].named >= 0 ? `${fns[all[k].named].name}@${all[k].start}` : `an unnamed function @${all[k].start}`;
}
const where = f => (f.top ? 'top level' : `local, inside ${f.inside}`);
const around = at => fns.filter(f => f.start <= at && at < f.end).sort((a, b) => b.start - a.start);
const innermost = at => around(at)[0];
// every function around an offset, named or not, innermost first (the bundle's wrapper apart): labels for in and find
const nameOf = k => (all[k].named >= 0 ? `${fns[all[k].named].name}@${all[k].start}` : `an unnamed function @${all[k].start}`);
const aroundAll = at => all.map((x, k) => k).filter(k => all[k].start <= at && at < all[k].end && !isWrapper(k)).sort((a, b) => all[b].start - all[a].start);

if (cmd === 'def') {
  const list = fns.filter(f => f.name === what);
  console.log(`${label}: ${list.length} definition(s) named ${what} (${list.filter(f => f.top).length} top level)`);
  for (const f of list.slice(0, 40)) console.log(`  @${f.start} ${f.kind}, ${where(f)}: ${clip(f.start, f.start + MAX)}`);
} else if (cmd === 'src') {
  let f;
  if (what.startsWith('@')) f = innermost(offset(what));
  else {
    const top = fns.filter(x => x.name === what && x.top);
    if (top.length !== 1) { console.log(`${label}: ${top.length} top-level definitions named ${what}; use src @<offset> (see def ${what})`); process.exit(1); }
    f = top[0];
  }
  if (!f) { console.log(`${label}: no named function at ${what}`); process.exit(1); }
  const body = src.slice(f.start, f.end);
  console.log(`${label} ${f.name}@${f.start}..${f.end} (${body.length} chars, ${where(f)}):`);
  console.log(body.length > MAX * 10 ? `${body.slice(0, MAX * 10)}… (cut at ${MAX * 10}; raise --max)` : body);
} else if (cmd === 'find') {
  const hits = [];
  for (let i = src.indexOf(what); i >= 0 && hits.length < 40; i = src.indexOf(what, i + 1)) hits.push(i);
  let total = hits.length;
  if (hits.length === 40) for (let i = src.indexOf(what, hits[39] + 1); i >= 0; i = src.indexOf(what, i + 1)) total++;
  console.log(`${label}: ${total} occurrence(s) of ${JSON.stringify(what)}${total > 40 ? ' (first 40 shown)' : ''}`);
  const half = Math.floor(MAX / 2);
  for (const at of hits) { const k = aroundAll(at)[0]; console.log(`  @${at} in ${k == null ? '(top-level code)' : nameOf(k)}: ${clip(at - half, at + half)}`); }
} else if (cmd === 'in') {
  const at = offset(what);
  const list = around(at);
  const ks = aroundAll(at);
  console.log(`${label} @${at}: ${ks.length ? ks.map(k => `${nameOf(k)}..${all[k].end}`).join(' < ') : 'top-level code'}`);
} else if (cmd === 'refs') {
  const list = [...refs].filter(([, set]) => set.has(what)).map(([i]) => fns[i]).sort((a, b) => a.start - b.start);
  console.log(`${label}: ${list.length} named function(s) mention ${what} as a name (not as x.${what} or an object key; their own name apart)${list.length > 60 ? ' (first 60 shown)' : ''}`);
  for (const f of list.slice(0, 60)) console.log(`  ${f.name}@${f.start} (${where(f)})`);
  console.log(`  outside named functions: ${outside.length ? outside.slice(0, 20).map(x => `@${x}`).join(' ') + (outside.length > 20 ? ` … (${outside.length})` : '') : 'none'}`);
  console.log(`  (property uses: find .${what})`);
} else usage();
