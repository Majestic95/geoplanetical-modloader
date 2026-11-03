// Port helper: carries a mod's patches from one game build to the next. For each edit, the old `find` text becomes a
// pattern in which short identifiers are wildcards (a repeated name must match the same new name; keywords, property
// names after a dot and string text stay fixed), searched near the edit's anchor in the new bundle; the single match is
// the new `find` and gives the old -> new names it contains. Names the `replace` text uses that the `find` does not
// contain are looked up by their top-level definition (as tools/rename-map.py does); names the replace text declares
// itself (let/const, parameters) and the mod's own names (those starting with an --own prefix, e.g. the prefix of the
// globals the mod defines) stay. Writes the ported patch files to <out dir> and a report; nothing in the mod is changed.
// Run from your mod workspace: bundles are read from .modding/decompiled/app-<build>/renderer/.
// With [tests dir], also rewrites the minified names inside string literals and template text of the test files
// (search strings they slice the bundle by, stub names they pass to new Function, names in their error text) into
// <out dir>/tests. Regression test: node tools/test-port-patches.mjs.
// Known limit: names a test compares as data (a call log, `c[0] === 'QxB'`) are renamed where they look like call
// arguments, while stub keys written as code are not; check such tests by hand after a port.
// Usage: node --max-old-space-size=8000 <loader>/tools/port-patches.mjs [--own <prefix> ...] <old build> <new build>
//          <mod dir> <out dir> [tests dir]
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DECOMPILED } from '../patcher/build.mjs';

const args = process.argv.slice(2);
const ownPrefixes = [];
for (let i = args.indexOf('--own'); i >= 0; i = args.indexOf('--own')) ownPrefixes.push(args.splice(i, 2)[1]);
const [oldB, newB, modDir, outDir, testsDir] = args;
if (!outDir || ownPrefixes.some(p => !p || p.startsWith('--'))) {
  console.error('usage: port-patches.mjs [--own <prefix> ...] <old build> <new build> <mod dir> <out dir> [tests dir]');
  process.exit(2);
}
// The folder holding app-<build>/: PORT_DECOMPILED (tools/test-port-patches.mjs uses fixtures), else the workspace's
// (patcher/build.mjs DECOMPILED: GEO_DECOMPILED, else .modding/decompiled in the workspace).
const decompiled = process.env.PORT_DECOMPILED || DECOMPILED;
const bundle = (b, file) => readFileSync(join(decompiled, `app-${b}`, 'renderer', file), 'utf8');
const KEYWORDS = new Set(('function return let const var if else for while do new this typeof instanceof in of try catch ' +
  'finally throw switch case default break continue async await class extends super null true false void delete yield ' +
  'static get set Math Number String Object Array JSON Map Set Error Infinity NaN undefined isFinite').split(' '));
const isName = t => /^[A-Za-z_$][\w$]*$/.test(t) && !KEYWORDS.has(t);
const own = t => ownPrefixes.some(p => t.startsWith(p));

// Tokens: strings (with ${...} parts of template literals tokenised again), names, numbers, other characters.
function tokens(src) {
  const out = [];
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { // comments stay as they are
      const end = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i) + 2;
      const j = end <= i ? src.length : end;
      out.push({ t: src.slice(i, j), kind: 'comment' }); i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out.push({ t: src.slice(i, j + 1), kind: 'str' }); i = j + 1;
    } else if (c === '`') {
      out.push({ t: '`', kind: 'punct' }); let j = i + 1, lit = '';
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') { lit += src.slice(j, j + 2); j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          if (lit) out.push({ t: lit, kind: 'str', tpl: true }); lit = '';
          let depth = 1, k = j + 2;
          while (k < src.length && depth) {
            const ch = src[k];
            if (ch === '"' || ch === "'" || ch === '`') { // skip a nested string, so its braces do not count
              let m = k + 1;
              while (m < src.length && src[m] !== ch) m += src[m] === '\\' ? 2 : 1;
              k = m + 1; continue;
            }
            if (ch === '{') depth++; else if (ch === '}') depth--;
            k++;
          }
          out.push({ t: '${', kind: 'punct' }, ...tokens(src.slice(j + 2, k - 1)), { t: '}', kind: 'punct' }); j = k; continue;
        }
        lit += src[j++];
      }
      if (lit) out.push({ t: lit, kind: 'str', tpl: true });
      out.push({ t: '`', kind: 'punct' }); i = j + 1;
    } else {
      const m = /^(?:[A-Za-z_$][\w$]*|\d+(?:\.\d+)?(?:e-?\d+)?|\s+|[\s\S])/.exec(src.slice(i, i + 200));
      const t = m[0]; out.push({ t, kind: isName(t) ? 'name' : 'punct' }); i += t.length;
    }
  }
  // A name right after a dot (property access), or an object-literal key ({k: or ,k:), stays fixed.
  for (let k = 0; k < out.length; k++) {
    if (out[k].kind !== 'name') continue;
    let p = k - 1, n = k + 1;
    while (p >= 0 && /^\s+$/.test(out[p].t)) p--;
    while (n < out.length && /^\s+$/.test(out[n].t)) n++;
    if (p >= 0 && out[p].t === '.') out[k].kind = 'prop';
    else if (p >= 0 && (out[p].t === '{' || out[p].t === ',') && n < out.length && out[n].t === ':') out[k].kind = 'prop';
  }
  return out;
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Pattern for a find text: each distinct short name becomes a capture group; repeats use a backreference.
function findPattern(find, { backrefs = true } = {}) {
  const groups = new Map(); let rx = '';
  for (const tk of tokens(find)) {
    if (tk.kind === 'name' && tk.t.length <= 4 && !own(tk.t)) {
      if (groups.has(tk.t)) rx += backrefs ? `\\k<g${groups.get(tk.t)}>` : '(?<![\\w$])[A-Za-z_$][\\w$]{0,4}(?![\\w$])';
      else { groups.set(tk.t, groups.size); rx += `(?<![\\w$])(?<g${groups.size - 1}>[A-Za-z_$][\\w$]{0,4})(?![\\w$])`; }
    } else rx += esc(tk.t);
  }
  return { rx, names: [...groups.keys()] };
}
// Names a replace text declares itself (so they are not game references): let/const/var X, (a,b)=>, X=>, function f(a).
function declared(text) {
  const d = new Set();
  for (const m of text.matchAll(/\b(?:let|const|var)\s+([^;]+)/g)) for (const part of m[1].split(',')) { const n = /^\s*([A-Za-z_$][\w$]*)\s*=/.exec(part); if (n) d.add(n[1]); }
  for (const m of text.matchAll(/\(([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\)\s*=>/g)) for (const n of m[1].split(',')) d.add(n.trim());
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) d.add(m[1]);
  for (const m of text.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) for (const n of m[1].split(',')) if (n.trim()) d.add(n.trim().split('=')[0].trim());
  for (const m of text.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) d.add(m[1]);
  return d;
}
// Top-level name lookup by definition (rename-map.py's method, in JS).
const defCache = new Map();
function topLevel(O, N, name) {
  const key = `${O.length}:${name}`;
  if (defCache.has(key)) return defCache.get(key);
  let res = null;
  for (const p of [`function ${esc(name)}\\(`, `(?<![\\w$.])${esc(name)}=(?!=)`, `class ${esc(name)}\\b`]) {
    const hits = [...O.matchAll(new RegExp(p, 'g'))];
    if (hits.length !== 1) continue;
    const at = hits[0].index;
    for (const len of [60, 120, 240, 480, 960]) {
      // No backreferences here: minified code reuses a name in nested scopes, which a new build may name apart.
      // The slice is cut back to the last complete token: a cut name (`retu` of `return`) would not match.
      const raw = O.slice(at, at + name.length + 40 + len), cut = raw.replace(/[A-Za-z_$][\w$]*$|\d+(?:\.\d*)?$/, '');
      const { rx } = findPattern(cut, { backrefs: false });
      const found = [...N.matchAll(new RegExp(rx, 'g'))];
      if (process.env.PORT_DEBUG) console.error(`  ${name} len ${len}: ${found.length} matches`);
      if (found.length === 1) {
        const head = new RegExp(p.replace(esc(name), '([A-Za-z_$][\\w$]*)')).exec(N.slice(found[0].index, found[0].index + name.length + 30));
        res = head ? head[1] : null; break;
      }
      if (!found.length) break;
    }
    break;
  }
  defCache.set(key, res);
  return res;
}
const rename = (text, map, keep) => tokens(text).map(tk => (tk.kind === 'name' && !own(tk.t) && !keep.has(tk.t) && map.has(tk.t) ? map.get(tk.t) : tk.t)).join('');

if (modDir === '--lookup') { // debug: node tools/port-patches.mjs <old> <new> --lookup NAME...
  const O = bundle(oldB, 'simulation-worker.bundle.js'), N = bundle(newB, 'simulation-worker.bundle.js');
  for (const name of args.slice(3)) console.log(name, '->', topLevel(O, N, name));
  process.exit(0);
}
const mod = JSON.parse(readFileSync(join(modDir, 'mod.json'), 'utf8'));
const report = [], globalMap = {};
const cache = {};
// A format-2 mod may have no patches. Its page scripts are not ported: they read the game's page, not its minified
// code (check them by hand on the new build).
for (const file of mod.patches || []) {
  const patch = JSON.parse(readFileSync(join(modDir, file), 'utf8'));
  const O = (cache[`o${patch.bundle}`] ||= bundle(oldB, patch.bundle)), N = (cache[`n${patch.bundle}`] ||= bundle(newB, patch.bundle));
  const edits = [], notes = [];
  for (const [i, e] of patch.edits.entries()) {
    const near = e.near ?? 2000, aNew = N.indexOf(e.anchor);
    if (aNew < 0 || N.indexOf(e.anchor, aNew + 1) >= 0) { notes.push(`edit ${i + 1}: FAIL anchor not unique in the new build`); edits.push(e); continue; }
    const { rx, names } = findPattern(e.find);
    const lo = Math.max(0, aNew - near - 500), window = N.slice(lo, aNew + near + 500 + e.find.length);
    const hits = [...window.matchAll(new RegExp(rx, 'g'))];
    if (hits.length !== 1) { notes.push(`edit ${i + 1}: FAIL find pattern matches ${hits.length} times near the anchor`); edits.push(e); continue; }
    const local = new Map(names.map((n, k) => [n, hits[0].groups[`g${k}`]]));
    // Names the replace declares itself stay, unless the find contains them: a replace that re-declares a game
    // function (`function To(`) must carry its new name, or every caller would call an undefined name.
    const keep = new Set([...declared(e.replace)].filter(n => !names.includes(n)));
    // Locals of the surrounding code that the replace uses but the find does not contain: match a wider context of
    // the old find (shrinking until it matches once around the new find) and take its names too.
    const oAt = O.indexOf(e.find), nAt = lo + hits[0].index;
    const needed = tokens(e.replace).filter(tk => tk.kind === 'name' && !own(tk.t) && !keep.has(tk.t) && !local.has(tk.t) && tk.t.length <= 2).map(tk => tk.t);
    if (needed.length && oAt >= 0) {
      for (const pad of [1200, 600, 300, 150, 80]) {
        const ctx = findPattern(O.slice(Math.max(0, oAt - pad), oAt + e.find.length + pad));
        const win = N.slice(Math.max(0, nAt - pad - 400), nAt + e.find.length + pad + 400);
        const m = [...win.matchAll(new RegExp(ctx.rx, 'g'))];
        if (m.length !== 1) continue;
        const wide = new Map(ctx.names.map((n, k) => [n, m[0].groups[`g${k}`]]));
        for (const n of needed) if (wide.has(n)) local.set(n, wide.get(n));
        notes.push(`edit ${i + 1}: context of ${pad} chars matched for ${needed.filter(n => wide.has(n)).join(',') || 'none'}`);
        break;
      }
    }
    // Names in the replace that the find does not give: game references, looked up by definition.
    for (const tk of tokens(e.replace)) {
      if (tk.kind !== 'name' || own(tk.t) || keep.has(tk.t) || local.has(tk.t)) continue;
      const nn = topLevel(O, N, tk.t);
      if (nn) local.set(tk.t, nn);
      else if (!notes.some(n => n.includes(`'${tk.t}'`))) notes.push(`edit ${i + 1}: WARN replace name '${tk.t}' has no top-level definition (kept as is)`);
    }
    // Names from the find are game names even when the replace re-declares them (e.g. it rewrites `function P7(`).
    for (const [a, b] of local) if (a !== b && (names.includes(a) || !keep.has(a))) (globalMap[a] ||= new Set()).add(b);
    const newFind = hits[0][0], newReplace = rename(e.replace, local, keep);
    if (N.indexOf(newFind) !== N.lastIndexOf(newFind)) notes.push(`edit ${i + 1}: FAIL new find occurs more than once in the bundle`);
    const dist = Math.abs(lo + hits[0].index - aNew);
    if (dist > near) notes.push(`edit ${i + 1}: FAIL find is ${dist} chars from the anchor (near ${near})`);
    edits.push({ ...e, find: newFind, replace: newReplace });
    const changed = [...local].filter(([a, b]) => a !== b).map(([a, b]) => `${a}->${b}`);
    notes.push(`edit ${i + 1}: ok${changed.length ? ` (${changed.join(' ')})` : ' (no renames)'}`);
  }
  const target = join(outDir, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ ...patch, edits }, null, 2) + '\n');
  report.push(`${patch.id}\n  ${notes.join('\n  ')}`);
}
if (testsDir) {
  const O = cache['osimulation-worker.bundle.js'] ||= bundle(oldB, 'simulation-worker.bundle.js');
  const N = cache['nsimulation-worker.bundle.js'] ||= bundle(newB, 'simulation-worker.bundle.js');
  mkdirSync(join(outDir, 'tests'), { recursive: true });
  const mapped = new Map(Object.entries(globalMap).filter(([, s]) => s.size === 1).map(([a, s]) => [a, [...s][0]]));
  const lookup = name => {
    if (mapped.has(name)) return mapped.get(name);
    const n = topLevel(O, N, name); if (n) mapped.set(name, n); return n;
  };
  for (const f of readdirSync(testsDir).filter(f => f.endsWith('.mjs'))) {
    const src = readFileSync(join(testsDir, f), 'utf8'), toks = tokens(src), notes = [];
    const strs = toks.map((tk, k) => ({ tk, k })).filter(({ tk }) => tk.kind === 'str').map(s => {
      const q = !s.tk.tpl && (s.tk.t[0] === '"' || s.tk.t[0] === "'") ? s.tk.t[0] : ''; // template text is unquoted, even when it starts with '
      return { ...s, q, body: q ? s.tk.t.slice(1, -1) : s.tk.t };
    });
    // 1. The file's game names, found where a string uses them as code: (a) stub parameters of `new Function(...)`
    // (every quoted argument before the body), any case; (b) a name followed by ( or = (not ==), or after
    // function/var/let/const/return, if minified-looking (an upper-case letter, digit, $ or _), used by the patches,
    // or one of the few lower-case game names tests use (TEST_NAMES). A name merely quoted (a fixture id such as
    // 'p1') or written in message text is not one of them.
    const TEST_NAMES = new Set(['sog', 'or']);
    const fileMap = new Map(), params = new Set(), bodyParams = new Map();
    for (let k = 0; k < toks.length; k++) {
      if (toks[k].t !== 'Function' || !/^\s+$/.test(toks[k - 1]?.t || '') || toks[k - 2]?.t !== 'new' || toks[k + 1]?.t !== '(') continue;
      const args = [];
      for (let m = k + 2; m < toks.length && (toks[m].kind === 'str' || /^[\s,]+$/.test(toks[m].t)); m++) if (toks[m].kind === 'str') args.push(m);
      const end = args.length ? toks.slice(args.at(-1) + 1).find(tk => !/^[\s,]+$/.test(tk.t)) : null;
      let body = [];
      if (end?.t === ')') body = [args.pop()]; // the last quoted argument is the body itself
      else if (end?.t === '`') { // or a template literal: every piece of its text up to the closing backtick
        let m = toks.indexOf(end, args.length ? args.at(-1) + 1 : k + 2) + 1;
        for (; m < toks.length && toks[m].t !== '`'; m++) if (toks[m].kind === 'str' && toks[m].tpl) body.push(m);
      }
      for (const m of args) params.add(m);
      // The body's uses of those parameters are code too, whatever their case: `new Function('or', 'return x||or')`.
      const names = new Set(args.map(m => toks[m].t.slice(1, -1)));
      for (const m of body) bodyParams.set(m, names);
    }
    const learn = w => {
      if (fileMap.has(w) || KEYWORDS.has(w) || own(w)) return;
      const n = lookup(w); if (n) fileMap.set(w, n);
    };
    const candidate = w => !KEYWORDS.has(w) && !own(w) && (/[A-Z0-9$_]/.test(w) || globalMap[w] || TEST_NAMES.has(w));
    // (c) a whole string that is a minified-looking name passed as an argument of a call (`fnSrc(text, 'IoB')`): the
    // nearest unclosed bracket before it is a ( that follows a name.
    const callArg = k => {
      let depth = 0;
      for (let m = k - 1; m >= 0; m--) {
        const t = toks[m].t;
        if (toks[m].kind === 'str') continue;
        if (t === ')' || t === ']' || t === '}') depth++;
        else if (t === '(' || t === '[' || t === '{') { if (depth--) continue; return t === '(' && /^[A-Za-z_$][\w$]*$/.test(toks[m - 1]?.t || ''); }
        else if (!depth && t === ';') return false;
      }
      return false;
    };
    for (const s of strs) {
      if (params.has(s.k) && /^[A-Za-z_$][\w$]{0,3}$/.test(s.body)) { learn(s.body); continue; }
      if (s.q && /^[A-Za-z_$][\w$]{0,3}$/.test(s.body) && /[A-Z$_]/.test(s.body) && candidate(s.body) && callArg(s.k)) { learn(s.body); continue; }
      for (const m of s.body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]{0,3})(?=\(|=(?!=))/g)) if (candidate(m[1])) learn(m[1]);
      for (const m of s.body.matchAll(/\b(?:function|var|let|const|return)\s+([A-Za-z_$][\w$]{0,3})(?![\w$])/g)) if (candidate(m[1])) learn(m[1]);
    }
    // 2. A string that is a piece of the old bundle (a search string the test slices by) becomes the matching piece
    // of the new bundle when that match is unique; its two-or-more-character names join the file's names unless they
    // are known already; a piece whose names contradict a known one is not used (reported) and its names are renamed one by one. Changed one-letter locals are reported:
    // stub parameter lists that name them are not rewritten.
    const piece = new Map();
    for (const s of strs) {
      if (s.body.length < 12 || params.has(s.k) || O.indexOf(s.body) < 0) continue;
      const { rx, names } = findPattern(s.body);
      if (!names.length) continue;
      const found = [...N.matchAll(new RegExp(rx, 'g'))];
      if (found.length !== 1) continue;
      const got = names.map((n, i) => [n, found[0].groups[`g${i}`]]);
      const clash = got.find(([n, nn]) => n.length > 1 && fileMap.has(n) && fileMap.get(n) !== nn);
      if (clash) { notes.push(`WARN ${clash[0]}: ${fileMap.get(clash[0])} by definition, ${clash[1]} in '${s.body.slice(0, 40)}' (piece not used; renamed by name)`); continue; }
      piece.set(s.k, found[0][0]);
      for (const [n, nn] of got) {
        if (n.length === 1) { if (nn !== n) notes.push(`WARN one-letter name ${n}->${nn} in '${s.body.slice(0, 40)}'`); continue; }
        if (!fileMap.has(n)) fileMap.set(n, nn);
      }
    }
    // 3. Rewrite: every occurrence of a file name in string and template text, as a whole name and not as an object
    // key or label (`bYB:`, 'K1: ...'), including message text and stub parameters; bundle pieces as matched. A
    // lower-case name changes only where it is code: a stub parameter, or followed by ( or =, or after
    // function/var/let/const/return. One pass, so a new name is
    // never mapped again.
    const changes = new Map();
    // Whether the name at `at` sits directly in an object literal: the nearest unclosed bracket is a { that starts an
    // expression (after ( [ , = : ? return, or at the start), not a block or function body (after ) { ; or =>).
    const inObject = (body, at) => {
      let depth = 0;
      for (let m = at - 1; m >= 0; m--) {
        const c = body[m];
        if (c === ')' || c === ']' || c === '}') depth++;
        else if (c === '(' || c === '[' || c === '{') {
          if (depth--) continue;
          return c === '{' && /(?:^|[([,=:?]|\breturn)\s*$/.test(body.slice(0, m)) && !/=>\s*$/.test(body.slice(0, m));
        }
      }
      return false;
    };
    // An object key or label is a name followed by : (not ::) at the start of the text or after { or , (a ternary's
    // `?A9B:` is code and is renamed). A name with no upper-case letter, $ or _ (`or`, `wa`, `p1`) also reads as a
    // word or a fixture value, so it changes only where it is code.
    const swap = (body, param) => body.replace(/(?<![\w$.])([A-Za-z_$][\w$]{0,3})(?![\w$])/g, (w, _, at) => {
      const n = fileMap.get(w); if (!n || n === w) return w;
      if (/^\s*:(?!:)/.test(body.slice(at + w.length)) && /(?:^|[{,])\s*$/.test(body.slice(0, at))) return w;
      const shorthand = /^\s*[,}]/.test(body.slice(at + w.length)) && /[{,]\s*$/.test(body.slice(0, at)) && inObject(body, at);
      if (!/[A-Z$_]/.test(w) && param !== true && !param?.has?.(w) && !/^(?:\(|=(?!=))/.test(body.slice(at + w.length)) &&
        !/\b(?:function|var|let|const|return)\s+$/.test(body.slice(0, at))) return w;
      changes.set(w, n); return shorthand ? `${w}:${n}` : n; // a shorthand property keeps its key: {o5} -> {o5:ZZ9}
    });
    const strAt = new Map(strs.map(s => [s.k, s]));
    const out = toks.map((tk, k) => {
      const s = strAt.get(k); if (!s) return tk.t;
      if (piece.has(k)) { const t = piece.get(k); if (t !== s.body) changes.set(s.body.slice(0, 24), t.slice(0, 24)); return s.q + t + s.q; }
      return s.q + swap(s.body, params.has(k) || bodyParams.get(k)) + s.q;
    }).join('');
    writeFileSync(join(outDir, 'tests', f), out);
    report.push(`tests/${f}: ${changes.size ? [...changes].map(([a, b]) => `${a}->${b}`).join(' ') : 'no renames'}${notes.length ? `\n  ${notes.join('\n  ')}` : ''}`);
  }
}
const flat = Object.fromEntries(Object.entries(globalMap).map(([a, s]) => [a, [...s].join('|')]));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'name-map.json'), JSON.stringify(flat, null, 1) + '\n');
writeFileSync(join(outDir, 'report.txt'), report.join('\n') + '\n');
console.log(report.join('\n'));
