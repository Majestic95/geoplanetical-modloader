# Geoplanetical Mod Loader

A mod loader for [Geoplanetical](https://store.steampowered.com/app/940230/). It starts the game with the mods you
switch on, applying their changes to the game's code in memory. The game's own files are never changed, and
starting the game from Steam as usual plays it without mods.

The game's built-in mod support covers presentation, not the game's rules. This loader lets mods change how the
simulation works: economics, politics, war, anything in the game's code.

Not affiliated with the developers of Geoplanetical.

## For players

1. Download the packaged loader, `GeoplaneticalModLoader-<version>.zip`, from the
   [latest release](https://github.com/Majestic95/geoplanetical-modloader/releases/latest) and unzip it anywhere, or
   build it from source (below).
2. Run `GeoplaneticalModLoader.exe` and drop each mod's zip (or folder) onto its window, or click **Add mod...**.
   The loader checks the mod, adds it to its `mods` folder and replaces an older version of the same mod.
3. The first time, set up the **frozen game**: the loader's own copy of the game version its mods are made for, which
   Steam updates do not change (about 3.9 GB). Copy it from your Steam game while that is the same version, or
   download that version with Steam: the loader opens Steam's console and copies the one command to paste. You can
   also choose the live Steam game instead.
4. Switch mods on or off and click **Play with mods**.
5. To play the same mods through another program, such as a multiplayer launcher, click **Add program...** once and
   choose its `.exe`; its **Play with** button then starts it with the mods switched on in the loader.

The included `README.txt` covers saves, updates and what to do when something goes wrong.

- **Windows and Steam only.** Your copy of the game comes from your own Steam account. The loader starts the frozen
  game from its folder, with Steam running and signed in, or the live game through Steam.
- **Play with mods is single player.** A modded game's simulation differs from an unmodded one, so it cannot join
  unmodded multiplayer sessions. A separate multiplayer program added under **Programs** can play the mods with
  others who use the same ones.
- **Saves:** a save made with mods needs the same mods to load correctly. The frozen game keeps its own saves (your
  Steam saves are copied into it the first time you play it); Steam Cloud does not back them up.
- **Game updates:** a Steam update does not stop the mods: the frozen game stays on its version. Each mod states the
  game builds it was made for; when a loader release moves to a newer game version, the mods follow, and the loader
  replaces its copy once you get the new one.
- The executable is not code-signed, so Windows asks for confirmation the first time.

## For mod authors

A mod is a `mod.json` manifest and patch files of exact find-and-replace edits on the game's code, each pinned to
nearby stable text. The loader checks every edit before the game starts and refuses the whole mod if anything does
not match exactly, so a game update can never make a mod patch the wrong code. From mod format 2, a mod can also
bring page scripts: scripts that change what the game's window shows, such as labels or descriptions, walled off from
the game's code, saves and settings. From format 3, a patch can also correct the game's own English and French wording,
and only that.

- [docs/mod-format.md](docs/mod-format.md): the format specification (fields, anchors, determinism, page scripts,
  load order, requirements, conflicts).
- [docs/authoring.md](docs/authoring.md): writing, testing, releasing and porting a mod with the tools here, and
  [what the loader gives a program](docs/authoring.md#programs) started from its window.

## How it works

1. The loader reads the original game code from the game's `resources/app.asar` (read only) and applies the
   enabled mods' edits to it in memory. Every edit must match exactly once, near its anchor; replacements that
   would add non-deterministic code (time, randomness, page state, timers) are refused.
2. It starts the game with Chromium's remote-debugging port on 127.0.0.1 (the frozen game from its folder, after
   checking that its archive index and every file outside the archive match the pinned build; the live game through
   Steam), waits for each game
   worker that a mod changes, and runs the patched code in that worker in place of the original before the
   original runs.
3. It checks inside each worker that the patched code is the code serving the game, and stays attached until the
   game closes, so a worker that restarts during play is patched again. If a check fails, the window shows a red
   warning.
4. The mods' page scripts run in the game's main page, walled off from the game's code (each mod's in an isolated
   world with the page's elements only): at the start of every page load, and once in the page already open. If one
   fails, the window shows an amber warning; the game and its simulation are unaffected.

Source layout:

| Folder | Contents |
|---|---|
| `patcher/` | Mod loading and validation (`mods.mjs`), the patch engine (`patch-engine.mjs`), game detection (`game.mjs`), the frozen game's pin, check and start (`frozen.mjs`), the launch-and-attach runtime (`runner.mjs`, `session.mjs`, `cdp.mjs`), the author command-line tools `build.mjs` and `launch.mjs`, and tests |
| `launcher/` | The player launcher: a window served on 127.0.0.1 (`gui.mjs`, `gui-page.mjs`), adding mods from a zip or folder (`install.mjs`), a text menu (`console.mjs`), shared steps (`core.mjs`), and the packager (`package.mjs`) |
| `tools/` | Author tools for reading the game's minified code and porting mods to new game builds |
| `docs/` | Format specification and authoring guide |

## Building from source

Requires Node.js 22.15 or later on Windows.

```
npm ci
npm test                                # engine, loader and port-tool tests
node patcher/test-harness.mjs --dir <empty scratch folder>   # runtime swap against headless Chrome
node launcher/main.mjs                  # run the launcher from source (mods from ./mods)
npm run package                         # build dist/package/Geoplanetical Mod Loader/ and its zip
```

## Changes

See [CHANGELOG.md](CHANGELOG.md).

## License

The code, tools and documentation in this repository are dedicated to the public domain under
[CC0 1.0 Universal](LICENSE). You may copy, change and distribute them, including in your own mods and tools, for any
purpose, without asking permission or giving credit.

This does not cover Geoplanetical itself or anything taken from it. Mods for the loader are licensed by their own
authors.
