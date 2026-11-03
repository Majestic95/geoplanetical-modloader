// Geoplanetical Mod Loader, the player launcher: finds Geoplanetical through Steam's library list (or a folder the
// player gives once), lists the mods in the mods folder beside it with an on/off switch and changelog each, builds the
// chosen mods (each after the mods it requires) into the game's own code (read from the game's app.asar, never
// written), starts the game through Steam and stays attached while it runs. Opens a window by default
// (launcher/gui.mjs); --console gives the text menu (launcher/console.mjs).
// Packaged as a single windowed executable by launcher/package.mjs; for development: node launcher/main.mjs
//
// Usage: launcher [--console] [--dry-run] [--game-dir <folder>] [--port 9333] [--no-window]
//   --no-window (testing) serve the window's page without opening it; its address is printed
//   --console   the text menu instead of the window (development; the packaged executable has no console)
//   --dry-run   check the game and the mods and build them, but do not start the game
//   --game-dir  the game's folder (the one holding resources\app.asar); remembered in launcher-settings.json
// Single player only: a modded game diverges from unmodded multiplayer peers.
import { makeLog } from './core.mjs';
import { runConsole } from './console.mjs';
import { runGui, messageBox } from './gui.mjs';
import { LOG } from './core.mjs';

const argv = process.argv.slice(2);
const arg = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const opts = { dryRun: argv.includes('--dry-run'), port: Number(arg('--port')) || 9333, gameDirArg: arg('--game-dir'), noWindow: argv.includes('--no-window') };

const consoleMode = argv.includes('--console');
(consoleMode ? runConsole : runGui)(opts).catch(async e => {
  makeLog(line => console.error(line))(`error: ${e.stack || e.message}`);
  // The windowed launcher has no console: say it in a message box.
  if (!consoleMode && !opts.noWindow) await messageBox(`The loader could not start: ${e.message}\n\nDetails are in ${LOG}`);
  process.exit(1);
});
