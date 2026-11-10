// The launcher's window: a small HTTP server on 127.0.0.1 serves the page in launcher/gui-page.mjs and a JSON API, and the page opens
// in a Microsoft Edge app window (no address bar), or the default browser if Edge is missing. Every API call carries a
// random token, so no web page and no other user's program can drive the launcher (the token is in the window's
// command line, which programs of the same Windows user can read). The process is what serves the patched
// code to the game's workers, so it stays alive while a game session runs even if the window is closed; otherwise it
// exits on Quit or when the window has been gone for 15 seconds (150 in a default-browser tab, which is throttled when
// hidden). Only one launcher runs at a time (a named-pipe lock).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanMods, changeGroups } from '../patcher/mods.mjs';
import { PAGE as PAGE_SCRIPTS, PAGE_BUNDLE } from '../patcher/session.mjs';
import { findGame, gameRunning, steamExe, steamPath } from '../patcher/game.mjs';
import { PIN, frozenPlaces } from '../patcher/frozen.mjs';
import {
  VERSION, PRODUCT, MODS, LOG, BASE, makeLog, readSettings, saveSettings, isEnabled, chooseMods, launchBlocker, buildMods, playSession,
  MAX_PROGRAMS, sameExe, isConfirmed, downloaded, programName, programProblem, programRefusal, handOffRefusal, startProgram, programArgs,
  playChoice, frozenGame, chosenGame, prepareFrozen, noModsMessage, takeLock, FROZEN_NOT_READY, outsideMods,
} from './core.mjs';
import { repairPlaces, frozenStatus, copyIn, steamDownload, isAbort } from './freeze.mjs';
import { installMods, itemsFromPage, readChosen } from './install.mjs';
import PAGE from './gui-page.mjs';

const LOG_LINES = 400;
// Request bodies: small for every action, larger for a dropped mod (its files in base64; launcher/install.mjs caps the
// unpacked size at 32 MB).
const BODY_MAX = 65536;
const INSTALL_BODY_MAX = 48 * 1024 * 1024;
const GONE_MS = 15000;
const GONE_MS_BROWSER = 150000;
export async function runGui({ dryRun, port, gameDirArg, noWindow }) {
  if (!await takeLock()) {
    makeLog(() => {})('another launcher is already open; this one closes');
    if (noWindow) console.log('another launcher is already open');
    else await messageBox(`The ${PRODUCT} is already open. Use the window that is already running (check the taskbar).`);
    process.exit(1);
  }
  const token = randomBytes(16).toString('hex');
  const tokenBytes = Buffer.from(token);
  const sameToken = t => { const b = typeof t === 'string' ? Buffer.from(t) : null; return !!b && b.length === tokenBytes.length && timingSafeEqual(b, tokenBytes); };
  const lines = [];
  let logSeq = 0; // lines ever logged: the page redraws the log when it changes (the kept list stops growing at LOG_LINES)
  const log = makeLog(line => { lines.push(line); logSeq++; if (lines.length > LOG_LINES) lines.shift(); });
  // No console in the packaged launcher: an unexpected error is logged and shown, and the process keeps serving the game.
  // During a session that may mean the mods stopped being served: the window turns red (problem).
  const unexpected = e => { log(`unexpected error: ${e?.stack || e}`); if (phase === 'playing') problem = true; };
  process.on('uncaughtException', unexpected);
  process.on('unhandledRejection', unexpected);
  const settings = readSettings();
  if (gameDirArg) { settings.gameDir = gameDirArg; saveSettings(settings, log); }
  const steam = steamExe();
  // The two games (launcher/core.mjs chosenGame): `live`, the Steam game (findGame), and the frozen copy in `places`
  // (patcher/frozen.mjs), whose last check is `frozen` ({ status: 'checking' | 'ready' | 'missing' | 'other' | 'broken'
  // | 'unavailable', problem }). `task`: the frozen copy being set up ({ kind, step, done, total, mb, command,
  // clipboard, abort }; launcher/freeze.mjs), one at a time.
  let live = findGame(settings.gameDir || null);
  const places = frozenPlaces();
  let frozen = places ? { status: 'checking', problem: null } : { status: 'unavailable', problem: 'Windows does not say where programs keep their data (LOCALAPPDATA), so the frozen game has nowhere to go.' };
  let task = null;
  const current = () => chosenGame(settings, frozenGame(places, frozen.status === 'ready'), live);
  const frozenSaves = () => !!places && existsSync(join(places.data, 'saves'));
  let { mods, broken } = scanMods(MODS);
  // phase: ready (choose and start) | building | playing | ended (session over or dry run) ; message: the latest notice
  // or refusal ; notice: what the last action did when it succeeded (a mod added), until the next action
  // problem: the mods may not be active in the game (red); warning: a page script failed, the game runs modded (amber)
  let phase = 'ready', message = null, notice = null, problem = false, warning = false, lastSeen = Date.now(), browsing = false;
  let wroteCopy = false; // this session wrote mods into the frozen game (launcher/core.mjs playSession)
  let running = { at: 0, value: false };
  // starting: a program is being started ; handedOff: { at, name, pid } of the last program started (core.mjs)
  let starting = false, handedOff = null;
  // While a program starts, and while it reads the switches and the mods folder after it started, nothing here changes
  // them and nothing else starts the game.
  const programBusy = () => (starting ? 'A program is being started: wait for it.' : handOffRefusal(handedOff));
  // The programs list as the settings file holds it: a program's installer may have added one while the loader is
  // open, and every change made here is saved at once. Read before each change and each save of the settings.
  // (Kept as they are when the file does not read as settings, or the last save failed: the list here is then the
  // newer one.)
  let lastSaveOk = true;
  const save = () => { lastSaveOk = saveSettings(settings, log); };
  const freshPrograms = () => {
    if (!lastSaveOk) return;
    const onDisk = readSettings();
    if (onDisk.unreadable) return;
    settings.programs = onDisk.programs;
  };
  // A program's file is checked for each poll of the window: the answer is kept a few seconds (a sleeping drive), and
  // not checked again while the mods are built or a game session is served (a slow drive must not hold that up).
  const problems = new Map();
  const problemOf = exe => {
    const known = problems.get(exe);
    if (phase !== 'ready') return known ? known.problem : null;
    if (known && Date.now() - known.at < 5000) return known.problem;
    const problem = programProblem(exe);
    problems.set(exe, { at: Date.now(), problem });
    return problem;
  };
  const gameIsRunning = () => {
    if (Date.now() - running.at > 3000) {
      try { running = { at: Date.now(), value: gameRunning() }; } catch { running = { at: Date.now(), value: false }; }
    }
    return running.value;
  };
  log(`${PRODUCT} ${VERSION} (window). Single player only. Frozen game: build ${PIN.build} (game ${PIN.version}); playing the ${playChoice(settings)} game.`);
  if (!live) log(settings.gameDir ? `the saved game folder does not hold the game: ${settings.gameDir}` : 'Geoplanetical was not found in the Steam libraries');
  if (!steam) log('Steam was not found on this PC');

  // The frozen copy's state, checked again (about a second; it only reads). An interrupted replacement is repaired
  // once, here, before the window can start anything: the lock makes this the only loader working on that folder.
  const checkFrozen = async () => {
    if (!places) return;
    try { frozen = await frozenStatus(places); } catch (e) { frozen = { status: 'unreadable', problem: `The frozen game could not be checked (${e.code || 'unknown error'}). Click Refresh to check it again.` }; }
    log(`frozen game: ${frozen.status}${frozen.problem ? ` (${frozen.problem})` : ''}`);
  };
  if (places) {
    try { await repairPlaces(places, log); } catch (e) { log(`could not tidy the frozen game's folder (${e.code || 'unknown error'})`); }
    checkFrozen();
  }

  const state = () => {
    const game = current();
    // (mods that change code the chosen game runs outside its window: the page says what that means for them)
    let outside = new Set();
    try { outside = new Set(outsideMods(mods, game).map(m => m.id)); } catch { /* the game's archive cannot be read */ }
    return {
      version: VERSION, dryRun, phase, message, notice, problem, warning,
      steamFound: !!steam,
      play: playChoice(settings),
      pin: { build: PIN.build, version: PIN.version },
      frozen: { ...frozen, dir: places?.game ?? null, savesCopied: frozenSaves() },
      task: task && { kind: task.kind, step: task.step, done: task.done, total: task.total, mb: task.mb ?? null, command: task.command ?? null, clipboard: task.clipboard ?? null },
      live: live && { dir: live.dir, build: live.build, updating: live.updating, targetBuild: live.targetBuild },
      game: game && { dir: game.dir, build: game.build, updating: game.updating, targetBuild: game.targetBuild, frozen: !!game.frozen, ready: game.frozen ? game.ready : true },
      savedDir: settings.gameDir || null,
      gameRunning: phase === 'playing' ? true : gameIsRunning(),
      modsFolder: MODS,
      mods: mods.map(m => ({
        id: m.id, name: m.name, version: m.version, author: m.author || null, requires: m.requires || [],
        builds: m.builds, changes: changeGroups(m), scripts: m.scripts.length, wording: m.patches.some(p => p.bundle === PAGE_BUNDLE), outside: outside.has(m.id),
        fits: !!game && m.builds.includes(game.build), enabled: isEnabled(settings, m),
      })),
      broken: broken.map(b => ({ folder: b.folder, error: b.error })),
      programs: settings.programs.map(p => ({ exe: p.exe, name: programName(p), confirmed: isConfirmed(p), problem: problemOf(p.exe) })),
      log: lines, logSeq,
    };
  };

  const useFolder = dir => {
    const g = findGame(dir);
    if (!g) return 'That folder does not hold the game. Choose the folder with Geoplanetical.exe in it.';
    freshPrograms(); settings.gameDir = dir; save(); live = g;
    log(`game folder set: ${dir} (build ${g.build ?? 'unknown'})`);
    return null;
  };

  // Sets up the frozen copy in the background (launcher/freeze.mjs): `work({ onProgress, signal })`. Refused while
  // the loader is busy, a program was just handed the game, or the game runs (the copy may be in use).
  const freeze = (kind, work) => {
    if (phase !== 'ready') return 'The loader is busy.';
    if (task) return 'The frozen game is already being set up.';
    const busy = programBusy();
    if (busy) return busy;
    if (!places) return frozen.problem;
    if (frozen.status === 'checking') return 'The frozen game is being checked: try again in a moment.';
    try { running = { at: Date.now(), value: gameRunning() }; } catch (e) {
      log(`could not tell whether the game is running: ${e.message}`);
      return 'Could not tell whether Geoplanetical is running. Close it if it is, then try again.';
    }
    if (running.value) return 'Geoplanetical is running. Close it first: the frozen game may be in use.';
    const abort = new AbortController();
    task = { kind, step: 'starting', done: 0, total: 0, abort };
    message = null; notice = null;
    log(`setting up the frozen game (${kind})`);
    (async () => {
      try {
        await work({ onProgress: p => { if (task) Object.assign(task, p); }, signal: abort.signal });
        notice = `The frozen game is ready: build ${PIN.build} (game ${PIN.version}).`; message = null;
        log(`the frozen game is ready: build ${PIN.build}`);
      } catch (e) {
        if (isAbort(e)) { message = 'Cancelled. The frozen game was not changed.'; log('setting up the frozen game was cancelled'); } else {
          log(`the frozen game could not be set up: ${e.said ? e.message : e?.stack || e}`);
          message = e.said ? e.message : 'The frozen game could not be set up (see the log). It was not changed.';
        }
        notice = null;
      } finally {
        // (the new state first: until it is known, the task still holds Play and the other buttons)
        await checkFrozen();
        task = null; lastSeen = Date.now();
      }
    })();
    return null;
  };

  const start = () => {
    if (phase !== 'ready') return 'The loader is busy.';
    const busy = programBusy();
    if (busy) return busy;
    if (task) return 'Wait until the frozen game is set up, or cancel it.';
    const game = current();
    if (!game) return 'Choose the game folder first.';
    if (game.frozen && !game.ready) return frozen.status === 'checking' ? 'The frozen game is being checked: try again in a moment.' : FROZEN_NOT_READY;
    if (!steam) return 'Steam was not found on this PC. The game needs Steam.';
    const { chosen, error } = chooseMods(mods, settings, game, broken);
    if (error) return error;
    if (!chosen.length) return noModsMessage(mods, settings, game);
    const blocker = launchBlocker(settings, game);
    if (blocker) return blocker;
    // A failed check must not let a second copy start: the game's state is then unknown, so refuse.
    try { running = { at: Date.now(), value: gameRunning() }; } catch (e) {
      log(`could not tell whether the game is running: ${e.message}`);
      return 'Could not tell whether Geoplanetical is already running. Close it if it is, then press Play again.';
    }
    if (running.value) return 'Geoplanetical is already running. Close it, then press Play again.';
    phase = 'building'; problem = false; warning = false; message = 'Building the mods into the game’s code…';
    setTimeout(async () => {
      try {
        const built = buildMods(game, chosen, log);
        lastSeen = Date.now(); // the build blocks; polls queued meanwhile are read only after the next timer check
        if (built.error) { phase = 'ready'; message = built.error; return; }
        let frozenDir = null;
        if (game.frozen) {
          // (a dry run checks the copy, not Steam, and copies no saves) The check is the last step before the start.
          message = frozenSaves() || dryRun ? 'Checking the frozen game…' : 'Copying your Steam saves into the frozen game (once) and checking it…';
          const ready = await prepareFrozen(game, log, dryRun ? { saves: false, steam: false } : {});
          lastSeen = Date.now();
          if (ready.error) { phase = 'ready'; message = ready.error; checkFrozen(); return; }
          frozenDir = ready.dir;
        }
        if (dryRun) { log('dry run: everything checks out; the game was not started'); phase = 'ended'; message = 'Dry run: the mods were built and checked. The game was not started.'; return; }
        phase = 'playing'; wroteCopy = built.disk.size > 0; message = game.frozen ? 'Starting the frozen game…' : 'Starting the game through Steam…';
        // A worker that does not take the mods is shown at once (problem), not only when the game closes.
        // Page scripts: a throw stays a warning for the session; "did not run" lasts until a later page load runs them.
        // Wording changes not active: a warning until a later page load has them (broken: a problem, as for a worker).
        let pageFailed = false, pageMissing = false, wordingMissing = false;
        const onSwap = ({ bundle, status }) => {
          if (bundle === PAGE_BUNDLE && status !== 'broken') wordingMissing = status !== 'patched';
          else if (bundle !== PAGE_SCRIPTS) { if (status !== 'patched') problem = true; return; }
          else {
            if (status === 'broken') pageFailed = true;
            pageMissing = status === 'original';
          }
          warning = pageFailed || pageMissing || wordingMissing;
        };
        const end = await playSession({
          steam, frozen: frozenDir ? { dir: frozenDir, dataDir: game.dataDir, notes: game.notes } : null, disk: built.disk,
          port, payloads: built.payloads, scripts: built.scripts, chosen, log, onSwap,
        });
        phase = 'ended'; problem = end.problem; warning = end.warning; message = end.message;
        if (game.frozen) checkFrozen(); // its own files were put back (or not: then it says so)
      } catch (e) {
        log(`error: ${e?.stack || e}`);
        problem = true; message = 'Something went wrong (see the log). If the game opened, it may be running WITHOUT the mods: close it.';
        phase = phase === 'building' ? 'ready' : 'ended';
      }
    }, 50);
    return null;
  };

  // Adds mods (launcher/install.mjs): `read` gives the install items. Returns the refusal, or null with `notice` set.
  const add = (read, from) => {
    if (phase !== 'ready') return 'Mods cannot be added while the game is starting or running.';
    const busy = programBusy();
    if (busy) return busy;
    let added, kept;
    try { ({ added, kept } = installMods(read(), MODS)); } catch (e) {
      log(`could not add ${from}: ${e.message}`);
      ({ mods, broken } = scanMods(MODS));
      return `Could not add the mod: ${e.message}`;
    } finally {
      lastSeen = Date.now(); // the install blocks; polls queued meanwhile are read only after the next timer check
    }
    ({ mods, broken } = scanMods(MODS));
    for (const a of added) {
      log(`added ${a.name} ${a.version} to mods\\${a.folder}` +
        (a.from.length ? ` (replaced folder ${a.from.join(', ')}${a.replaced.length ? `, version ${a.replaced.join(', ')}` : ''})` : ''));
    }
    if (kept) log(`the replaced copies could not be moved to the Recycle Bin; they are in ${kept}`);
    const game = current();
    const unfit = added.filter(a => !game || !mods.find(m => m.id === a.id)?.builds.includes(game.build));
    notice = `Added ${added.map(a => `${a.name} ${a.version}${a.replaced.length ? ` (replacing ${a.replaced.join(', ')})` : ''}`).join(', ')}.` +
      (added.some(a => a.from.length) ? (kept ? ` The previous copy is kept in ${kept}.` : ' The previous copy is in the Recycle Bin.') : '') +
      (unfit.length ? ` ${unfit.map(a => a.name).join(', ')} ${unfit.length > 1 ? 'are' : 'is'} not made for your game version yet.` : '');
    return null;
  };

  // Why program `p` cannot be started now, or null: core.mjs programRefusal, then what needs Steam and Windows.
  const refuseProgram = (p, confirmed) => {
    const game = current();
    const refusal = programRefusal(p, { confirmed, dryRun, game, mods, broken, settings, saved: readSettings().enabled });
    if (refusal) return refusal;
    const name = programName(p);
    const blocker = programBusy() || (task ? 'Wait until the frozen game is set up, or cancel it.' : null) || launchBlocker(settings, game);
    if (blocker) return blocker;
    try { running = { at: Date.now(), value: gameRunning() }; } catch (e) {
      log(`could not tell whether the game is running: ${e.message}`);
      return `Could not tell whether Geoplanetical is already running. Close it if it is, then start ${name} again.`;
    }
    if (running.value) return `Geoplanetical is already running. Close it, then start ${name} again.`;
    return null;
  };

  const quit = () => {
    if (phase === 'building') return 'Wait until the mods are built: the game is about to start.';
    if (phase === 'playing') {
      log('quit while the game was running: parts of the game that restart now run WITHOUT the mods served through its window.' +
        (wroteCopy ? ' The mods written into the frozen game stay until it closes; the loader puts its own files back the next time it opens.' : ''));
    }
    if (task) { task.abort.abort(); log('quit while the frozen game was being set up: it was not changed (the partial copy is removed next time)'); }
    log('launcher closed');
    setTimeout(() => process.exit(problem ? 1 : 0), 200);
    return null;
  };

  const handle = async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    // Only this launcher's own address (no DNS-rebound host name), and the token before anything else is read.
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return send(403, { error: 'forbidden' });
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return send(400, { error: 'bad request' }); }
    if (req.method === 'GET' && url.pathname === '/') {
      if (!sameToken(url.searchParams.get('t'))) return send(403, 'Forbidden', 'text/plain');
      lastSeen = Date.now();
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
      return send(200, PAGE, 'text/html');
    }
    if (!url.pathname.startsWith('/api/') || !sameToken(req.headers['x-token'])) return send(403, { error: 'forbidden' });
    lastSeen = Date.now();
    let body = {};
    // A drop is refused before its (large) body is read while a game session runs: reading it would hold up the
    // process that serves the game.
    if (url.pathname === '/api/install' && phase !== 'ready') {
      return send(200, { error: 'Mods cannot be added while the game is starting or running.', state: state() });
    }
    if (req.method === 'POST') {
      const max = url.pathname === '/api/install' ? INSTALL_BODY_MAX : BODY_MAX;
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > max) return send(413, { error: max === BODY_MAX ? 'too large' : 'What was dropped is too large to be a mod (over 32 MB).' });
      }
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'bad json' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    }
    // A refused action is shown in the window's banner until the next action (message), unless a session is under way.
    const reply = (error = null) => {
      if (error && phase === 'ready') { message = error; notice = null; }
      return send(200, { error, state: state() });
    };
    const done = (keepNotice = false) => { if (phase === 'ready') { message = null; if (!keepNotice) notice = null; } return reply(); };
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/state': return reply();
      case 'POST /api/toggle': {
        const m = mods.find(x => x.id === body.id);
        if (phase !== 'ready') return reply('Mods cannot be switched while the game is starting or running.');
        const busy = programBusy();
        if (busy) return reply(busy);
        if (!m) return reply('No such mod.');
        const game = current();
        if (!game || !m.builds.includes(game.build)) return reply(`${m.name} cannot run on this game version.`);
        freshPrograms();
        settings.enabled[m.id] = !isEnabled(settings, m); save();
        return done();
      }
      case 'POST /api/gamedir': {
        if (phase !== 'ready') return reply('The game folder cannot be changed now.');
        if (programBusy()) return reply(programBusy());
        const dir = typeof body.dir === 'string' ? body.dir.trim().replace(/^"|"$/g, '') : '';
        const e = dir ? useFolder(dir) : 'Enter the game folder.';
        return e ? reply(e) : done();
      }
      case 'POST /api/browse': {
        if (phase !== 'ready') return reply('The game folder cannot be changed now.');
        if (programBusy()) return reply(programBusy());
        if (browsing) return reply('A dialog is already open.');
        browsing = true;
        let dir;
        try { dir = await browseFolder(); } finally { browsing = false; } // asynchronous: polling goes on meanwhile
        lastSeen = Date.now();
        if (phase !== 'ready') return reply('The game folder cannot be changed now.');
        if (programBusy()) return reply(programBusy()); // a program may have been started while the dialog was open
        const e = dir ? useFolder(dir) : null;
        return e ? reply(e) : done();
      }
      case 'POST /api/rescan': {
        if (phase !== 'ready') return reply('Wait until the session is over.');
        const busy = programBusy();
        if (busy) return reply(busy);
        live = findGame(settings.gameDir || null); ({ mods, broken } = scanMods(MODS));
        freshPrograms(); problems.clear();
        if (!task) checkFrozen();
        return done();
      }
      case 'POST /api/play': {
        if (phase !== 'ready') return reply('The game cannot be changed now.');
        const busy = programBusy();
        if (busy) return reply(busy);
        if (body.which !== 'live' && body.which !== 'frozen') return reply('No such game.');
        freshPrograms(); settings.play = body.which; save();
        log(`playing the ${body.which} game`);
        return done();
      }
      case 'POST /api/freeze-live': {
        if (!live || live.build !== PIN.build || live.updating) {
          return reply(`Your Steam game is not build ${PIN.build} (game ${PIN.version}) now${live?.build ? ` but ${live.build}` : ''}, so it cannot be copied. Download that build with Steam instead.`);
        }
        const src = live.dir;
        return reply(freeze('copy from the Steam game', o => copyIn(src, places, { ...o, log, what: 'Your Steam game' })));
      }
      case 'POST /api/freeze-folder': {
        if (phase !== 'ready') return reply('The loader is busy.');
        if (task) return reply('The frozen game is already being set up.');
        if (browsing) return reply('A dialog is already open.');
        browsing = true;
        let dir;
        try { dir = await browseFolder({ frozen: true }); } finally { browsing = false; }
        lastSeen = Date.now();
        if (!dir) return done();
        return reply(freeze(`copy from ${dir}`, o => copyIn(dir, places, { ...o, log })));
      }
      case 'POST /api/freeze-download': {
        // (refused before Steam's folder is looked up: that runs PowerShell, which must not hold up a game session)
        if (phase !== 'ready') return reply('The loader is busy.');
        if (task) return reply('The frozen game is already being set up.');
        const steamDir = steamPath();
        if (!steam || !steamDir) return reply('Steam was not found on this PC.');
        return reply(freeze('download with Steam', o => steamDownload({ steam, steamDir, places, onStatus: o.onProgress, signal: o.signal, log })));
      }
      case 'POST /api/freeze-cancel': {
        if (task) task.abort.abort();
        return reply();
      }
      case 'POST /api/install': {
        const e = add(() => itemsFromPage(body), 'what was dropped');
        return e ? reply(e) : done(true);
      }
      case 'POST /api/add': {
        if (phase !== 'ready') return reply('Mods cannot be added while the game is starting or running.');
        if (programBusy()) return reply(programBusy());
        if (browsing) return reply('A dialog is already open.');
        browsing = true;
        let file;
        try { file = await chooseModFile(); } finally { browsing = false; }
        lastSeen = Date.now();
        if (!file) return done();
        const e = add(() => readChosen(file), file);
        return e ? reply(e) : done(true);
      }
      case 'POST /api/start': return reply(start());
      case 'POST /api/program-add': {
        if (phase !== 'ready') return reply('Programs can be added when no game session is running.');
        if (browsing) return reply('A dialog is already open.');
        freshPrograms();
        if (settings.programs.length >= MAX_PROGRAMS) return reply(`At most ${MAX_PROGRAMS} programs: remove one first.`);
        browsing = true;
        let file;
        try { file = await chooseProgramFile(); } finally { browsing = false; }
        lastSeen = Date.now();
        if (!file) return done();
        if (phase !== 'ready') return reply('Programs can be added when no game session is running.');
        const problem = programProblem(file);
        if (problem) return reply(`That cannot be added: ${problem}.`);
        // Picked in the dialog: the player chose this file, so its first start needs no further confirmation, unless
        // it was downloaded from the internet (Windows does not ask when it starts this way).
        freshPrograms();
        if (settings.programs.length >= MAX_PROGRAMS) return reply(`At most ${MAX_PROGRAMS} programs: remove one first.`);
        let p = settings.programs.find(o => sameExe(o.exe, file));
        const known = !!p;
        if (!p) { p = { exe: file }; settings.programs.push(p); }
        const fromInternet = downloaded(file);
        if (fromInternet) delete p.confirmed; else p.confirmed = p.exe;
        save();
        if (!known) log(`program added: ${file}${fromInternet ? ' (downloaded from the internet)' : ''}`);
        notice = (known ? `${programName(p)} is already in the list.` : `Added ${programName(p)} (${file}). Its button starts it with the mods switched on here.`) +
          (fromInternet ? ' It was downloaded from the internet, so the loader asks you once before it first starts it.' : '');
        return done(true);
      }
      case 'POST /api/program-remove': {
        if (phase !== 'ready') return reply('Programs can be removed when no game session is running.');
        freshPrograms();
        const i = settings.programs.findIndex(p => p.exe === body.exe);
        if (i < 0) return reply('No such program.');
        const [p] = settings.programs.splice(i, 1);
        save();
        log(`program removed from the list: ${p.exe}`);
        return done();
      }
      case 'POST /api/program-start': {
        if (phase !== 'ready') return reply('The loader is busy.');
        freshPrograms();
        const p = settings.programs.find(x => x.exe === body.exe);
        if (!p) return reply('No such program.');
        const refusal = refuseProgram(p, body.confirmed === true);
        if (refusal) return reply(refusal);
        if (!isConfirmed(p)) { p.confirmed = p.exe; save(); }
        const name = programName(p);
        // The frozen game: the program is given the copy's folder (--game) after the same check as Play (it checks
        // the folder again itself, and keeps its own saves for it).
        const game = current();
        let gameDir = null;
        starting = true;
        let started;
        try {
          if (game.frozen) {
            const ready = await prepareFrozen(game, log, { saves: false });
            if (ready.error) { checkFrozen(); return reply(ready.error); }
            gameDir = ready.dir;
          }
          started = await startProgram(p.exe, BASE, { gameDir });
        } finally { starting = false; }
        lastSeen = Date.now();
        if (started.error) {
          log(`could not start ${name} (${p.exe}): ${started.error}`);
          return reply(`${name} could not be started: ${started.error}`);
        }
        handedOff = { at: Date.now(), name, pid: started.pid };
        log(`started ${name} (${p.exe} ${programArgs(BASE, gameDir)}); it starts the ${gameDir ? 'frozen ' : ''}game itself, with the mods switched on here`);
        notice = `Started ${name}. It starts the ${gameDir ? 'frozen ' : ''}game itself, with the mods switched on here: follow its own window. You can close this one.`;
        return done(true);
      }
      case 'POST /api/open': {
        const target = body.what === 'log' ? LOG : body.what === 'mods' ? MODS : body.what === 'saves' && places ? join(places.data, 'saves') : null;
        if (!target || !existsSync(target)) return reply('Nothing to open yet.');
        const child = spawn(body.what === 'log' ? 'notepad' : 'explorer', [target], { detached: true, stdio: 'ignore' });
        child.on('error', e => log(`could not open ${target}: ${e.message}`));
        child.unref();
        return reply();
      }
      case 'POST /api/quit': return reply(quit());
      default: return send(404, { error: 'not found' });
    }
  };
  const server = createServer((req, res) => handle(req, res).catch(e => {
    log(`request error: ${e?.message || e}`);
    try { if (!res.headersSent) res.writeHead(500); res.end(); } catch { /* connection gone */ }
  }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
  log(`window address: http://127.0.0.1:${server.address().port}/ (private to this launcher)`);
  // A default-browser tab is throttled when hidden (a poll a minute at worst), so it gets a longer grace than the Edge
  // window, which is started with background throttling off.
  let goneMs = GONE_MS;
  if (noWindow) console.log(`launcher page: ${url}`); // testing: no window, the address on stdout
  else openWindow(url, log, () => { goneMs = GONE_MS_BROWSER; });

  // The window is gone when the page stops polling. Outside a game session that ends the launcher; during one the
  // launcher keeps serving the game and ends when the session ends.
  setInterval(() => {
    if (Date.now() - lastSeen < goneMs) return;
    if (phase === 'playing' || phase === 'building') return;
    // A copy being made finishes first; waiting for Steam's download ends with the window (nobody would see it end).
    if (task && ['starting', 'waiting', 'downloading'].includes(task.step) && task.kind === 'download with Steam') {
      if (!task.abort.signal.aborted) { log('window closed while waiting for Steam\'s download: stopped waiting'); task.abort.abort(); }
      return;
    }
    if (task) return;
    log('window closed; launcher exiting');
    process.exit(problem ? 1 : 0);
  }, 2000).unref?.();
  await new Promise(() => {}); // run until exit
}

// Edge app window with its own profile (so it opens as a separate window, not a tab), else the default browser
// (onBrowser() is called then). Background throttling is off so the page keeps polling behind a fullscreen game.
function openWindow(url, log, onBrowser) {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const edge = roots.map(r => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(p => existsSync(p));
  if (edge) {
    const profile = join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'GeoplaneticalModLauncher', 'window');
    try { mkdirSync(profile, { recursive: true }); } catch { /* Edge creates it */ }
    spawn(edge, [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--window-size=1000,860', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'], { detached: true, stdio: 'ignore' })
      .on('error', e => { log(`Microsoft Edge could not be started (${e.message}); using the default browser`); onBrowser(); openDefault(url, log); })
      .unref();
    log('opened the launcher window (Microsoft Edge app window)');
    return;
  }
  onBrowser();
  openDefault(url, log);
}

function openDefault(url, log) {
  spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
    .on('error', e => log(`the launcher window could not be opened (${e.message}). Open this address in a browser: ${url}`))
    .unref();
  log('opened the launcher in the default browser');
}

// Runs a PowerShell command without a console window; resolves its trimmed output ('' on any failure).
function powershell(command) {
  return new Promise(resolve => {
    let out = '';
    const child = spawn('powershell', ['-NoProfile', '-STA', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => resolve(''));
    child.on('close', code => resolve(code === 0 ? out.trim() : ''));
  });
}

// The Windows folder picker: for the Steam game's folder, or (`frozen`) a folder holding the pinned build to copy.
// Resolves the folder, or null if cancelled. The command is constant (no user input; the pin is digits).
async function browseFolder({ frozen = false } = {}) {
  const what = frozen
    ? `Choose a folder holding Geoplanetical build ${PIN.build} (game ${PIN.version}). It is copied, never changed.`
    : 'Choose the Geoplanetical game folder (the one with Geoplanetical.exe)';
  const dir = await powershell('Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
    `$d.Description = '${what}'; ` +
    '$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; ' +
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; if ($d.ShowDialog($f) -eq "OK") { $d.SelectedPath }');
  return dir || null;
}

// The Windows file picker for Add mod: a mod's .zip, or the mod.json in its folder. Resolves the file, or null if
// cancelled. The command is constant (no user input).
async function chooseModFile() {
  const file = await powershell('Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; ' +
    "$d.Title = 'Add a mod: choose its .zip file, or the mod.json inside its folder'; " +
    "$d.Filter = 'Mod (.zip or mod.json)|*.zip;mod.json|All files|*.*'; " +
    '$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; ' +
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; if ($d.ShowDialog($f) -eq "OK") { $d.FileName }');
  return file || null;
}

// The Windows file picker for Add program: a program's .exe. Resolves the file, or null if cancelled. The command is
// constant (no user input).
async function chooseProgramFile() {
  const file = await powershell('Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; ' +
    "$d.Title = 'Add a program that starts the game with these mods (its .exe file)'; " +
    "$d.Filter = 'Programs (*.exe)|*.exe'; " +
    '$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; ' +
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; if ($d.ShowDialog($f) -eq "OK") { $d.FileName }');
  return file || null;
}

// A Windows message box: the windowed launcher's only way to speak when it has no window (it has no console).
export function messageBox(text) {
  const quoted = String(text).replace(/['‘-‛]/g, "''"); // PowerShell also ends strings at curly quotes
  return powershell(`Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('${quoted}', '${PRODUCT}')`);
}
