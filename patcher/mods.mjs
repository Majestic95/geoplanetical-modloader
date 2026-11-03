// Mod loader: reads each mods/<folder>/mod.json, its patch files (plain data) and its page scripts. Strict: an unknown or
// missing field is an error naming the file, so a typo never silently drops an edit. Nothing here executes mod code
// (a page script is only parsed).
// The format is specified for mod authors in docs/mod-format.md; keep the two in step.
//
// mod.json   { id, name, version, description, builds: [buildId], patches: ["patches/<file>.json", ...],
//              format?: 1 | 2, author?, requires?: [modId], changes?: [entry, ...], scripts?: ["<file>.js", ...] }
//              (changes shown by the launcher), each entry a change ("one or two plain sentences") or a group of them:
//              { group: "Heading", items: [...] }. scripts needs format 2; with scripts, format 2 may leave out patches.
// patch file { id, finding?, effect, bundle, edits: [{ anchor, find, replace, near?, determinismOk? }] }
// Loaded:    { ...mod.json, dir, patches: [patch file, ...], scripts: [{ path, text }] } (both lists always present)
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Script } from 'node:vm';
import { wrap } from './page-script.mjs';

// The mod format this loader reads. A mod declares a higher one only when it uses fields added later; this loader
// then lists it as needing a newer loader instead of rejecting a field it does not know.
// 1: patches (loader 0.3.0). 2: adds scripts for the game's page, patches optional with scripts (loader 0.4.0).
export const FORMAT = 2;
const MOD_KEYS = ['id', 'name', 'version', 'description', 'builds'];
const MOD_OPTIONAL = ['patches', 'changes', 'format', 'author', 'requires', 'scripts'];
// Page scripts: per file and per mod, and how a script path is written (plain segments, no "." or "..").
const MAX_SCRIPT = 2 * 1024 * 1024;
const MAX_SCRIPTS = 20;
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
const SCRIPT_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\.js$/;
const PATCH_KEYS = ['id', 'effect', 'bundle', 'edits'];
const PATCH_OPTIONAL = ['finding'];
const EDIT_REQUIRED = ['anchor', 'find', 'replace'];
const EDIT_OPTIONAL = ['near', 'determinismOk'];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BUNDLE = /^[a-z0-9-]+\.bundle\.js$/;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

function exactKeys(obj, required, optional, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${where}: expected an object`);
  for (const k of Object.keys(obj)) {
    if (!required.includes(k) && !optional.includes(k)) throw new Error(`${where}: unknown field "${k}"`);
  }
  for (const k of required) if (!(k in obj)) throw new Error(`${where}: missing field "${k}"`);
}

const nonEmpty = (v, where) => {
  if (typeof v !== 'string' || !v) throw new Error(`${where}: must be a non-empty string`);
};

function loadPatch(file, where) {
  const p = readJson(file);
  exactKeys(p, PATCH_KEYS, PATCH_OPTIONAL, where);
  if (!ID.test(p.id)) throw new Error(`${where}: id "${p.id}" must match ${ID}`);
  if (p.finding != null) nonEmpty(p.finding, `${where} finding`);
  nonEmpty(p.effect, `${where} effect`);
  if (!BUNDLE.test(p.bundle)) throw new Error(`${where}: bundle "${p.bundle}" is not a game bundle name`);
  if (!Array.isArray(p.edits) || !p.edits.length) throw new Error(`${where}: edits must be a non-empty array`);
  p.edits.forEach((e, k) => {
    const w = `${where} edit ${k}`;
    exactKeys(e, EDIT_REQUIRED, EDIT_OPTIONAL, w);
    nonEmpty(e.anchor, `${w} anchor`);
    nonEmpty(e.find, `${w} find`);
    if (typeof e.replace !== 'string') throw new Error(`${w} replace: must be a string`);
    if ('near' in e && !(Number.isSafeInteger(e.near) && e.near > 0)) throw new Error(`${w} near: positive integer`);
    if ('determinismOk' in e) nonEmpty(e.determinismOk, `${w} determinismOk`);
  });
  return p;
}

function loadMod(dir) {
  const file = join(dir, 'mod.json');
  const m = readJson(file);
  // Before the field check: a mod for a newer format may use fields this loader does not know.
  if (m && typeof m === 'object' && 'format' in m) {
    if (!Number.isSafeInteger(m.format) || m.format < 1) throw new Error(`${file}: format must be a whole number from 1`);
    if (m.format > FORMAT) {
      throw new Error(`${file}: this mod needs a newer Geoplanetical Mod Loader (mod format ${m.format}; this loader ` +
        `reads format ${FORMAT})`);
    }
  }
  exactKeys(m, MOD_KEYS, MOD_OPTIONAL, file);
  if ('scripts' in m && (m.format ?? 1) < 2) throw new Error(`${file}: scripts need mod format 2: add "format": 2`);
  // patches is required, as in format 1, unless a format-2 mod has scripts instead.
  if (!('patches' in m) && !('scripts' in m)) {
    throw new Error(`${file}: missing field "patches"${(m.format ?? 1) >= 2 ? ' (a format-2 mod may have "scripts" instead)' : ''}`);
  }
  const text = c => typeof c === 'string' && c.trim();
  const entry = c => text(c) || (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).sort().join() === 'group,items' &&
    text(c.group) && Array.isArray(c.items) && c.items.length && c.items.every(text));
  if ('changes' in m && !(Array.isArray(m.changes) && m.changes.every(entry))) {
    throw new Error(`${file}: changes must be a list of non-empty strings or { group, items } groups of them`);
  }
  if (!ID.test(m.id)) throw new Error(`${file}: id "${m.id}" must match ${ID}`);
  for (const k of ['name', 'version', 'description']) nonEmpty(m[k], `${file} ${k}`);
  if ('author' in m) nonEmpty(m.author, `${file} author`);
  if ('requires' in m) {
    const ok = Array.isArray(m.requires) && m.requires.every(r => typeof r === 'string' && ID.test(r));
    if (!ok) throw new Error(`${file}: requires must be a list of mod ids`);
    if (new Set(m.requires).size !== m.requires.length) throw new Error(`${file}: requires lists a mod twice`);
    if (m.requires.includes(m.id)) throw new Error(`${file}: a mod cannot require itself`);
  }
  if (!Array.isArray(m.builds) || !m.builds.length || !m.builds.every(b => typeof b === 'string' && /^\d+$/.test(b))) {
    throw new Error(`${file}: builds must list Steam build ids`);
  }
  if ('patches' in m && (!Array.isArray(m.patches) || !m.patches.length)) throw new Error(`${file}: patches must be a non-empty array`);
  const ids = new Set();
  const patches = (m.patches || []).map(rel => {
    nonEmpty(rel, `${file} patches[]`);
    const path = resolve(dir, rel);
    if (!path.startsWith(resolve(dir) + sep)) throw new Error(`${file}: patch path "${rel}" leaves the mod folder`);
    const p = loadPatch(path, `${m.id}/${rel}`);
    if (ids.has(p.id)) throw new Error(`${m.id}: patch id "${p.id}" repeated`);
    ids.add(p.id);
    return p;
  });
  let scripts = [];
  if ('scripts' in m) {
    if (!Array.isArray(m.scripts) || !m.scripts.length) throw new Error(`${file}: scripts must be a non-empty array`);
    if (m.scripts.length > MAX_SCRIPTS) throw new Error(`${file}: more than ${MAX_SCRIPTS} scripts`);
    for (const rel of m.scripts) {
      if (typeof rel !== 'string' || !SCRIPT_PATH.test(rel)) {
        throw new Error(`${file}: script path ${shown(rel)} must be a .js file path of letters, digits, _ . - and / ` +
          '(each folder and file name starting with a letter, digit or _)');
      }
    }
    // Windows does not tell A.js from a.js: one file listed twice would run twice.
    if (new Set(m.scripts.map(r => r.toLowerCase())).size !== m.scripts.length) throw new Error(`${file}: scripts lists a file twice`);
    let bytes = 0;
    scripts = m.scripts.map(rel => {
      const text = loadScript(dir, rel, `${m.id}/${rel}`);
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_SCRIPT_BYTES) throw new Error(`${file}: the scripts are larger than ${MAX_SCRIPT_BYTES / 1024 / 1024} MB together`);
      // The script inside the function it runs as, exactly as the page is sent it (patcher/page-script.mjs). Text that
      // parses there is balanced, so even one that closes that function early stays inside the loader's guard (in the
      // top frame, once per page load, in its own world).
      try { new Script(wrap(text), { filename: `${m.id}/${rel}` }); } catch (e) {
        throw new Error(`${m.id}/${rel}: does not parse as a script: ${e.message}`);
      }
      return { path: rel, text };
    });
  }
  return { ...m, dir, patches, scripts };
}

// A value quoted in a message, anything outside printable ASCII escaped (no line breaks of its own in a message).
const shown = v => JSON.stringify(v).replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// A page script's text: a file inside the mod folder (also after following links) of at most MAX_SCRIPT bytes of
// UTF-8. Read here; parsed by the caller; never run.
function loadScript(dir, rel, where) {
  const path = resolve(dir, rel);
  let real;
  try { real = realpathSync(path); } catch (e) { throw new Error(`${where}: ${e.message}`); }
  if (!real.startsWith(realpathSync(dir) + sep)) throw new Error(`${where}: the file is outside the mod folder (a link)`);
  if (statSync(real).size > MAX_SCRIPT) throw new Error(`${where}: larger than ${MAX_SCRIPT / 1024 / 1024} MB`);
  const bytes = readFileSync(real);
  if (bytes.length > MAX_SCRIPT) throw new Error(`${where}: larger than ${MAX_SCRIPT / 1024 / 1024} MB`); // changed while read
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) {
    throw new Error(`${where}: ${e.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' ? 'not UTF-8 text' : e.message}`);
  }
}

// A mod's changelog as groups: [{ group: heading or null, items: [sentence, ...] }]. Loose sentences keep their place
// in the list, each run of them in a group without a heading.
export function changeGroups(m) {
  const out = [];
  for (const c of m.changes || []) {
    if (typeof c === 'string') {
      if (out.length && out.at(-1).group === null) out.at(-1).items.push(c); else out.push({ group: null, items: [c] });
    } else out.push({ group: c.group, items: [...c.items] });
  }
  return out;
}

// Every mod folder in `root`: { mods (loaded, sorted by id), broken: [{ folder, id, error }] }. For a mod list that
// shows a broken mod with its error instead of stopping (launcher/gui.mjs, launcher/console.mjs).
export function scanMods(root) {
  const mods = [], broken = [];
  if (existsSync(root)) {
    for (const name of readdirSync(root, { withFileTypes: true })) {
      if (!name.isDirectory() || !existsSync(join(root, name.name, 'mod.json'))) continue;
      try {
        mods.push(loadMod(join(root, name.name)));
      } catch (e) {
        let id = null;
        try { id = JSON.parse(readFileSync(join(root, name.name, 'mod.json'), 'utf8'))?.id ?? null; } catch { /* unreadable */ }
        broken.push({ folder: name.name, id, error: e.message });
      }
    }
  }
  mods.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Two folders with the same mod id (a copy, or a new version unzipped beside the old one): none of them loads, and
  // each is listed with the reason, so the player can delete the extra folder.
  const seen = new Map();
  for (const m of mods) seen.set(m.id, [...(seen.get(m.id) || []), m]);
  const dupes = [...seen.values()].filter(list => list.length > 1).flat();
  for (const m of dupes) {
    const others = dupes.filter(o => o.id === m.id && o !== m).map(o => o.dir.split(/[\\/]/).pop());
    broken.push({ folder: m.dir.split(/[\\/]/).pop(), id: m.id, error: `the same mod (${m.id}) is also in folder ${others.join(', ')}: delete the older copy` });
  }
  return { mods: mods.filter(m => !dupes.includes(m)), broken };
}

// Why `chosen` (the mods about to be loaded) cannot load together, or null: a mod whose required mod is not among
// them. `all` (every mod that loaded) tells a mod that is switched off from one that is missing, and `broken` (scanMods'
// list) one that is installed but cannot load.
export function requirementProblem(chosen, all = chosen, broken = []) {
  const ids = new Set(chosen.map(m => m.id));
  for (const m of chosen) {
    for (const r of m.requires || []) {
      if (ids.has(r)) continue;
      const other = all.find(o => o.id === r);
      if (other) return `${m.name} needs ${other.name} (${r}) loaded with it: switch ${other.name} on too`;
      const bad = broken.find(b => b.id === r);
      if (bad) return `${m.name} needs the mod "${r}", which is installed but cannot load: ${bad.error}`;
      return `${m.name} needs the mod "${r}", which is not in the mods folder: install it, or switch ${m.name} off`;
    }
  }
  return null;
}

// `mods` in load order: each mod after the mods it requires (those among `mods`), otherwise in the given order.
// Throws on a requirement cycle.
export function orderMods(mods) {
  const byId = new Map(mods.map(m => [m.id, m]));
  const out = [], state = new Map(); // id -> 'visiting' | 'done'
  const visit = (m, path) => {
    if (state.get(m.id) === 'done') return;
    if (state.get(m.id) === 'visiting') {
      throw new Error(`mods require each other in a circle: ${[...path.slice(path.indexOf(m.id)), m.id].join(' -> ')}`);
    }
    state.set(m.id, 'visiting');
    for (const r of m.requires || []) if (byId.has(r)) visit(byId.get(r), [...path, m.id]);
    state.set(m.id, 'done');
    out.push(m);
  };
  for (const m of mods) visit(m, []);
  return out;
}

// Loads every mod in `root` (each sub-folder with a mod.json), or only `only` in that order, then puts each mod after
// the mods it requires. With `only`, a broken mod that was not selected is skipped; without it, any broken mod is an
// error. A required mod that is not loaded is an error.
export function loadMods(root, opts = {}) {
  const { selected, found, broken } = selectMods(root, opts);
  const problem = requirementProblem(selected, [...found.values()], broken);
  if (problem) throw new Error(problem);
  return orderMods(selected);
}

function selectMods(root, { only = null } = {}) {
  const found = new Map();
  const broken = [];
  if (existsSync(root)) {
    for (const name of readdirSync(root, { withFileTypes: true })) {
      if (!name.isDirectory() || !existsSync(join(root, name.name, 'mod.json'))) continue;
      let mod;
      try {
        mod = loadMod(join(root, name.name));
      } catch (e) {
        let id = null;
        try { id = JSON.parse(readFileSync(join(root, name.name, 'mod.json'), 'utf8'))?.id ?? null; } catch { /* unreadable */ }
        broken.push({ folder: name.name, id, error: e.message });
        continue;
      }
      if (found.has(mod.id)) throw new Error(`mod id "${mod.id}" used by two folders`);
      found.set(mod.id, mod);
    }
  }
  if (!only) {
    if (broken.length) throw new Error(broken.map(b => b.error).join('\n'));
    return { found, broken, selected: [...found.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
  }
  return {
    found,
    broken,
    selected: only.map(id => {
      if (found.has(id)) return found.get(id);
      const b = broken.find(x => x.id === id || x.folder === id);
      throw new Error(b ? b.error : `no mod "${id}" in ${root}`);
    }),
  };
}
