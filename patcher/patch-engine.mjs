// Applies mods to one game bundle's text. All-or-nothing: any anchor that is missing, repeated or far from its
// edit throws, so a renamed or moved function is never patched by accident (docs/mod-format.md).
//
// An edit is { find, replace, anchor, near?, determinismOk? }: `find` occurs exactly once and is replaced; `anchor`
// is stable text (error string, event id, config key) that occurs exactly once within `near` chars (default 2000)
// of `find`. Mods and patches are loaded and validated by mods.mjs. Edits to the main page's bundle must also be wording
// changes (patcher/page-text.mjs).
import { PAGE_BUNDLE, wordingGuard } from './page-text.mjs';

const DEFAULT_NEAR = 2000;

// Replacement text runs inside the game's deterministic simulation (docs/mod-format.md, Determinism).
const HAZARDS = [
  [/\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\s*\(/, 'wall-clock time'],
  [/\bMath\.random\s*\(/, 'Math.random'],
  [/\bcrypto\.(?:getRandomValues|randomUUID)\s*\(/, 'crypto randomness'],
  [/\b(?:document|window|localStorage|sessionStorage|navigator)\./, 'DOM/UI/local state'],
  [/\.toLocale(?:String|DateString|TimeString)\s*\(|\bIntl\./, 'locale formatting'],
  [/\bsetTimeout\s*\(|\bsetInterval\s*\(|\brequestAnimationFrame\s*\(/, 'timer-driven ordering'],
];

function occurrences(text, needle) {
  const at = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    at.push(i);
    if (at.length > 1) break;
  }
  return at;
}

function exactlyOnce(text, needle, what) {
  if (typeof needle !== 'string' || !needle) throw new Error(`${what}: empty`);
  const at = occurrences(text, needle);
  if (at.length !== 1) throw new Error(`${what}: expected 1 match, found ${at.length === 0 ? 0 : '2+'}`);
  return at[0];
}

// Node access. From game 1.0.9 on, the simulation and its helper workers run in a Node process, where these reach the
// player's PC (files, other programs). No edit may add one, whatever determinismOk says: mods change the game's logic.
// A check against mistakes, not a sandbox (code can reach the same things in disguise; docs/mod-format.md).
// Only the names themselves: a property of the same name (the game's own `l.exports[n]`, `this.require(...)`) is not one,
// but a spread (`...process`) and the global object's own (`globalThis.process`) are. Optional calls (`?.(`, `?.x`) and
// tagged templates count too.
const NAME = '(?<![\\w$])(?<![^.]\\.)';
const NODE_ACCESS = [
  [new RegExp(`${NAME}require\\s*(?:\\?\\.)?[(\`]`), 'require('],
  [new RegExp(`${NAME}process\\s*(?:\\?\\.|[.[])`), 'process'],
  [new RegExp(`${NAME}import\\s*\\(`), 'import('],
  [new RegExp(`${NAME}eval\\s*(?:\\?\\.)?[(\`]`), 'eval('],
  [new RegExp(`${NAME}Function\\s*(?:\\?\\.)?[(\`]`), 'the Function constructor'],
  [new RegExp(`${NAME}(?:module|exports)\\s*(?:\\?\\.|[.[])`), 'module or exports'],
  [new RegExp(`${NAME}__(?:dirname|filename)\\b`), '__dirname or __filename'],
  [/(?<![\w$])(?:globalThis|global|self|window)\s*(?:\?\.|\.)\s*(?:process|require|module|exports)\b/, 'a Node name through the global object'],
  [/\.\.\.\s*(?:process|require|module|exports)\b/, 'a spread of a Node name'],
];

export function hazardsIn(code) {
  return HAZARDS.filter(([re]) => re.test(code)).map(([, label]) => label);
}

const HAZARD_WINDOW = 300;
const countOf = (re, text) => (text.match(new RegExp(re.source, 'g')) || []).length;

// Hazards an edit introduces, counted in a window around the edit before and after it, so an edit that assembles a
// forbidden call from surrounding text (`max` -> `random` inside `Math.max(`) is caught as well as one it contains.
export function hazardsIntroduced(before, after, at, findLength, replaceLength, list = HAZARDS) {
  const lo = Math.max(0, at - HAZARD_WINDOW);
  const old = before.slice(lo, at + findLength + HAZARD_WINDOW);
  const neu = after.slice(lo, at + replaceLength + HAZARD_WINDOW);
  return list.filter(([re]) => countOf(re, neu) > countOf(re, old)).map(([, label]) => label);
}

// The Node access an edit introduces, counted the same way.
export const nodeAccessIntroduced = (before, after, at, findLength, replaceLength) =>
  hazardsIntroduced(before, after, at, findLength, replaceLength, NODE_ACCESS);

function applyEdit(text, e, what) {
  if (typeof e.replace !== 'string') throw new Error(`${what}: replace must be a string`);
  const at = exactlyOnce(text, e.find, `${what} find`);
  const anchorAt = exactlyOnce(text, e.anchor, `${what} anchor`);
  const near = e.near ?? DEFAULT_NEAR;
  if (Math.abs(anchorAt - at) > near) {
    throw new Error(`${what}: anchor is ${Math.abs(anchorAt - at)} chars from the edit (limit ${near})`);
  }
  return { text: text.slice(0, at) + e.replace + text.slice(at + e.find.length), offset: at };
}

// Edit-level: applies plain patches { id, bundle, builds, edits } (headless probes and tests).
export function applyPatches(text, patches, { build, bundle }) {
  const report = [];
  for (const p of patches.filter(x => x.bundle === bundle)) {
    if (!Array.isArray(p.builds) || !p.builds.includes(build)) {
      throw new Error(`${p.id}: pinned to builds ${p.builds}, not ${build}; port it with tools/rename-map.py`);
    }
    p.edits.forEach((e, k) => {
      const r = applyEdit(text, e, `${p.id} edit ${k}`);
      text = r.text;
      report.push({ patch: p.id, edit: k, offset: r.offset, delta: e.replace.length - e.find.length });
    });
  }
  return { text, report };
}

// The loader marker: what is loaded, readable from inside the worker. Nothing in the simulation reads it, and it is
// not enumerable, so it never reaches a save.
export const MARKER = '__gpModLoader';
export function markerPrelude(build, loaded) {
  return `Object.defineProperty(globalThis,"${MARKER}",{value:Object.freeze(${JSON.stringify({ build, mods: loaded })}),` +
    'enumerable:false});\n';
}

// Appended after the bundle: records the message handler the patched code installed, so the launcher can check after
// resume that the patched code, not a re-run original, answers the game (patcher/session.mjs).
export const HANDLER_MARKER = `${MARKER}Onmessage`;
export const HANDLER_POSTLUDE =
  `\n;Object.defineProperty(globalThis,"${HANDLER_MARKER}",{value:globalThis.onmessage,enumerable:false});\n`;

// When `e` fails after earlier edits but fits the original bundle, the earlier edit that broke it for good: the edits
// are replayed on the original, and the last one after which `e` stopped fitting is named (an edit that broke it
// only until a later edit restored the code is not the cause). Null when `e` does not fit the original either (a
// plain error, such as a mod made for other code). Runs only on the error path.
function conflictWith(original, applied, e) {
  const fits = t => { try { applyEdit(t, e, 'check'); return true; } catch { return false; } };
  if (!fits(original)) return null;
  let text = original, fitting = true, cause = null;
  for (const a of applied) {
    text = applyEdit(text, a.edit, 'replay').text;
    const now = fits(text);
    if (fitting && !now) cause = a;
    fitting = now;
  }
  return cause;
}

// Mod-level: applies every loaded mod's patches for `bundle`, in mod order, and prepends the marker.
// Returns null when no mod touches the bundle.
export function buildBundle(original, mods, { build, bundle }) {
  let text = original;
  const report = [];
  const loaded = [];
  const applied = []; // every edit applied so far, in order: { mod, patch, index, edit }
  let guard = null;
  for (const mod of mods) {
    const mine = mod.patches.filter(p => p.bundle === bundle);
    if (!mine.length) continue;
    if (!mod.builds.includes(build)) {
      throw new Error(`mod ${mod.id} ${mod.version} is made for game build ${mod.builds.join(', ')}, not ${build}: ` +
        'it needs updating for this game version');
    }
    for (const p of mine) {
      p.edits.forEach((e, k) => {
        const what = `mod ${mod.id}, patch ${p.id}, edit ${k}`;
        let r;
        try {
          r = applyEdit(text, e, what);
        } catch (err) {
          const by = applied.length ? conflictWith(original, applied, e) : null;
          if (!by) throw err;
          const fitsOwn = `${err.message}. It fits the game's own code, but`;
          throw new Error(by.mod !== mod.id
            ? `${fitsOwn} mod ${by.mod} (patch ${by.patch}) already changed that code: ${by.mod} and ${mod.id} conflict; ` +
              'switch one of them off'
            : by.patch === p.id
              ? `${fitsOwn} edit ${by.index} of the same patch already changed that code: the patch's edits overlap`
              : `${fitsOwn} patch ${by.patch} of the same mod already changed that code: the mod's patches overlap`);
        }
        let entry = null;
        if (bundle === PAGE_BUNDLE) {
          guard ??= wordingGuard(original, what);
          entry = guard.check(text, r.offset, e, what);
        }
        const hazards = hazardsIntroduced(text, r.text, r.offset, e.find.length, e.replace.length);
        if (hazards.length && !e.determinismOk) {
          throw new Error(`${what}: the edit introduces ${hazards.join(', ')}; the simulation must stay deterministic ` +
            '(set determinismOk with the reason if it provably never feeds simulation state)');
        }
        // (not in the page bundle: it runs in the game's window, without Node, and its edits are text, where "process."
        // can end a sentence)
        const access = bundle === PAGE_BUNDLE ? [] : nodeAccessIntroduced(text, r.text, r.offset, e.find.length, e.replace.length);
        if (access.length) {
          throw new Error(`${what}: the edit adds ${access.join(', ')}, which can reach the player's PC where the game runs ` +
            'this code in a Node process (from game 1.0.9 on); a mod may change only the game\'s own logic');
        }
        text = r.text;
        report.push({ mod: mod.id, patch: p.id, edit: k, offset: r.offset, delta: e.replace.length - e.find.length, ...(entry ? { entry } : {}) });
        applied.push({ mod: mod.id, patch: p.id, index: k, edit: e });
      });
    }
    loaded.push({ id: mod.id, version: mod.version, patches: mine.map(p => p.id) });
  }
  if (!loaded.length) return null;
  return { text: markerPrelude(build, loaded) + text + HANDLER_POSTLUDE, report, loaded };
}
