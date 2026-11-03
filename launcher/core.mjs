// What the player launcher does, shared by its two front ends (launcher/gui.mjs, the window; launcher/console.mjs,
// the text menu): the files beside the executable, the settings file, the log, building the chosen mods into the
// game's code (read from the game's app.asar, never written), and starting the game through Steam while serving the
// patched code to its workers.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { isSea } from 'node:sea';
import { buildBundle } from '../patcher/patch-engine.mjs';
import { requirementProblem, orderMods } from '../patcher/mods.mjs';
import { findGame, originalBundle } from '../patcher/game.mjs';
import { launchAndServe } from '../patcher/runner.mjs';

export const VERSION = '0.3.0';
export const PRODUCT = 'Geoplanetical Mod Loader';
// Packaged: everything sits beside the executable. Development: the repository root (mods/ is the repo's).
export const BASE = isSea() ? dirname(process.execPath) : join(dirname(fileURLToPath(import.meta.url)), '..');
export const MODS = join(BASE, 'mods');
const SETTINGS = join(BASE, 'launcher-settings.json');
export const LOG = join(BASE, 'launcher.log');

// A log that writes launcher.log and passes each line to the front end's `show(line)`.
export function makeLog(show) {
  return msg => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    try { show(line); } catch { /* the front end may be gone */ }
    try { appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* the log is a convenience */ }
  };
}

// The settings file is the player's to edit: anything but a plain object (or a gameDir that is not text) is ignored.
export function readSettings() {
  let s;
  try { s = JSON.parse(readFileSync(SETTINGS, 'utf8')); } catch { return { enabled: {} }; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { enabled: {} };
  if (typeof s.gameDir !== 'string') delete s.gameDir;
  if (!s.enabled || typeof s.enabled !== 'object' || Array.isArray(s.enabled)) s.enabled = {};
  return s;
}
export function saveSettings(s, log) {
  try { writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n'); } catch (e) { log(`could not save settings: ${e.message}`); }
}

export const isEnabled = (settings, m) => settings.enabled[m.id] !== false;

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

// Builds the chosen mods into the game's code and checks it compiles: { payloads } or { error }.
export function buildMods(game, chosen, log) {
  log(`building ${chosen.map(m => `${m.name} ${m.version}`).join(', ')} for build ${game.build}`);
  log('read-only: the game files are read, never changed');
  const payloads = new Map();
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
  return { payloads };
}

// Starts the game through Steam and serves it until it closes. Resolves { problem, message } at the end of the session;
// onSwap({ bundle, status }) also reports each worker swap as it happens.
export async function playSession({ steam, port, payloads, chosen, log, onSwap: report = () => {} }) {
  log(`starting Geoplanetical through Steam with ${chosen.map(m => m.name).join(', ')}`);
  let problem = false;
  const confirmed = new Set();
  const onSwap = ({ bundle, status }) => {
    try { report({ bundle, status }); } catch { /* the front end's display only */ }
    if (status === 'patched') { confirmed.add(bundle); return log(`mods active (${bundle})`); }
    problem = true;
    if (status === 'unverified') log(`warning: the mods started in ${bundle} but could not be confirmed as running.`);
    else if (status === 'broken') log(`THE MODS FAILED in ${bundle}: the game will not work this session. Close the game and report this, with launcher.log.`);
    else log(`THE MODS ARE NOT ACTIVE in ${bundle} (${status}): this session plays the unmodded game. Close the game and report this, with launcher.log.`);
  };
  await new Promise(resolve => {
    launchAndServe({ steam, port, payloads, log, onSwap, onExit: code => { if (code) problem = true; resolve(); } })
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
  return {
    problem,
    message: problem
      ? 'Something went wrong (see the log). Saves from that session may be unmodded. launcher.log beside this program has the details.'
      : 'The game has closed. The mods were active the whole session.',
  };
}
