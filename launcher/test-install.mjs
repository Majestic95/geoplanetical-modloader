// Unit checks for launcher/install.mjs: zip reading, entry paths, folder reading and the install transaction.
// Usage: node launcher/test-install.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateRawSync, crc32 } from 'node:zlib';
import { entryPath, readZip, readFolder, readChosen, installMods, itemsFromPage } from './install.mjs';

let failed = 0;
function expect(name, fn, { throws = null, check = null } = {}) {
  try {
    const r = fn();
    if (throws) { failed++; console.log(`FAIL ${name}: expected an error matching ${throws}`); return; }
    if (check && !check(r)) { failed++; console.log(`FAIL ${name}: unexpected result ${JSON.stringify(r)?.slice(0, 300)}`); return; }
    console.log(`ok   ${name}`);
  } catch (e) {
    if (throws && throws.test(e.message)) { console.log(`ok   ${name}`); return; }
    failed++; console.log(`FAIL ${name}: ${e.message}`);
  }
}

// The tests never use the Recycle Bin: replaced copies are deleted instead (or kept, to test that path).
const gone = dir => { rmSync(dir, { recursive: true, force: true }); return true; };
const install = (items, dir, ops = {}) => installMods(items, dir, { discard: gone, ...ops });

// A minimal zip writer for the tests: [{ name, data, method?, flags?, crc?, usize?, alias? }] (crc and usize to lie on
// purpose; alias: a directory entry pointing at the data of an earlier entry).
function zip(files) {
  const locals = [], centrals = [], at = [];
  let offset = 0;
  for (const f of files) {
    const src = f.alias === undefined ? f : files[f.alias];
    const data = Buffer.from(src.data ?? '');
    const method = src.method ?? 8, body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(f.name, 'utf8'), flags = f.flags ?? 0x800;
    const crc = f.crc ?? crc32(data), usize = f.usize ?? data.length;
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(f.alias === undefined ? offset : at[f.alias], 42);
    centrals.push(ch, name);
    at.push(offset);
    if (f.alias !== undefined) continue;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const modJson = (id, extra = {}) => JSON.stringify({ id, name: id.toUpperCase(), version: '1.0.0', description: 'D', builds: ['1'], patches: ['patches/p.json'], ...extra });
const patch = JSON.stringify({ id: 'p', effect: 'E', bundle: 'simulation-worker.bundle.js', edits: [{ anchor: 'a', find: 'b', replace: 'c' }] });
const modFiles = (prefix, id, extra) => [{ name: `${prefix}mod.json`, data: modJson(id, extra) }, { name: `${prefix}patches/p.json`, data: patch }];
const asItem = (name, files) => ({ name, files: files.map(f => ({ path: f.name, data: Buffer.from(f.data) })) });

const root = mkdtempSync(join(tmpdir(), 'gpml-install-'));
let n = 0;
const fresh = () => { const d = join(root, `m${n++}`); mkdirSync(d, { recursive: true }); return d; };
const placeMod = (modsDir, folder, id, extra) => {
  mkdirSync(join(modsDir, folder, 'patches'), { recursive: true });
  writeFileSync(join(modsDir, folder, 'mod.json'), modJson(id, extra));
  writeFileSync(join(modsDir, folder, 'patches', 'p.json'), patch);
};
const listing = dir => readdirSync(dir).sort();
const version = (modsDir, folder) => JSON.parse(readFileSync(join(modsDir, folder, 'mod.json'), 'utf8')).version;

// Entry paths.
for (const bad of ['../x', '/x', 'C:/x', 'c:x', 'a/../b', 'a//b', './a', 'con.json', 'a/nul', 'con .txt', 'COM\u00b9', 'conin$', 'a:b', 'x.', 'x ', 'a\u0001b', 'q?']) {
  expect(`path refused: ${JSON.stringify(bad)}`, () => entryPath(bad), { check: r => r instanceof Error });
}
expect('backslashes are separators', () => entryPath('my-mod\\patches\\p.json'), { check: r => r === 'my-mod/patches/p.json' });
expect('a normal path passes', () => entryPath('a/b.c/console.json'), { check: r => r === 'a/b.c/console.json' });

// Zips.
expect('zip: stored and deflated files read back', () => readZip(zip([{ name: 'a/x.txt', data: 'hello', method: 0 }, { name: 'a/y.txt', data: 'world'.repeat(50) }])),
  { check: r => r.length === 2 && r[0].data.toString() === 'hello' && r[1].data.toString() === 'world'.repeat(50) });
expect('zip: folders and __MACOSX left out', () => readZip(zip([{ name: 'a/', data: '' }, { name: '__MACOSX/a/._x', data: 'z' }, { name: 'a/x', data: '1' }])),
  { check: r => r.length === 1 && r[0].path === 'a/x' });
expect('zip: a wrong CRC is refused', () => readZip(zip([{ name: 'x', data: 'abc', crc: 1 }])), { throws: /damaged at "x"/ });
expect('zip: data longer than declared is refused', () => readZip(zip([{ name: 'x', data: 'abcdef', usize: 2 }])), { throws: /damaged at "x"/ });
expect('zip: encrypted is refused', () => readZip(zip([{ name: 'x', data: 'a', flags: 1 }])), { throws: /encrypted/ });
expect('zip: unknown method is refused', () => readZip(zip([{ name: 'x', data: 'a', method: 12 }])), { throws: /compression/ });
expect('zip: declared size over the cap is refused before inflating', () => readZip(zip([{ name: 'x', data: 'a', usize: 40 * 1024 * 1024 }])), { throws: /unpacks to more than/ });
expect('zip: entries sharing their bytes are refused', () => readZip(zip([{ name: 'a', data: 'x'.repeat(1000) }, { name: 'b', alias: 0 }, { name: 'c', alias: 0 }])), { throws: /damaged at "[bc]"/ });
expect('zip: not a zip', () => readZip(Buffer.from('just text, long enough to search for an end record')), { throws: /not a zip/ });
{
  const many = Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}`, data: '', method: 0 }));
  expect('zip: more than 5000 files is refused', () => readZip(zip(many)), { throws: /more than 5000 files/ });
}

// Install: shapes of zip.
{
  const mods = fresh();
  const r = install([{ name: 'top.zip', files: readZip(zip(modFiles('', 'alpha'))) }], mods);
  expect('install: zip of the files inside the mod folder', () => r, { check: x => x.added.length === 1 && x.added[0].folder === 'alpha' && x.kept === null && existsSync(join(mods, 'alpha', 'patches', 'p.json')) });
  expect('install: no work folders left behind', () => listing(mods), { check: l => l.join() === 'alpha' });
  if (process.platform === 'win32') {
    expect('install: files are marked as downloaded', () => readFileSync(join(mods, 'alpha', 'mod.json:Zone.Identifier'), 'utf8'), { check: s => /ZoneId=3/.test(s) });
  }
}
{
  const mods = fresh();
  const files = [...modFiles('repo-main/mods/beta/', 'beta'), { name: 'repo-main/README.md', data: '#' }, { name: 'repo-main/mods/beta/tests/t.mjs', data: '//' },
    { name: 'repo-main/mods/beta/tests/fixture/mod.json', data: '{}' }, { name: 'repo-main/docs/site.url', data: '[InternetShortcut]' }];
  const r = install([{ name: 'repo.zip', files: readZip(zip(files)) }], mods);
  expect('install: repository zip finds the mod in its sub-folder, nested mod.json and files outside it ignored', () => r.added,
    { check: x => x.length === 1 && x[0].id === 'beta' && existsSync(join(mods, 'beta', 'tests', 't.mjs')) && !existsSync(join(mods, 'README.md')) });
}
{
  const mods = fresh();
  const r = install([{ name: 'pack.zip', files: readZip(zip([...modFiles('pack/one/', 'one'), ...modFiles('pack/two/', 'two', { requires: ['one'] })])) }], mods);
  expect('install: a pack of two mods installs both', () => r.added.map(x => x.id).sort().join(), { check: s => s === 'one,two' });
}

// Install: replacing.
{
  const mods = fresh();
  placeMod(mods, 'My Balance Mod', 'gamma', { version: '0.1.0' });
  placeMod(mods, 'other', 'other');
  const discarded = [];
  const r = install([asItem('gamma.zip', modFiles('gamma/', 'gamma', { version: '0.2.0' }))], mods, { discard: d => { discarded.push(d); return gone(d); } });
  expect('install: replaces the same mod in its old folder', () => r.added[0],
    { check: x => x.folder === 'My Balance Mod' && x.replaced.join() === '0.1.0' && x.from.join() === 'My Balance Mod' && version(mods, 'My Balance Mod') === '0.2.0' });
  expect('install: the old copy goes to the bin under its own folder name', () => discarded, { check: d => d.length === 1 && d[0].endsWith('My Balance Mod') });
  expect('install: other mods untouched', () => listing(mods).join('|'), { check: s => s === 'My Balance Mod|other' });
}
{
  const mods = fresh();
  placeMod(mods, 'copy-a', 'delta'); placeMod(mods, 'copy-b', 'delta');
  install([asItem('delta.zip', modFiles('', 'delta', { version: '2' }))], mods);
  expect('install: two old copies of the same id are both replaced', () => listing(mods).join('|'), { check: s => s === 'delta' && version(mods, 'delta') === '2' });
}
{
  const mods = fresh();
  placeMod(mods, 'pi', 'pi', { version: 'old' });
  const r = install([asItem('pi.zip', modFiles('', 'pi', { version: 'new' }))], mods, { discard: () => false });
  expect('install: when the bin refuses, the old copy is kept and named', () => r,
    { check: x => !!x.kept && version(mods, 'pi') === 'new' && existsSync(join(x.kept, '0-0', 'pi', 'mod.json')) });
}
{
  const mods = fresh();
  placeMod(mods, '.gpml-install-player-folder', 'rho');
  mkdirSync(join(mods, '.gpml-install-0123456789ab', '0'), { recursive: true });
  install([asItem('s.zip', modFiles('', 'sigma'))], mods);
  expect('install: only the loader\'s own leftover work folders are cleaned', () => listing(mods).join('|'), { check: s => s === '.gpml-install-player-folder|sigma' });
}

// Install: refusals leave the mods folder as it was.
const snapshot = mods => JSON.stringify(listing(mods).map(f => [f, existsSync(join(mods, f, 'mod.json')) ? readFileSync(join(mods, f, 'mod.json'), 'utf8') : null]));
const unchanged = (name, prepare, items, re) => {
  const mods = fresh();
  prepare(mods);
  const before = snapshot(mods);
  expect(name, () => install(items, mods), { throws: re });
  expect(`${name}: mods folder unchanged`, () => snapshot(mods), { check: s => s === before });
};
unchanged('refused: no mod.json', m => placeMod(m, 'keep', 'keep'), [asItem('x.zip', [{ name: 'readme.txt', data: 'hi' }])], /no mod\.json found/);
unchanged('refused: a broken mod', m => placeMod(m, 'eps', 'eps'), [asItem('eps.zip', modFiles('', 'eps', { typo: 1 }))], /^eps\.zip: mod\.json: unknown field "typo"$/);
unchanged('refused: a missing patch file named relative to the mod', () => {}, [asItem('mp.zip', modFiles('', 'mp', { patches: ['patches/none.json'] }))], /^mp\.zip: patches[\\/]none\.json: ENOENT[^:]*: no such file or directory, open 'patches[\\/]none\.json'$/);
unchanged('refused: needs a newer loader', () => {}, [asItem('new.zip', modFiles('', 'newer', { format: 2 }))], /needs a newer Geoplanetical Mod Loader/);
unchanged('refused: an unsafe path', () => {}, [asItem('evil.zip', [...modFiles('', 'evil'), { name: '../outside.txt', data: 'x' }])], /not a plain path/);
unchanged('refused: a shortcut inside the mod', () => {}, [asItem('lnk.zip', [...modFiles('', 'lnk'), { name: 'readme.lnk', data: 'x' }])], /readme\.lnk is a shortcut or shell file/);
unchanged('refused: the same path twice (case)', () => {}, [asItem('dup.zip', [...modFiles('', 'dup'), { name: 'Patches/P.json', data: patch }])], /appears twice/);
unchanged('refused: a file and a folder of the same name', () => {}, [asItem('ff.zip', [...modFiles('', 'ff'), { name: 'a', data: '1' }, { name: 'a/b', data: '2' }])], /could not be written/);
unchanged('refused: a device name as the mod id', () => {}, [asItem('con.zip', modFiles('', 'con'))], /a name Windows keeps for devices/);
unchanged('refused: folder name taken by another mod', m => placeMod(m, 'zeta', 'not-zeta'), [asItem('zeta.zip', modFiles('', 'zeta'))], /already has a folder named "zeta"/);
unchanged('refused: folder name taken by a non-mod folder', m => mkdirSync(join(m, 'eta')), [asItem('eta.zip', modFiles('', 'eta'))], /already has a folder named "eta"/);
unchanged('refused: the same id twice in one drop', () => {}, [asItem('a.zip', modFiles('', 'twin')), asItem('b.zip', modFiles('', 'twin'))], /"twin" is in what was added more than once \(a\.zip, b\.zip\)/);
{
  const big = 'x'.repeat(20 * 1024 * 1024);
  unchanged('refused: the byte limit holds across items', () => {}, [asItem('b1.zip', [...modFiles('', 'b1'), { name: 'big', data: big }]), asItem('b2.zip', [...modFiles('', 'b2'), { name: 'big', data: big }])], /unpacks to more than 32 MB/);
}

// Install: a failure part-way puts everything back.
{
  const mods = fresh();
  placeMod(mods, 'theta', 'theta', { version: 'old' });
  placeMod(mods, 'iota', 'iota', { version: 'old' });
  let calls = 0;
  const rename = (a, b) => { if (++calls === 4) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } renameSync(a, b); };
  expect('rollback: a rename fails mid-swap', () => install([asItem('p.zip', [...modFiles('p/theta/', 'theta', { version: 'new' }), ...modFiles('p/iota/', 'iota', { version: 'new' })])], mods, { rename }), { throws: /^busy$/ });
  expect('rollback: both old versions back in place, nothing else', () => [listing(mods).join('|'), version(mods, 'theta'), version(mods, 'iota')].join(' '),
    { check: s => s === 'iota|theta old old' });
}
{
  const mods = fresh();
  placeMod(mods, 'kappa', 'kappa', { version: 'old' });
  let calls = 0;
  // 1 old copy aside, 2 new copy in (fails), 3 old copy back (fails too).
  const rename = (a, b) => { calls++; if (calls === 2 || calls === 3) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } renameSync(a, b); };
  let msg = '';
  try { install([asItem('k.zip', modFiles('', 'kappa', { version: 'new' }))], mods, { rename }); } catch (e) { msg = e.message; }
  const kept = listing(mods).find(f => f.startsWith('.gpml-replaced-'));
  expect('rollback that cannot finish keeps the old copy and says where', () => [msg, kept],
    { check: ([m, k]) => !!k && m.includes(k) && /move the previous copies/.test(m) && existsSync(join(mods, k, '0-0', 'kappa', 'mod.json')) });
}

// Folders on disk and the Add mod dialog's choices.
{
  const src = fresh();
  placeMod(src, 'lambda', 'lambda');
  expect('folder: read with its own name first', () => readFolder(join(src, 'lambda')).map(f => f.path).sort().join(),
    { check: s => s === 'lambda/mod.json,lambda/patches/p.json' });
  expect('chosen: mod.json installs its folder', () => install(readChosen(join(src, 'lambda', 'mod.json')), fresh()).added[0].id, { check: id => id === 'lambda' });
  mkdirSync(join(src, 'outside'));
  symlinkSync(join(src, 'outside'), join(src, 'lambda', 'link'), 'junction');
  expect('folder: a junction inside is refused', () => readFolder(join(src, 'lambda')), { throws: /is a link/ });
  writeFileSync(join(src, 'm.zip'), zip(modFiles('', 'mu')));
  expect('chosen: a .zip', () => install(readChosen(join(src, 'm.zip')), fresh()).added[0].id, { check: id => id === 'mu' });
  expect('chosen: anything else is refused', () => readChosen(join(src, 'lambda', 'patches', 'p.json')), { throws: /choose a mod/ });
}

// What the window sends for a drop.
{
  const b64 = s => Buffer.from(s).toString('base64');
  const items = itemsFromPage({ items: [{ name: 'a.zip', zip: zip(modFiles('', 'xi')).toString('base64') },
    { name: 'omicron', files: modFiles('omicron/', 'omicron').map(f => ({ path: f.name, data: b64(f.data) })) }] });
  expect('page: a zip and a folder become install items', () => install(items, fresh()).added.map(x => x.id).sort().join(), { check: s => s === 'omicron,xi' });
  expect('page: nothing to add', () => itemsFromPage({}), { throws: /nothing to add/ });
  expect('page: more than 20 items', () => itemsFromPage({ items: Array(21).fill({ name: 'x', zip: '' }) }), { throws: /nothing to add/ });
  expect('page: an item that is neither', () => itemsFromPage({ items: [{ name: 'odd', files: [{ path: 1, data: 'x' }] }] }), { throws: /odd: not a zip file or a folder/ });
  const big = zip([{ name: 'big', data: 'y'.repeat(20 * 1024 * 1024) }]).toString('base64');
  expect('page: the byte limit holds across zips', () => itemsFromPage({ items: [{ name: 'a', zip: big }, { name: 'b', zip: big }] }), { throws: /unpacks to more than 32 MB/ });
}

// A zip made by Windows PowerShell's Compress-Archive (backslash separators in 5.1), as players and package.mjs make them.
if (process.platform === 'win32') {
  const src = fresh(), out = join(src, 'nu.zip');
  placeMod(src, 'nu', 'nu');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:FROM -DestinationPath $env:TO'],
    { encoding: 'utf8', env: { ...process.env, FROM: join(src, 'nu'), TO: out } });
  if (r.status === 0) {
    const mods = fresh();
    expect('Compress-Archive zip installs', () => install(readChosen(out), mods).added[0], { check: x => x.id === 'nu' && existsSync(join(mods, 'nu', 'patches', 'p.json')) });
  } else console.log('skip Compress-Archive zip (PowerShell not available)');
}

rmSync(root, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) FAILED` : 'all install checks passed');
process.exit(failed ? 1 : 0);
