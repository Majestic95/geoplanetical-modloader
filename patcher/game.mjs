// Game detection shared by the dev launcher (patcher/launch.mjs) and the player launcher (launcher/main.mjs):
// Steam's executable, its libraries, the library holding Geoplanetical, the installed build, whether the game is
// running, and the original bundles read straight from the game's resources/app.asar and the files it keeps beside it
// in app.asar.unpacked (read-only). Detection reads
// only Steam's own records (two registry values, libraryfolders.vdf, the game's appmanifest); no folder is searched.
// A game folder given by the user replaces the library lookup.
// Child processes run with windowsHide so the windowed launcher (launcher/gui.mjs) flashes no console windows.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const APP_ID = '940230';

// Registry string value. Read through PowerShell with UTF-8 output: reg.exe writes the console code page, which garbles
// a Steam folder with non-ASCII letters. reg.exe is the fallback.
function regValue(key, name) {
  const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-ItemProperty -LiteralPath 'Registry::${key}' -Name '${name}' -ErrorAction SilentlyContinue).'${name}'`],
  { encoding: 'utf8', windowsHide: true });
  const v = ps.status === 0 ? ps.stdout.trim() : '';
  if (v) return v;
  const r = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true });
  return r.stdout?.match(new RegExp(`${name}\\s+REG_SZ\\s+(.+)`))?.[1]?.trim() || null;
}

export function steamExe() {
  const exe = regValue('HKCU\\Software\\Valve\\Steam', 'SteamExe');
  return exe && existsSync(exe) ? exe : null;
}

// Steam's own folder (where it keeps its logs and its console downloads), or null.
export function steamPath() {
  const p = regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  return p ? p.replace(/\//g, '\\') : null;
}

// Every Steam library folder: Steam's own folder plus those listed in steamapps/libraryfolders.vdf.
export function steamLibraries() {
  const steamDir = steamPath();
  const roots = new Set(steamDir ? [steamDir] : []);
  roots.add('C:\\Program Files (x86)\\Steam');
  // Keyed case-insensitively: Windows paths, and Steam records the same folder in either case.
  const libs = new Map(), add = p => libs.has(p.toLowerCase()) || libs.set(p.toLowerCase(), p);
  for (const root of roots) {
    const vdf = join(root, 'steamapps', 'libraryfolders.vdf');
    if (!existsSync(vdf)) continue;
    add(join(root, 'steamapps'));
    for (const m of readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) add(join(m[1].replace(/\\\\/g, '\\'), 'steamapps'));
  }
  return [...libs.values()];
}

// From an appmanifest: the installed build, and whether Steam has an update pending or running for the game (a
// different TargetBuildID, or StateFlags other than 4 = fully installed). Steam installs a pending update before it
// starts the game, so a launch then would meet a different build than the one the mods were built for.
function manifestState(acf) {
  const build = acf.match(/"buildid"\s+"(\d+)"/)?.[1] ?? null;
  const target = acf.match(/"TargetBuildID"\s+"(\d+)"/)?.[1] ?? null;
  // StateFlags is a bit mask: 4 fully installed; 2 update required, 256 update running, 512 update paused, 1024 update
  // started, 2048 uninstalling, 4096+ validating/staging. Other bits (e.g. 64, app running) are not an update.
  const flags = Number(acf.match(/"StateFlags"\s+"(\d+)"/)?.[1] ?? 4);
  const busy = !(flags & 4) || (flags & (2 | 256 | 512 | 1024 | 2048 | 4096 | 8192 | 65536 | 131072)) !== 0;
  return { build, updating: Boolean((target && target !== '0' && target !== build) || busy), targetBuild: target };
}

// { steamapps, dir, build, updating, targetBuild } for the installed game, or null. With `gameDir` (the game's own
// folder, the one holding resources\app.asar), only that folder is used; its build comes from the appmanifest two
// levels up (null if there is none: then no mod can be matched to it).
export function findGame(gameDir = null) {
  if (gameDir) {
    if (typeof gameDir !== 'string' || !existsSync(join(gameDir, 'resources', 'app.asar'))) return null;
    const lib = join(gameDir, '..', '..'), manifest = join(lib, `appmanifest_${APP_ID}.acf`);
    const state = existsSync(manifest) ? manifestState(readFileSync(manifest, 'utf8')) : { build: null, updating: false, targetBuild: null };
    return { steamapps: lib, dir: gameDir, ...state };
  }
  for (const lib of steamLibraries()) {
    const manifest = join(lib, `appmanifest_${APP_ID}.acf`);
    if (!existsSync(manifest)) continue;
    const acf = readFileSync(manifest, 'utf8');
    const installdir = acf.match(/"installdir"\s+"([^"]+)"/)?.[1];
    if (!installdir) continue;
    const dir = join(lib, 'common', installdir);
    if (existsSync(join(dir, 'resources', 'app.asar'))) return { steamapps: lib, dir, ...manifestState(acf) };
  }
  return null;
}

export function gameRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Geoplanetical.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('tasklist failed; cannot tell whether the game is running');
  return /Geoplanetical\.exe/i.test(r.stdout);
}

// An asar archive: a pickle header (4-byte size fields), a JSON index, then the file data. { index, base } (base: where
// the file data starts).
// (an index larger than MAX_INDEX is not a game's: refused before it is read, as patcher/frozen.mjs does)
const MAX_INDEX = 64 * 1024 * 1024;
function readIndex(fd) {
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const base = 8 + head.readUInt32LE(4), headerSize = head.readUInt32LE(12);
  if (headerSize > MAX_INDEX) throw new Error('the archive index is too large for a game archive');
  const json = Buffer.alloc(headerSize);
  readSync(fd, json, 0, headerSize, 16);
  return { index: JSON.parse(json.toString('utf8')), base };
}

// The index entry of `innerPath` ('renderer/x.js'), or null when the archive has no such file.
function entryOf(index, innerPath) {
  let node = index;
  for (const part of innerPath.split('/').filter(Boolean)) {
    node = Object.hasOwn(node?.files ?? {}, part) ? node.files[part] : null;
    if (!node) return null;
  }
  return node.files ? null : node;
}

// The index entry of one file of the archive at `asarPath` ({ size, offset } or { size, unpacked }, and integrity), or
// null.
export function asarEntry(asarPath, innerPath) {
  const fd = openSync(asarPath, 'r');
  try { return entryOf(readIndex(fd).index, innerPath); } finally { closeSync(fd); }
}

// Whether `data` is the file the index entry describes: its size, and its SHA-256 when the index records one (the
// game's archives record one for every file). `required`: no record is a mismatch too.
export function matchesEntry(data, entry, required = false) {
  if (data.length !== Number(entry.size)) return false;
  const integrity = entry.integrity;
  if (integrity?.algorithm !== 'SHA256') return !required;
  return createHash('sha256').update(data).digest('hex') === String(integrity.hash).toLowerCase();
}

// Reads a file of an asar archive. A file the archive keeps outside itself (index entry marked "unpacked": game 1.0.9
// and later keep the simulation and its helper workers there) is read from <archive>.unpacked; Electron does not check
// those, so the index must record its SHA-256 and the file must match it.
export function readAsarFile(asarPath, innerPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const { index, base } = readIndex(fd);
    const node = entryOf(index, innerPath);
    if (!node) throw new Error(`${innerPath} is not in ${asarPath}`);
    let data;
    if (node.unpacked) {
      const parts = innerPath.split('/').filter(Boolean);
      if (parts.some(p => p === '.' || p === '..' || /[\\:]/.test(p))) throw new Error(`${innerPath}: not a plain path in the archive`);
      const file = join(`${asarPath}.unpacked`, ...parts);
      if (statSync(file).size !== Number(node.size)) {
        throw new Error(`${innerPath} in ${asarPath}.unpacked does not match the archive's own record of it (a damaged game file)`);
      }
      data = readFileSync(file);
    } else {
      const size = Number(node.size);
      data = Buffer.alloc(size);
      if (readSync(fd, data, 0, size, base + Number(node.offset)) !== size) throw new Error(`${innerPath} is cut short in ${asarPath}`);
    }
    // The index carries each file's SHA-256 (as the game's archives do): the text read must be that file. With the
    // index itself checked (patcher/frozen.mjs), this makes it the pinned build's.
    if (!matchesEntry(data, node, !!node.unpacked)) {
      throw new Error(`${innerPath} in ${asarPath}${node.unpacked ? '.unpacked' : ''} does not match the archive's own record of it (a damaged game file)`);
    }
    return data;
  } finally {
    closeSync(fd);
  }
}

// The renderer bundles a game folder keeps outside its archive (game 1.0.9 and later: the simulation and its helper
// workers, which the game runs in a Node process of its own, out of reach of the loader's DevTools connection). A Set of
// file names; empty when the folder has no readable archive. Kept while the archive's size and time are the same (the
// window asks for it on every refresh).
const outsideCache = new Map();
export function unpackedBundles(gameDir) {
  const asar = join(gameDir, 'resources', 'app.asar');
  let key;
  try { const st = statSync(asar); key = `${st.size}|${st.mtimeMs}`; } catch { return new Set(); }
  const hit = outsideCache.get(asar);
  if (hit?.key === key) return hit.names;
  let names = new Set();
  try {
    const fd = openSync(asar, 'r');
    try {
      const renderer = readIndex(fd).index.files?.renderer?.files ?? {};
      names = new Set(Object.keys(renderer).filter(n => /\.bundle\.js$/.test(n) && !renderer[n].files && renderer[n].unpacked));
    } finally { closeSync(fd); }
  } catch { /* not an archive the loader can read: nothing outside it */ }
  outsideCache.set(asar, { key, names });
  return names;
}

// The original text of a renderer bundle of the installed game.
export function originalBundle(game, bundle) {
  return readAsarFile(join(game.dir, 'resources', 'app.asar'), `renderer/${bundle}`).toString('utf8');
}
