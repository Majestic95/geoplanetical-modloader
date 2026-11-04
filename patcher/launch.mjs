// Runtime patcher: launches Geoplanetical through Steam (or the loader's frozen copy) with Chromium remote debugging,
// swaps the patched bundles into their workers before the originals run (patcher/session.mjs), and checks the marker
// inside each worker; the mods' page scripts run in the game page. Stays attached until the game closes: later worker
// restarts are patched too, and the page scripts run again on every page load.
//
// The command-line launcher for mod authors (players use launcher/). Run from the workspace that holds mods/.
// Usage: node <loader>/patcher/launch.mjs [--port 9333] [--mods <dir>] [--mod <id> ...] [--unpatched] [--dry-run]
//          [--require-patched] [--game-dir <folder> | --frozen]
//   --mods       the folder holding the mod folders (default: mods/ in the current folder)
//   --mod        load only these mods, in this order (default: every mod); name the mods they require too, which
//                then load first
//   --unpatched  launch with the same harness but leave every worker original (baseline runs)
//   --dry-run    run every check and build the payloads, but do not launch
//   --require-patched  exit 1 if any patched bundle's worker is not verified as running patched code (test runs)
//   --game-dir   the game's folder, instead of finding it through Steam's library list
//   --frozen     play the loader's frozen copy of the pinned build (patcher/frozen.mjs; set it up in the loader's
//                window), started from its folder with its own saves, instead of the Steam game
//
// Single player only: a patched game diverges from unpatched multiplayer peers. The game must not already be running
// (the launcher attaches only to a game it starts).
import { resolve, join } from 'node:path';
import { buildBundle } from './patch-engine.mjs';
import { modArgs, argValue, MODS_DIR } from './build.mjs';
import { loadMods } from './mods.mjs';
import { findGame, gameRunning, steamExe, originalBundle } from './game.mjs';
import { launchAndServe } from './runner.mjs';
import { PIN, frozenPlaces, checkFolder, checkProblem, steamRunning, copySavesOnce } from './frozen.mjs';
import { PAGE, PAGE_BUNDLE } from './session.mjs';

const argv = process.argv.slice(2);
const opt = name => argv.includes(name);
const port = Number(argv[argv.indexOf('--port') + 1]) || 9333;
const log = msg => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function fail(msg) {
  console.error(`patcher: ${msg}`);
  process.exit(1);
}

async function main() {
  const places = opt('--frozen') ? frozenPlaces() : null;
  if (opt('--frozen') && argValue(argv, '--game-dir')) fail('--frozen and --game-dir cannot be combined');
  if (opt('--frozen') && !places) fail('the Windows folder for program data (LOCALAPPDATA) is not set; there is no frozen copy');
  let game;
  if (places) {
    // The frozen copy's build is the pin its files match, not an appmanifest's.
    const r = await checkFolder(places.game);
    if (!r.ok) fail(`${checkProblem(r, `The loader's frozen copy (${places.game})`)} Set it up in the loader's window first.`);
    game = { dir: places.game, build: PIN.build, updating: false, targetBuild: null };
  } else {
    game = findGame(argValue(argv, '--game-dir'));
    if (!game) fail('Geoplanetical not found in the Steam libraries (or in --game-dir)');
  }
  const build = game.build;
  if (!build) fail(`the installed build is unknown (no Steam appmanifest beside ${game.dir}); mods cannot be matched to it`);
  if (game.updating && !opt('--dry-run')) fail(`Steam has an update pending for the game (target build ${game.targetBuild}); let it finish first`);
  if (game.updating) log(`warning: Steam has an update pending (target build ${game.targetBuild}); a real launch would refuse`);
  if (gameRunning()) fail('Geoplanetical is already running; the patcher only attaches to a game it starts');

  const payloads = new Map();
  let scripts = [];
  if (!opt('--unpatched')) {
    const modsDir = resolve(argValue(argv, '--mods') || MODS_DIR);
    const mods = loadMods(modsDir, { only: modArgs(argv) });
    if (!mods.length) fail(`no mods in ${modsDir}; use --unpatched for a baseline run`);
    log(`mods: ${mods.map(m => `${m.id} ${m.version}`).join(', ')}`);
    // The original bundles come from the installed game's app.asar, as in the player launcher.
    for (const bundle of [...new Set(mods.flatMap(m => m.patches.map(p => p.bundle)))].sort()) {
      const r = buildBundle(originalBundle(game, bundle), mods, { build, bundle });
      if (!r) continue;
      payloads.set(bundle, r.text);
      log(`built ${bundle}: ${r.report.length} edit(s)`);
    }
    // Page scripts run as they are; like a patch, a script is only for the builds its mod was made for.
    for (const m of mods.filter(x => x.scripts.length && !x.builds.includes(build))) {
      fail(`mod ${m.id} ${m.version} is made for game build ${m.builds.join(', ')}, not ${build}: it needs updating for this game version`);
    }
    scripts = mods.flatMap(m => m.scripts.map(s => ({ mod: m.id, path: s.path, text: s.text })));
    if (scripts.length) log(`page: ${scripts.length} script(s): ${scripts.map(s => `${s.mod}/${s.path}`).join(', ')}`);
  }
  log(`mode ${opt('--unpatched') ? 'UNPATCHED baseline' : 'patched'}, build ${build}${places ? ' (frozen copy)' : ''}, port ${port}, game ${game.dir}`);
  log('single player only: a patched game diverges from unpatched multiplayer peers');
  if (opt('--dry-run')) return log('dry run: not launching');

  let steam = null, frozen = null;
  if (places) {
    // Started outside Steam, the game needs Steam running, or it would run without the player's account.
    if (!steamRunning()) fail('Steam is not running. Start Steam and sign in, then try again.');
    const saves = await copySavesOnce(places.data).catch(e => fail(`could not copy the Steam saves into the frozen copy's saves (${e.code || e.message})`));
    if (!saves.already) log(`copied ${saves.files} save file(s) of the Steam game into the frozen copy's saves (once): ${join(places.data, 'saves')}`);
    // Checked again as the last step before the start, and started from the folder as checked.
    const r = await checkFolder(places.game);
    if (!r.ok) fail(checkProblem(r, `The loader's frozen copy (${places.game})`));
    frozen = { dir: r.dir, dataDir: places.data };
  } else {
    steam = steamExe();
    if (!steam) fail('Steam not found (HKCU\\Software\\Valve\\Steam SteamExe)');
  }
  await launchAndServe({ steam, frozen, port, payloads, scripts, log, onSwap, onExit: code => { log(code ? 'patcher exiting (error)' : 'patcher exiting'); process.exit(code); } });
  log('attached; leave this running while you play. Ctrl+C detaches (later worker restarts are then unpatched).');
}

function onSwap({ bundle, status, detail }) {
  if (status === 'patched') return;
  if (bundle === PAGE) {
    log(`!!! A PAGE SCRIPT ${status === 'broken' ? 'FAILED' : 'DID NOT RUN'}: ${detail || status}. The workers are unaffected; ` +
      'see the game\'s developer tools console for the error.');
  } else if (bundle === PAGE_BUNDLE && status !== 'broken') {
    log(`!!! THE WORDING CHANGES ARE NOT ACTIVE (${status}): ${detail || status}. The game shows its own text; the workers are unaffected.`);
  } else if (bundle === PAGE_BUNDLE) {
    log(`!!! THE MOD FAILED in ${bundle}: ${detail || status}. The game's window may not work in this session. Close the game and launch without this mod.`);
  } else if (status === 'unverified') {
    log(`worker ${bundle}: the patched code ran but could not be verified as the one serving the game.`);
  } else if (status === 'broken') {
    log(`!!! THE MOD FAILED in ${bundle}: its code threw while starting and the worker is stopped, so the game will ` +
      'not work in this session. Close the game and launch without this mod.');
  } else {
    log(`!!! THE MOD IS NOT ACTIVE in ${bundle} (${status}). This game session runs unmodded code; do not test or ` +
      'compare it as modded. Close the game and check the log above.');
  }
  if (opt('--require-patched')) process.exit(1);
}

main().catch(e => fail(e.stack || e.message));
