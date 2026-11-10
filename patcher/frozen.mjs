// The frozen game: one build of Geoplanetical (the pin) that this loader release plays from its own copy, outside the
// Steam library, so a Steam update of the installed game does not stop the mods. Each player's copy comes from their
// own Steam account (a copy of their install while it is the pinned build, or Steam's download_depot of the pinned
// manifest: launcher/freeze.mjs); game files are never distributed. The copy is always written by the loader itself
// into its own folder, so it has that folder's permissions (only the player's account), never those of a shared one.
//
// The copy is started directly (startFrozen) instead of through Steam, so everything that runs is checked first
// (checkFolder): the archive's size and JSON index name the build (the index holds a SHA-256 of every file in the
// archive), and one SHA-256 covers every file outside the archive (the exe, its DLLs and data, V8's snapshot files,
// the Steam library). The pinned exe has Electron's asar integrity fuses on (EnableEmbeddedAsarIntegrityValidation,
// OnlyLoadAppFromAsar): it checks the archive against that index itself. The loader's own reads from the archive are
// checked against the index's per-file hashes (patcher/game.mjs readAsarFile). A copy is also hashed in full once,
// right after it is made, so a bad copy is found before play rather than during it.
//
// The copy keeps its own saves and settings (its --user-data-dir): Steam Cloud does not sync them. The first time,
// the saves of the Steam game are copied into it (copySavesOnce).
//
// From game 1.0.9 on, the simulation runs in a Node process of the game's, loaded from files beside the archive
// (resources\app.asar.unpacked). Mods to those files are written into the copy for one session and the originals put
// back afterwards (patcher/copy-bundles.mjs); at rest the copy is the pinned build, and that is what is checked here.
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, realpathSync, lstatSync } from 'node:fs';
import { open, readdir, mkdir, copyFile, rename, rm, stat, statfs, constants } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { APP_ID } from './game.mjs';

// The build this loader release plays. Moving it is a release decision: mods add the new build to `builds`.
export const PIN = Object.freeze({
  build: '26519199',
  version: '1.1.0',
  depot: '940231',
  manifest: '7115452977362333310',
  // resources\app.asar: its size, the SHA-256 of its JSON index (the bytes after the 16-byte header, as long as its
  // offset 12 says), and the SHA-256 of the whole file
  asarSize: 3595466666,
  asarIndexSha256: '6ae538594f745a6140b5cff9f5946278f2c2e4347d02bc1af67972c3d9a1f46d',
  asarSha256: '961553dea82db409991cfb299364189966d3e3b080e9e0ca4e392de591b6a215',
  // every file outside resources\app.asar (111 files, resources\app.asar.unpacked included): their total size, and
  // folderSha256
  folderBytes: 495135922,
  folderSha256: '6d72a2ac39ab1426f538189a892865cc32fce7af1cb4629a380f9007aa1de872',
});

export const GAME_EXE = 'Geoplanetical.exe';
const ASAR = join('resources', 'app.asar');
// (an archive index larger than this is not a game's: refused before the read, as a picked folder could name any size)
const MAX_INDEX = 64 * 1024 * 1024;
// (the pinned build has 111 files and a few dozen folders outside the archive; a folder with far more is not a game's)
export const MAX_ENTRIES = 5000;
// Chromium may write a debug.log beside the exe; it is not part of the build.
const SKIP = new Set(['resources/app.asar', 'debug.log']);

// The loader's own folder for the copy (the window's Edge profile lives there too): null if Windows does not say.
export const FROZEN_ROOT = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'GeoplaneticalModLauncher') : null;
// game: the copy; data: its user-data-dir (saves in data\saves); staging: a copy being made (never started); old: the
// copy being replaced (removed right after); notes: where code the loader wrote into the copy says it started
// (patcher/copy-bundles.mjs).
export function frozenPlaces(root = FROZEN_ROOT) {
  if (!root) return null;
  return {
    root, game: join(root, 'game'), data: join(root, 'game-data'), staging: join(root, 'game.new'), old: join(root, 'game.old'),
    notes: join(root, 'session-notes.txt'),
  };
}
// The saves of the Steam game (the game's userData is %APPDATA%\Geoplanetical; saves in its saves folder).
export const STEAM_SAVES = process.env.APPDATA ? join(process.env.APPDATA, 'Geoplanetical', 'saves') : null;

// A file error for the player's eyes: the system's code (ENOENT, EACCES, ...). Its own message names the full path,
// and with it the Windows user name.
export const errorCode = e => (e?.code ? String(e.code) : 'unknown error');
const coded = (message, code) => Object.assign(new Error(message), { code });

const sha256 = b => createHash('sha256').update(b).digest('hex');
export const onLocalDrive = p => typeof p === 'string' && /^[A-Za-z]:\\/.test(p);

export async function asarIndexSha256(dir) {
  const fh = await open(join(dir, ASAR), 'r');
  try {
    const head = Buffer.alloc(16);
    if ((await fh.read(head, 0, 16, 0)).bytesRead !== 16) throw coded('app.asar is too short', 'SHORT');
    const size = head.readUInt32LE(12);
    if (size > MAX_INDEX) throw coded('app.asar index is too large', 'TOO_LARGE');
    const index = Buffer.alloc(size);
    if ((await fh.read(index, 0, size, 16)).bytesRead !== size) throw coded('app.asar index is cut short', 'SHORT');
    return sha256(index);
  } finally {
    await fh.close();
  }
}

// Every file of `dir` as a path relative to it with '/', sorted. A link or junction anywhere throws LINK (it could
// lead past the drive check), unless `skipLinks` (then it is left out); more than `max` files and folders throws
// TOO_MANY. `skip`: relative paths left out.
export async function listFiles(dir, { skip = new Set(), skipLinks = false, max = MAX_ENTRIES } = {}) {
  const out = [];
  let entries = 0;
  const walk = async d => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (++entries > max) throw coded('the folder holds too many files', 'TOO_MANY');
      const full = join(d, e.name);
      if (e.isSymbolicLink() || (!e.isDirectory() && !e.isFile())) {
        if (skipLinks) continue;
        throw coded('the folder holds a link', 'LINK');
      }
      if (e.isDirectory()) await walk(full);
      else {
        const rel = relative(dir, full).split(sep).join('/');
        if (!skip.has(rel)) out.push(rel);
      }
    }
  };
  await walk(dir);
  return out.sort();
}

// SHA-256 of a whole file, read in pieces; onBytes(n) after each; stops with an AbortError through `signal`.
export function fileSha256(path, onBytes = () => {}, signal) {
  return new Promise((done, fail) => {
    const h = createHash('sha256');
    createReadStream(path, { highWaterMark: 8 << 20, signal })
      .on('data', d => { h.update(d); onBytes(d.length); })
      .on('error', fail)
      .on('end', () => done(h.digest('hex')));
  });
}

// Every file outside the archive (debug.log left out) with its size: { files, bytes }.
async function outsideFiles(dir) {
  const files = await listFiles(dir, { skip: SKIP });
  let bytes = 0;
  for (const f of files) bytes += (await stat(join(dir, ...f.split('/')))).size;
  return { files, bytes };
}

// SHA-256 over the sorted lines `<path> <sha256>` of every file outside the archive (debug.log left out), joined with
// '\n': a file added, removed or changed changes it.
export async function folderSha256(dir, { files, signal } = {}) {
  const lines = [];
  for (const f of files ?? (await outsideFiles(dir)).files) lines.push(`${f} ${await fileSha256(join(dir, ...f.split('/')), undefined, signal)}`);
  return sha256(lines.join('\n'));
}

// Whether `dir` holds the pinned build, unchanged: { ok: true, dir } (dir: the folder as it really is on disk, the
// path to start it from) or { ok: false, reason, code? }.
//   reason: 'place' (not on a drive of this PC), 'missing' (no game there), 'build' (another build), 'changed'
//   (a file changed, missing or added), 'link', 'unreadable' (code: the system's error code)
// Sizes are compared before anything is hashed, so a folder that is not the build costs little to refuse. `full` also
// hashes the whole archive (9 s or so; onBytes(n) reports progress). `signal` stops the hashing (AbortError).
export async function checkFolder(dir, { pin = PIN, full = false, onBytes, signal } = {}) {
  if (!onLocalDrive(dir)) return { ok: false, reason: 'place' };
  let real;
  try {
    // (the folder itself must not be a link or junction either: the files are checked through it)
    if (lstatSync(dir).isSymbolicLink()) return { ok: false, reason: 'link' };
    real = realpathSync.native(dir);
  } catch (e) { return e.code === 'ENOENT' ? { ok: false, reason: 'missing' } : { ok: false, reason: 'unreadable', code: errorCode(e) }; }
  if (!onLocalDrive(real)) return { ok: false, reason: 'place' };
  if (!existsSync(join(real, GAME_EXE)) || !existsSync(join(real, ASAR))) return { ok: false, reason: 'missing' };
  try {
    if ((await stat(join(real, ASAR))).size !== pin.asarSize || await asarIndexSha256(real) !== pin.asarIndexSha256) return { ok: false, reason: 'build' };
    const outside = await outsideFiles(real);
    if (outside.bytes !== pin.folderBytes || await folderSha256(real, { files: outside.files, signal }) !== pin.folderSha256) return { ok: false, reason: 'changed' };
    if (full && await fileSha256(join(real, ASAR), onBytes, signal) !== pin.asarSha256) return { ok: false, reason: 'changed' };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    if (e.code === 'LINK') return { ok: false, reason: 'link' };
    if (e.code === 'TOO_MANY' || e.code === 'TOO_LARGE' || e.code === 'SHORT') return { ok: false, reason: 'build' };
    return { ok: false, reason: 'unreadable', code: errorCode(e) };
  }
  return { ok: true, dir: real };
}

// What a failed check means, for the player.
export function checkProblem(r, what = 'The folder') {
  switch (r.reason) {
    case 'place': return `${what} is not on a drive of this PC.`;
    case 'missing': return `${what} does not hold the game (no ${GAME_EXE} and resources\\app.asar).`;
    case 'build': return `${what} holds another game version, not build ${PIN.build} (game ${PIN.version}).`;
    case 'changed': return `${what} holds build ${PIN.build}, but a file in it is changed, missing or added.`;
    case 'link': return `${what} is, or holds, a link or junction; copy the files themselves.`;
    default: return `${what} could not be read (${r.code || 'unknown error'}).`;
  }
}

// Bytes free on the drive holding `dir` (an existing folder), or null if Windows does not say.
export async function freeBytes(dir) {
  try { const s = await statfs(dir); return s.bavail * s.bsize; } catch { return null; }
}

// Whether Steam runs (a game started outside Steam needs it, or it would run without the player's account).
export function steamRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('tasklist failed; cannot tell whether Steam is running');
  return /^"steam\.exe","\d+"/im.test(r.stdout);
}

// The environment the frozen game starts with: the loader's, without ELECTRON_* and NODE_* (run-as-Node, Node options,
// module paths, TLS checks), GEO_* (the game's developer switches) and SSLKEYLOGFILE (Chromium writes its TLS keys
// there), and with the Steam ids set once (Windows names ignore case: a second spelling would leave the choice to the
// system). With SteamAppId set, the game's own Steam check (electron/steam.js restartAppIfNecessary) does not hand it
// back to Steam.
export function frozenEnv(env = process.env) {
  const keep = Object.entries(env).filter(([k]) => !/^(ELECTRON_|NODE_|GEO_)|^(SSLKEYLOGFILE|STEAMAPPID|STEAMGAMEID)$/i.test(k));
  return { ...Object.fromEntries(keep), SteamAppId: APP_ID, SteamGameId: APP_ID };
}

// Starts the copy's exe with the loader's debug port and its own data folder, detached (as through Steam). `dir` is
// the folder checkFolder has just passed, as it returned it (nothing slow may run between the two), and Steam runs.
// onError(e) if Windows cannot start it.
export function startFrozen({ dir, dataDir, port, onError }) {
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${dataDir}`];
  const child = spawn(join(dir, GAME_EXE), args, { detached: true, stdio: 'ignore', cwd: dir, env: frozenEnv() });
  child.on('error', onError);
  child.unref();
  return args;
}

// Before the first start of the frozen copy: copies the Steam game's saves into its own saves folder, once. Nothing
// happens when that folder exists (the copy was made before, or the player has played it). The Steam saves are only
// read; nothing is overwritten (the copy goes to saves.partial, renamed to saves when complete); Steam's
// steam_autocloud.vdf marker and any link are left out. No Steam saves: an empty saves folder is made, so the copy
// still happens only once. Resolves { already } or { files, bytes }; throws (with the system's code) on failure,
// leaving no saves folder, so the next start tries again.
export async function copySavesOnce(dataDir, { source = STEAM_SAVES, onBytes = () => {} } = {}) {
  const dest = join(dataDir, 'saves'), partial = join(dataDir, 'saves.partial');
  if (existsSync(dest)) return { already: true };
  await mkdir(dataDir, { recursive: true });
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial);
  let files = [];
  if (source && existsSync(source)) {
    files = (await listFiles(source, { skipLinks: true, max: 200000 })).filter(f => f.toLowerCase() !== 'steam_autocloud.vdf');
    let total = 0;
    for (const f of files) total += (await stat(join(source, ...f.split('/')))).size;
    const free = await freeBytes(dataDir);
    if (free !== null && free < total + 256 * 1024 * 1024) throw coded('not enough free space for the saves', 'ENOSPC');
  }
  let bytes = 0;
  for (const f of files) {
    const to = join(partial, ...f.split('/'));
    await mkdir(join(to, '..'), { recursive: true });
    await copyFile(join(source, ...f.split('/')), to, constants.COPYFILE_EXCL);
    const n = (await stat(to)).size;
    bytes += n; onBytes(n);
  }
  await rename(partial, dest);
  return { files: files.length, bytes };
}

// Whether `inner` is `outer` or inside it (both resolved; Windows paths compare without case).
export function within(outer, inner) {
  const r = relative(resolve(outer).toLowerCase(), resolve(inner).toLowerCase());
  return r === '' || (!r.startsWith('..') && !r.includes(':'));
}
