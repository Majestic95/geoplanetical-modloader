# Writing a mod

This guide walks through making a mod for the Geoplanetical Mod Loader with the tools in this repository. The
format itself is specified in [mod-format.md](mod-format.md).

You need Windows, Steam with Geoplanetical installed, [Node.js](https://nodejs.org) 22.15 or later, and Python 3
for the extraction and lookup tools (`asar_extract.py`, `ctx.py`, `fn.py`, `rename-map.py`). In Git Bash, prefix a command whose arguments start with `/` with `MSYS_NO_PATHCONV=1`, or
Git Bash rewrites them into Windows paths.

## 1. Set up

Clone this repository and install its dependencies once:

```
git clone https://github.com/Majestic95/geoplanetical-modloader.git
cd geoplanetical-modloader
npm ci
```

Then make a separate folder for your mod work, your **workspace**. The tools read from the folder you run them
in:

```
my-mods/
  mods/
    my-mod/            your mod (mod.json, patches/)
  tools/GAME_BUILD     optional: the game build you work against (a single line, e.g. 26368058)
  .modding/
    decompiled/        game code you extract (step 2); never share or commit it
```

Below, `<loader>` stands for the path to your clone of this repository. Without `tools/GAME_BUILD`, `bq.mjs` and
`build.mjs` use the build of the game installed through Steam; `fn.py` then needs `--build`.

Two environment variables change the defaults: `GPML_WORKSPACE` (the workspace folder, instead of the current
folder) and `GEO_DECOMPILED` (the folder holding the `app-<build>` folders, instead of `.modding/decompiled`).

## 2. Extract the game's code

The game's code sits inside `resources\app.asar` in its install folder. Copy out the bundle you want to change; the
game's files are only read. Use the installed build id (Steam's `steamapps\appmanifest_940230.acf`, `"buildid"`):

```
python -I <loader>/tools/asar_extract.py "<game folder>/resources/app.asar" .modding/decompiled/app-26368058 /renderer/simulation-worker.bundle.js
```

The last arguments are path prefixes inside the archive. Name each bundle you need: the whole `/renderer` folder is
several gigabytes, mostly media. Most of the simulation lives in `simulation-worker.bundle.js`.

## 3. Find the code to change

The bundles are minified single-line files of 30 to 100 MB, so ordinary search tools print far too much. Use:

- `node --max-old-space-size=8000 <loader>/tools/bq.mjs def|src|find|at|in|refs <argument>`: questions about the
  simulation bundle answered from its syntax tree (definitions, a function's source, who refers to a name, which
  function holds an offset). Needs about 8 GB of memory.
- `python -I <loader>/tools/fn.py def|refs|at|find <argument>`: a lighter lookup (about 1 GB) with the same offsets.
- `python -I <loader>/tools/ctx.py <file> <regex> [count] [width]`: regex matches with a little context.

Start from text that players see or that never changes between builds (an error message, an event id, a config
key), find the function around it, and read what it does.

## 4. Write the patch

Create `mods/my-mod/mod.json` and a patch file as in [mod-format.md](mod-format.md). For each edit:

- choose a `find` that is unique and covers the exact code you change;
- choose an `anchor` of stable text close by (not a minified name);
- keep the replacement deterministic (no time, randomness, page state or timers);
- if the replacement calls game functions by their minified names, note them: they change with each build.

## 5. Build and check

From your workspace:

```
node --max-old-space-size=8000 <loader>/patcher/build.mjs [--mod my-mod] [--build <id>] [--mods <dir>] [--no-check]
```

This applies the mods to the extracted bundles, writes the result to `dist/<build>/` and checks that it parses. Any
edit that does not fit stops the build with the mod, patch and edit named. Diff the output against the original
bundle, or load it in your own tests: `patcher/build.mjs` exports `buildAll`, `bundlePath`, `workspaceBuild` and
`MODS_DIR` for scripts run from the workspace.

## 6. Play it

Close the game, then start it through the loader with only your mod:

```
node <loader>/patcher/launch.mjs --mod my-mod
```

This starts the game through Steam, applies the mod in memory and stays attached until the game closes; it prints
whether each patched part of the game is confirmed to run your code. `--dry-run` does everything except start the
game, and `--unpatched` starts the game through the same path without mods, for comparison. You can also copy your
mod folder into the `mods` folder of a packaged loader and use its window.

Test at least: a new game, a few months of play, save, quit, and load the save again through the loader.

## 7. Release

Zip your mod folder (`my-mod/` with `mod.json` and its patch files) for players to unzip into their loader's
`mods` folder. Do not include extracted game files: a mod carries only the short pieces of game code in its
`find` and `anchor` text.

To hand players a ready-to-play package with the loader and your mods in one zip:

```
node <loader>/launcher/package.mjs --mods mods --name "My Mod Pack" [--readme my-readme.txt]
```

The package lands in `dist/package/` in your workspace.

## When the game updates

A game update changes the build id, and usually the minified names and positions in the bundles. The loader then
lists your mod as not made for this game version until you port it:

1. Extract the new build next to the old one (step 2, with the new build id).
2. Run the port tool. It finds each edit's code in the new build near its anchor and works out the renamed names:

   ```
   node --max-old-space-size=8000 <loader>/tools/port-patches.mjs [--own <prefix>] <old build> <new build> mods/my-mod ported/ [mods/my-mod/tests]
   ```

   `--own` (repeatable) names prefixes of names your mod defines itself, so they are never renamed. Read the report
   in `ported/`: every WARN and FAIL needs checking by hand. A warning that a name in your replacement has no
   top-level definition can mean the name now belongs to a different function.
3. For single names, `python -I <loader>/tools/rename-map.py <old bundle> <new bundle> NAME ...` finds what a
   function or variable is called in the new build.
4. Copy the ported patches in, set `builds` to the new build, build (step 5) and play-test again (step 6).
