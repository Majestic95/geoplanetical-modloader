// Regression test for tools/asar_extract.py on tiny hand-built archives: files kept outside the archive (index entries
// marked "unpacked", stored in <app.asar>.unpacked) are copied only when their size and SHA-256 match the index, and
// an archive path that would leave the output folder refuses the whole run before anything is written.
// Needs Python 3 (PYTHON, or python / python3 on PATH). Usage: node tools/test-asar-extract.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('./asar_extract.py', import.meta.url));
// The first of PYTHON, python, python3 that runs.
const python = [process.env.PYTHON, 'python', 'python3'].filter(Boolean)
  .find(cmd => spawnSync(cmd, ['-c', 'import sys; sys.exit(sys.version_info[0] != 3)']).status === 0) ?? 'python';
const dir = mkdtempSync(join(tmpdir(), 'asar-test-'));
const sha = b => createHash('sha256').update(b).digest('hex');
const PACKED = Buffer.from('packed content\n');
const UNPACKED = Buffer.from('unpacked content\n');

// Electron's layout: uint32 4, uint32 header size; then the header (uint32 payload size, uint32 JSON length, JSON
// padded to 4 bytes); file data starts right after the header.
function archive(name, files, unpacked) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  const json = Buffer.from(JSON.stringify({ files }));
  const pad = (4 - json.length % 4) % 4;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(json.length + pad + 8, 4);
  head.writeUInt32LE(json.length + pad + 4, 8);
  head.writeUInt32LE(json.length, 12);
  writeFileSync(join(root, 'app.asar'), Buffer.concat([head, json, Buffer.alloc(pad), PACKED]));
  for (const [path, data] of Object.entries(unpacked)) {
    mkdirSync(join(root, 'app.asar.unpacked', 'r'), { recursive: true });
    writeFileSync(join(root, 'app.asar.unpacked', ...path.split('/')), data);
  }
  return join(root, 'app.asar');
}

const packedEntry = { size: PACKED.length, offset: '0' };
const unpackedEntry = (integrity = true) => ({
  size: UNPACKED.length, unpacked: true,
  ...(integrity && { integrity: { algorithm: 'SHA256', hash: sha(UNPACKED), blockSize: 4194304, blocks: [sha(UNPACKED)] } }),
});

function run(asar, out, ...prefixes) {
  const r = spawnSync(python, ['-I', tool, asar, out, ...prefixes], { encoding: 'utf8' });
  if (r.error) throw new Error(`cannot run ${python} (Python 3 is needed for the author tools; set PYTHON): ${r.error.message}`);
  return { code: r.status, text: r.stdout + r.stderr };
}
const inside = folder => existsSync(folder) ? readdirSync(folder) : [];
const files = out => existsSync(out) ? readdirSync(out, { recursive: true }).filter(p => p.endsWith('.js')).sort() : [];

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`);
  if (!ok) failed++;
}

try {
  const cases = [
    ['good', { 'p.js': packedEntry, 'u.js': unpackedEntry() }, { 'r/u.js': UNPACKED }, 0, /2 files \(1 from the archive, 1 from/],
    ['hash differs', { 'p.js': packedEntry, 'u.js': unpackedEntry() }, { 'r/u.js': Buffer.from('unpacked c0ntent\n') }, 1, /refused: \/r\/u\.js: SHA-256/],
    ['size differs', { 'p.js': packedEntry, 'u.js': unpackedEntry() }, { 'r/u.js': Buffer.concat([UNPACKED, Buffer.from('x')]) }, 1, /18 bytes, the index says 17/],
    ['missing', { 'p.js': packedEntry, 'u.js': unpackedEntry() }, {}, 1, /marked unpacked but .* is missing/],
    ['no integrity record (size only)', { 'u.js': unpackedEntry(false) }, { 'r/u.js': UNPACKED }, 0, /1 files \(0 from the archive, 1 from/],
  ];
  for (const [label, entries, unpacked, code, message] of cases) {
    const out = join(dir, `out-${label.replace(/\W+/g, '-')}`);
    const r = run(archive(label.replace(/\W+/g, '-'), { r: { files: entries } }, unpacked), out, '/r');
    check(`${label}: exit ${code}`, r.code === code, `exit ${r.code}, ${r.text.trim()}`);
    check(`${label}: message`, message.test(r.text), r.text.trim());
    if (code === 0) {
      for (const f of files(out)) {
        const want = f.endsWith('u.js') ? UNPACKED : PACKED;
        check(`${label}: ${f} bytes`, readFileSync(join(out, f)).equals(want), 'content differs');
      }
    } else {
      check(`${label}: refused file not written`, !files(out).some(f => f.endsWith('u.js')), files(out).join(', '));
    }
  }

  const out = join(dir, 'out-traverse');
  const r = run(archive('traverse', { r: { files: { 'p.js': packedEntry, '..': { files: { 'evil.js': packedEntry } } } } }, {}), out, '/r');
  check('.. path: exit 1', r.code === 1, `exit ${r.code}`);
  check('.. path: message', /unsafe path in the archive index: '\/r\/\.\.\/evil\.js'/.test(r.text), r.text.trim());
  check('.. path: nothing written', files(out).length === 0 && !existsSync(join(dir, 'evil.js')), files(out).join(', '));

  const none = run(join(dir, 'good', 'app.asar'), join(dir, 'out-none'), '/zzz');
  check('no match: exit 1', none.code === 1, `exit ${none.code}`);
  check('no match: message', /no file in the archive starts with \/zzz/.test(none.text), none.text.trim());

  const typo = run(join(dir, 'good', 'app.asar'), join(dir, 'out-typo'), '/r/p.js', '/r/typo');
  check('one prefix matches nothing: exit 1', typo.code === 1, `exit ${typo.code}`);
  check('one prefix matches nothing: names it', /starts with \/r\/typo$/m.test(typo.text), typo.text.trim());
  check('one prefix matches nothing: nothing written', files(join(dir, 'out-typo')).length === 0, files(join(dir, 'out-typo')).join(', '));

  for (const name of ['nul.js', 'nul .js', 'COM¹.txt', 'trailing.']) {
    const dev = run(archive('device', { r: { files: { [name]: packedEntry } } }, {}), join(dir, 'out-device'), '/r');
    check(`unwritable name ${JSON.stringify(name)}: refused`, dev.code === 1 && /unsafe path in the archive index/.test(dev.text), dev.text.trim());
  }

  const noHash = run(join(dir, 'no-integrity-record-size-only-', 'app.asar'), join(dir, 'out-warn'), '/r');
  check('no integrity record: warns', /warning: \/r\/u\.js: the index has no SHA-256/.test(noHash.text), noHash.text.trim());

  // A good extraction, then the same file changed at the same size: the refusal removes the older copy.
  const stale = archive('stale', { r: { files: { 'u.js': unpackedEntry() } } }, { 'r/u.js': UNPACKED });
  const staleOut = join(dir, 'out-stale');
  check('stale: first run exit 0', run(stale, staleOut, '/r').code === 0, 'first extraction failed');
  writeFileSync(join(dir, 'stale', 'app.asar.unpacked', 'r', 'u.js'), Buffer.from('unpacked c0ntent\n'));
  const again = run(stale, staleOut, '/r');
  check('stale: refused', again.code === 1, `exit ${again.code}`);
  check('stale: older copy removed, no temporary file left', inside(join(staleOut, 'r')).length === 0, inside(join(staleOut, 'r')).join(', '));
  check('stale: first run again exit 0', (writeFileSync(join(dir, 'stale', 'app.asar.unpacked', 'r', 'u.js'), UNPACKED), run(stale, staleOut, '/r').code === 0), 'extraction failed');
  rmSync(join(dir, 'stale', 'app.asar.unpacked', 'r', 'u.js'));
  const gone = run(stale, staleOut, '/r');
  check('stale: missing source removes the older copy', gone.code === 1 && inside(join(staleOut, 'r')).length === 0, gone.text.trim());
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'asar_extract: all passed');
process.exit(failed ? 1 : 0);
