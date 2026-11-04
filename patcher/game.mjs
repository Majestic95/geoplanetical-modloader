// Game detection shared by the dev launcher (patcher/launch.mjs) and the player launcher (launcher/main.mjs):
// Steam's executable, its libraries, the library holding Geoplanetical, the installed build, whether the game is
// running, and the original bundles read straight from the game's resources/app.asar (read-only). Detection reads
// only Steam's own records (two registry values, libraryfolders.vdf, the game's appmanifest); no folder is searched.
// A game folder given by the user replaces the library lookup.
// Child processes run with windowsHide so the windowed launcher (launcher/gui.mjs) flashes no console windows.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
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

// Reads files out of an asar archive: a pickle header (4-byte size fields), a JSON index, then the file data.
export function readAsarFile(asarPath, innerPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const base = 8 + head.readUInt32LE(4), headerSize = head.readUInt32LE(12);
    const json = Buffer.alloc(headerSize);
    readSync(fd, json, 0, headerSize, 16);
    let node = JSON.parse(json.toString('utf8'));
    for (const part of innerPath.split('/').filter(Boolean)) {
      node = node?.files?.[part];
      if (!node) throw new Error(`${innerPath} is not in ${asarPath}`);
    }
    if (node.unpacked) throw new Error(`${innerPath} is unpacked outside the archive; not supported`);
    const size = Number(node.size), data = Buffer.alloc(size);
    if (readSync(fd, data, 0, size, base + Number(node.offset)) !== size) throw new Error(`${innerPath} is cut short in ${asarPath}`);
    // The index carries each file's SHA-256 (as the game's archives do): the text read must be that file. With the
    // index itself checked (patcher/frozen.mjs), this makes it the pinned build's.
    const integrity = node.integrity;
    if (integrity?.algorithm === 'SHA256' && createHash('sha256').update(data).digest('hex') !== integrity.hash) {
      throw new Error(`${innerPath} in ${asarPath} does not match the archive's own record of it (a damaged game file)`);
    }
    return data;
  } finally {
    closeSync(fd);
  }
}

// The original text of a renderer bundle of the installed game.
export function originalBundle(game, bundle) {
  return readAsarFile(join(game.dir, 'resources', 'app.asar'), `renderer/${bundle}`).toString('utf8');
}
