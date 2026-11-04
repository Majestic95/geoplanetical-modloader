// Getting the frozen copy (patcher/frozen.mjs) into the loader's own folder, in one of three ways. Each one copies the
// game's files into game.new (so the copy is written by the loader, with its folder's permissions), checks that copy in
// full, and installs it:
//   - copyIn from the Steam game while it is the pinned build, or from a folder the player picks (their own copy of
//     that build); the source is only read;
//   - steamDownload: the player pastes `download_depot` in Steam's console (the loader puts it on the clipboard and
//     opens the console); Steam writes the build to its own folder (<Steam>\steamapps\content\app_940230\depot_940231,
//     whatever library the game is in) and logs `Depot download complete : "<folder>" (manifest <id>)` in
//     logs\console_log.txt; the loader then copies it in (takeDownload) and removes Steam's folder once the copy is in
//     place. (Steam's folder is not moved: it would keep the shared permissions of Steam's own folder.)
// There is one copy: a new one replaces the old once it is checked (install). A copy being made lives in game.new and
// is never started; an interrupted install is repaired when the loader opens (repairPlaces).
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, open } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { PIN, checkFolder, checkProblem, listFiles, freeBytes, errorCode, within } from '../patcher/frozen.mjs';
import { APP_ID, gameRunning } from '../patcher/game.mjs';

// An error whose message is for the player as it is.
const said = (message, extra = {}) => Object.assign(new Error(message), { said: true, ...extra });
export const isAbort = e => e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
// Room kept free beside a copy (the game writes its cache and logs, Windows needs some too).
const SPARE = 512 * 1024 * 1024;
// How long the loader waits for Steam's download before it gives up.
export const DOWNLOAD_MS = 4 * 60 * 60 * 1000;

const wait = (ms, signal) => new Promise((done, fail) => {
  if (signal?.aborted) return fail(signal.reason);
  const t = setTimeout(() => { signal?.removeEventListener('abort', stop); done(); }, ms);
  const stop = () => { clearTimeout(t); fail(signal.reason); };
  signal?.addEventListener('abort', stop, { once: true });
});
// A rename or removal Windows refuses for a moment (an antivirus scan or the search indexer holding a file of a
// freshly written folder) is tried again a few times.
async function patiently(step) {
  for (let i = 0; ; i++) {
    try { return await step(); } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw e;
      await wait(500 * (i + 1));
    }
  }
}

// When the loader opens, before anything else: an install cut short between its two renames leaves game.old and no
// game (renamed back); a copy being made (game.new) is removed: it was never installed; a replaced copy (game.old
// beside game) is removed.
export async function repairPlaces(places, log = () => {}) {
  if (!existsSync(places.game) && existsSync(places.old)) {
    await rename(places.old, places.game);
    log('the frozen copy\'s last replacement was interrupted: the previous copy is back in place');
  }
  for (const p of [places.staging, places.old]) {
    if (!existsSync(p)) continue;
    try { await rm(p, { recursive: true, force: true }); } catch (e) { log(`could not remove the frozen game's ${p === places.old ? 'previous copy' : 'unfinished copy'} (${errorCode(e)}); it is removed next time`); }
  }
}

// The copy's state: { status: 'ready' } or { status: 'missing' | 'other' | 'broken' | 'unreadable', problem }.
// 'other': a copy of another build (an earlier pin): the next copy replaces it.
export async function frozenStatus(places, pin = PIN) {
  if (!existsSync(places.game)) return { status: 'missing', problem: 'The frozen game is not set up yet.' };
  const r = await checkFolder(places.game, { pin });
  if (r.ok) return { status: 'ready' };
  if (r.reason === 'build') return { status: 'other', problem: `The frozen game is an older game version; this loader plays build ${pin.build} (game ${pin.version}). Get the new one: it replaces the old copy.` };
  if (r.reason === 'unreadable') return { status: 'unreadable', problem: `The frozen game could not be read just now (${r.code}). Click Refresh to check it again; get it again only if this stays.` };
  return { status: 'broken', problem: `${checkProblem(r, 'The frozen game')} Get it again.` };
}

// Makes staging the copy: a replaced copy left from before is removed, the copy (if any) goes to game.old, staging to
// game, then game.old is removed. Refused while the game runs (the copy may be in use). A failure between the two
// renames puts the old copy back. `inUse` is for tests.
export async function install(places, { log = () => {}, inUse = gameRunning } = {}) {
  if (!existsSync(places.staging)) throw said('The new frozen game is not there to put in place.');
  if (inUse()) throw said('Geoplanetical is running. Close it, then get the frozen game again.');
  const hadOld = existsSync(places.game);
  if (hadOld && existsSync(places.old)) {
    try { await patiently(() => rm(places.old, { recursive: true, force: true })); } catch (e) {
      throw said(`An earlier frozen game could not be removed (${errorCode(e)}). Close any window showing its folder, then try again.`);
    }
  }
  if (hadOld) {
    try { await patiently(() => rename(places.game, places.old)); } catch (e) {
      throw said(`The old frozen game could not be replaced (${errorCode(e)}): it may be in use. Close the game and any window showing its folder, then try again.`);
    }
  }
  try { await patiently(() => rename(places.staging, places.game)); } catch (e) {
    if (hadOld && !existsSync(places.game)) await rename(places.old, places.game).catch(() => {});
    throw said(`The new frozen game could not be put in place (${errorCode(e)}). Try again.`);
  }
  if (hadOld) {
    try { await patiently(() => rm(places.old, { recursive: true, force: true })); log('the previous frozen copy was replaced and removed'); } catch (e) {
      log(`the previous frozen copy could not be removed yet (${errorCode(e)}); it is removed when the loader next opens`);
    }
  }
}

// Copies every file of `src` (the game folder, archive included) into staging. onProgress({ step: 'copying', done,
// total }) in bytes. Throws said() errors for the player; staging is removed on any failure.
async function copyFolder(src, places, { onProgress = () => {}, signal } = {}) {
  let files, total = 0;
  try {
    files = (await listFiles(src)).filter(f => f !== 'debug.log');
    for (const f of files) total += (await stat(join(src, ...f.split('/')))).size;
  } catch (e) {
    throw said(e.code === 'LINK' ? checkProblem({ reason: 'link' }, 'That folder') : `That folder could not be read (${errorCode(e)}).`);
  }
  try {
    await mkdir(places.root, { recursive: true });
    await patiently(() => rm(places.staging, { recursive: true, force: true }));
  } catch (e) {
    throw said(`The loader's folder for the frozen game could not be prepared (${errorCode(e)}).`);
  }
  const free = await freeBytes(places.root);
  if (free !== null && free < total + SPARE) {
    throw said(`Not enough free space for the frozen game: it needs ${gb(total + SPARE)} GB on the drive of ${places.root}, and ${gb(free)} GB are free.`);
  }
  let done = 0;
  try {
    for (const f of files) {
      signal?.throwIfAborted();
      const to = join(places.staging, ...f.split('/'));
      await mkdir(join(to, '..'), { recursive: true });
      const count = new Transform({ transform(chunk, _, next) { done += chunk.length; onProgress({ step: 'copying', done, total }); next(null, chunk); } });
      await pipeline(createReadStream(join(src, ...f.split('/')), { highWaterMark: 8 << 20 }), count, createWriteStream(to, { flags: 'wx' }), { signal });
    }
  } catch (e) {
    await patiently(() => rm(places.staging, { recursive: true, force: true })).catch(() => {});
    if (isAbort(e)) throw e;
    throw said(`The game files could not be copied (${errorCode(e)}). Nothing was changed.`);
  }
}
const gb = n => (n / 1024 ** 3).toFixed(1);

// Full check of staging (every file, the whole archive), then install. Staging is removed if it fails or is
// cancelled; a cancel is honoured up to the install itself.
async function checkAndInstall(places, { pin = PIN, onProgress = () => {}, signal, log, inUse } = {}) {
  let total = 0, done = 0, r;
  try { total = (await stat(join(places.staging, 'resources', 'app.asar'))).size; } catch { /* checkFolder says what is missing */ }
  try {
    r = await checkFolder(places.staging, { pin, full: true, signal, onBytes: n => { done += n; onProgress({ step: 'checking', done, total }); } });
    signal?.throwIfAborted();
  } catch (e) {
    await rm(places.staging, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  if (!r.ok) {
    await rm(places.staging, { recursive: true, force: true }).catch(() => {});
    throw said(`${checkProblem(r, 'The copy')} Nothing was changed; try again.`);
  }
  await install(places, { log, inUse });
}

// Copies the pinned build from `src` (the Steam game, or a folder the player picked) and makes it the frozen copy.
// The source is checked first (its sizes, its archive index and every file outside the archive), only read, and the
// copy is checked again in full before it is used.
export async function copyIn(src, places, { pin = PIN, onProgress = () => {}, signal, log = () => {}, what = 'That folder', inUse } = {}) {
  onProgress({ step: 'checking-source', done: 0, total: 0 });
  if (within(places.root, src)) throw said(`${what} is the loader's own folder for the frozen game; choose another one.`);
  const r = await checkFolder(src, { pin, signal });
  if (!r.ok) throw said(checkProblem(r, what));
  if (within(places.root, r.dir)) throw said(`${what} is the loader's own folder for the frozen game; choose another one.`);
  await copyFolder(r.dir, places, { onProgress, signal });
  await checkAndInstall(places, { pin, onProgress, signal, log, inUse });
}

// --- Steam's download_depot ---

export const downloadCommand = (pin = PIN) => `download_depot ${APP_ID} ${pin.depot} ${pin.manifest}`;
export const downloadFolder = (steamDir, pin = PIN) => join(steamDir, 'steamapps', 'content', `app_${APP_ID}`, `depot_${pin.depot}`);
export const steamConsoleLog = steamDir => join(steamDir, 'logs', 'console_log.txt');

// What Steam added to its console log since `offset` (whole lines only): { offset, started, done }. started: { files,
// mb } once Steam says it downloads the pinned depot; done: Steam says the pinned manifest's download is complete. A
// log shorter than `offset` was started again (Steam restarted): it is read from the start. Offsets count bytes.
const LOG_PIECE = 4 * 1024 * 1024;
export async function readDownloadLog(file, offset, pin = PIN) {
  let fh;
  try { fh = await open(file, 'r'); } catch { return { offset, started: null, done: false }; }
  try {
    const { size } = await fh.stat();
    if (size < offset) offset = 0;
    const length = Math.min(size - offset, LOG_PIECE);
    const buf = Buffer.alloc(length);
    if (length) await fh.read(buf, 0, length, offset);
    let end = buf.lastIndexOf(0x0a) + 1;
    // (a line longer than a whole piece is skipped rather than waited for)
    if (!end && length === LOG_PIECE) end = length;
    let started = null, done = false;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      const s = line.match(/Downloading depot (\d+) \((\d+) files, (\d+) MB\)/);
      if (s && s[1] === pin.depot) started = { files: Number(s[2]), mb: Number(s[3]) };
      const d = line.match(/Depot download complete : "[^"]*" \(manifest (\d+)\)/);
      if (d && d[1] === pin.manifest) done = true;
    }
    return { offset: offset + end, started, done };
  } finally {
    await fh.close();
  }
}

// Size of a file, 0 if it is not there.
export const sizeOf = async file => { try { return (await stat(file)).size; } catch { return 0; } };

// Puts `text` on the clipboard (clip.exe reads it from its input). Resolves true when done.
export function toClipboard(text) {
  return new Promise(done => {
    const child = spawn('clip', [], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

// Opens Steam's console (Steam must be running: the URL starts it otherwise, and its console then opens once signed in).
export function openSteamConsole(steam, log = () => {}) {
  spawn(steam, ['steam://open/console'], { detached: true, stdio: 'ignore' })
    .on('error', e => log(`Steam's console could not be opened (${errorCode(e)})`)).unref();
}

// Copies Steam's finished download in (checked in full first), installs it, then removes Steam's folder (Windows
// allowing). With `quiet`, a download that is not complete yet resolves null instead of throwing (the folder is
// looked at while Steam may still be writing it).
export async function takeDownload(src, places, { pin = PIN, onProgress = () => {}, signal, log = () => {}, quiet = false, inUse } = {}) {
  let total = 0, done = 0;
  try { total = (await stat(join(src, 'resources', 'app.asar'))).size; } catch { /* checkFolder says what is missing */ }
  const r = await checkFolder(src, { pin, full: true, signal, onBytes: n => { done += n; onProgress({ step: 'checking-download', done, total }); } });
  if (!r.ok) {
    if (quiet) return null;
    throw said(`${checkProblem(r, 'Steam\'s download')} Run the download again.`);
  }
  await copyFolder(r.dir, places, { onProgress, signal });
  await checkAndInstall(places, { pin, onProgress, signal, log, inUse });
  try { await patiently(() => rm(r.dir, { recursive: true, force: true })); return { left: null }; } catch (e) {
    log(`Steam's download folder could not be removed (${errorCode(e)}); you can delete it: ${src}`);
    return { left: src };
  }
}

// The whole download. If Steam's download folder already holds the complete pinned build it is taken at once;
// otherwise the command goes on the clipboard, Steam's console opens, and the log is watched until Steam says the
// download is complete (the folder is also looked at now and then, in case the log says nothing; a folder Steam is
// still writing is waited for). onStatus({ step, ... }): 'waiting' (the player pastes the command), 'downloading'
// ({ mb }), then the copy's steps. Ends with the copy in place, or throws (an AbortError when cancelled through
// `signal`; a said() error after DOWNLOAD_MS).
export async function steamDownload({ steam, steamDir, places, pin = PIN, onStatus = () => {}, signal, log = () => {}, pollMs = 2000, folderEveryMs = 30000, timeoutMs = DOWNLOAD_MS, inUse }) {
  const folder = downloadFolder(steamDir, pin), logFile = steamConsoleLog(steamDir);
  const take = quiet => takeDownload(folder, places, { pin, onProgress: onStatus, signal, log, quiet, inUse });
  if (existsSync(folder) && (await checkFolder(folder, { pin, signal })).ok) {
    log(`Steam's download folder already holds build ${pin.build}; checking it`);
    const taken = await take(true);
    if (taken) return taken;
    log('it is not complete; asking Steam for it again');
  }
  let offset = await sizeOf(logFile);
  const copied = await toClipboard(downloadCommand(pin));
  openSteamConsole(steam, log);
  log(`asked for Steam's download: ${downloadCommand(pin)} (${copied ? 'on the clipboard' : 'the clipboard could not be set'})`);
  onStatus({ step: 'waiting', command: downloadCommand(pin), clipboard: copied });
  const until = Date.now() + timeoutMs;
  let lastFolderLook = Date.now(), started = null, unfinished = false;
  for (;;) {
    if (Date.now() > until) throw said(`Steam's download did not finish within ${timeoutMs / 3600000} hours. Try again.`);
    await wait(pollMs, signal);
    const seen = await readDownloadLog(logFile, offset, pin);
    offset = seen.offset;
    if (seen.started && !started) { started = seen.started; log(`Steam is downloading build ${pin.build} (${started.mb} MB)`); onStatus({ step: 'downloading', mb: started.mb }); }
    if (seen.done) {
      log('Steam finished the download');
      return take(false);
    }
    // (once a look found the folder unfinished, only Steam's log line counts: hashing it again and again would compete
    // with Steam's own writing)
    if (!unfinished && Date.now() - lastFolderLook > folderEveryMs && existsSync(folder)) {
      if ((await checkFolder(folder, { pin, signal })).ok) {
        const taken = await take(true);
        if (taken) { log('Steam\'s download is complete'); return taken; }
        unfinished = true;
        onStatus({ step: started ? 'downloading' : 'waiting', mb: started?.mb, command: downloadCommand(pin), clipboard: copied });
      }
      lastFolderLook = Date.now();
    }
  }
}
