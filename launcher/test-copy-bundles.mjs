// Checks for the code the game runs outside its window (patcher/copy-bundles.mjs, the parts of patcher/game.mjs,
// launcher/freeze.mjs and launcher/core.mjs that use it) on small fake game folders: reading a file kept beside the
// archive, writing the patched text into the frozen copy and putting the original back after every way a session can
// end (including a crash at each step), the notes the written code leaves when Node loads it (a real `node` process
// requires the written file), and the refusal for the Steam game. Nothing is started and Steam is not touched.
// Usage: node launcher/test-copy-bundles.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, renameSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { readAsarFile, unpackedBundles } from '../patcher/game.mjs';
import { listFiles, asarIndexSha256, folderSha256, fileSha256, PIN, frozenPlaces } from '../patcher/frozen.mjs';
import {
  RENDERER_OUTSIDE, ORIGINAL, NEW, leftInCopy, settleCopy, writeBundles, restoreBundles, noteWrap, readNotes, noteJudge, newNonce,
} from '../patcher/copy-bundles.mjs';
import { repairPlaces, frozenStatus } from './freeze.mjs';
import { buildMods, prepareFrozen, playSession, outsideMods, programRefusal } from './core.mjs';

let failed = 0;
async function expect(name, fn, check) {
  let r;
  try { r = await fn(); } catch (e) { r = { threw: e.message, code: e.code }; }
  if (check(r)) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}: unexpected result ${JSON.stringify(r)?.slice(0, 300)}`); }
}
const sha = b => createHash('sha256').update(b).digest('hex');
const yes = () => true, no = () => false;
const SIM = 'sim-worker.bundle.js', PAGEW = 'page-worker.bundle.js';
// A bundle shaped like the game's: it installs its message handler (the 1.1.0 simulation does so after an await).
const SIM_TEXT = '/*geo-channel:release*/\n(async () => { await null; globalThis.onmessage = e => e; })();\n';
const PAGE_TEXT = 'globalThis.onmessage = e => e;\n';

// A fake game folder: an exe, an archive holding page-worker.bundle.js and recording sim-worker.bundle.js as kept beside
// it (with its size and SHA-256, as the game's archive does), and that file in app.asar.unpacked\renderer.
function makeGame(dir, { record = true } = {}) {
  mkdirSync(join(dir, ...RENDERER_OUTSIDE), { recursive: true });
  writeFileSync(join(dir, 'Geoplanetical.exe'), 'MZ fake exe');
  writeFileSync(join(dir, ...RENDERER_OUTSIDE, SIM), SIM_TEXT);
  const page = Buffer.from(PAGE_TEXT), sim = Buffer.from(SIM_TEXT);
  const integrity = b => ({ algorithm: 'SHA256', hash: sha(b), blockSize: 4194304, blocks: [sha(b)] });
  const index = Buffer.from(JSON.stringify({ files: { renderer: { files: {
    [PAGEW]: { size: page.length, offset: '0', integrity: integrity(page) },
    [SIM]: { size: sim.length, unpacked: true, ...(record ? { integrity: integrity(sim) } : {}) },
  } } } }));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0); head.writeUInt32LE(index.length + 8, 4); head.writeUInt32LE(index.length + 4, 8); head.writeUInt32LE(index.length, 12);
  writeFileSync(join(dir, 'resources', 'app.asar'), Buffer.concat([head, index, page]));
  return dir;
}
const tree = dir => listFiles(dir).then(fs => fs.map(f => `${f} ${sha(readFileSync(join(dir, f)))}`).join('\n'));
const simFile = dir => join(dir, ...RENDERER_OUTSIDE, SIM);
const asar = dir => join(dir, 'resources', 'app.asar');
// A mod as patcher/mods.mjs reads it (only the fields the build uses).
const mod = (id, bundle, find, replace, builds = ['b1']) => ({
  id, name: id, version: '1.0.0', builds, scripts: [], requires: [],
  patches: [{ id: `${id}-p`, bundle, builds, edits: [{ find, replace, anchor: find }] }],
});

const root = mkdtempSync(join(tmpdir(), 'gpml-copy-'));
try {
  const g = makeGame(join(root, 'game'));
  const pristine = await tree(g);

  // Reading the game's files.
  await expect('archive reads: a file kept beside the archive is read from app.asar.unpacked, checked', () => readAsarFile(asar(g), `renderer/${SIM}`).toString(),
    r => r === SIM_TEXT);
  await expect('archive reads: a changed file beside the archive is refused', () => {
    const h = makeGame(join(root, 'tampered'));
    writeFileSync(simFile(h), SIM_TEXT.replace('await', 'awaix'));
    return readAsarFile(asar(h), `renderer/${SIM}`);
  }, r => /does not match the archive's own record/.test(r.threw));
  await expect('archive reads: a file beside the archive with no SHA-256 in the index is refused', () => readAsarFile(asar(makeGame(join(root, 'norecord'), { record: false })), `renderer/${SIM}`),
    r => /does not match the archive's own record/.test(r.threw));
  await expect('outside bundles: named from the archive index; none for a folder without an archive', () => [[...unpackedBundles(g)].join(), unpackedBundles(join(root, 'nothing')).size],
    r => r[0] === SIM && r[1] === 0);

  // Writing into the copy and putting it back.
  await expect('write: the patched text replaces the file, the original is kept beside it', () => {
    const w = writeBundles(g, new Map([[SIM, 'PATCHED']]));
    return [readFileSync(simFile(g), 'utf8'), readFileSync(simFile(g) + ORIGINAL, 'utf8'), w.get(SIM) === sha('PATCHED'), leftInCopy(g).join()];
  }, r => r[0] === 'PATCHED' && r[1] === SIM_TEXT && r[2] && r[3] === `${SIM}${ORIGINAL}`);
  await expect('settle: nothing is put back while the game runs', async () => [settleCopy(g, { inUse: yes }).state, readFileSync(simFile(g), 'utf8')],
    r => r[0] === 'in-use' && r[1] === 'PATCHED');
  await expect('settle: once the game is closed the copy is the game\'s own files again', async () => [settleCopy(g, { inUse: no }).restored.join(), await tree(g) === pristine, leftInCopy(g).length],
    r => r[0] === SIM && r[1] && r[2] === 0);
  await expect('settle: a clean copy does not even ask whether the game runs', () => settleCopy(g, { inUse: () => { throw new Error('asked'); } }).state,
    r => r === 'clean');

  // Each point a write can stop at (a crash, a power cut) leaves something settle repairs.
  const crash = async (label, set) => expect(`crash ${label}: settle puts the game's own files back`, async () => {
    set();
    const s = settleCopy(g, { inUse: no });
    return [s.state, await tree(g) === pristine, leftInCopy(g).length];
  }, r => r[0] === 'restored' && r[1] && r[2] === 0);
  await crash('after the new file was written', () => writeFileSync(simFile(g) + NEW, 'PATCHED'));
  await crash('after the original was set aside', () => { writeFileSync(simFile(g) + NEW, 'PATCHED'); renameSync(simFile(g), simFile(g) + ORIGINAL); });
  await crash('during the session', () => { renameSync(simFile(g), simFile(g) + ORIGINAL); writeFileSync(simFile(g), 'PATCHED'); });

  await expect('settle: an original that does not match the game\'s record is left where it is', async () => {
    renameSync(simFile(g), simFile(g) + ORIGINAL);
    writeFileSync(simFile(g) + ORIGINAL, 'NOT THE GAME\'S');
    writeFileSync(simFile(g), 'PATCHED');
    const s = settleCopy(g, { inUse: no });
    const r = [s.refused.join(), readFileSync(simFile(g), 'utf8'), existsSync(simFile(g) + ORIGINAL)];
    rmSync(simFile(g) + ORIGINAL); writeFileSync(simFile(g), SIM_TEXT);
    return r;
  }, r => r[0] === SIM && r[1] === 'PATCHED' && r[2]);
  await expect('write: refused while files of an earlier session are still in the copy', async () => {
    writeFileSync(simFile(g) + NEW, 'x');
    let err = null;
    try { writeBundles(g, new Map([[SIM, 'PATCHED']])); } catch (e) { err = e.code; }
    return [err, await tree(g) === pristine];
  }, r => r[0] === 'EEXIST' && r[1]);
  await expect('write: a failure part-way puts back what was already written', async () => {
    let err = null;
    try { writeBundles(g, new Map([[SIM, 'PATCHED'], ['missing-worker.bundle.js', 'X']])); } catch (e) { err = e.code; }
    return [err, await tree(g) === pristine];
  }, r => r[0] === 'ENOENT' && r[1]);
  await expect('write: only bundle names, never a path', async () => {
    let err = null;
    try { writeBundles(g, new Map([['../x.bundle.js', 'X']])); } catch (e) { err = e.code; }
    return [err, await tree(g) === pristine];
  }, r => r[0] === 'EINVAL' && r[1]);
  await expect('restore: a written file changed during the session is reported, and the original still goes back', async () => {
    const w = writeBundles(g, new Map([[SIM, 'PATCHED']]));
    writeFileSync(simFile(g), 'SOMEONE ELSE');
    const back = restoreBundles(g, w, { inUse: no });
    return [back.changed.join(), back.state, await tree(g) === pristine];
  }, r => r[0] === SIM && r[1] === 'restored' && r[2]);

  // The notes: a real Node process requires the written file, as the game's simulation process does.
  const notes = join(root, 'session-notes.txt');
  const nonce = newNonce();
  // (in a worker thread, as the game's simulation process runs it: simulation-node-worker.js requires the bundle)
  const loadIn = file => spawnSync(process.execPath, ['-e', "const w = new (require('node:worker_threads').Worker)(process.argv[1]); " +
    "w.on('error', () => {}); w.on('exit', c => { process.exitCode = c; });", file], { encoding: 'utf8' });
  await expect('notes: the patched code loaded by Node says it started and finished loading; text unchanged inside', () => {
    const text = noteWrap(SIM_TEXT, { file: notes, nonce, bundle: SIM });
    new Script(text);
    const w = writeBundles(g, new Map([[SIM, text]]));
    const runs = [loadIn(simFile(g)).status, loadIn(simFile(g)).status]; // a session and a load: two processes
    const c = readNotes(notes, nonce, [SIM]).get(SIM);
    restoreBundles(g, w, { inUse: no });
    return [runs.join(), c.start, c.end, text.includes(SIM_TEXT)];
  }, r => r[0] === '0,0' && r[1] === 2 && r[2] === 2 && r[3]);
  await expect('notes: code that loads, then stops with an error later (after an await), leaves an exit note: broken', () => {
    rmSync(notes, { force: true });
    const w = writeBundles(g, new Map([[SIM, noteWrap('(async () => { await null; throw new Error("mod broke later"); })().catch(e => setTimeout(() => { throw e; }, 0));',
      { file: notes, nonce, bundle: SIM })]]));
    const run = loadIn(simFile(g));
    const c = readNotes(notes, nonce, [SIM]);
    restoreBundles(g, w, { inUse: no });
    const j = noteJudge([SIM]);
    return [run.status !== 0, c.get(SIM).start, c.get(SIM).end, c.get(SIM).exit, j.poll(c, 0).map(x => x.status).join(), j.end(c)[0].status];
  }, r => r[0] && r[1] === 1 && r[2] === 1 && r[3] === 1 && r[4] === 'patched,broken' && r[5] === 'broken');
  await expect('notes: a thread that ends without an error, or is ended from outside, leaves no exit note', () => {
    rmSync(notes, { force: true });
    const w = writeBundles(g, new Map([[SIM, noteWrap('globalThis.x = 1;', { file: notes, nonce, bundle: SIM })]]));
    const ended = spawnSync(process.execPath, ['-e', "const w = new (require('node:worker_threads').Worker)(process.argv[1]); " +
      "w.on('online', () => setTimeout(() => w.terminate(), 50));", simFile(g)], { encoding: 'utf8' });
    const run = loadIn(simFile(g));
    const c = readNotes(notes, nonce, [SIM]).get(SIM);
    restoreBundles(g, w, { inUse: no });
    return [ended.status, run.status, c.start, c.end, c.exit];
  }, r => r[0] === 0 && r[1] === 0 && r[2] === 2 && r[3] === 2 && r[4] === 0);
  await expect('notes: code that throws while starting leaves a start without its end', () => {
    rmSync(notes, { force: true });
    const w = writeBundles(g, new Map([[SIM, noteWrap('throw new Error("mod broke");', { file: notes, nonce, bundle: SIM })]]));
    const run = loadIn(simFile(g));
    const c = readNotes(notes, nonce, [SIM]).get(SIM);
    restoreBundles(g, w, { inUse: no });
    return [run.status !== 0, c.start, c.end];
  }, r => r[0] && r[1] === 1 && r[2] === 0);
  await expect('notes: the notes never throw into the game (no notes folder, no require)', () => {
    const text = noteWrap('globalThis.ok = 1;', { file: join(root, 'no-such-folder', 'n.txt'), nonce, bundle: SIM });
    const ctx = {};
    new Script(text).runInNewContext(ctx); // a page worker: no require
    const f = join(root, 'cjs.js');
    writeFileSync(f, text);
    return [ctx.ok, loadIn(f).status];
  }, r => r[0] === 1 && r[1] === 0);
  await expect('notes: lines of another session, another bundle or no note at all are left out', () => {
    writeFileSync(notes, [
      JSON.stringify({ gpml: 'other', bundle: SIM, at: 'end' }), JSON.stringify({ gpml: nonce, bundle: '__proto__', at: 'end' }),
      JSON.stringify({ gpml: nonce, bundle: SIM, at: 'middle' }), 'not json', `{"gpml":"${nonce}","bundle":"${SIM}","at":"end","pad":"${'x'.repeat(400)}"}`,
      JSON.stringify({ gpml: nonce, bundle: SIM, at: 'start' }), '',
    ].join('\n'));
    const c = readNotes(notes, nonce, [SIM]);
    return [c.get(SIM).start, c.get(SIM).end, c.size];
  }, r => r[0] === 1 && r[1] === 0 && r[2] === 1);
  await expect('notes: what they say during and at the end of a session', () => {
    const j = noteJudge([SIM, 'b.bundle.js', 'c.bundle.js'], { stuckMs: 1000 });
    const at = (s, e) => new Map([[SIM, { start: s, end: e }], ['b.bundle.js', { start: 1, end: 0 }], ['c.bundle.js', { start: 0, end: 0 }]]);
    const first = j.poll(at(1, 1), 0), second = j.poll(at(2, 2), 10), stuck = j.poll(at(2, 2), 1500);
    return [first.map(x => `${x.bundle}:${x.status}`).join(), second.length, stuck.map(x => `${x.bundle}:${x.status}`).join(),
      j.end(at(2, 2)).map(x => `${x.bundle}:${x.status}`).join()];
  }, r => r[0] === `${SIM}:patched` && r[1] === 0 && r[2] === 'b.bundle.js:broken' && r[3] === `${SIM}:patched,b.bundle.js:broken,c.bundle.js:idle`);
  await expect('notes: a load cut off by the game closing, after one finished, is not a failure', () => {
    const j = noteJudge([SIM], { stuckMs: 1000 });
    const c = new Map([[SIM, { start: 3, end: 2, exit: 0 }]]);
    j.poll(c, 0);
    return j.end(c)[0].status;
  }, r => r === 'patched');

  // The launcher: which mods change code outside the window, the refusal for the Steam game, the build split.
  const simMod = mod('simmod', SIM, 'await null', 'await null; globalThis.modded = 1'), pageMod = mod('pagemod', PAGEW, 'e => e', 'e => e + 1');
  const live = { dir: g, build: 'b1', frozen: false }, frozen = { dir: g, build: 'b1', frozen: true, notes };
  await expect('build: mods that change code outside the window are named', () => outsideMods([simMod, pageMod], live).map(m => m.id).join(),
    r => r === 'simmod');
  await expect('build: refused for the Steam game, with the way to play it', () => buildMods(live, [simMod, pageMod], () => {}),
    r => /simmod changes the game's simulation/.test(r.error) && /only in the frozen game, never in your Steam game/.test(r.error));
  await expect('build: for the frozen game, written to the copy or served through the window', () => {
    const b = buildMods(frozen, [simMod, pageMod], () => {}, { inUse: no });
    return [[...b.disk.keys()].join(), [...b.payloads.keys()].join(), b.disk.get(SIM).includes('globalThis.modded = 1')];
  }, r => r[0] === SIM && r[1] === PAGEW && r[2]);
  await expect('build: code the game loads with require is compiled as require does (let module is refused)', () => {
    const bad = mod('badmod', SIM, '/*geo-channel:release*/', '/*geo-channel:release*/ let module = 1;');
    return [buildMods(frozen, [bad], () => {}, { inUse: no }).error, !!buildMods(frozen, [mod('pg', PAGEW, 'globalThis.onmessage', 'let module = 1; globalThis.onmessage')], () => {}, { inUse: no }).payloads];
  }, r => /could not be applied/.test(r[0]) && /module/.test(r[0]) && r[1]);
  await expect('build: a copy left changed is put back before its files are read', async () => {
    renameSync(simFile(g), simFile(g) + ORIGINAL); writeFileSync(simFile(g), 'PATCHED');
    const b = buildMods(frozen, [simMod], () => {}, { inUse: no });
    return [!!b.disk, await tree(g) === pristine];
  }, r => r[0] && r[1]);
  await expect('build: not while the game runs with the copy changed', async () => {
    renameSync(simFile(g), simFile(g) + ORIGINAL); writeFileSync(simFile(g), 'PATCHED');
    const b = buildMods(frozen, [simMod], () => {}, { inUse: yes });
    settleCopy(g, { inUse: no });
    return b.error;
  }, r => /Geoplanetical is running/.test(r));
  await expect('programs: not handed mods they would play unmodded (code outside the window)', () => {
    const exe = join(root, 'prog.exe');
    writeFileSync(exe, 'MZ');
    const p = { exe, confirmed: exe, name: 'Prog' };
    const args = { game: { ...frozen, ready: true }, broken: [], settings: { enabled: {} }, saved: {} };
    return [programRefusal(p, { ...args, mods: [simMod, pageMod] }), programRefusal(p, { ...args, mods: [pageMod] })];
  }, r => /simmod changes the game's simulation/.test(r[0]) && /not Prog/.test(r[0]) && r[1] === null);
  await expect('build: a damaged original kept aside is the copy\'s fault, not the mod\'s', async () => {
    renameSync(simFile(g), simFile(g) + ORIGINAL); writeFileSync(simFile(g) + ORIGINAL, 'DAMAGED'); writeFileSync(simFile(g), 'PATCHED');
    const b = buildMods(frozen, [simMod], () => {}, { inUse: no });
    rmSync(simFile(g) + ORIGINAL); writeFileSync(simFile(g), SIM_TEXT);
    return [b.error, await tree(g) === pristine];
  }, r => /could not be put back/.test(r[0]) && /Get the frozen game again/.test(r[0]) && r[1]);
  await expect('session: bundles for the copy without a frozen game start nothing', () => playSession({
    steam: null, frozen: null, port: 0, payloads: new Map(), disk: new Map([[SIM, 'x']]), chosen: [simMod], log: () => {},
  }), r => r.problem === true && /only in the frozen game/.test(r.message));
  await expect('session: nothing is written while the game runs (started during the build or the saves copy)', async () => {
    const r = await playSession({
      steam: null, frozen: { dir: g, dataDir: join(root, 'data'), notes }, port: 0, payloads: new Map(), disk: new Map([[SIM, 'PATCHED']]),
      chosen: [simMod], log: () => {}, inUse: yes,
    });
    return [r.problem, /Geoplanetical is running/.test(r.message), await tree(g) === pristine];
  }, r => r[0] === true && r[1] && r[2]);
  await expect('prepare: a copy left changed is put back before the check', async () => {
    renameSync(simFile(g), simFile(g) + ORIGINAL); writeFileSync(simFile(g), 'PATCHED');
    const r = await prepareFrozen({ ...frozen }, () => {}, { saves: false, steam: false, inUse: no });
    return [/another game version/.test(r.error), await tree(g) === pristine]; // (the fixture is not the pinned build)
  }, r => r[0] && r[1]);

  // The loader's own folder: at open and on Refresh.
  const places = frozenPlaces(join(root, 'loader'));
  makeGame(places.game);
  const pin = {
    ...PIN, build: 'b1', asarSize: readFileSync(asar(places.game)).length, asarIndexSha256: await asarIndexSha256(places.game),
    folderBytes: (await listFiles(places.game)).filter(f => f !== 'resources/app.asar').reduce((n, f) => n + readFileSync(join(places.game, f)).length, 0),
    folderSha256: await folderSha256(places.game), asarSha256: await fileSha256(asar(places.game)),
  };
  const dirty = () => { renameSync(simFile(places.game), simFile(places.game) + ORIGINAL); writeFileSync(simFile(places.game), 'PATCHED'); };
  await expect('status: while the game runs, a changed copy says to close the game (not to get it again)', async () => {
    dirty();
    return frozenStatus(places, pin, { inUse: yes });
  }, r => r.status === 'unreadable' && /Geoplanetical is running/.test(r.problem));
  await expect('status: once the game is closed, the copy is put back and ready', () => frozenStatus(places, pin, { inUse: no }),
    r => r.status === 'ready');
  await expect('open: the loader puts a changed copy back when it opens', async () => {
    dirty();
    const said = [];
    await repairPlaces(places, m => said.push(m), { inUse: no });
    return [said.some(m => /put back in place/.test(m)), readdirSync(join(places.game, ...RENDERER_OUTSIDE)).join()];
  }, r => r[0] && r[1] === SIM);
  appendFileSync(notes, ''); // (the notes file is the loader's: it is removed with the rest below)
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failed ? `${failed} copy check(s) FAILED` : 'all copy checks passed');
process.exit(failed ? 1 : 0);
