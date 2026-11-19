// Checks for the launcher's programs (launcher/core.mjs): the settings entries, which files may be started, when a start
// is refused, the hand-off, the argument a program is given, and a start that fails. No program is started (a start
// that works opens a window).
// Usage: node launcher/test-programs.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanPrograms, cleanSettings, isConfirmed, downloaded, programName, programProblem, programRefusal, handOffRefusal, quoteArg, startProgram, MAX_PROGRAMS, HANDOFF_MS,
} from './core.mjs';
import { readProgram, scanPrograms, programStamp } from './programs.mjs';

let failed = 0;
async function expect(name, fn, check) {
  let r;
  try { r = await fn(); } catch (e) { failed++; console.log(`FAIL ${name}: threw ${e.message}`); return; }
  if (check(r)) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}: unexpected result ${JSON.stringify(r)?.slice(0, 300)}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'gpml-programs-'));
try {
  // Settings entries: kept only as { exe, name?, confirmed? }, each file once (any letter case), at most MAX_PROGRAMS.
  const rlo = String.fromCharCode(0x202e);
  await expect('settings: anything but a list is no programs', () => [null, {}, 'x', 1].map(cleanPrograms), r => r.every(l => Array.isArray(l) && !l.length));
  await expect('settings: entries without a text exe are dropped', () => cleanPrograms([{}, { exe: 1 }, { exe: '' }, null, [], 'C:\\x.exe', { exe: 'C:\\a.exe' }]),
    r => r.length === 1 && r[0].exe === 'C:\\a.exe');
  await expect('settings: one entry per file, whatever the letter case', () => cleanPrograms([{ exe: 'C:\\A\\b.exe' }, { exe: 'c:\\a\\B.EXE', confirmed: 'c:\\a\\B.EXE' }]),
    r => r.length === 1 && r[0].exe === 'C:\\A\\b.exe' && !isConfirmed(r[0]));
  await expect('settings: a name is kept when it is plain text, and trimmed', () => cleanPrograms([{ exe: 'C:\\a.exe', name: ' Mehrspieler - Beta 2 ' }]),
    r => r[0].name === 'Mehrspieler - Beta 2');
  await expect('settings: a name with direction or control characters, empty or too long is dropped',
    () => ['Evil' + rlo + 'exe.txt', 'a\nb', '', '   ', 'x'.repeat(61), 7].map(name => cleanPrograms([{ exe: 'C:\\a.exe', name }])[0]),
    r => r.every(p => !('name' in p)));
  await expect('settings: a confirmation counts only for the same path (an installer writing true, or an entry moved, is asked again)',
    () => cleanPrograms([{ exe: 'C:\\a.exe', confirmed: true }, { exe: 'C:\\b.exe', confirmed: 'C:\\old\\b.exe' }, { exe: 'C:\\c.exe', confirmed: 'C:\\c.exe' }]),
    r => !isConfirmed(r[0]) && !('confirmed' in r[0]) && !isConfirmed(r[1]) && isConfirmed(r[2]));
  await expect('settings: at most MAX_PROGRAMS', () => cleanPrograms(Array.from({ length: MAX_PROGRAMS + 3 }, (_, i) => ({ exe: `C:\\p${i}.exe` }))),
    r => r.length === MAX_PROGRAMS);
  await expect('settings: other fields are dropped', () => cleanPrograms([{ exe: 'C:\\a.exe', args: '--evil', extra: 1 }]),
    r => JSON.stringify(r) === JSON.stringify([{ exe: 'C:\\a.exe' }]));
  await expect('name: its own name, else the file name without .exe',
    () => [programName({ exe: 'D:\\MP\\GeoplaneticalMP.exe' }), programName({ exe: 'D:\\x.EXE', name: 'Online' })],
    r => r[0] === 'GeoplaneticalMP' && r[1] === 'Online');
  await expect('name: a file name with a direction character is shown with "?", an empty one as "program"',
    () => [programName({ exe: `D:\\Evil${rlo}exe.txt.exe` }), programName({ exe: 'D:\\.exe' })],
    r => r[0] === 'Evil?exe.txt' && r[1] === 'program');

  // Which files may be started.
  const exe = join(dir, 'program.exe');
  writeFileSync(exe, 'MZ');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  mkdirSync(join(dir, 'folder.exe'));
  await expect('file: an existing local .exe can be started', () => programProblem(exe), r => r === null);
  await expect('file: a relative path is refused', () => programProblem('program.exe'), r => /not a full path/.test(r));
  await expect('file: network and device paths are refused',
    () => ['\\\\server\\share\\program.exe', '//server/share/program.exe', '\\\\?\\C:\\program.exe', 'C:program.exe'].map(programProblem),
    r => r.every(p => /not a full path on this PC/.test(p)));
  await expect('file: a file that is not an .exe is refused', () => [programProblem(join(dir, 'notes.txt')), programProblem(`${exe}.`)],
    r => r.every(p => /not a program/.test(p)));
  mkdirSync(join(dir, 'sub', 'x.exe'), { recursive: true });
  await expect('file: a path that is not written plainly is refused (the path shown must be the file that starts)',
    () => [join(dir, 'sub', 'x.exe') + '\\..\\..\\program.exe', exe.replace(/\\/g, '/'), exe.replace('program.exe', '.\\program.exe'),
      exe.replace('program.exe', `pro${rlo}gram.exe`), exe.replace('program.exe', `pro${String.fromCharCode(0x200b)}gram.exe`),
      `${join(dir, 'notes.txt')}:p.exe`, `${dir}\\${'a'.repeat(260)}.exe`].map(programProblem),
    r => r.every(p => /not written plainly|not a full path/.test(p)));
  const modsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'mods');
  await expect('file: a program inside the mods folder is refused (mods are data)', () => {
    const hadMods = existsSync(modsDir);
    mkdirSync(join(modsDir, 'gpml-test-program'), { recursive: true });
    mkdirSync(join(modsDir, '..gpml-test-program'), { recursive: true });
    writeFileSync(join(modsDir, 'gpml-test-program', 'tool.exe'), 'MZ');
    writeFileSync(join(modsDir, '..gpml-test-program', 'tool.exe'), 'MZ');
    try { return [programProblem(join(modsDir, 'gpml-test-program', 'tool.exe')), programProblem(join(modsDir, '..gpml-test-program', 'tool.exe'))]; } finally {
      for (const d of hadMods ? ['gpml-test-program', '..gpml-test-program'] : ['']) rmSync(join(modsDir, d), { recursive: true, force: true });
    }
  }, r => r.every(p => /inside the mods folder/.test(p)));
  await expect('file: a file Windows marks as downloaded is known as such', () => {
    const before = downloaded(exe);
    writeFileSync(`${exe}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
    return [before, downloaded(exe)];
  }, r => r[0] === false && r[1] === true);
  await expect('file: a missing file is refused', () => programProblem(join(dir, 'gone.exe')), r => /not there any more/.test(r));
  await expect('file: a folder named .exe is refused', () => programProblem(join(dir, 'folder.exe')), r => /not a file/.test(r));
  await expect('file: the loader itself is refused', () => programProblem(process.execPath), r => /this loader/.test(r));
  await expect('file: no text is refused', () => [programProblem(null), programProblem(5)], r => r.every(p => /not a full path/.test(p)));

  // When a start is refused (the checks that need no Steam or Windows; launcher/gui.mjs adds those).
  const game = { build: '1' };
  const mod = (id, requires = []) => ({ id, name: id.toUpperCase(), requires, builds: ['1'], patches: [] });
  const ctx = (over = {}) => ({ game, mods: [mod('a')], broken: [], settings: { enabled: {} }, saved: {}, ...over });
  const p = { exe, confirmed: exe };
  await expect('refusal: none for a confirmed program with mods that load', () => programRefusal(p, ctx()), r => r === null);
  await expect('refusal: none with no mod switched on (a program may play without mods)',
    () => programRefusal(p, ctx({ settings: { enabled: { a: false } }, saved: { a: false } })), r => r === null);
  await expect('refusal: a dry run starts no program', () => programRefusal(p, ctx({ dryRun: true })), r => /Dry run/.test(r));
  await expect('refusal: a missing file, named with its path', () => programRefusal({ exe: join(dir, 'gone.exe') }, ctx()),
    r => /cannot be started: the file is not there any more \(.*gone\.exe\)/.test(r));
  await expect('refusal: an unconfirmed entry needs the confirmation', () => [programRefusal({ exe }, ctx()), programRefusal({ exe }, ctx({ confirmed: true }))],
    r => /Confirm that you want to start/.test(r[0]) && r[1] === null);
  await expect('refusal: no game found', () => programRefusal(p, ctx({ game: null })), r => /game folder first/.test(r));
  await expect('refusal: switched-on mods that cannot load together, with Play\'s message',
    () => programRefusal(p, ctx({ mods: [mod('b', ['off']), mod('off')], settings: { enabled: { off: false } }, saved: { off: false } })),
    r => r === 'B needs OFF (off) loaded with it: switch OFF on too.');
  await expect('refusal: switches the settings file does not hold (a save failed)',
    () => programRefusal(p, ctx({ settings: { enabled: { a: false } }, saved: {} })), r => /could not be saved to launcher-settings\.json/.test(r));

  // The hand-off after a start: the program's minute, ended early when it exits.
  const t = 1_000_000;
  const started = { at: t, name: 'Online', pid: 4242 };
  await expect('hand-off: refused within the minute while the program runs', () => handOffRefusal(started, t + 1000, () => true),
    r => /Online was just started and starts the game itself/.test(r));
  await expect('hand-off: over once the program has exited', () => handOffRefusal(started, t + 1000, () => false), r => r === null);
  await expect('hand-off: over after the minute', () => handOffRefusal(started, t + HANDOFF_MS, () => true), r => r === null);
  await expect('hand-off: without a process id, the minute counts', () => handOffRefusal({ ...started, pid: null }, t + 1000, () => false), r => !!r);
  await expect('hand-off: none before any start', () => handOffRefusal(null, t), r => r === null);

  // The argument as Windows hands it to the program: the loader folder arrives as one argument, unchanged.
  const probe = join(dir, 'probe.js');
  writeFileSync(probe, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  for (const folder of [join(dir, 'plain'), join(dir, 'a b&c%PATH%^(x) [1]'), 'F:\\', 'C:\\with space\\', 'C:\\x"y', '']) {
    await expect(`argument: ${JSON.stringify(folder)} arrives unchanged`, () => {
      // (verbatim: the command line is exactly these words, so the program's own path is quoted here too)
      const r = spawnSync(process.execPath, [quoteArg(probe), '--loader', quoteArg(folder)],
        { windowsVerbatimArguments: true, argv0: quoteArg(process.execPath), encoding: 'utf8' });
      return JSON.parse(r.stdout);
    }, argv => argv.length === 2 && argv[0] === '--loader' && argv[1] === folder);
  }

  // A start Windows refuses is reported as text, and nothing is left running.
  await expect('start: a failed start is reported', () => startProgram(join(dir, 'gone.exe'), dir), r => typeof r.error === 'string' && r.error.length > 0 && !('pid' in r));

  // Program folders (launcher/programs.mjs): program.json read strictly, the .exe inside the folder.
  const programs = join(dir, 'programs');
  const place = (folder, json, exe = 'Multi.exe') => {
    mkdirSync(join(programs, folder), { recursive: true });
    writeFileSync(join(programs, folder, 'program.json'), typeof json === 'string' ? json : JSON.stringify(json));
    if (exe) writeFileSync(join(programs, folder, exe), 'MZ');
    return join(programs, folder);
  };
  const good = (id, extra = {}) => ({ format: 1, id, name: 'Multi', version: '1.0', description: 'Plays with friends.', exe: 'Multi.exe', ...extra });
  await expect('program folder: a good program.json reads, the .exe as a full path', () => readProgram(place('ok', good('ok', { author: 'A', builds: ['26734764'] }))),
    p => p.id === 'ok' && p.exe === join(programs, 'ok', 'Multi.exe') && p.author === 'A' && p.builds.join() === '26734764');
  for (const [what, json, re] of [
    ['an unknown field', good('u', { run: 'x' }), /unknown field "run"/],
    ['a missing field', (({ description, ...rest }) => rest)(good('m')), /missing field "description"/],
    ['a newer format', good('n', { format: 2, extra: 1 }), /needs a newer loader/],
    ['an id that is not one', good('Not An Id'), /id must be text/],
    ['a name with a direction character', good('d', { name: `Evil${String.fromCharCode(0x202e)}exe` }), /plain text/],
    ['an exe outside the folder', good('o', { exe: '../Multi.exe' }), /exe must be/],
    ['an exe that is not .exe', good('x', { exe: 'run.bat' }), /exe must be/],
    ['builds that are not build ids', good('b', { builds: [26734764] }), /builds must be/],
    ['text that is not JSON', '{ nope', /program\.json/],
  ]) {
    await expect(`program folder: refused: ${what}`, () => { try { readProgram(place(`bad-${what.replace(/\W+/g, '-')}`, json)); return null; } catch (e) { return e.message; } }, m => re.test(m || ''));
  }
  await expect('program folder: refused: its .exe is missing', () => { try { readProgram(place('noexe', good('noexe'), null)); return null; } catch (e) { return e.message; } }, m => /not in the program's folder/.test(m || ''));
  await expect('program folders: the good ones listed, the bad ones broken with their folder', () => scanPrograms(programs),
    r => r.programs.map(p => p.id).join() === 'ok' && r.broken.some(b => b.folder === 'noexe') && r.broken.every(b => typeof b.error === 'string'));
  place('ok-copy', good('ok'));
  await expect('program folders: two folders with one id are both refused', () => scanPrograms(programs),
    r => !r.programs.some(p => p.id === 'ok') && r.broken.filter(b => b.id === 'ok').length === 2);
  await expect('program folders: no programs folder, no programs', () => scanPrograms(join(dir, 'none')), r => !r.programs.length && !r.broken.length);
  // The stamp: a SHA-256 of the whole folder, so any change is asked again, whatever its size and time.
  const okDir = join(programs, 'ok'), okExe = join(okDir, 'Multi.exe');
  const before = programStamp(okDir);
  await expect('stamp: the same files, the same stamp', () => programStamp(okDir), s => !!before && s === before);
  const { mtime } = statSync(okExe);
  writeFileSync(okExe, 'MX'); utimesSync(okExe, mtime, mtime); // (same size, same time, other bytes)
  await expect('stamp: other bytes of the same size and time give another stamp', () => programStamp(okDir), s => !!s && s !== before);
  writeFileSync(okExe, 'MZ'); utimesSync(okExe, mtime, mtime);
  await expect('stamp: back to the same bytes, back to the same stamp', () => programStamp(okDir), s => s === before);
  writeFileSync(join(okDir, 'helper.dll'), 'code beside the exe');
  await expect('stamp: a file added beside the .exe gives another stamp', () => programStamp(okDir), s => !!s && s !== before);
  await expect('stamp: a missing folder has none', () => programStamp(join(programs, 'gone')), s => s === null);
  if (process.platform === 'win32') {
    const target = join(dir, 'elsewhere'); mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'x.dll'), 'x');
    const r = spawnSync('cmd', ['/c', 'mklink', '/J', join(okDir, 'lib'), target], { encoding: 'utf8' });
    if (r.status === 0) {
      await expect('program folder: a link inside it is refused', () => { try { readProgram(okDir); return null; } catch (e) { return e.message; } }, m => /is a link/.test(m || ''));
      rmSync(join(okDir, 'lib'), { recursive: false, force: true });
    } else console.log('skip junction check (mklink failed)');
  }

  // Settings: the loader's own program keys kept only in the shape it writes.
  await expect('settings: playWith kept as text, dropped otherwise', () => [cleanSettings({ playWith: 'mp' }).playWith, cleanSettings({ playWith: 7 }).playWith, cleanSettings({ playWith: 'x'.repeat(301) }).playWith, cleanSettings({ playWith: '' }).playWith],
    r => r[0] === 'mp' && r.slice(1).every(v => v === undefined));
  await expect('settings: confirmedPrograms keeps text entries only', () => [cleanSettings({ confirmedPrograms: { a: 'sha256:1', b: 2, c: null } }).confirmedPrograms, cleanSettings({ confirmedPrograms: [1] }).confirmedPrograms, cleanSettings({}).confirmedPrograms],
    r => JSON.stringify(r[0]) === '{"a":"sha256:1"}' && JSON.stringify(r[1]) === '{}' && JSON.stringify(r[2]) === '{}');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `${failed} program check(s) FAILED` : 'all program checks passed');
process.exit(failed ? 1 : 0);
