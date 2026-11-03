// What the player launcher does, shared by its two front ends (launcher/gui.mjs, the window; launcher/console.mjs,
// the text menu): the files beside the executable, the settings file, the log, building the chosen mods into the
// game's code (read from the game's app.asar, never written), and starting the game through Steam while serving the
// patched code to its workers.
import { readFileSync, writeFileSync, appendFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, basename, resolve, isAbsolute, normalize, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { isSea } from 'node:sea';
import { buildBundle } from '../patcher/patch-engine.mjs';
import { requirementProblem, orderMods } from '../patcher/mods.mjs';
import { findGame, originalBundle } from '../patcher/game.mjs';
import { launchAndServe } from '../patcher/runner.mjs';
import { PAGE } from '../patcher/session.mjs';

export const VERSION = '0.5.0';
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
  if (!s.enabled || typeof s.enabled !== 'object' || Array.isArray(s.enabled)) s.enabled = {};
  s.programs = cleanPrograms(s.programs);
  return s;
}
// Writes the settings (`unreadable` is not a setting); true when written.
export function saveSettings(s, log) {
  const { unreadable, ...keep } = s;
  try { writeFileSync(SETTINGS, JSON.stringify(keep, null, 2) + '\n'); return true; } catch (e) { log(`could not save settings: ${e.message}`); return false; }
}

export const isEnabled = (settings, m) => settings.enabled[m.id] !== false;

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
  const { error } = chooseMods(mods, settings, game, broken);
  if (error) return error;
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

// Starts `exe --loader "<loader folder>"` in the program's folder through Windows (ShellExecute, as Explorer does): a
// console program gets a console window of its own. Windows shows no warning for a downloaded program started this way
// (see downloaded). The command is constant; the paths reach it only through environment variables, which are removed
// before the program starts, and are taken as they are (Start-Process would read [ and ] in a path as wildcards and
// could start another file). Resolves { pid } (null when Windows does not say) when started, or { error }. Gives up
// after `timeoutMs` (a warning nobody answers).
export const START_TIMEOUT_MS = 120000;
export function startProgram(exe, loaderDir = BASE, timeoutMs = START_TIMEOUT_MS) {
  const command = "$ErrorActionPreference = 'Stop'; try { $i = New-Object System.Diagnostics.ProcessStartInfo; " +
    '$i.FileName = $env:GPML_PROGRAM; $i.Arguments = $env:GPML_PROGRAM_ARGS; $i.WorkingDirectory = $env:GPML_PROGRAM_DIR; ' +
    '$i.UseShellExecute = $true; Remove-Item Env:GPML_PROGRAM, Env:GPML_PROGRAM_ARGS, Env:GPML_PROGRAM_DIR; ' +
    "$p = [System.Diagnostics.Process]::Start($i); 'started ' + $(if ($p) { $p.Id } else { '' }) } " +
    "catch { $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }; 'failed: ' + $e.Message }";
  return new Promise(done => {
    let out = '';
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GPML_PROGRAM: exe, GPML_PROGRAM_ARGS: `--loader ${quoteArg(loaderDir)}`, GPML_PROGRAM_DIR: dirname(exe) },
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

// Steam installs a pending update before it starts the game, so the mods would meet a different game version. Returns
// the reason the game cannot be started now, or null.
export function launchBlocker(settings, game) {
  const now = findGame(settings.gameDir || null);
  if (now?.updating) {
    return `Steam is updating Geoplanetical${now.targetBuild ? ` (to build ${now.targetBuild})` : ''}. Let the update finish ` +
      'first; then the loader shows whether the mods are ready for the new version.';
  }
  if (!now || now.build !== game.build) return 'The game changed since the loader opened. Close the loader and open it again.';
  return null;
}

// Builds the chosen mods into the game's code and checks it compiles: { payloads, scripts } or { error }. The page
// scripts (already parsed when the mods were read) go in load order.
export function buildMods(game, chosen, log) {
  log(`building ${chosen.map(m => `${m.name} ${m.version}`).join(', ')} for build ${game.build}`);
  log('read-only: the game files are read, never changed');
  const payloads = new Map();
  const scripts = chosen.flatMap(m => m.scripts.map(s => ({ mod: m.id, path: s.path, text: s.text })));
  if (scripts.length) log(`page: ${scripts.length} script(s) ready (${scripts.map(s => `${s.mod}/${s.path}`).join(', ')})`);
  try {
    for (const bundle of [...new Set(chosen.flatMap(m => m.patches.map(p => p.bundle)))].sort()) {
      const r = buildBundle(originalBundle(game, bundle), chosen, { build: game.build, bundle });
      if (!r) continue;
      new Script(r.text, { filename: bundle }); // compile only: a broken result never reaches the game
      payloads.set(bundle, r.text);
      log(`${bundle}: ${r.report.length} change(s) ready`);
    }
  } catch (e) {
    log(`the mods could not be applied: ${e.message}`);
    return { error: `The mods could not be applied: ${e.message}. Nothing was started. Switch the named mod off, or check for an updated version of it.` };
  }
  return { payloads, scripts };
}

// Starts the game through Steam and serves it until it closes. Resolves { problem, warning, message } at the end of the
// session; onSwap({ bundle, status }) also reports each worker swap and the page scripts (bundle PAGE) as they happen.
// A page script runs beside the game's own code, so one that fails is a warning (what a mod shows on screen may be
// missing), not a problem (the game possibly unmodded). A script that threw stays a warning for the session; one that
// did not run stops being one once a later page load runs it.
export async function playSession({ steam, port, payloads, scripts = [], chosen, log, onSwap: report = () => {} }) {
  log(`starting Geoplanetical through Steam with ${chosen.map(m => m.name).join(', ')}`);
  let problem = false, pageFailed = false, pageMissing = false;
  const confirmed = new Set();
  const onSwap = ({ bundle, status, detail }) => {
    try { report({ bundle, status }); } catch { /* the front end's display only */ }
    if (bundle === PAGE) pageMissing = status === 'original';
    if (status === 'patched') { confirmed.add(bundle); return log(`mods active (${bundle})`); }
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
  await new Promise(resolve => {
    launchAndServe({ steam, port, payloads, scripts, log, onSwap, onExit: code => { if (code) problem = true; resolve(); } })
      .then(() => log('attached to the game; waiting for the mods to start inside it'), e => {
        log(`could not start the game with the mods: ${e.message}. If the game still opens, it is running WITHOUT the mods: close it.`);
        problem = true; resolve();
      });
  });
  const missing = [...payloads.keys()].filter(b => !confirmed.has(b));
  if (missing.length) {
    problem = true;
    log(`the mods were never confirmed active in ${missing.join(', ')}: that session most likely ran the UNMODDED game.`);
  }
  if (scripts.length && !confirmed.has(PAGE) && !pageFailed) {
    pageMissing = true;
    log('the page scripts were never confirmed running: what those mods show on screen was most likely missing.');
  }
  const warning = pageFailed || pageMissing;
  return {
    problem,
    warning,
    message: problem
      ? 'Something went wrong (see the log). Saves from that session may be unmodded. launcher.log beside this program has the details.'
      : warning
        ? 'The game has closed. The mods were active, but a page script failed or did not run, so what a mod shows on screen may have been missing (see the log).'
        : 'The game has closed. The mods were active the whole session.',
  };
}
