// The launcher's window: a small HTTP server on 127.0.0.1 serves the page in launcher/gui-page.mjs and a JSON API, and the page opens
// in a Microsoft Edge app window (no address bar), or the default browser if Edge is missing. Every API call carries a
// random token, so no web page and no other user's program can drive the launcher (the token is in the window's
// command line, which programs of the same Windows user can read). The process is what serves the patched
// code to the game's workers, so it stays alive while a game session runs even if the window is closed; otherwise it
// exits on Quit or when the window has been gone for 15 seconds (150 in a default-browser tab, which is throttled when
// hidden). Only one launcher runs at a time (a named-pipe lock).
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanMods, changeGroups } from '../patcher/mods.mjs';
import { PAGE as PAGE_SCRIPTS } from '../patcher/session.mjs';
import { findGame, gameRunning, steamExe } from '../patcher/game.mjs';
import {
  VERSION, PRODUCT, MODS, LOG, makeLog, readSettings, saveSettings, isEnabled, chooseMods, launchBlocker, buildMods, playSession,
} from './core.mjs';
import { installMods, itemsFromPage, readChosen } from './install.mjs';
import PAGE from './gui-page.mjs';

const LOG_LINES = 400;
// Request bodies: small for every action, larger for a dropped mod (its files in base64; launcher/install.mjs caps the
// unpacked size at 32 MB).
const BODY_MAX = 65536;
const INSTALL_BODY_MAX = 48 * 1024 * 1024;
const GONE_MS = 15000;
const GONE_MS_BROWSER = 150000;
// One launcher at a time: two would both start the game on the same debug port and serve it twice. The pipe keeps
// the name of the 0.2 launcher (and the window profile below its folder) so an older copy and this one exclude
// each other.
const LOCK_PIPE = '\\\\.\\pipe\\geoplanetical-mod-launcher';

export async function runGui({ dryRun, port, gameDirArg, noWindow }) {
  const lock = createNetServer();
  const locked = await new Promise(resolve => { lock.once('error', () => resolve(false)); lock.listen(LOCK_PIPE, () => resolve(true)); });
  if (!locked) {
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
  let game = findGame(settings.gameDir || null);
  let { mods, broken } = scanMods(MODS);
  // phase: ready (choose and start) | building | playing | ended (session over or dry run) ; message: the latest notice
  // or refusal ; notice: what the last action did when it succeeded (a mod added), until the next action
  // problem: the mods may not be active in the game (red); warning: a page script failed, the game runs modded (amber)
  let phase = 'ready', message = null, notice = null, problem = false, warning = false, lastSeen = Date.now(), browsing = false;
  let running = { at: 0, value: false };
  const gameIsRunning = () => {
    if (Date.now() - running.at > 3000) {
      try { running = { at: Date.now(), value: gameRunning() }; } catch { running = { at: Date.now(), value: false }; }
    }
    return running.value;
  };
  log(`${PRODUCT} ${VERSION} (window). Single player only.`);
  if (!game) log(settings.gameDir ? `the saved game folder does not hold the game: ${settings.gameDir}` : 'Geoplanetical was not found in the Steam libraries');
  if (!steam) log('Steam was not found on this PC');

  const state = () => ({
    version: VERSION, dryRun, phase, message, notice, problem, warning,
    steamFound: !!steam,
    game: game && { dir: game.dir, build: game.build, updating: game.updating, targetBuild: game.targetBuild },
    savedDir: settings.gameDir || null,
    gameRunning: phase === 'playing' ? true : gameIsRunning(),
    modsFolder: MODS,
    mods: mods.map(m => ({
      id: m.id, name: m.name, version: m.version, author: m.author || null, requires: m.requires || [],
      builds: m.builds, changes: changeGroups(m), scripts: m.scripts.length,
      fits: !!game && m.builds.includes(game.build), enabled: isEnabled(settings, m),
    })),
    broken: broken.map(b => ({ folder: b.folder, error: b.error })),
    log: lines, logSeq,
  });

  const useFolder = dir => {
    const g = findGame(dir);
    if (!g) return 'That folder does not hold the game. Choose the folder with Geoplanetical.exe in it.';
    settings.gameDir = dir; saveSettings(settings, log); game = g;
    log(`game folder set: ${dir} (build ${g.build ?? 'unknown'})`);
    return null;
  };

  const start = () => {
    if (phase !== 'ready') return 'The loader is busy.';
    if (!game) return 'Choose the game folder first.';
    if (!steam) return 'Steam was not found on this PC. The game must be started through Steam.';
    const { chosen, error } = chooseMods(mods, settings, game, broken);
    if (error) return error;
    if (!chosen.length) return 'No mod is switched on. Start the game from Steam as usual to play without mods.';
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
        if (dryRun) { log('dry run: everything checks out; the game was not started'); phase = 'ended'; message = 'Dry run: the mods were built and checked. The game was not started.'; return; }
        phase = 'playing'; message = 'Starting the game through Steam…';
        // A worker that does not take the mods is shown at once (problem), not only when the game closes.
        // Page scripts: a throw stays a warning for the session; "did not run" lasts until a later page load runs them.
        let pageFailed = false;
        const onSwap = ({ bundle, status }) => {
          if (bundle !== PAGE_SCRIPTS) { if (status !== 'patched') problem = true; return; }
          if (status === 'broken') pageFailed = true;
          warning = pageFailed || status === 'original';
        };
        const end = await playSession({ steam, port, payloads: built.payloads, scripts: built.scripts, chosen, log, onSwap });
        phase = 'ended'; problem = end.problem; warning = end.warning; message = end.message;
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
    const unfit = added.filter(a => !game || !mods.find(m => m.id === a.id)?.builds.includes(game.build));
    notice = `Added ${added.map(a => `${a.name} ${a.version}${a.replaced.length ? ` (replacing ${a.replaced.join(', ')})` : ''}`).join(', ')}.` +
      (added.some(a => a.from.length) ? (kept ? ` The previous copy is kept in ${kept}.` : ' The previous copy is in the Recycle Bin.') : '') +
      (unfit.length ? ` ${unfit.map(a => a.name).join(', ')} ${unfit.length > 1 ? 'are' : 'is'} not made for your game version yet.` : '');
    return null;
  };

  const quit = () => {
    if (phase === 'building') return 'Wait until the mods are built: the game is about to start.';
    if (phase === 'playing') log('quit while the game was running: parts of the game that restart now run WITHOUT the mods.');
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
        if (!m) return reply('No such mod.');
        if (!game || !m.builds.includes(game.build)) return reply(`${m.name} cannot run on this game version.`);
        settings.enabled[m.id] = !isEnabled(settings, m); saveSettings(settings, log);
        return done();
      }
      case 'POST /api/gamedir': {
        if (phase !== 'ready') return reply('The game folder cannot be changed now.');
        const dir = typeof body.dir === 'string' ? body.dir.trim().replace(/^"|"$/g, '') : '';
        const e = dir ? useFolder(dir) : 'Enter the game folder.';
        return e ? reply(e) : done();
      }
      case 'POST /api/browse': {
        if (phase !== 'ready') return reply('The game folder cannot be changed now.');
        if (browsing) return reply('A dialog is already open.');
        browsing = true;
        let dir;
        try { dir = await browseFolder(); } finally { browsing = false; } // asynchronous: polling goes on meanwhile
        lastSeen = Date.now();
        if (phase !== 'ready') return reply('The game folder cannot be changed now.');
        const e = dir ? useFolder(dir) : null;
        return e ? reply(e) : done();
      }
      case 'POST /api/rescan': {
        if (phase !== 'ready') return reply('Wait until the session is over.');
        game = findGame(settings.gameDir || null); ({ mods, broken } = scanMods(MODS));
        return done();
      }
      case 'POST /api/install': {
        const e = add(() => itemsFromPage(body), 'what was dropped');
        return e ? reply(e) : done(true);
      }
      case 'POST /api/add': {
        if (phase !== 'ready') return reply('Mods cannot be added while the game is starting or running.');
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
      case 'POST /api/open': {
        const target = body.what === 'log' ? LOG : body.what === 'mods' ? MODS : null;
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

// The Windows folder picker. Resolves the folder, or null if cancelled. The command is constant (no user input).
async function browseFolder() {
  const dir = await powershell('Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
    "$d.Description = 'Choose the Geoplanetical game folder (the one with Geoplanetical.exe)'; " +
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

// A Windows message box: the windowed launcher's only way to speak when it has no window (it has no console).
export function messageBox(text) {
  const quoted = String(text).replace(/['‘-‛]/g, "''"); // PowerShell also ends strings at curly quotes
  return powershell(`Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('${quoted}', '${PRODUCT}')`);
}
