// Checks for the frozen game (patcher/frozen.mjs, launcher/freeze.mjs, the frozen parts of launcher/core.mjs) on small
// fake game folders: the folder check and what it refuses, the copy and its replacement of an older copy, repair of an
// interrupted replacement, the one-time saves copy, reading Steam's console log, taking a finished download, the
// environment the game starts with, and what a program is given. Nothing is started and Steam is not touched.
// Usage: node launcher/test-frozen.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PIN, checkFolder, asarIndexSha256, folderSha256, fileSha256, frozenEnv, frozenPlaces, copySavesOnce, listFiles,
} from '../patcher/frozen.mjs';
import { readAsarFile } from '../patcher/game.mjs';
import { repairPlaces, frozenStatus, copyIn, install, readDownloadLog, takeDownload, steamDownload, downloadCommand, downloadFolder } from './freeze.mjs';
import { playChoice, frozenGame, chosenGame, launchBlocker, programRefusal, programArgs, noModsMessage, FROZEN_NOT_READY } from './core.mjs';

let failed = 0;
async function expect(name, fn, check) {
  let r;
  try { r = await fn(); } catch (e) { r = { threw: e.message, said: !!e.said, name: e.name }; }
  if (check(r)) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}: unexpected result ${JSON.stringify(r)?.slice(0, 300)}`); }
}
const sha = b => createHash('sha256').update(b).digest('hex');
const no = () => false;

// A fake game folder: an exe, a few files outside the archive, and an app.asar laid out as the game's is (16-byte
// pickle header, JSON index, data). `tag` changes the index (another build); `data` changes the archive's bytes only.
function makeGame(dir, { tag = 'b1', data = 'console.log(1)' } = {}) {
  mkdirSync(join(dir, 'resources', 'app.asar.unpacked', 'mod'), { recursive: true });
  mkdirSync(join(dir, 'locales'), { recursive: true });
  writeFileSync(join(dir, 'Geoplanetical.exe'), 'MZ fake exe');
  writeFileSync(join(dir, 'ffmpeg.dll'), 'dll');
  writeFileSync(join(dir, 'locales', 'en-US.pak'), 'pak');
  writeFileSync(join(dir, 'resources', 'app.asar.unpacked', 'mod', 'steam.node'), 'node');
  const body = Buffer.from(data);
  const index = Buffer.from(JSON.stringify({ tag, files: { renderer: { files: { 'a.js': { size: body.length, offset: '0' } } } } }));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0); head.writeUInt32LE(index.length + 8, 4); head.writeUInt32LE(index.length + 4, 8); head.writeUInt32LE(index.length, 12);
  writeFileSync(join(dir, 'resources', 'app.asar'), Buffer.concat([head, index, body]));
  return dir;
}
async function pinOf(dir, build = PIN.build) {
  const sizes = (await listFiles(dir)).filter(f => f !== 'resources/app.asar').reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  return {
    ...PIN, build, asarSize: statSync(join(dir, 'resources', 'app.asar')).size, asarIndexSha256: await asarIndexSha256(dir),
    folderBytes: sizes, folderSha256: await folderSha256(dir), asarSha256: await fileSha256(join(dir, 'resources', 'app.asar')),
  };
}
const tree = dir => listFiles(dir).then(fs => fs.map(f => `${f} ${sha(readFileSync(join(dir, f)))}`).join('\n'));

const root = mkdtempSync(join(tmpdir(), 'gpml-frozen-'));
try {
  const src = makeGame(join(root, 'src'));
  const pin = await pinOf(src);

  // The folder hash: the sorted lines "<path> <sha256>" of every file outside the archive, joined with \n.
  await expect('folder hash: the documented lines, archive and debug.log left out', async () => {
    writeFileSync(join(src, 'debug.log'), 'x');
    const files = ['Geoplanetical.exe', 'ffmpeg.dll', 'locales/en-US.pak', 'resources/app.asar.unpacked/mod/steam.node'];
    const want = sha(files.map(f => `${f} ${sha(readFileSync(join(src, f)))}`).join('\n'));
    const got = await folderSha256(src);
    rmSync(join(src, 'debug.log'));
    return got === want && got === pin.folderSha256;
  }, r => r === true);
  await expect('check: the pinned folder passes, quick and full', async () => [await checkFolder(src, { pin }), await checkFolder(src, { pin, full: true })],
    r => r.every(x => x.ok));
  await expect('check: the real pin does not match a fake folder (another build)', () => checkFolder(src), r => !r.ok && r.reason === 'build');

  const mutate = async (name, change, undo, reason, opts = {}) => expect(`check: ${name}`, async () => {
    change();
    try { return await checkFolder(src, { pin, ...opts }); } finally { undo(); }
  }, r => !r.ok && r.reason === reason);
  await mutate('a changed DLL is refused', () => writeFileSync(join(src, 'ffmpeg.dll'), 'evil'), () => writeFileSync(join(src, 'ffmpeg.dll'), 'dll'), 'changed');
  await mutate('an added DLL is refused', () => writeFileSync(join(src, 'version.dll'), 'x'), () => rmSync(join(src, 'version.dll')), 'changed');
  await mutate('a missing file is refused', () => rmSync(join(src, 'locales', 'en-US.pak')), () => writeFileSync(join(src, 'locales', 'en-US.pak'), 'pak'), 'changed');
  const asar = join(src, 'resources', 'app.asar'), asarBytes = readFileSync(asar);
  await mutate('archive bytes changed under the same index: refused by the full check', () => { const b = Buffer.from(asarBytes); b[b.length - 1] ^= 1; writeFileSync(asar, b); },
    () => writeFileSync(asar, asarBytes), 'changed', { full: true });
  await expect('check: archive bytes changed under the same index pass the quick check (the game itself checks its archive)', async () => {
    const b = Buffer.from(asarBytes); b[b.length - 1] ^= 1; writeFileSync(asar, b);
    try { return await checkFolder(src, { pin }); } finally { writeFileSync(asar, asarBytes); }
  }, r => r.ok);
  await mutate('an index claiming 4 GB is refused before it is read', () => { const b = Buffer.from(asarBytes); b.writeUInt32LE(0xffffffff, 12); writeFileSync(asar, b); },
    () => writeFileSync(asar, asarBytes), 'build');
  await mutate('a junction inside the folder is refused', () => symlinkSync(join(root), join(src, 'locales', 'link'), 'junction'),
    () => rmSync(join(src, 'locales', 'link'), { recursive: false, force: true }), 'link');
  await expect('check: a relative path, a network path and a missing folder', async () => [
    await checkFolder('src', { pin }), await checkFolder('\\\\server\\share\\game', { pin }), await checkFolder(join(root, 'nope'), { pin }),
  ], r => r[0].reason === 'place' && r[1].reason === 'place' && r[2].reason === 'missing');

  // The environment the frozen game starts with.
  await expect('env: Electron, Node, the game\'s switches and the TLS key log are removed; Steam ids set once', () => frozenEnv({
    Path: 'p', NODE_OPTIONS: '--require x', node_path: 'y', ELECTRON_RUN_AS_NODE: '1', GEO_DEV: '1', SSLKEYLOGFILE: 'k', steamappid: '1', SteamGameId: '2', GPML_X: 'z',
  }), r => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['GPML_X', 'Path', 'SteamAppId', 'SteamGameId']) && r.SteamAppId === '940230' && r.SteamGameId === '940230');

  // Getting the copy.
  const places = frozenPlaces(join(root, 'loader'));
  const before = await tree(src);
  await expect('copy: the copy is installed, checked, and the source left as it was', async () => {
    await copyIn(src, places, { pin, inUse: no });
    return [(await checkFolder(places.game, { pin, full: true })).ok, existsSync(places.staging), existsSync(places.old), await tree(src) === before];
  }, r => r[0] === true && r[1] === false && r[2] === false && r[3] === true);
  await expect('status: ready', () => frozenStatus(places, pin), r => r.status === 'ready');

  const newer = makeGame(join(root, 'newer'), { tag: 'b2' });
  const pin2 = await pinOf(newer, '99999999');
  await expect('status: a copy of an earlier pin is "other"', () => frozenStatus(places, pin2), r => r.status === 'other');
  await expect('copy: a new pin\'s copy replaces the old one, and the old one is removed', async () => {
    await copyIn(newer, places, { pin: pin2, inUse: no });
    return [(await checkFolder(places.game, { pin: pin2 })).ok, existsSync(places.old), readdirSync(places.root).sort().join(',')];
  }, r => r[0] === true && r[1] === false && r[2] === 'game');
  await expect('copy: a folder of another build is refused, and the copy left as it was', async () => {
    const was = await tree(places.game);
    let err = null;
    try { await copyIn(src, places, { pin: pin2, inUse: no }); } catch (e) { err = e; }
    return [err?.said, /another game version/.test(err?.message), await tree(places.game) === was, existsSync(places.staging)];
  }, r => r[0] === true && r[1] === true && r[2] === true && r[3] === false);
  await expect('copy: a copy that fails the full check is removed, and the copy left as it was', async () => {
    const was = await tree(places.game);
    let err = null;
    try { await copyIn(newer, places, { pin: { ...pin2, asarSha256: '0'.repeat(64) }, inUse: no }); } catch (e) { err = e; }
    return [err?.said, /changed, missing or added/.test(err?.message), await tree(places.game) === was, existsSync(places.staging)];
  }, r => r[0] === true && r[1] === true && r[2] === true && r[3] === false);
  await expect('copy: cancelled before it starts copying', async () => {
    const was = await tree(places.game), ac = new AbortController();
    ac.abort();
    let err = null;
    try { await copyIn(newer, places, { pin: pin2, signal: ac.signal }); } catch (e) { err = e; }
    return [err?.name, await tree(places.game) === was, existsSync(places.staging)];
  }, r => r[0] === 'AbortError' && r[1] === true && r[2] === false);

  // Repair after an interrupted replacement.
  await expect('repair: no copy but the previous one in game.old: it is put back; a half-made copy is removed', async () => {
    const p = frozenPlaces(join(root, 'repair'));
    makeGame(p.old); makeGame(p.staging);
    await repairPlaces(p);
    return [existsSync(p.game), existsSync(p.old), existsSync(p.staging)];
  }, r => r[0] === true && r[1] === false && r[2] === false);
  await expect('repair: a replaced copy left beside the copy is removed', async () => {
    const p = frozenPlaces(join(root, 'repair2'));
    makeGame(p.game); makeGame(p.old, { tag: 'old' });
    await repairPlaces(p);
    return [existsSync(p.game), existsSync(p.old), (await checkFolder(p.game, { pin })).ok];
  }, r => r[0] === true && r[1] === false && r[2] === true);
  await expect('install: nothing in staging: the copy is kept', async () => {
    const p = frozenPlaces(join(root, 'inst'));
    makeGame(p.game);
    let err = null;
    try { await install(p, { inUse: no }); } catch (e) { err = e; }
    return [err?.said, existsSync(p.game), existsSync(p.old)];
  }, r => r[0] === true && r[1] === true && r[2] === false);

  // The saves, copied once.
  const saves = join(root, 'steam-saves');
  mkdirSync(join(saves, 'sub'), { recursive: true });
  writeFileSync(join(saves, 'A.gsav'), 'save a'); writeFileSync(join(saves, 'sub', 'B.gsav'), 'save b'); writeFileSync(join(saves, 'steam_autocloud.vdf'), 'cloud');
  const savesBefore = await tree(saves), data = join(root, 'game-data');
  await expect('saves: copied once, without Steam\'s cloud marker, the Steam saves left as they were', async () => {
    const r = await copySavesOnce(data, { source: saves });
    return [r.files, (await listFiles(join(data, 'saves'))).join(','), existsSync(join(data, 'saves.partial')), await tree(saves) === savesBefore];
  }, r => r[0] === 2 && r[1] === 'A.gsav,sub/B.gsav' && r[2] === false && r[3] === true);
  await expect('saves: never again once the frozen game has saves, and nothing in them is overwritten', async () => {
    writeFileSync(join(data, 'saves', 'A.gsav'), 'played on');
    writeFileSync(join(saves, 'C.gsav'), 'new steam save');
    const r = await copySavesOnce(data, { source: saves });
    return [r.already, readFileSync(join(data, 'saves', 'A.gsav'), 'utf8'), existsSync(join(data, 'saves', 'C.gsav'))];
  }, r => r[0] === true && r[1] === 'played on' && r[2] === false);
  await expect('saves: no Steam saves: an empty saves folder, so it still happens once', async () => {
    const d = join(root, 'game-data-2');
    const r = await copySavesOnce(d, { source: join(root, 'no-saves') });
    return [r.files, existsSync(join(d, 'saves')), readdirSync(join(d, 'saves')).length];
  }, r => r[0] === 0 && r[1] === true && r[2] === 0);
  await expect('saves: a half-made copy left from before is replaced, not added to', async () => {
    const d = join(root, 'game-data-3');
    mkdirSync(join(d, 'saves.partial'), { recursive: true }); writeFileSync(join(d, 'saves.partial', 'junk.gsav'), 'x');
    await copySavesOnce(d, { source: saves });
    return (await listFiles(join(d, 'saves'))).join(',');
  }, r => r === 'A.gsav,C.gsav,sub/B.gsav');

  // Steam's console log.
  const logFile = join(root, 'console_log.txt');
  writeFileSync(logFile, `[t] Depot download complete : "C:\\x" (manifest ${PIN.manifest})\n`);
  const start = readFileSync(logFile).length;
  await expect('log: what was there before the click does not count', () => readDownloadLog(logFile, start), r => !r.done && !r.started && r.offset === start);
  appendFileSync(logFile, `[t] Downloading depot ${PIN.depot} (95 files, 2889 MB) ... \n[t] Depot download complete : "C:\\y" (manifest 123)\n[t] Depot download comp`);
  let seen;
  await expect('log: the start is seen, another manifest is not the pin\'s, a half-written line waits', async () => (seen = await readDownloadLog(logFile, start)),
    r => r.started?.mb === 2889 && r.started.files === 95 && !r.done && r.offset < readFileSync(logFile).length);
  appendFileSync(logFile, `lete : "C:\\program files (x86)\\steam\\steamapps\\content\\app_940230\\depot_940231" (manifest ${PIN.manifest}) \n`);
  await expect('log: the pinned manifest\'s completion is seen once its line is whole', () => readDownloadLog(logFile, seen.offset), r => r.done === true);
  await expect('log: a log started again (Steam restarted) is read from the start', async () => {
    writeFileSync(logFile, `[t] Depot download complete : "C:\\z" (manifest ${PIN.manifest})\n`);
    return readDownloadLog(logFile, 10 ** 6);
  }, r => r.done === true);
  await expect('download: the command and the folder Steam writes to', () => [downloadCommand(), downloadFolder('C:\\Program Files (x86)\\Steam')],
    r => r[0] === `download_depot 940230 940231 ${PIN.manifest}` && r[1] === 'C:\\Program Files (x86)\\Steam\\steamapps\\content\\app_940230\\depot_940231');

  // Taking Steam's download.
  await expect('download: a finished download is copied in (with the loader folder\'s permissions), replaces the copy, and Steam\'s folder is removed', async () => {
    const steamDir = join(root, 'steam'), dl = downloadFolder(steamDir, pin);
    makeGame(dl);
    const p = frozenPlaces(join(root, 'loader-dl'));
    makeGame(p.game, { tag: 'old' });
    const r = await takeDownload(dl, p, { pin, inUse: no });
    return [r.left, existsSync(dl), (await checkFolder(p.game, { pin })).ok, existsSync(p.old)];
  }, r => r[0] === null && r[1] === false && r[2] === true && r[3] === false);
  await expect('download: a download that is not the pinned build is refused and left where it is', async () => {
    const dl = join(root, 'steam2', 'depot');
    makeGame(dl, { tag: 'wrong' });
    let err = null;
    try { await takeDownload(dl, frozenPlaces(join(root, 'loader-dl2')), { pin, inUse: no }); } catch (e) { err = e; }
    return [err?.said, existsSync(dl), existsSync(join(root, 'loader-dl2', 'game'))];
  }, r => r[0] === true && r[1] === true && r[2] === false);
  await expect('download: a download already in Steam\'s folder is taken without asking Steam again', async () => {
    const steamDir = join(root, 'steam3');
    makeGame(downloadFolder(steamDir, pin));
    const p = frozenPlaces(join(root, 'loader-dl3')), steps = [];
    await steamDownload({ steam: join(root, 'no-steam.exe'), steamDir, places: p, pin, inUse: no, onStatus: s => steps.push(s.step) });
    return [(await checkFolder(p.game, { pin })).ok, steps.includes('waiting')];
  }, r => r[0] === true && r[1] === false);

  // Fixes from review.
  await expect('check: a folder that is itself a junction is refused (even to the real build)', async () => {
    symlinkSync(src, join(root, 'src-link'), 'junction');
    try { return await checkFolder(join(root, 'src-link'), { pin }); } finally { rmSync(join(root, 'src-link'), { force: true }); }
  }, r => !r.ok && r.reason === 'link');
  await expect('check: the folder is returned as it is on disk, to start it from there', () => checkFolder(src, { pin }), r => r.ok && r.dir.toLowerCase() === src.toLowerCase());
  await expect('check: an archive of another size is another build, refused before it is hashed', () => checkFolder(src, { pin: { ...pin, asarSize: pin.asarSize + 1 } }),
    r => !r.ok && r.reason === 'build');
  await expect('check: outside files of another total size are refused before they are hashed', () => checkFolder(src, { pin: { ...pin, folderBytes: pin.folderBytes + 1 } }),
    r => !r.ok && r.reason === 'changed');
  await expect('copy: the loader\'s own folder cannot be the source', async () => {
    let err = null;
    try { await copyIn(places.game, places, { pin: pin2, inUse: no }); } catch (e) { err = e; }
    return [err?.said, /loader's own folder/.test(err?.message), (await checkFolder(places.game, { pin: pin2 })).ok];
  }, r => r[0] === true && r[1] === true && r[2] === true);
  await expect('copy: cancelled during the check of the copy: nothing installed, the copy left as it was', async () => {
    const was = await tree(places.game), ac = new AbortController();
    let err = null;
    try { await copyIn(src, places, { pin, inUse: no, signal: ac.signal, onProgress: p => { if (p.step === 'checking') ac.abort(); } }); } catch (e) { err = e; }
    return [err?.name, await tree(places.game) === was, existsSync(places.staging)];
  }, r => r[0] === 'AbortError' && r[1] === true && r[2] === false);
  await expect('install: refused while the game runs; the copy and the new one kept', async () => {
    const p = frozenPlaces(join(root, 'inst-running'));
    makeGame(p.game); makeGame(p.staging, { tag: 'new' });
    let err = null;
    try { await install(p, { inUse: () => true }); } catch (e) { err = e; }
    return [err?.said, /running/.test(err?.message), existsSync(p.game), existsSync(p.staging)];
  }, r => r[0] === true && r[1] === true && r[2] === true && r[3] === true);
  await expect('install: a replaced copy left over from before does not block the next replacement', async () => {
    const p = frozenPlaces(join(root, 'inst-old'));
    makeGame(p.game, { tag: 'cur' }); makeGame(p.old, { tag: 'older' }); makeGame(p.staging);
    await install(p, { inUse: no });
    return [(await checkFolder(p.game, { pin })).ok, existsSync(p.old), existsSync(p.staging)];
  }, r => r[0] === true && r[1] === false && r[2] === false);
  await expect('download: a download Steam is still writing is "not yet" when looked at, and stays where it is', async () => {
    const dl = join(root, 'steam4', 'depot');
    makeGame(dl);
    const r = await takeDownload(dl, frozenPlaces(join(root, 'loader-dl4')), { pin: { ...pin, asarSha256: '0'.repeat(64) }, quiet: true, inUse: no });
    return [r, existsSync(dl), existsSync(join(root, 'loader-dl4', 'game'))];
  }, r => r[0] === null && r[1] === true && r[2] === false);
  await expect('saves: a link in the Steam saves is left out, not a reason to refuse', async () => {
    const s2 = join(root, 'steam-saves-2'), d = join(root, 'game-data-4');
    mkdirSync(s2); writeFileSync(join(s2, 'A.gsav'), 'a'); symlinkSync(root, join(s2, 'elsewhere'), 'junction');
    const r = await copySavesOnce(d, { source: s2 });
    return [r.files, (await listFiles(join(d, 'saves'))).join(',')];
  }, r => r[0] === 1 && r[1] === 'A.gsav');
  await expect('archive reads: a file whose bytes differ from the archive\'s own record of it is refused', () => {
    const g = join(root, 'integrity');
    mkdirSync(join(g, 'resources'), { recursive: true });
    const body = Buffer.from('original text'), index = Buffer.from(JSON.stringify({ files: { renderer: { files: { 'a.js': {
      size: body.length, offset: '0', integrity: { algorithm: 'SHA256', hash: sha(Buffer.from('another text!')), blockSize: 4194304, blocks: [] },
    } } } } }));
    const head = Buffer.alloc(16);
    head.writeUInt32LE(4, 0); head.writeUInt32LE(index.length + 8, 4); head.writeUInt32LE(index.length + 4, 8); head.writeUInt32LE(index.length, 12);
    writeFileSync(join(g, 'resources', 'app.asar'), Buffer.concat([head, index, body]));
    return readAsarFile(join(g, 'resources', 'app.asar'), 'renderer/a.js');
  }, r => typeof r.threw === 'string' && /does not match the archive's own record/.test(r.threw));
  await expect('archive reads: the game\'s own archive reads with its records checked', () => readAsarFile(join(src, 'resources', 'app.asar'), 'renderer/a.js').toString(),
    r => r === 'console.log(1)');

  // The choice, and what Play and the programs see.
  await expect('choice: frozen unless the settings say live', () => [playChoice({}), playChoice({ play: 'live' }), playChoice({ play: 'x' })],
    r => r.join() === 'frozen,live,frozen');
  const fg = frozenGame(places, false), liveGame = { dir: 'C:\\g', build: '1', updating: false };
  await expect('choice: the frozen game\'s build is the pin, ready or not', () => [fg.build, fg.frozen, fg.ready, chosenGame({}, fg, liveGame) === fg, chosenGame({ play: 'live' }, fg, liveGame) === liveGame],
    r => r[0] === PIN.build && r[1] === true && r[2] === false && r[3] && r[4]);
  await expect('choice: Steam\'s update state does not block the frozen game', () => launchBlocker({ gameDir: join(root, 'nope') }, fg), r => r === null);
  const exe = join(root, 'prog.exe'); writeFileSync(exe, 'MZ');
  const balance = { id: 'b', builds: [PIN.build] };
  await expect('no mods to play: on but made for the frozen game, off, or made for neither', () => [
    noModsMessage([balance], { enabled: {} }, liveGame), noModsMessage([balance], { enabled: { b: false } }, liveGame), noModsMessage([{ id: 'c', builds: ['5'] }], { enabled: {} }, fg),
  ], r => /build 1\). Play the frozen game instead/.test(r[0]) && /^No mod is switched on/.test(r[1]) && /Wait for updated versions/.test(r[2]));
  await expect('programs: refused while the frozen game is not set up', () => programRefusal({ exe, confirmed: exe }, {
    game: fg, mods: [], settings: { enabled: {} }, saved: {},
  }), r => r === FROZEN_NOT_READY);
  await expect('programs: the frozen game\'s folder is passed as --game', () => [programArgs('C:\\Loader'), programArgs('C:\\Loader', 'C:\\Users\\A B\\game')],
    r => r[0] === '--loader C:\\Loader' && r[1] === '--loader C:\\Loader --game "C:\\Users\\A B\\game"');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failed ? `${failed} frozen-game check(s) FAILED` : 'all frozen-game checks passed');
process.exit(failed ? 1 : 0);
