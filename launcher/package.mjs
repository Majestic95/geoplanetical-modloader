// Packages the player launcher: bundles launcher/main.mjs into one CommonJS file (esbuild), turns it into a Node
// single executable (node --experimental-sea-config, then postject into a copy of this node.exe, marked as a windowed
// program), and lays out <out>/<name>/ with the executable, a mods folder and the README, then zips it.
// By default the package holds the loader alone (an empty mods folder). A mod author can ship a ready-to-play pack
// with their mods inside (mod.json, patch files and page scripts only, checked with the launcher's own strict loader).
// Usage: node launcher/package.mjs [--mods <dir>] [--mod <id> ...] [--name <folder>] [--readme <file>] [--out <dir>]
//   --mods    the folder holding the mod folders to include (all of them unless --mod names some)
//   --mod     include only these mods (from --mods, default mods/ in the current folder)
//   --name    the package folder and zip name (default "Geoplanetical Mod Loader")
//   --readme  the README.txt to ship (default launcher/README-player.txt)
//   --out     where the package goes (default dist/package in the current folder)
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { loadMods } from '../patcher/mods.mjs';
import { modArgs, argValue } from '../patcher/build.mjs';
import { PRODUCT, VERSION } from './core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const NAME = argValue(argv, '--name') || PRODUCT;
// Starts and ends with a letter, digit or _ ( ) -, so it can never be "." or ".." or lose trailing dots and spaces
// to Windows: each output path below is then a direct child of OUT_ROOT (checked again after resolving).
if (!/^[\w()-]([\w .()-]{0,78}[\w()-])?$/.test(NAME)) {
  throw new Error(`--name "${NAME}": letters, digits, spaces and . _ ( ) -, not starting or ending with a dot or space`);
}
const OUT_ROOT = resolve(argValue(argv, '--out') || join(process.cwd(), 'dist', 'package'));
const OUT = join(OUT_ROOT, NAME);
const ZIP = join(OUT_ROOT, `${NAME}.zip`);
const WORK = join(OUT_ROOT, `${NAME}.build`);
for (const p of [OUT, ZIP, WORK]) {
  if (dirname(p) !== OUT_ROOT) throw new Error(`${p} is not directly inside ${OUT_ROOT}; refusing to replace it`);
}
const inside = (p, dir) => { const r = relative(dir, p); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
const README = resolve(argValue(argv, '--readme') || join(ROOT, 'launcher', 'README-player.txt'));
const EXE = 'GeoplaneticalModLoader.exe';
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const run = (cmd, args, what) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`${what} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

// The mods to include, validated with the launcher's own strict loader before they are copied.
const wantMods = argv.includes('--mods') || argv.includes('--mod');
const modsDir = resolve(argValue(argv, '--mods') || join(process.cwd(), 'mods'));
const mods = wantMods ? loadMods(modsDir, { only: modArgs(argv) }) : [];
if (wantMods && !mods.length) throw new Error(`no mods in ${modsDir}`);
if (!existsSync(README)) throw new Error(`no README at ${README}`);
// The old package is deleted below before anything is copied: a source inside it would be lost.
for (const [what, p] of [['--readme', README], ['--mods', modsDir]]) {
  if ((what === '--readme' || wantMods) && [OUT, WORK].some(d => inside(p, d))) throw new Error(`${what} ${p} is inside the package being replaced`);
}

// Only this package's own folder, zip and work folder are replaced; nothing else in --out is touched. Each is
// replaced only when it is missing or is what an earlier run made, so a name that happens to match another folder
// (`--out . --name mods`) is refused instead of deleted.
const madeHere = [[OUT, () => existsSync(join(OUT, EXE))], [WORK, () => existsSync(join(WORK, 'sea-config.json'))],
  [ZIP, () => statSync(ZIP).isFile()]];
for (const [p, ours] of madeHere) {
  if (existsSync(p) && !ours()) throw new Error(`${p} exists and is not an earlier package; move or delete it yourself`);
}
for (const p of [WORK, OUT, ZIP]) rmSync(p, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

// 1. One CommonJS file. import.meta.url is used only outside the packaged executable (launcher/core.mjs BASE).
await build({
  entryPoints: [join(ROOT, 'launcher', 'main.mjs')], bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  outfile: join(WORK, 'launcher.cjs'), logLevel: 'error', define: { 'import.meta.url': 'undefined' },
});

// 2. The single executable.
writeFileSync(join(WORK, 'sea-config.json'), JSON.stringify({
  main: join(WORK, 'launcher.cjs'), output: join(WORK, 'sea-prep.blob'), disableExperimentalSEAWarning: true,
}, null, 2));
run(process.execPath, ['--experimental-sea-config', join(WORK, 'sea-config.json')], 'node --experimental-sea-config');
const exe = join(OUT, EXE);
copyFileSync(process.execPath, exe);
run(process.execPath, [join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'), exe, 'NODE_SEA_BLOB', join(WORK, 'sea-prep.blob'),
  '--sentinel-fuse', SENTINEL], 'postject');
// Windows GUI subsystem (PE optional header Subsystem, at e_lfanew + 0x5C: 3 console -> 2 GUI), so double-clicking the
// launcher opens only its window (launcher/gui.mjs), no console. Checked against the PE signature before writing.
{
  const img = readFileSync(exe), pe = img.readUInt32LE(0x3c);
  if (img.toString('latin1', pe, pe + 4) !== 'PE\0\0' || img.readUInt16LE(pe + 0x5c) !== 3) throw new Error('unexpected executable header; subsystem not changed');
  img.writeUInt16LE(2, pe + 0x5c);
  writeFileSync(exe, img);
}

// 3. The mods folder (with its README, and the mods if any: mod.json, patch files and page scripts only), the README and
// the license.
mkdirSync(join(OUT, 'mods'), { recursive: true });
copyFileSync(join(ROOT, 'launcher', 'mods-README.txt'), join(OUT, 'mods', 'README.txt'));
for (const m of mods) {
  const dst = join(OUT, 'mods', m.id);
  mkdirSync(dst, { recursive: true });
  copyFileSync(join(m.dir, 'mod.json'), join(dst, 'mod.json'));
  const manifest = JSON.parse(readFileSync(join(m.dir, 'mod.json'), 'utf8'));
  for (const rel of [...(manifest.patches || []), ...(manifest.scripts || [])]) { // either may sit in sub-folders of the mod
    mkdirSync(dirname(join(dst, rel)), { recursive: true });
    copyFileSync(join(m.dir, rel), join(dst, rel));
  }
}
copyFileSync(README, join(OUT, 'README.txt'));
copyFileSync(join(ROOT, 'LICENSE'), join(OUT, 'LICENSE.txt'));
rmSync(WORK, { recursive: true, force: true });

// 4. Zip for sending.
// The paths go in through the environment, never inside the command text, so no character in them can end a string
// (PowerShell -Command joins any further arguments into the command text).
const zipped = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
  'Compress-Archive -LiteralPath $env:GPML_ZIP_FROM -DestinationPath $env:GPML_ZIP_TO -Force'],
{ encoding: 'utf8', shell: false, env: { ...process.env, GPML_ZIP_FROM: OUT, GPML_ZIP_TO: ZIP } });
if (zipped.status !== 0) throw new Error(`zip failed:\n${zipped.stdout}\n${zipped.stderr}`);
console.log(`packaged ${PRODUCT} ${VERSION}: ${OUT}`);
console.log(`  ${readdirSync(OUT).join(', ')}; mods: ${mods.length ? mods.map(m => `${m.id} ${m.version} (builds ${m.builds.join(', ')})`).join('; ') : 'none'}`);
console.log(`zip: ${ZIP}${existsSync(ZIP) ? '' : ' (missing!)'}`);
