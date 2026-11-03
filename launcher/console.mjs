// The launcher's text menu (node launcher/main.mjs --console): the same steps as the window (launcher/gui.mjs), typed
// at a prompt. Kept for development and for players who prefer it.
import { createInterface } from 'node:readline/promises';
import { scanMods, changeGroups } from '../patcher/mods.mjs';
import { findGame, gameRunning, steamExe } from '../patcher/game.mjs';
import {
  VERSION, PRODUCT, MODS, makeLog, readSettings, saveSettings, isEnabled, chooseMods, launchBlocker, buildMods, playSession,
} from './core.mjs';

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
  const settings = readSettings();
  if (gameDirArg) { settings.gameDir = gameDirArg; saveSettings(settings, log); }
  let game = findGame(settings.gameDir || null);
  while (!game) {
    console.log(settings.gameDir
      ? `\nThe folder in launcher-settings.json does not hold the game: ${settings.gameDir}`
      : '\nGeoplanetical was not found in your Steam libraries.');
    const dir = (await rl.question('Paste the game folder (the one with Geoplanetical.exe), or press Enter to quit: ')).trim().replace(/^"|"$/g, '');
    if (!dir) await exitAfterKey(1);
    game = findGame(dir);
    if (game) { settings.gameDir = dir; saveSettings(settings, log); }
  }
  const steam = steamExe();
  if (!steam) await exitAfterKey(1, 'Steam was not found on this PC. The game must be started through Steam.');

  const { mods, broken } = scanMods(MODS);
  for (;;) {
    screen(game, mods, broken, m => isEnabled(settings, m));
    const answer = (await rl.question('> ')).trim().toLowerCase();
    if (answer === 'q') { rl.close(); return; }
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
      console.log('\nNo mod is switched on. Start the game from Steam as usual to play without mods.');
      continue;
    }
    const blocker = launchBlocker(settings, game);
    if (blocker) { console.log(`\n${blocker}`); continue; }
    while (gameRunning()) {
      const r = (await rl.question('\nGeoplanetical is already running. Close it, then press Enter (or Q then Enter to go back): ')).trim().toLowerCase();
      if (r === 'q') break;
    }
    if (gameRunning()) continue;
    const built = buildMods(game, chosen, log);
    if (built.error) { console.log(built.error); continue; }
    if (dryRun) { log('dry run: everything checks out; the game was not started'); rl.close(); return; }
    console.log('Leave this window open while you play: it keeps the mods active. Closing it early turns them off for\n' +
      'parts of the game that restart. Saves made now need the same mods to load correctly.');
    const end = await playSession({ steam, port, payloads: built.payloads, scripts: built.scripts, chosen, log });
    await exitAfterKey(end.problem ? 1 : 0, end.message);
    return;
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

function screen(game, mods, broken, enabled) {
  console.log(`\n${PRODUCT} ${VERSION}`);
  console.log(`Game: ${game.dir}  (build ${game.build ?? 'unknown'})`);
  if (game.updating) console.log(`  Steam is updating the game${game.targetBuild ? ` to build ${game.targetBuild}` : ''}: it cannot be started with mods until that finishes.`);
  console.log(`Mods folder: ${MODS}\n`);
  if (!mods.length && !broken.length) console.log('  (no mods found; put a mod folder inside the mods folder)');
  mods.forEach((m, i) => {
    const fits = m.builds.includes(game.build);
    const box = !fits ? '[ unavailable ]' : enabled(m) ? '[x]' : '[ ]';
    console.log(`  ${i + 1}. ${box} ${m.name} ${m.version}${m.author ? ` by ${m.author}` : ''}`);
    if (!fits) console.log(`        made for game build ${m.builds.join(', ')}; your game is ${game.build}. The game has updated: wait for an updated version of this mod.`);
    if (m.requires?.length) {
      const needs = m.requires.map(id => mods.find(o => o.id === id)?.name ?? `${id} (not installed)`);
      console.log(`        needs: ${needs.join(', ')}`);
    }
    if (m.scripts?.length) console.log('        also runs its own script in the game\'s window');
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
  console.log('\nType a number and Enter to switch a mod on or off. Press Enter to start the game, or Q then Enter to quit.');
}
