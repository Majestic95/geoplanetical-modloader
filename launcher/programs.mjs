// Program folders (docs/authoring.md#programs): a program, such as a multiplayer launcher, can ship as a folder in the
// loader's `programs` folder, beside `mods`, with a `program.json` that names it and its .exe. The window lists it with
// the mods; the player confirms it once before its first start (again whenever any file of it changes: programStamp). A
// program is never read from the mods folder: mods are data, a program can do anything on the PC.
//
// program.json { format: 1, id, name, version, description, exe, author?, builds?: [buildId] }
//   exe: the program's .exe, a plain path inside its folder ("GeoplaneticalMP.exe", "bin/start.exe")
//   builds: the game builds it plays; without it, any (the program checks the game itself)
import { readFileSync, readdirSync, lstatSync, statSync, realpathSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

// The program.json formats this loader reads.
export const PROGRAM_FORMAT = 1;
// At most this many program folders are listed (the same as programs added in the settings).
export const MAX_PROGRAM_FOLDERS = 8;
const MAX_JSON = 64 * 1024;
// A program folder is hashed whole before each start (programStamp): at most this much, so a start never stalls.
export const MAX_PROGRAM_BYTES = 512 * 1024 * 1024;
const MAX_PROGRAM_FILES = 5000;
const REQUIRED = ['format', 'id', 'name', 'version', 'description', 'exe'];
const OPTIONAL = ['author', 'builds'];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Shown text: letters, marks, digits, punctuation, symbols and spaces (no control or direction characters).
const PLAIN = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;
const EXE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\.exe$/i;
const BUILD = /^\d{1,12}$/;

const text = (v, max, where) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || !PLAIN.test(v)) {
    throw new Error(`${where} must be plain text of at most ${max} characters (no line breaks or direction characters)`);
  }
  return v.trim();
};
const inside = (root, p) => { const r = relative(root, p); return !!r && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };

// The program in folder `dir` (its program.json read strictly), or throws an Error for the player.
export function readProgram(dir) {
  const file = join(dir, 'program.json');
  const st = statSync(file);
  if (st.size > MAX_JSON) throw new Error(`${file}: larger than ${MAX_JSON / 1024} KB`);
  let p;
  try { p = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: ${e.message}`); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`${file}: expected an object`);
  if (typeof p.format === 'number' && Number.isInteger(p.format) && p.format > PROGRAM_FORMAT) {
    throw new Error(`${file}: program format ${p.format} needs a newer loader (this one reads format ${PROGRAM_FORMAT})`);
  }
  for (const k of Object.keys(p)) if (!REQUIRED.includes(k) && !OPTIONAL.includes(k)) throw new Error(`${file}: unknown field "${k}"`);
  for (const k of REQUIRED) if (!(k in p)) throw new Error(`${file}: missing field "${k}"`);
  if (p.format !== PROGRAM_FORMAT) throw new Error(`${file}: "format" must be ${PROGRAM_FORMAT}`);
  if (typeof p.id !== 'string' || !ID.test(p.id)) throw new Error(`${file}: id must be text matching ${ID}`);
  const out = {
    id: p.id,
    name: text(p.name, 60, `${file}: name`),
    version: text(p.version, 40, `${file}: version`),
    description: text(p.description, 1000, `${file}: description`),
    author: 'author' in p ? text(p.author, 60, `${file}: author`) : null,
    builds: null,
  };
  if ('builds' in p) {
    if (!Array.isArray(p.builds) || !p.builds.length || !p.builds.every(b => typeof b === 'string' && BUILD.test(b))) {
      throw new Error(`${file}: builds must be a non-empty list of build ids (digits, in quotes)`);
    }
    out.builds = [...p.builds];
  }
  if (typeof p.exe !== 'string' || !EXE.test(p.exe)) throw new Error(`${file}: exe must be the program's .exe, a plain path inside its folder (such as "MyProgram.exe")`);
  // (the file itself, inside the folder also once links are followed)
  const exe = join(dir, ...p.exe.split('/'));
  let real, realDir;
  try { real = realpathSync.native(exe); realDir = realpathSync.native(dir); } catch { throw new Error(`${file}: ${p.exe} is not in the program's folder`); }
  if (!inside(realDir, real) || !statSync(real).isFile()) throw new Error(`${file}: ${p.exe} is not a file inside the program's folder`);
  programFiles(dir); // (throws for a link inside it, or a folder too large to check before each start)
  return { ...out, exe, dir };
}

// Every file of a program folder, [{ rel, abs, size, mtimeMs }] sorted by path. A link (or junction) anywhere inside is
// refused: the files hashed must be the files the program runs.
export function programFiles(dir) {
  const out = [];
  let bytes = 0;
  const walk = (abs, rel) => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const a = join(abs, d.name), r = rel ? `${rel}/${d.name}` : d.name;
      const st = lstatSync(a);
      if (st.isSymbolicLink()) throw new Error(`${r} in the program's folder is a link to somewhere else; a program folder holds its own files`);
      if (st.isDirectory()) { walk(a, r); continue; }
      if (!st.isFile()) continue;
      bytes += st.size;
      if (out.length >= MAX_PROGRAM_FILES || bytes > MAX_PROGRAM_BYTES) throw new Error(`the program's folder holds more than ${MAX_PROGRAM_FILES} files or ${MAX_PROGRAM_BYTES / 1024 / 1024} MB`);
      out.push({ rel: r, abs: a, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// A quick look at a program folder (its files' paths, sizes and times of change): when it is the same as before, the
// last stamp still holds. Null when the folder cannot be read.
export function programLook(dir) {
  try { return programFiles(dir).map(f => `${f.rel}|${f.size}|${Math.floor(f.mtimeMs)}`).join('\n'); } catch { return null; }
}

// Every program folder in `root` (the loader's `programs` folder): { programs (sorted by id), broken: [{ folder, id,
// error }] }. A folder that is a link (or junction) is refused: what the window lists must be what is there. Two folders
// with one id are both refused, as for mods; folders past MAX_PROGRAM_FOLDERS are refused.
export function scanPrograms(root) {
  const programs = [], broken = [];
  if (!root || !existsSync(root)) return { programs, broken };
  if (lstatSync(root).isSymbolicLink()) return { programs, broken: [{ folder: 'programs', id: null, error: 'the programs folder is a link to another folder: make it a folder of its own' }] };
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const dir = join(root, d.name);
    let isLink = false;
    try { isLink = lstatSync(dir).isSymbolicLink(); } catch { continue; }
    if (isLink) { if (existsSync(join(dir, 'program.json'))) broken.push({ folder: d.name, id: null, error: 'it is a link to another folder: put the program itself here' }); continue; }
    if (!d.isDirectory() || !existsSync(join(dir, 'program.json'))) continue;
    try { programs.push({ ...readProgram(dir), folder: d.name }); } catch (e) {
      let id = null;
      // (its id, to name it and find it when a new version replaces it; never more than the strict reader would read)
      try {
        if (statSync(join(dir, 'program.json')).size <= MAX_JSON) {
          const v = JSON.parse(readFileSync(join(dir, 'program.json'), 'utf8'))?.id;
          if (typeof v === 'string' && ID.test(v)) id = v;
        }
      } catch { /* unreadable */ }
      broken.push({ folder: d.name, id, error: e.message });
    }
  }
  programs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Map();
  for (const p of programs) seen.set(p.id, [...(seen.get(p.id) || []), p]);
  const dupes = [...seen.values()].filter(l => l.length > 1).flat();
  for (const p of dupes) {
    broken.push({ folder: p.folder, id: p.id, error: `the same program (${p.id}) is also in folder ${dupes.filter(o => o.id === p.id && o !== p).map(o => o.folder).join(', ')}: delete the older copy` });
  }
  const ok = programs.filter(p => !dupes.includes(p));
  for (const p of ok.slice(MAX_PROGRAM_FOLDERS)) broken.push({ folder: p.folder, id: p.id, error: `more than ${MAX_PROGRAM_FOLDERS} programs: remove one` });
  return { programs: ok.slice(0, MAX_PROGRAM_FOLDERS), broken };
}

// What the player's confirmation of a program folder is tied to: the SHA-256 of every file in it (paths and contents),
// so any change to the program (a new version, a file swapped beside the .exe, whatever its size and time of change) is
// asked again. Null when the folder cannot be read.
export function programStamp(dir) {
  try {
    const h = createHash('sha256'), buf = Buffer.alloc(1 << 20);
    for (const f of programFiles(dir)) {
      // (each file hashed on its own, then its path, that hash and the bytes read go into the folder's hash: no file's
      // bytes can pass for the next file's path, and the stamp depends on what was read alone)
      const fh = createHash('sha256');
      let read = 0;
      const fd = openSync(f.abs, 'r');
      try { for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) { fh.update(buf.subarray(0, n)); read += n; } } finally { closeSync(fd); }
      h.update(`${f.rel}\0${fh.digest('hex')}\0${read}\n`);
    }
    return `sha256:${h.digest('hex')}`;
  } catch { return null; }
}
