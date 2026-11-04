// The launcher's text menu (node launcher/main.mjs --console): the same steps as the window (launcher/gui.mjs), typed
// at a prompt. Kept for development and for players who prefer it.
import { createInterface } from 'node:readline/promises';
import { scanMods, changeGroups } from '../patcher/mods.mjs';
import { PAGE_BUNDLE } from '../patcher/page-text.mjs';
import { findGame, gameRunning, steamExe, steamPath } from '../patcher/game.mjs';
import { PIN, frozenPlaces } from '../patcher/frozen.mjs';
import {
  VERSION, PRODUCT, MODS, makeLog, readSettings, saveSettings, isEnabled, chooseMods, launchBlocker, buildMods, playSession,
  playChoice, frozenGame, chosenGame, prepareFrozen, noModsMessage, takeLock, FROZEN_NOT_READY,
} from './core.mjs';
import { repairPlaces, frozenStatus, copyIn, steamDownload } from './freeze.mjs';

export async function runConsole({ dryRun, port, gameDirArg }) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const log = makeLog(line => console.log(line));
  let closing = false;
  // Ctrl+C: say what it means and leave (the game keeps running; workers it starts later run unmodded).
  rl.on('SIGINT', () => {
    log('stopped with Ctrl+C. If the game is still running, parts of it that restart now run WITHOUT the mods.');
    closing = true; rl.close(); process.exit(130);
  });
  const exitAfterKey = async (code, msg) => {
    if (msg) console.log(`\n${msg}`);
    if (!closing) {
      closing = true;
      try { await rl.question('\nPress Enter to close this window.'); } catch { /* input already closed */ }
      rl.close();
    }
    process.exit(code);
  };

  console.log(`${PRODUCT} ${VERSION}. Single player only.`);
  // One loader at a time, the window or this menu (launcher/core.mjs takeLock).
  if (!await takeLock()) await exitAfterKey(1, `The ${PRODUCT} is already open (its window or another text menu). Use that one.`);
  const settings = readSettings();
  if (gameDirArg) { settings.gameDir = gameDirArg; saveSettings(settings, log); }
  // The two games (launcher/core.mjs chosenGame): the frozen copy (patcher/frozen.mjs) and the live Steam game.
  const places = frozenPlaces();
  let frozen = { status: 'unavailable', problem: 'Windows does not say where programs keep their data (LOCALAPPDATA), so the frozen game has nowhere to go.' };
  const checkFrozen = async () => {
    if (!places) return;
    frozen = await frozenStatus(places).catch(e => ({ status: 'unreadable', problem: `The frozen game could not be checked (${e.code || 'unknown error'}).` }));
  };
  // (an interrupted replacement is repaired once, before anything else: the lock makes this the only loader on it)
  if (places) await repairPlaces(places, log).catch(e => log(`could not tidy the frozen game's folder (${e.code || 'unknown error'})`));
  await checkFrozen();
  let live = findGame(settings.gameDir || null);
  while (!live && playChoice(settings) === 'live') {
    console.log(settings.gameDir
      ? `\nThe folder in launcher-settings.json does not hold the game: ${settings.gameDir}`
      : '\nGeoplanetical was not found in your Steam libraries.');
    const dir = (await rl.question('Paste the game folder (the one with Geoplanetical.exe), F then Enter to play the frozen game, or Enter to quit: ')).trim().replace(/^"|"$/g, '');
    if (!dir) await exitAfterKey(1);
    if (dir.toLowerCase() === 'f') { settings.play = 'frozen'; saveSettings(settings, log); break; }
    live = findGame(dir);
    if (live) { settings.gameDir = dir; saveSettings(settings, log); }
  }
  const steam = steamExe();
  if (!steam) await exitAfterKey(1, 'Steam was not found on this PC. The game needs Steam.');

  const { mods, broken } = scanMods(MODS);
  for (;;) {
    const game = chosenGame(settings, frozenGame(places, frozen.status === 'ready'), live);
    screen({ game, live, frozen, places, play: playChoice(settings) }, mods, broken, m => isEnabled(settings, m));
    const answer = (await rl.question('> ')).trim().toLowerCase();
    if (answer === 'q') { rl.close(); return; }
    if (answer === 'f' || answer === 'l') {
      if (answer === 'l' && !live) { console.log('The Steam game was not found. Start the loader with --game-dir <folder>.'); continue; }
      settings.play = answer === 'f' ? 'frozen' : 'live'; saveSettings(settings, log);
      continue;
    }
    if (answer === 'g') { await getFrozen(); continue; }
    if (!game) { console.log('No game to play.'); continue; }
    if (answer) {
      const m = mods[Number(answer) - 1];
      if (!m) console.log('No mod with that number.');
      else if (!m.builds.includes(game.build)) console.log(`${m.name} cannot run on this game version.`);
      else { settings.enabled[m.id] = !isEnabled(settings, m); saveSettings(settings, log); }
      continue;
    }
    const { chosen, error } = chooseMods(mods, settings, game, broken);
    if (error) { console.log(`\n${error}`); continue; }
    if (!chosen.length) {
      console.log(`\n${noModsMessage(mods, settings, game)}`);
      continue;
    }
    if (game.frozen && !game.ready) { console.log(`\n${FROZEN_NOT_READY.replace('(Frozen game, above)', '(G then Enter)')}`); continue; }
    const blocker = launchBlocker(settings, game);
    if (blocker) { console.log(`\n${blocker}`); continue; }
    while (gameRunning()) {
      const r = (await rl.question('\nGeoplanetical is already running. Close it, then press Enter (or Q then Enter to go back): ')).trim().toLowerCase();
      if (r === 'q') break;
    }
    if (gameRunning()) continue;
    const built = buildMods(game, chosen, log);
    if (built.error) { console.log(built.error); continue; }
    let frozenDir = null;
    if (game.frozen) {
      // (a dry run checks the copy, not Steam, and copies no saves) The check is the last step before the start.
      const ready = await prepareFrozen(game, log, dryRun ? { saves: false, steam: false } : {});
      if (ready.error) { console.log(`\n${ready.error.replace('(Frozen game, above)', '(G then Enter)')}`); await checkFrozen(); continue; }
      frozenDir = ready.dir;
    }
    if (dryRun) { log('dry run: everything checks out; the game was not started'); rl.close(); return; }
    console.log('Leave this window open while you play: it keeps the mods active. Closing it early turns them off for\n' +
      'parts of the game that restart. Saves made now need the same mods to load correctly.');
    const end = await playSession({
      steam, frozen: frozenDir ? { dir: frozenDir, dataDir: game.dataDir } : null,
      port, payloads: built.payloads, scripts: built.scripts, chosen, log,
    });
    await exitAfterKey(end.problem ? 1 : 0, end.message);
    return;
  }

  // Getting the frozen copy (launcher/freeze.mjs), with progress lines every few seconds. Ctrl+C stops it (the partial
  // copy is removed the next time the loader opens).
  async function getFrozen() {
    if (!places) { console.log(frozen.problem); return; }
    let running;
    try { running = gameRunning(); } catch { console.log('Could not tell whether Geoplanetical is running. Close it if it is, then try again.'); return; }
    if (running) { console.log('Geoplanetical is running. Close it first: the frozen game may be in use.'); return; }
    const fits = live && live.build === PIN.build && !live.updating;
    console.log(`\nGet the frozen game: your own copy of game ${PIN.version} (build ${PIN.build}), about 3.9 GB.`);
    console.log(`  1. Copy from your Steam game${fits ? '' : ` (not possible now: it is build ${live?.build ?? 'not found'})`}`);
    console.log('  2. Download with Steam (you paste one command into Steam\'s console)');
    console.log('  3. Copy from a folder that holds that build');
    const pick = (await rl.question('Type 1, 2 or 3 and Enter (Enter alone goes back): ')).trim();
    let last = 0;
    const onProgress = p => {
      if (p.step === 'waiting') {
        console.log(`\nSteam's console is opening. Click in it, ${p.clipboard ? 'press Ctrl+V (the command is copied)' : 'type this command'}, then press Enter:\n  ${p.command}\nWaiting for Steam to finish (Ctrl+C stops)...`);
      } else if (p.step === 'downloading') console.log(`Steam is downloading game ${PIN.version}${p.mb ? ` (${p.mb} MB)` : ''}...`);
      else if (Date.now() - last > 3000 && p.total) {
        last = Date.now();
        console.log(`${p.step === 'copying' ? 'copying' : p.step === 'checking-download' ? 'checking Steam\'s download' : 'checking the copy'}: ${(p.done / 1024 ** 3).toFixed(1)} of ${(p.total / 1024 ** 3).toFixed(1)} GB`);
      }
    };
    try {
      if (pick === '1') {
        if (!fits) { console.log('Your Steam game is another version now: download with Steam instead.'); return; }
        await copyIn(live.dir, places, { onProgress, log, what: 'Your Steam game' });
      } else if (pick === '2') {
        const steamDir = steamPath();
        if (!steamDir) { console.log('Steam\'s folder was not found.'); return; }
        await steamDownload({ steam, steamDir, places, onStatus: onProgress, log });
      } else if (pick === '3') {
        const dir = (await rl.question('Paste the folder (the one with Geoplanetical.exe): ')).trim().replace(/^"|"$/g, '');
        if (!dir) return;
        await copyIn(dir, places, { onProgress, log });
      } else return;
      console.log(`\nThe frozen game is ready: build ${PIN.build} (game ${PIN.version}).`);
    } catch (e) {
      log(`the frozen game could not be set up: ${e.said ? e.message : e?.stack || e}`);
      if (!e.said) console.log('The frozen game could not be set up (see above). It was not changed.');
    } finally {
      await checkFrozen();
    }
  }
}

// Wraps text to `width` columns: the first line starts with `first`, the rest with `rest`.
function wrap(text, width, first, rest) {
  const lines = [];
  let line = first;
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width && line.trim() !== first.trim()) { lines.push(line); line = rest; }
    line += (line === first || line === rest ? '' : ' ') + word;
  }
  lines.push(line);
  return lines.join('\n');
}

const FROZEN_LABEL = {
  ready: 'ready', missing: 'not set up (G then Enter to get it)', other: 'an older version (G then Enter to get the new one)',
  broken: 'needs fixing (G then Enter)', unreadable: 'could not be read just now', unavailable: 'unavailable',
};

function screen({ game, live, frozen, places, play }, mods, broken, enabled) {
  console.log(`\n${PRODUCT} ${VERSION}`);
  console.log(`${play === 'frozen' ? '>' : ' '} Frozen game: game ${PIN.version} (build ${PIN.build}), ${FROZEN_LABEL[frozen.status] ?? frozen.status}${frozen.status === 'ready' ? `  ${places.game}` : ''}`);
  if (play === 'frozen' && frozen.problem && frozen.status !== 'missing') console.log(`    ${frozen.problem}`);
  if (play === 'frozen') console.log('    It keeps its own saves (your Steam saves are copied in the first time); Steam Cloud does not back them up.');
  console.log(`${play === 'live' ? '>' : ' '} Live Steam game: ${live ? `build ${live.build ?? 'unknown'}  ${live.dir}` : 'not found'}`);
  if (play === 'live' && live?.updating) console.log(`    Steam is updating the game${live.targetBuild ? ` to build ${live.targetBuild}` : ''}: it cannot be started with mods until that finishes.`);
  console.log(`Mods folder: ${MODS}\n`);
  if (!mods.length && !broken.length) console.log('  (no mods found; put a mod folder inside the mods folder)');
  mods.forEach((m, i) => {
    const fits = !!game && m.builds.includes(game.build);
    const box = !fits ? '[ unavailable ]' : enabled(m) ? '[x]' : '[ ]';
    console.log(`  ${i + 1}. ${box} ${m.name} ${m.version}${m.author ? ` by ${m.author}` : ''}`);
    if (!fits) console.log(`        made for game build ${m.builds.join(', ')}; the ${play === 'frozen' ? 'frozen' : 'Steam'} game is ${game?.build ?? 'not found'}. Wait for an updated version of this mod.`);
    if (m.requires?.length) {
      const needs = m.requires.map(id => mods.find(o => o.id === id)?.name ?? `${id} (not installed)`);
      console.log(`        needs: ${needs.join(', ')}`);
    }
    if (m.scripts?.length) console.log('        also runs its own script in the game\'s window');
    if (m.patches?.some(p => p.bundle === PAGE_BUNDLE)) console.log('        also changes wording in the game\'s window (English and French)');
    if (m.changes?.length) {
      console.log(`        What it changes:`);
      for (const g of changeGroups(m)) {
        if (g.group) console.log(`
          ${g.group.toUpperCase()}`);
        for (const c of g.items) console.log(wrap(c, 104, '          - ', '            '));
      }
      console.log('');
    }
  });
  for (const b of broken) console.log(`  -  [ broken ] ${b.folder}: ${b.error}`);
  console.log('\nType a number and Enter to switch a mod on or off; F or L and Enter to play the frozen or the live game;\n' +
    'G and Enter to get the frozen game. Press Enter to start the game, or Q then Enter to quit.');
}
