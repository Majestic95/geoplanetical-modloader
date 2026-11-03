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
import { PAGE } from '../patcher/session.mjs';

export const VERSION = '0.4.0';
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
