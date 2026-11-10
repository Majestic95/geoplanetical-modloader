// What the player launcher does, shared by its two front ends (launcher/gui.mjs, the window; launcher/console.mjs,
// the text menu): the files beside the executable, the settings file, the log, building the chosen mods into the
// game's code (read from the game's app.asar and the files beside it), and starting the game (through Steam, or the
// loader's frozen copy of the pinned build) while serving the patched code to its workers. The Steam game's files are
// never written. Code the game runs outside its window (its simulation, from game 1.0.9 on) is written into the frozen
// copy for the session and put back afterwards (patcher/copy-bundles.mjs), so such mods play only in the frozen game.
import { readFileSync, writeFileSync, appendFileSync, statSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, basename, resolve, isAbsolute, normalize, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Script, compileFunction } from 'node:vm';
import { isSea } from 'node:sea';
import { buildBundle } from '../patcher/patch-engine.mjs';
import { requirementProblem, orderMods } from '../patcher/mods.mjs';
import { findGame, originalBundle, unpackedBundles, gameRunning } from '../patcher/game.mjs';
import { launchAndServe } from '../patcher/runner.mjs';
import { PIN, checkFolder, checkProblem, copySavesOnce, steamRunning, errorCode } from '../patcher/frozen.mjs';
import { PAGE, PAGE_BUNDLE } from '../patcher/session.mjs';
import { settleCopy, writeBundles, restoreBundles, noteWrap, readNotes, noteJudge, newNonce } from '../patcher/copy-bundles.mjs';

export const VERSION = '0.7.0';
export const PRODUCT = 'Geoplanetical Mod Loader';
// Packaged: everything sits beside the executable. Development: the repository root (mods/ is the repo's).
export const BASE = isSea() ? dirname(process.execPath) : join(dirname(fileURLToPath(import.meta.url)), '..');
export const MODS = join(BASE, 'mods');
const SETTINGS = join(BASE, 'launcher-settings.json');
export const LOG = join(BASE, 'launcher.log');

// A log that writes launcher.log and passes each line to the front end's `show(line)`. Messages can carry text from a
// mod (its name, a file name, a page script's error): control and direction characters are replaced and further lines
// indented, so no message can pass for a line of its own.
export function makeLog(show) {
  return text => {
    // eslint-disable-next-line no-control-regex
    const msg = String(text).replace(/\r?\n/g, '\n    ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '?');
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    try { show(line); } catch { /* the front end may be gone */ }
    try { appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* the log is a convenience */ }
  };
}

// The settings file is the player's to edit: anything but a plain object (or a gameDir that is not text) is ignored.
export function readSettings() {
  let s;
  try { s = JSON.parse(readFileSync(SETTINGS, 'utf8')); } catch (e) { return { enabled: {}, programs: [], ...(e.code === 'ENOENT' ? {} : { unreadable: true }) }; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { enabled: {}, programs: [], unreadable: true };
  if (typeof s.gameDir !== 'string') delete s.gameDir;
  if (s.play !== 'live' && s.play !== 'frozen') delete s.play;
  if (!s.enabled || typeof s.enabled !== 'object' || Array.isArray(s.enabled)) s.enabled = {};
  s.programs = cleanPrograms(s.programs);
  return s;
}
// Writes the settings (`unreadable` is not a setting); true when written.
export function saveSettings(s, log) {
  const { unreadable, ...keep } = s;
  try { writeFileSync(SETTINGS, JSON.stringify(keep, null, 2) + '\n'); return true; } catch (e) { log(`could not save settings: ${e.message}`); return false; }
}

// One loader at a time (the window or the text menu): two would both start the game on the same debug port and serve
// it twice, or both work on the frozen game's folder. The pipe keeps the name of the 0.2 launcher (and the window
// profile below its folder) so an older copy and this one exclude each other. Resolves true when this process holds
// it (until it exits).
const LOCK_PIPE = '\\\\.\\pipe\\geoplanetical-mod-launcher';
export function takeLock() {
  const lock = createNetServer();
  // (unref: the lock alone does not keep the process running)
  return new Promise(resolve => { lock.once('error', () => resolve(false)); lock.listen(LOCK_PIPE, () => { lock.unref(); resolve(true); }); });
}

export const isEnabled = (settings, m) => settings.enabled[m.id] !== false;

// Which game Play starts (launcher-settings.json `play`): the frozen copy of the pinned build (patcher/frozen.mjs),
// the default, or the live Steam game.
export const playChoice = settings => (settings.play === 'live' ? 'live' : 'frozen');
// The frozen copy as a game: its build is the pin (its files are checked against it before each start), whatever
// state the copy is in; `ready` says whether the last check found it in place.
export const frozenGame = (places, ready) => places && {
  dir: places.game, dataDir: places.data, notes: places.notes, build: PIN.build, frozen: true, ready: !!ready, updating: false, targetBuild: null,
};

// The mods among `mods` that change code `game` runs outside its window (patcher/copy-bundles.mjs): they
// play only in the frozen game, and run there with the same access to the PC as any program.
export function outsideMods(mods, game) {
  if (typeof game?.dir !== 'string') return [];
  const outside = unpackedBundles(game.dir);
  return mods.filter(m => m.patches.some(p => outside.has(p.bundle)));
}
const names = list => list.map(m => m.name).join(', ');
// The game Play and the programs use: the frozen game, or the live one (findGame's, or null when not found).
export const chosenGame = (settings, frozen, live) => (playChoice(settings) === 'live' ? live : frozen);

// Programs (docs/authoring.md#programs): other programs that start the game with this loader's mods, such as a
// multiplayer launcher. The player adds one with a file dialog, or a program's installer adds an entry to
// launcher-settings.json: { "exe": "<full path of the .exe>", "name"?: "<shown on its button>" }. The loader starts
// it as `<exe> --loader "<this loader's folder>"` and does not start the game itself; the program reads the mods
// folder and the switches here and starts the game. The loader records the player's consent to start a file as
// "confirmed": that same path (picked in the dialog, or its full path confirmed before its first start); an entry for
// another path, or without it, is confirmed again. Installers do not write it.
export const MAX_PROGRAMS = 8;
// A name shown on a button: letters, marks, digits, punctuation, symbols and spaces (no control or direction characters).
const PROGRAM_NAME = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]{1,60}$/u;
export function cleanPrograms(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.exe !== 'string' || !p.exe) continue;
    if (out.some(o => sameExe(o.exe, p.exe)) || out.length >= MAX_PROGRAMS) continue;
    const name = typeof p.name === 'string' && PROGRAM_NAME.test(p.name.trim()) ? p.name.trim() : null;
    out.push({ exe: p.exe, ...(name ? { name } : {}), ...(p.confirmed === p.exe ? { confirmed: p.exe } : {}) });
  }
  return out;
}
export const sameExe = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
export const isConfirmed = p => p.confirmed === p.exe;
// Its own name, else the file name without .exe, with anything a name cannot hold shown as "?".
export const programName = p => p.name ||
  (basename(p.exe).replace(/\.exe$/i, '').replace(/[^\p{L}\p{M}\p{N}\p{P}\p{S} ]/gu, '?').slice(0, 60) || 'program');

// Why the loader will not start `exe`, or null: it must be a .exe file on one of this PC's drives (not a \\server path,
// also not through a link), written plainly (the path the player is shown is the file that starts), not inside the mods
// folder (mods are data: a mod cannot bring a program), and not the loader.
// (\p{C}: control, format such as direction marks and zero-width characters, private-use and unassigned characters)
const UNSAFE_PATH = /[\p{C}\p{Zl}\p{Zp}]/u;
export function programProblem(exe) {
  if (typeof exe !== 'string' || !isAbsolute(exe) || !/^[A-Za-z]:\\/.test(exe)) return 'it is not a full path on this PC';
  if (exe.length > 260 || UNSAFE_PATH.test(exe) || exe.includes(':', 2) || normalize(exe) !== exe) {
    return 'its path is not written plainly (choose the file with Add program)';
  }
  if (!/\.exe$/i.test(exe)) return 'it is not a program (.exe file)';
  let st, real;
  try { st = statSync(exe); real = realpathSync.native(exe); } catch { return 'the file is not there any more'; }
  if (!st.isFile()) return 'it is not a file';
  if (!/^[A-Za-z]:\\/.test(real)) return 'it is on another computer (a network share)';
  if ([exe, real].some(p => { const r = relative(MODS, p); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); })) {
    return 'it is inside the mods folder (mods cannot bring programs)';
  }
  if (sameExe(real, process.execPath)) return 'it is this loader';
  return null;
}

// Whether Windows marks `exe` as downloaded from the internet (its Zone.Identifier says so). Such a file is confirmed
// in the window before its first start even when the player picked it: Windows itself does not ask when a program
// is started this way.
export function downloaded(exe) {
  try { return /ZoneId=[34]/.test(readFileSync(`${exe}:Zone.Identifier`, 'utf8')); } catch { return false; }
}

// Why program `p` cannot be started now, or null: what can be told without asking Windows (the caller also checks
// Steam's update state, whether the game runs, and the hand-off below). The same checks as Play, except that a program
// may run with no mod switched on: it plays the mods the loader would play. `saved`: the switches as
// launcher-settings.json holds them, which is what the program reads.
export function programRefusal(p, { confirmed = false, dryRun = false, game, mods, broken = [], settings, saved }) {
  const name = programName(p);
  if (dryRun) return 'Dry run: programs are not started.';
  const problem = programProblem(p.exe);
  if (problem) return `${name} cannot be started: ${problem} (${p.exe}). Remove it, or add it again from where it is now.`;
  if (!isConfirmed(p) && !confirmed) return `Confirm that you want to start ${p.exe} first.`;
  if (!game) return 'Choose the game folder first.';
  if (game.frozen && !game.ready) return FROZEN_NOT_READY;
  const { error, chosen } = chooseMods(mods, settings, game, broken);
  if (error) return error;
  // A program starts the game itself: code this game version runs outside its window is changed only by the loader's
  // own Play (playSession), so a program would play those mods unmodded.
  const outside = outsideMods(chosen, game);
  if (outside.length) {
    return `${names(outside)} ${outside.length > 1 ? 'change' : 'changes'} the game's simulation, which this game version runs outside the game ` +
      `window: for now only this loader's Play with mods can apply that, not ${name}. Switch ${outside.length > 1 ? 'them' : 'it'} off to start ${name}.`;
  }
  if (!sameSwitches(saved, settings.enabled)) {
    return `The mod switches could not be saved to launcher-settings.json (see the log), and ${name} reads them from there. ` +
      'Check that the loader\'s folder is not read-only, then try again.';
  }
  return null;
}
const sameSwitches = (a, b) => {
  const off = e => Object.keys(e || {}).filter(k => e[k] === false).sort().join('\n');
  return off(a) === off(b);
};

// After a program is started it starts the game itself: until HANDOFF_MS have passed, or the program has exited, the
// loader starts neither the game nor another program and keeps the switches and the mods folder as they are (the
// program reads them while it starts). `handedOff`: { at, name, pid } of the last start (pid null if unknown).
export const HANDOFF_MS = 60000;
export function handOffRefusal(handedOff, now = Date.now(), alive = pidAlive) {
  if (!handedOff || now - handedOff.at >= HANDOFF_MS) return null;
  if (handedOff.pid && !alive(handedOff.pid)) return null;
  return `${handedOff.name} was just started and starts the game itself. Wait for it, or close it first.`;
}
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// A command-line argument as Windows programs read it (CommandLineToArgvW): quoted when it holds a space or a quote,
// with the backslashes before a quote and at the end doubled.
export const quoteArg = a => (a && !/[\s"]/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);

// A program's arguments: the loader's folder, and the frozen copy's folder when the player plays the frozen game
// (docs/authoring.md#programs).
export const programArgs = (loaderDir, gameDir = null) => `--loader ${quoteArg(loaderDir)}${gameDir ? ` --game ${quoteArg(gameDir)}` : ''}`;

// Starts `exe --loader "<loader folder>" [--game "<frozen copy>"]` in the program's folder through Windows (ShellExecute, as Explorer does): a
// console program gets a console window of its own. Windows shows no warning for a downloaded program started this way
// (see downloaded). The command is constant; the paths reach it only through environment variables, which are removed
// before the program starts, and are taken as they are (Start-Process would read [ and ] in a path as wildcards and
// could start another file). Resolves { pid } (null when Windows does not say) when started, or { error }. Gives up
// after `timeoutMs` (a warning nobody answers).
export const START_TIMEOUT_MS = 120000;
export function startProgram(exe, loaderDir = BASE, { timeoutMs = START_TIMEOUT_MS, gameDir = null } = {}) {
  const command = "$ErrorActionPreference = 'Stop'; try { $i = New-Object System.Diagnostics.ProcessStartInfo; " +
    '$i.FileName = $env:GPML_PROGRAM; $i.Arguments = $env:GPML_PROGRAM_ARGS; $i.WorkingDirectory = $env:GPML_PROGRAM_DIR; ' +
    '$i.UseShellExecute = $true; Remove-Item Env:GPML_PROGRAM, Env:GPML_PROGRAM_ARGS, Env:GPML_PROGRAM_DIR; ' +
    "$p = [System.Diagnostics.Process]::Start($i); 'started ' + $(if ($p) { $p.Id } else { '' }) } " +
    "catch { $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }; 'failed: ' + $e.Message }";
  return new Promise(done => {
    let out = '';
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GPML_PROGRAM: exe, GPML_PROGRAM_ARGS: programArgs(loaderDir, gameDir), GPML_PROGRAM_DIR: dirname(exe) },
    });
    const timer = setTimeout(() => { child.kill(); done({ error: `Windows did not start it within ${timeoutMs / 1000} seconds` }); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.on('error', e => { clearTimeout(timer); done({ error: `PowerShell could not be started (${e.message})` }); });
    child.on('close', () => {
      clearTimeout(timer);
      // The last line is the answer (a profile or module may have printed something before it).
      const last = out.trim().split(/\r?\n/).pop().trim();
      const started = last.match(/^started ?(\d*)$/);
      done(started ? { pid: Number(started[1]) || null } : { error: last.replace(/^failed: /, '') || 'Windows did not start it' });
    });
  });
}

// The mods to load for `game`: those switched on that are made for its build, each after the mods it requires.
// { chosen } (possibly empty) or { error } when a required mod is off, missing, broken (`broken`: scanMods' list) or
// not made for this build.
export function chooseMods(mods, settings, game, broken = []) {
  const on = mods.filter(m => isEnabled(settings, m) && m.builds.includes(game.build));
  for (const m of on) {
    for (const r of m.requires || []) {
      const other = mods.find(o => o.id === r);
      if (other && !other.builds.includes(game.build)) {
        return { error: `${m.name} needs ${other.name}, which is not made for this game version yet.` };
      }
    }
  }
  const problem = requirementProblem(on, mods, broken);
  if (problem) return { error: problem.replace(/\.?$/, '.') };
  try { return { chosen: orderMods(on) }; } catch (e) { return { error: `${e.message}.` }; }
}

// Why Play has nothing to play when chooseMods chose no mod: mods switched on but made for another build (say which
// game they are made for), or no mod switched on at all.
export function noModsMessage(mods, settings, game) {
  const on = mods.filter(m => isEnabled(settings, m));
  if (!on.length) return 'No mod is switched on. Start the game from Steam as usual to play without mods.';
  const other = game.frozen ? null : on.some(m => m.builds.includes(PIN.build)) ? ' Play the frozen game instead: they are made for it.' : null;
  return `None of the mods switched on is made for this game version (build ${game.build}).${other ?? ' Wait for updated versions of them.'}`;
}

// Steam installs a pending update before it starts the game, so the mods would meet a different game version. Returns
// the reason the game cannot be started now, or null.
// The frozen copy is not Steam's to update: its checks are prepareFrozen's.
export function launchBlocker(settings, game) {
  if (game?.frozen) return null;
  const now = findGame(settings.gameDir || null);
  if (now?.updating) {
    return `Steam is updating Geoplanetical${now.targetBuild ? ` (to build ${now.targetBuild})` : ''}. Let the update finish ` +
      'first; then the loader shows whether the mods are ready for the new version.';
  }
  if (!now || now.build !== game.build) return 'The game changed since the loader opened. Close the loader and open it again.';
  return null;
}

export const FROZEN_NOT_READY = 'The frozen game is not set up yet: get it first (Frozen game, above), or choose the live Steam game.';

// Right before the frozen copy starts (Play, or a program given --game), in this order: for the loader's own Play
// (`saves`), the Steam game's saves are copied into the copy's saves the first time; Steam must run (the game started
// outside Steam would otherwise run without the player's account); and last the copy must match the pin (its sizes,
// the archive's index and every file outside the archive: patcher/frozen.mjs), so that nothing slow runs between that
// check and the start (only the write of the bundles the game runs outside its window: playSession). Resolves { dir } (the checked folder as it is on disk: start it from there, at once) or
// { error } (why it cannot start).
export async function prepareFrozen(game, log, { saves = true, steam = true, inUse = gameRunning } = {}) {
  // Files a session wrote into the copy are put back first: the check is of the pinned build, and a program handed the
  // copy gets that build.
  try {
    if (settleCopy(game.dir, { log, inUse }).state === 'in-use') return { error: 'Geoplanetical is running. Close it, then try again.' };
  } catch (e) {
    log(`could not put the frozen game's own files back: ${errorCode(e)}`);
    return { error: `The frozen game's own files could not be put back (${errorCode(e)}). Nothing was started; try again.` };
  }
  if (saves) {
    try {
      const s = await copySavesOnce(game.dataDir);
      if (!s.already) log(`copied ${s.files} save file(s) of the Steam game into the frozen game's own saves (once; ${(s.bytes / 1024 ** 2).toFixed(0)} MB)`);
    } catch (e) {
      log(`could not copy the Steam saves: ${errorCode(e)}`);
      return { error: `Your Steam saves could not be copied into the frozen game's saves (${errorCode(e)}). Nothing was started; try again.` };
    }
  }
  if (steam) {
    try { if (!steamRunning()) return { error: 'Steam is not running. Start Steam and sign in, then try again: the frozen game needs it for your account.' }; } catch (e) {
      log(`could not tell whether Steam is running: ${e.message}`);
      return { error: 'Could not tell whether Steam is running. Start Steam and sign in, then try again.' };
    }
  }
  const r = await checkFolder(game.dir);
  if (!r.ok) {
    log(`frozen copy check failed: ${r.reason}${r.code ? ` (${r.code})` : ''}`);
    return { error: `${checkProblem(r, 'The frozen game')} Get it again (Frozen game, above).` };
  }
  log(`frozen copy checked: build ${PIN.build} (game ${PIN.version})`);
  return { dir: r.dir };
}

// Builds the chosen mods into the game's code and checks it compiles: { payloads, disk, scripts } or { error }.
// payloads: the bundles served through the game's window (patcher/session.mjs); disk: those the game runs outside its
// window, written into the frozen copy for the session (playSession), so refused for the live game. The page scripts
// (already parsed when the mods were read) go in load order.
export function buildMods(game, chosen, log, { inUse = gameRunning } = {}) {
  log(`building ${chosen.map(m => `${m.name} ${m.version}`).join(', ')} for build ${game.build}`);
  const outside = outsideMods(chosen, game);
  if (outside.length && !game.frozen) {
    log(`${names(outside)}: changes code this game version runs outside its window; refused for the Steam game`);
    return {
      error: `${names(outside)} ${outside.length > 1 ? 'change' : 'changes'} the game's simulation, which this game version runs outside ` +
        `the game window: the loader can change that only in the frozen game, never in your Steam game. Play the frozen game, or switch ${outside.length > 1 ? 'them' : 'it'} off.`,
    };
  }
  if (game.frozen) {
    // A copy left changed by an earlier session is put back before its files are read.
    try {
      const s = settleCopy(game.dir, { log, inUse });
      if (s.state === 'in-use') return { error: 'Geoplanetical is running. Close it, then press Play again.' };
      if (s.refused.length) {
        return { error: `The frozen game's own ${s.refused.join(', ')} could not be put back: the copy the loader kept of it is damaged. Get the frozen game again (Frozen game, above).` };
      }
    } catch (e) {
      log(`could not put the frozen game's own files back: ${errorCode(e)}`);
      return { error: `The frozen game's own files could not be put back (${errorCode(e)}). Nothing was started; try again.` };
    }
  }
  if (outside.length) {
    log(`${names(outside)} ${outside.length > 1 ? 'change' : 'changes'} the game's simulation: written into the frozen game for this session ` +
      'and put back when it closes (your Steam game is never changed). Such mods run inside the game with the same access to your PC as any program.');
  } else log('read-only: the game files are read, never changed');
  const outsideNames = unpackedBundles(game.dir);
  const payloads = new Map(), disk = new Map();
  const scripts = chosen.flatMap(m => m.scripts.map(s => ({ mod: m.id, path: s.path, text: s.text })));
  if (scripts.length) log(`page: ${scripts.length} script(s) ready (${scripts.map(s => `${s.mod}/${s.path}`).join(', ')})`);
  try {
    for (const bundle of [...new Set(chosen.flatMap(m => m.patches.map(p => p.bundle)))].sort()) {
      const r = buildBundle(originalBundle(game, bundle), chosen, { build: game.build, bundle });
      if (!r) continue;
      // Compile only: a broken result never reaches the game. A bundle the game loads with require() is compiled as
      // require compiles it (inside a function of exports, require, module, __filename, __dirname: `let module` is
      // fine in a page worker and an error there).
      if (outsideNames.has(bundle)) compileFunction(r.text, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: bundle });
      else new Script(r.text, { filename: bundle });
      (outsideNames.has(bundle) ? disk : payloads).set(bundle, r.text);
      log(`${bundle}: ${r.report.length} change(s) ready`);
      const entries = r.report.filter(e => e.entry).map(e => `${e.mod}: ${e.entry}`);
      if (entries.length) log(`wording changed: ${entries.join(', ')}`);
    }
  } catch (e) {
    log(`the mods could not be applied: ${e.message}`);
    return { error: `The mods could not be applied: ${e.message}. Nothing was started. Switch the named mod off, or check for an updated version of it.` };
  }
  return { payloads, disk, scripts };
}

// Until no Geoplanetical process runs (a failed look counts as running): the frozen copy's files must not change while
// one of the game's processes may still load them.
async function untilClosed(log, inUse, { everyMs = 2000, misses = 3 } = {}) {
  let told = false, gone = 0;
  for (;;) {
    let running = true;
    try { running = inUse(); } catch { /* cannot tell: wait */ }
    // (several looks in a row: the game's startup guard can relaunch it, leaving a moment with no process)
    gone = running ? 0 : gone + 1;
    if (gone >= misses) return;
    if (running && !told) { log('waiting for Geoplanetical to close, to put the frozen game\'s own files back'); told = true; }
    await new Promise(r => setTimeout(r, everyMs));
  }
}

// Starts the game through Steam (or `frozen`, { dir, dataDir, notes }: the frozen copy, after prepareFrozen) and serves
// it until it closes. Resolves { problem, warning, message } at the end of the
// session; onSwap({ bundle, status }) also reports each worker swap and the page scripts (bundle PAGE) as they happen.
// `disk` (buildMods): bundles the game runs outside its window. They are written into the frozen copy right before the
// start, reported from the notes their code leaves (patcher/copy-bundles.mjs: patched once loaded, broken if it threw
// while starting; one that never started is not a problem, since no other code can run in its place), and put back
// once no Geoplanetical process runs, which this waits for even when the connection to the game was lost.
// A page script runs beside the game's own code, so one that fails is a warning (what a mod shows on screen may be
// missing), not a problem (the game possibly unmodded). A script that threw stays a warning for the session; one that
// did not run stops being one once a later page load runs it. Wording changes that are not active are a warning too: the
// game runs its own code and only its text differs; a later page load that has them ends the warning. The one exception
// is the status broken: the changed code failed and the page was left that way, which is a problem like a broken worker.
export async function playSession({ steam, frozen = null, port, payloads, disk = new Map(), scripts = [], chosen, log, onSwap: report = () => {}, inUse = gameRunning }) {
  if (disk.size && !frozen?.notes) {
    log(`${[...disk.keys()].join(', ')}: can only be written into the frozen game; nothing was started`);
    return { problem: true, warning: false, message: 'These mods play only in the frozen game. Nothing was started.' };
  }
  log(`starting Geoplanetical ${frozen ? `from the frozen copy (build ${PIN.build})` : 'through Steam'} with ${chosen.map(m => m.name).join(', ')}`);
  let problem = false, pageFailed = false, pageMissing = false, wordingMissing = false, wordingBroken = false;
  const confirmed = new Set();
  const onSwap = ({ bundle, status, detail }) => {
    try { report({ bundle, status }); } catch { /* the front end's display only */ }
    if (bundle === PAGE) pageMissing = status === 'original';
    if (bundle === PAGE_BUNDLE) {
      wordingMissing = status !== 'patched';
      wordingBroken ||= status === 'broken';
    }
    if (status === 'patched') { confirmed.add(bundle); return log(`mods active (${bundle})`); }
    if (bundle === PAGE_BUNDLE && status !== 'broken') {
      return log(`THE WORDING CHANGES ARE NOT ACTIVE (${status}): ${detail || status}. The game shows its own text; its code and ` +
        'simulation mods are unaffected. Report it to the mod\'s author, with launcher.log.');
    }
    if (bundle === PAGE) {
      if (status === 'broken') pageFailed = true;
      return log(`A PAGE SCRIPT ${status === 'broken' ? 'FAILED' : 'DID NOT RUN'}: ${detail || status}. The game itself and its ` +
        'simulation are unaffected; what the mod shows on screen may be missing. Report it to the mod\'s author, with launcher.log.');
    }
    problem = true;
    if (status === 'unverified') log(`warning: the mods started in ${bundle} but could not be confirmed as running.`);
    else if (status === 'broken') log(`THE MODS FAILED in ${bundle}: the game will not work this session. Close the game and report this, with launcher.log.`);
    else log(`THE MODS ARE NOT ACTIVE in ${bundle} (${status}): this session plays the unmodded game. Close the game and report this, with launcher.log.`);
  };
  // The bundles the game runs outside its window: written into the copy now, the last step before the start.
  let written = null, judge = null, watch = null, nonce = null, putBackLater = false, idle = false, damaged = null;
  const notesNow = () => readNotes(frozen.notes, nonce, disk.keys());
  const noted = r => { if (r.detail) log(`${r.bundle}: ${r.detail}`); onSwap(r); };
  if (disk.size) {
    nonce = newNonce();
    const texts = new Map([...disk].map(([bundle, text]) => [bundle, noteWrap(text, { file: frozen.notes, nonce, bundle })]));
    // The game may have been started (by the player or a program) while the mods were built or the saves copied: then
    // one of its processes could load a file being changed. Looked at once more right before the write.
    let running;
    try { running = inUse(); } catch { running = true; }
    if (running) {
      log('Geoplanetical is running: the mods were not written into the frozen game; nothing was started');
      return { problem: true, warning: false, message: 'Geoplanetical is running. Close it, then press Play again. Nothing was started.' };
    }
    try {
      rmSync(frozen.notes, { force: true });
      written = writeBundles(frozen.dir, texts, { inUse });
    } catch (e) {
      log(`could not write the mods into the frozen game: ${errorCode(e)}${e.code ? '' : ` (${e.message})`}`);
      return { problem: true, warning: false, message: `The mods could not be written into the frozen game (${errorCode(e)}). Nothing was started; try again.` };
    }
    log(`written into the frozen game for this session: ${[...written.keys()].join(', ')}`);
    judge = noteJudge(disk.keys());
    watch = setInterval(() => { for (const r of judge.poll(notesNow())) noted(r); }, 1000);
  }
  await new Promise(resolve => {
    launchAndServe({ steam, frozen, port, payloads, scripts, log, onSwap, onExit: code => { if (code) problem = true; resolve(); } })
      .then(() => log('attached to the game; waiting for the mods to start inside it'), e => {
        log(`could not start the game with the mods: ${e.message}. If the game still opens, ` +
          `${written ? 'only the mods written into the frozen game are active' : 'it is running WITHOUT the mods'}: close it.`);
        problem = true; resolve();
      });
  });
  if (written) {
    await untilClosed(log, inUse);
    clearInterval(watch);
    const counts = notesNow();
    for (const r of judge.poll(counts)) noted(r);
    for (const r of judge.end(counts)) {
      if (r.status === 'broken' && !r.reported) noted({ bundle: r.bundle, status: 'broken', detail: r.detail });
      if (r.status === 'idle') log(`${r.bundle}: did not start this session (the game closed before it needed it, or the loader saw no note from it)`);
    }
    idle = judge.end(counts).every(r => r.status === 'idle');
    try {
      const back = restoreBundles(frozen.dir, written, { inUse, log });
      if (back.changed.length) {
        problem = true;
        log(`the frozen game's ${back.changed.join(', ')} changed while the game ran (not by the loader): the mods in it may not have been active.`);
      }
      if (back.state === 'in-use') putBackLater = true;
      if (back.refused.length) damaged = back.refused;
      if (back.state === 'in-use') log('Geoplanetical started again before the frozen game\'s own files could be put back: they are put back once it closes, when the loader next checks the frozen game.');
    } catch (e) {
      putBackLater = true;
      log(`could not put the frozen game's own files back (${errorCode(e)}): they are put back when the loader next checks the frozen game.`);
    }
  }
  if (payloads.has(PAGE_BUNDLE) && !confirmed.has(PAGE_BUNDLE)) {
    wordingMissing = true;
    if (!wordingBroken) log('the wording changes were never confirmed active: the game most likely showed its own text.');
  }
  const missing = [...payloads.keys()].filter(b => b !== PAGE_BUNDLE && !confirmed.has(b));
  if (missing.length) {
    problem = true;
    log(`the mods were never confirmed active in ${missing.join(', ')}: that session most likely ran the UNMODDED game.`);
  }
  if (scripts.length && !confirmed.has(PAGE) && !pageFailed) {
    pageMissing = true;
    log('the page scripts were never confirmed running: what those mods show on screen was most likely missing.');
  }
  const warning = pageFailed || pageMissing || wordingMissing;
  const later = (putBackLater ? ' The frozen game\'s own files could not be put back yet: the loader does it the next time it opens.' : '') +
    (damaged ? ` The frozen game's own ${damaged.join(', ')} could not be put back: the copy the loader kept of it is damaged. Get the frozen game again before you play it.` : '');
  return {
    problem,
    warning,
    message: (problem
      ? 'Something went wrong (see the log). Saves from that session may be unmodded. launcher.log beside this program has the details.'
      : warning
        ? 'The game has closed. The mods were active, but a page script or a wording change failed or did not run, so what a mod shows on screen may have been missing (see the log).'
        : idle
          ? 'The game has closed. The mods that change the simulation never started: no game was started or loaded, or the loader could not see them start (see the log).'
          : 'The game has closed. The mods were active the whole session.') + later,
  };
}
