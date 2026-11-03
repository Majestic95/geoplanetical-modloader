// Installs mods into the mods folder from what a player gives the window: a mod's .zip (launcher/gui.mjs reads it from
// a dropped file or the Add mod dialog) or a mod folder (dropped, or the folder of a chosen mod.json). One install is
// one transaction: every file is read into memory and every mod checked with the loader's strict reader before the
// mods folder changes, an older copy of the same mod (same id) is replaced and goes to the Recycle Bin, and a failure
// part-way puts everything back. Nothing here runs mod code; the files are only copied.
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, renameSync, rmSync, existsSync, statSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inflateRawSync, crc32 } from 'node:zlib';
import { scanMods } from '../patcher/mods.mjs';

// Far above a real mod (the largest known is under 1 MB in 80 files), low enough that a wrong file is refused quickly.
// The file and byte limits hold for one install as a whole, however many zips or folders it takes.
export const MAX_ZIP = 32 * 1024 * 1024;
export const MAX_FILES = 5000;
export const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PATH = 200;
const MAX_ITEMS = 20;
const MAX_MODS = 50;
// The loader's own work folders inside the mods folder. A mod sits two levels down in them, so the mod list (which
// reads mods/<folder>/mod.json) never shows them.
const STAGING = '.gpml-install-';
const STAGING_LEFT = /^\.gpml-install-[0-9a-f]{12}$/;
const REPLACED = '.gpml-replaced-';

// Names Windows keeps for devices, with or without an extension (and spaces before it).
const DEVICE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$) *(\..*)?$/i;
// Files Explorer acts on just by showing the folder they are in; a mod has no use for them.
const SHELL_FILE = /\.(lnk|url|scf|library-ms|searchconnector-ms)$/i;
// Marks a written file as downloaded from the internet, as Explorer's Extract All does for a downloaded zip.
const ZONE = '[ZoneTransfer]\r\nZoneId=3\r\n';

const mb = n => `${n / 1024 / 1024} MB`;
const newBudget = () => ({ files: 0, bytes: 0 });
function spend(budget, bytes, what) {
  if (++budget.files > MAX_FILES) throw new Error(`${what} holds more than ${MAX_FILES} files`);
  budget.bytes += bytes;
  if (budget.bytes > MAX_BYTES) throw new Error(`${what} unpacks to more than ${mb(MAX_BYTES)}`);
}

// A path inside a mod as given by a zip or a dropped folder, as `a/b/c` segments, or an Error saying why it cannot
// be written safely on Windows. Backslashes count as separators (Windows PowerShell's Compress-Archive writes them).
export function entryPath(raw) {
  const p = String(raw).replace(/\\/g, '/');
  if (p.length > MAX_PATH) return new Error(`the path ${JSON.stringify(p.slice(0, 60))}... is longer than ${MAX_PATH} characters`);
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return new Error(`${JSON.stringify(p)} is an absolute path`);
  const parts = p.split('/');
  for (const s of parts) {
    if (s === '' || s === '.' || s === '..') return new Error(`${JSON.stringify(p)} is not a plain path inside the mod`);
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\u0000-\u001f]/.test(s) || /[. ]$/.test(s) || DEVICE.test(s)) {
      return new Error(`${JSON.stringify(p)} has a name Windows cannot store`);
    }
  }
  return parts.join('/');
}

// The files of a zip archive as [{ path, data }] (folders left out). Refuses what it cannot check: encrypted entries,
// ZIP64, compression other than stored or deflate, entries that share their bytes, sizes over the caps (counted in
// `budget`, shared by every zip and folder of one install), and data whose length or CRC does not match.
export function readZip(buf, budget = newBudget()) {
  if (buf.length > MAX_ZIP) throw new Error(`the zip is larger than ${mb(MAX_ZIP)}`);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10), cdSize = buf.readUInt32LE(end + 12), cdAt = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdAt === 0xffffffff || cdSize === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  if (cdAt + cdSize > end) throw new Error('the zip is damaged (directory out of range)');
  const entries = [];
  for (let i = 0, at = cdAt; i < count; i++) {
    if (at + 46 > end || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('the zip is damaged (bad directory entry)');
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10), crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20), usize = buf.readUInt32LE(at + 24);
    const nlen = buf.readUInt16LE(at + 28), xlen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nlen);
    at += 46 + nlen + xlen + clen;
    if (/[\\/]$/.test(name)) continue; // a folder
    if (name.replace(/\\/g, '/').startsWith('__MACOSX/')) continue; // macOS resource forks
    const shown = JSON.stringify(name.slice(0, 80));
    if (flags & 1) throw new Error(`${shown} is encrypted`);
    if (method !== 0 && method !== 8) throw new Error(`${shown} uses an unsupported compression method`);
    spend(budget, usize, 'what was added');
    entries.push({ name, shown, method, crc, csize, usize, local });
  }
  // Each entry's bytes must be its own: entries pointing at the same data would make one small zip inflate it again
  // and again.
  let used = 0;
  for (const e of [...entries].sort((a, b) => a.local - b.local)) {
    if (e.local < used || e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error(`the zip is damaged at ${e.shown}`);
    e.start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    used = e.start + e.csize;
    if (used > buf.length) throw new Error(`the zip is damaged at ${e.shown}`);
  }
  return entries.map(e => {
    const raw = buf.subarray(e.start, e.start + e.csize);
    let data;
    try { data = e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, e.usize) }); } catch {
      throw new Error(`the zip is damaged at ${e.shown}`);
    }
    if (data.length !== e.usize || crc32(data) !== e.crc) throw new Error(`the zip is damaged at ${e.shown}`);
    return { path: e.name, data };
  });
}

// The files of a folder on disk as [{ path, data }], paths starting with the folder's own name. Refuses links
// (symbolic links and junctions), so nothing outside the folder is read.
export function readFolder(dir, budget = newBudget()) {
  const out = [];
  const walk = (abs, rel) => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const a = join(abs, d.name), r = `${rel}/${d.name}`;
      const st = lstatSync(a);
      if (st.isSymbolicLink()) throw new Error(`${r} is a link; copy the mod folder itself`);
      if (st.isDirectory()) { walk(a, r); continue; }
      if (!st.isFile()) continue;
      spend(budget, st.size, 'the folder');
      out.push({ path: r, data: readFileSync(a) });
    }
  };
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a link; choose the mod folder itself`);
  walk(dir, basename(dir));
  return out;
}

// What the player chose in the Add mod dialog: a .zip, or a mod.json (its folder is installed).
export function readChosen(file) {
  if (/\.zip$/i.test(file)) {
    if (statSync(file).size > MAX_ZIP) throw new Error(`the zip is larger than ${mb(MAX_ZIP)}`);
    return [{ name: basename(file), files: readZip(readFileSync(file)) }];
  }
  if (basename(file).toLowerCase() === 'mod.json') return [{ name: basename(dirname(file)), files: readFolder(dirname(file)) }];
  throw new Error('choose a mod\'s .zip file, or the mod.json inside its folder');
}

// What the window sends for a drop (launcher/gui-page.mjs): { items: [{ name, zip } | { name, files: [{ path, data }] }] },
// file contents in base64. The install items, or an Error for the player.
export function itemsFromPage(body) {
  const list = body?.items;
  if (!Array.isArray(list) || !list.length || list.length > MAX_ITEMS) throw new Error(`nothing to add (drop up to ${MAX_ITEMS} items at a time)`);
  const budget = newBudget();
  return list.map(it => {
    const name = typeof it?.name === 'string' && it.name ? it.name.slice(0, 120) : 'the dropped item';
    if (typeof it.zip === 'string') return { name, files: readZip(Buffer.from(it.zip, 'base64'), budget) };
    const files = it.files;
    if (Array.isArray(files) && files.every(f => typeof f?.path === 'string' && typeof f.data === 'string')) {
      return {
        name, files: files.map(f => {
          const data = Buffer.from(f.data, 'base64');
          spend(budget, data.length, 'what was added');
          return { path: f.path, data };
        }),
      };
    }
    throw new Error(`${name}: not a zip file or a folder`);
  });
}

// Windows can refuse a rename for a moment while another program (an antivirus, Explorer) has a file open.
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return renameSync(from, to); } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1));
    }
  }
}

// Moves a folder to the Recycle Bin, so a replaced copy can still be restored. True when it is gone from its place.
// Only from a fixed local drive: where there is no Recycle Bin (a USB stick, a network share) Windows would delete it
// for good without asking, so it is left in place instead (false). The path goes in through the environment, never
// inside the command text.
function recycle(dir) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'try { if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:GPML_RECYCLE)).DriveType -ne "Fixed") { exit 3 } } catch { exit 3 }; ' +
    'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:GPML_RECYCLE, 'OnlyErrorDialogs', 'SendToRecycleBin')"],
  { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, GPML_RECYCLE: dir } });
  return r.status === 0 && !existsSync(dir);
}

const folderOf = dir => dir.split(/[\\/]/).pop();
const quietRm = dir => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left for later */ } };

// Installs the mods found in `items` ([{ name, files: [{ path, data }] }], `name` only for messages) into `modsDir`.
// A mod is each shallowest folder holding a mod.json, so a zip of the mod folder, of the files inside it, or of a
// repository with the mod in a sub-folder all work, and a pack of several mods installs together. Returns
// { added: [{ id, name, version, folder, replaced: [old versions], from: [old folders] }], kept }: `kept` is the folder
// holding the replaced copies when they could not go to the Recycle Bin, else null. Throws an Error for the player,
// with mods/ unchanged. `ops.rename` and `ops.discard` are for tests.
export function installMods(items, modsDir, ops = {}) {
  const rename = ops.rename || renameRetry;
  const discard = ops.discard || recycle;
  // 1. Check every path, find the mods, all in memory.
  const roots = [], budget = newBudget();
  items.forEach(item => {
    const seen = new Set(), files = [];
    for (const f of item.files) {
      const p = entryPath(f.path);
      if (p instanceof Error) throw new Error(`${item.name}: ${p.message}`);
      if (seen.has(p.toLowerCase())) throw new Error(`${item.name}: ${p} appears twice`);
      seen.add(p.toLowerCase());
      files.push({ path: p, data: f.data });
    }
    const dirs = files.filter(f => f.path.split('/').pop().toLowerCase() === 'mod.json').map(f => f.path.split('/').slice(0, -1).join('/'));
    const under = (d, root) => root === '' || d.startsWith(`${root}/`);
    const shallow = dirs.filter(d => !dirs.some(o => o !== d && under(d, o)));
    if (!shallow.length) throw new Error(`${item.name}: no mod.json found; this is not a Geoplanetical Mod Loader mod`);
    for (const root of shallow) {
      const own = files.filter(f => under(f.path, root)).map(f => ({ path: root ? f.path.slice(root.length + 1) : f.path, data: f.data }));
      for (const f of own) {
        if (SHELL_FILE.test(f.path)) throw new Error(`${item.name}: ${f.path} is a shortcut or shell file; a mod has no use for one`);
        spend(budget, f.data.length, 'what was added');
      }
      roots.push({ item: item.name, files: own });
    }
  });
  if (roots.length > MAX_MODS) throw new Error(`more than ${MAX_MODS} mods at once`);

  mkdirSync(modsDir, { recursive: true });
  for (const d of readdirSync(modsDir)) if (STAGING_LEFT.test(d)) quietRm(join(modsDir, d)); // an earlier install that stopped
  const staging = join(modsDir, STAGING + randomBytes(6).toString('hex'));
  const replaced = join(modsDir, REPLACED + randomBytes(6).toString('hex'));
  const done = [], moved = []; // what the swap did, undone in reverse on failure
  let plan;
  try {
    // 2. Stage each mod and read it back with the loader's own strict reader.
    roots.forEach((r, k) => {
      const dir = join(staging, String(k));
      for (const f of r.files) {
        const to = resolve(dir, ...f.path.split('/'));
        const rel = relative(dir, to);
        if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error(`${r.item}: ${f.path} leaves the mod folder`);
        try {
          mkdirSync(dirname(to), { recursive: true });
          writeFileSync(to, f.data, { flag: 'wx' });
        } catch (e) {
          throw new Error(`${r.item}: ${f.path} could not be written (${e.code || e.message}); the zip may hold a file and a folder of the same name`);
        }
        if (process.platform === 'win32') {
          try { writeFileSync(`${to}:Zone.Identifier`, ZONE); } catch { /* not NTFS: no mark to keep */ }
        }
      }
    });
    const staged = scanMods(staging);
    if (staged.broken.length) {
      const twice = staged.broken.find(b => b.id && staged.broken.filter(o => o.id === b.id).length > 1);
      if (twice) {
        const from = staged.broken.filter(o => o.id === twice.id).map(o => roots[Number(o.folder)].item);
        throw new Error(`the mod "${twice.id}" is in what was added more than once (${[...new Set(from)].join(', ')}); add one copy`);
      }
      // The loader names files by their full path: show them relative to the mod instead of the work folder.
      const b = staged.broken[0], r = roots[Number(b.folder)], at = join(staging, b.folder);
      throw new Error(`${r.item}: ${b.error.split(at + sep).join('').split(at).join(r.item)}`);
    }

    // 3. Plan: each mod replaces every folder holding the same mod id, and goes in the old folder's place (or a folder
    // named after its id). A folder name already taken by anything else stops the install before any change.
    const now = scanMods(modsDir);
    plan = staged.mods.map(m => {
      const old = [...new Set([...now.mods.filter(o => o.id === m.id).map(o => folderOf(o.dir)), ...now.broken.filter(b => b.id === m.id).map(b => b.folder)])];
      const target = old.length === 1 ? old[0] : m.id;
      if (DEVICE.test(target)) throw new Error(`${m.name}: its id "${m.id}" is a name Windows keeps for devices and cannot be a folder name`);
      if (existsSync(join(modsDir, target)) && !old.some(o => o.toLowerCase() === target.toLowerCase())) {
        throw new Error(`the mods folder already has a folder named "${target}" holding something else: rename or remove it, then add ${m.name} again`);
      }
      return { m, old, target, versions: now.mods.filter(o => o.id === m.id).map(o => o.version) };
    });
    const targets = plan.map(p => p.target.toLowerCase());
    const clash = plan.find(p => targets.filter(t => t === p.target.toLowerCase()).length > 1 ||
      plan.some(q => q !== p && q.old.some(o => o.toLowerCase() === p.target.toLowerCase())));
    if (clash) throw new Error(`two of the mods being added would use the folder "${clash.target}"; add them one at a time`);

    // 4. Swap: old copies aside (each under its own name, for the Recycle Bin), new ones in. Undone in reverse if
    // any step fails.
    mkdirSync(replaced);
    plan.forEach((p, i) => {
      p.old.forEach((o, j) => {
        const to = join(replaced, `${i}-${j}`, o);
        mkdirSync(dirname(to));
        rename(join(modsDir, o), to); moved.push([join(modsDir, o), to]);
      });
      rename(p.m.dir, join(modsDir, p.target)); done.push([p.m.dir, join(modsDir, p.target)]);
    });
  } catch (e) {
    const newLeft = [], oldLeft = [];
    for (const [from, to] of [...done].reverse()) { try { rename(to, from); } catch { newLeft.push(to); } }
    for (const [from, to] of [...moved].reverse()) { try { rename(to, from); } catch { oldLeft.push(to); } }
    quietRm(staging);
    if (!oldLeft.length) quietRm(replaced); // every previous copy is back: only empty work folders remain there
    if (!newLeft.length && !oldLeft.length) throw e;
    throw new Error(`${e.message}. The mods folder could not be put fully back:` +
      (newLeft.length ? ` remove the new copies ${newLeft.join(', ')}` : '') +
      (newLeft.length && oldLeft.length ? ', then' : '') +
      (oldLeft.length ? ` move the previous copies from ${replaced} back into the mods folder` : '') + '.');
  }
  // 5. Done: the replaced copies go to the Recycle Bin. Clean-up never changes the outcome.
  quietRm(staging);
  let kept = null;
  for (const [, to] of moved) if (!discard(to)) kept = replaced;
  if (!kept) quietRm(replaced);
  return {
    added: plan.map(p => ({ id: p.m.id, name: p.m.name, version: p.m.version, folder: p.target, replaced: p.versions, from: p.old })),
    kept,
  };
}
