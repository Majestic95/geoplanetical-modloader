// Offline build for mod authors: applies the mods in a workspace to game bundles extracted from the game and writes
// the patched bundles to <workspace>/dist/<build>/, to read, diff or test (the launcher builds in memory instead).
// The workspace is the current folder (or GPML_WORKSPACE): mods in <workspace>/mods, extracted game code in
// <workspace>/.modding/decompiled/app-<build>/renderer/ (GEO_DECOMPILED: the folder holding app-<build>/), and the
// target build in <workspace>/tools/GAME_BUILD when that file exists, else the installed game's build
// (docs/authoring.md). Also imported by mod tests for the same paths: they are fixed when this module is first
// imported, so run such tests from the workspace (or set GPML_WORKSPACE before starting node).
// Usage: node <loader>/patcher/build.mjs [--build <id>] [--mods <dir>] [--mod <id> ...] [--no-check]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from './patch-engine.mjs';
import { loadMods } from './mods.mjs';
import { findGame } from './game.mjs';

export const WORKSPACE = resolve(process.env.GPML_WORKSPACE || process.cwd());
export const MODS_DIR = join(WORKSPACE, 'mods');
export const DECOMPILED = resolve(process.env.GEO_DECOMPILED || join(WORKSPACE, '.modding', 'decompiled'));

// The build the workspace targets: tools/GAME_BUILD if present, else the installed game's build, else null.
export function workspaceBuild() {
  const pin = join(WORKSPACE, 'tools', 'GAME_BUILD');
  if (existsSync(pin)) return readFileSync(pin, 'utf8').trim();
  return findGame()?.build ?? null;
}

// `--mod a --mod b` in argv, or null for every mod.
export function modArgs(argv) {
  const ids = argv.flatMap((a, i) => (a === '--mod' ? [argv[i + 1]] : []));
  return ids.length ? ids : null;
}

// The value after `name` in argv, or null.
export const argValue = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? null : null);

export function bundlePath(build, bundle, decompiled = DECOMPILED) {
  return join(decompiled, `app-${build}`, 'renderer', bundle);
}

// Returns Map(bundle -> { text, report, loaded }) built from the local extraction of `build`.
export function buildAll(build, mods, { decompiled = DECOMPILED } = {}) {
  const out = new Map();
  const bundles = [...new Set(mods.flatMap(m => m.patches.map(p => p.bundle)))].sort();
  for (const bundle of bundles) {
    const r = buildBundle(readFileSync(bundlePath(build, bundle, decompiled), 'utf8'), mods, { build, bundle });
    if (r) out.set(bundle, r);
  }
  return out;
}

function main(argv) {
  const build = argValue(argv, '--build') || workspaceBuild();
  if (!build) throw new Error('no game build: pass --build <id>, write it to tools/GAME_BUILD, or install the game');
  const modsDir = resolve(argValue(argv, '--mods') || MODS_DIR);
  const mods = loadMods(modsDir, { only: modArgs(argv) });
  if (!mods.length) throw new Error(`no mods in ${modsDir}`);
  const dir = join(WORKSPACE, 'dist', build);
  mkdirSync(dir, { recursive: true });
  for (const m of mods.filter(x => x.scripts.length)) {
    console.log(`${m.id}: ${m.scripts.length} page script(s), checked to parse; they run as they are (nothing to build)`);
  }
  for (const [bundle, r] of buildAll(build, mods)) {
    const file = join(dir, bundle);
    writeFileSync(file, r.text);
    console.log(`${bundle}: ${r.loaded.map(m => `${m.id} ${m.version}`).join(', ')} -> ${file}`);
    for (const e of r.report) console.log(`  ${JSON.stringify(e)}`);
    if (!argv.includes('--no-check')) {
      const c = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (c.status !== 0) throw new Error(`node --check failed for ${bundle}:\n${c.stderr}`);
      console.log('  node --check ok');
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main(process.argv.slice(2));
