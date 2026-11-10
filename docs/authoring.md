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

From game 1.0.9 on, the worker bundles and `renderer/runtime-data/` sit next to the archive, in
`resources\app.asar.unpacked`. The tool copies those from there and checks each one's size (and SHA-256, when the index
records one) against the archive's index, refusing a file that differs. It prints how many files it wrote and fails when a prefix matches
nothing.

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

### A page script instead (format 2)

To change only what the screen shows (a label, a description, a tooltip), a page script is often simpler than a
patch: it reads the game's page as it is and adds elements of its own, with no minified names to port. List it in
`scripts`, set `"format": 2`, and follow [Page scripts](mod-format.md#page-scripts): it runs in the game's main page
at the start of every page load, as the body of a function, walled off from the game's code: it works with the page's
elements only, so anything it needs has to be readable from them. To find the elements to work with, inspect the
game's page while it runs through `patcher/launch.mjs`: in Chrome (`chrome://inspect`) or Edge (`edge://inspect`), add
`localhost:9333` (the launcher's debug port) to the network targets, then inspect the page `renderer/index.html`; in
the console, pick your mod's context (`gpml:<your mod id>`) to see what your script sees. Page scripts are not ported by
`tools/port-patches.mjs`: check them by hand on each new build.

### Correcting the game's text (format 3)

To correct the game's own English or French wording, patch `app.bundle.js`: extract it as in step 2, find the entry by
its key (`"enr.moon.note":"`), set `"format": 3`, and follow [Wording changes](mod-format.md#wording-changes). Such a
patch can change the text of existing entries and nothing else, and `patcher/build.mjs` refuses anything more with a
message naming the edit. Keep it in a mod of its own: multiplayer launchers that read format 2 refuse a format-3 mod.

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

This starts the game through Steam, applies the mod in memory and stays attached until the game closes; with
`--frozen` it starts the loader's frozen game instead (set it up once in the loader's window; it has its own saves,
apart from the Steam game's). It prints
whether each patched part of the game is confirmed to run your code, whether your wording changes are active, and
whether your page scripts ran (on every page load; an error a script throws is in the game's developer tools console). `--dry-run` does everything except start the
game, and `--unpatched` starts the game through the same path without mods, for comparison. You can also copy your
mod folder into the `mods` folder of a packaged loader and use its window.

Test at least: a new game, a few months of play, save, quit, and load the save again through the loader.

## 7. Release

Zip your mod folder (`my-mod/` with `mod.json`, its patch files and page scripts). Players drop the zip onto the loader's
window (or choose it with **Add mod...**), and the loader checks the mod and adds it; unzipping it into the `mods`
folder by hand also works. Do not include extracted game files: a mod carries only the short pieces of game code in
its `find` and `anchor` text.

What the loader accepts when a zip or folder is added:

- The mod is each shallowest folder in the zip that holds a `mod.json`: a zip of the mod folder, of the files inside
  it, or of a repository with the mod in a sub-folder all work. A zip with several mod folders adds them all at once
  (a pack, up to 50 mods), so a mod and the mods it `requires` can ship together.
- Everything under the mod's folder is copied (a README or tests may sit beside `mod.json`), marked as downloaded
  from the internet. Nothing in the zip is run. Shortcut and shell files (`.lnk`, `.url`, `.scf`, `.library-ms`,
  `.searchConnector-ms`) inside the mod's folder are refused.
- The new version replaces every installed folder with the same mod `id`, whatever its version, and the replaced
  folder goes to the Recycle Bin. Keep the `id` the same across releases. A player's on/off switch is kept by `id`
  too. If you develop in the loader's own `mods` folder, adding a release of the same mod moves your working folder
  to the Recycle Bin: work in a separate folder (your workspace) instead.
- The mod must load with this loader's strict checks, or nothing is added. Limits for one add (all zips and folders
  dropped together): at most 20 items, 32 MB per zip, 32 MB and 5000 files unpacked in all; plain stored or deflated
  entries (no encryption, no ZIP64); paths inside the mod of at most 200 characters, with names Windows can store.

To hand players a ready-to-play package with the loader and your mods in one zip:

```
node <loader>/launcher/package.mjs --mods mods --name "My Mod Pack" [--readme my-readme.txt]
```

The package lands in `dist/package/` in your workspace.

## When the game updates

A Steam update of the game does not stop your mod: players play the loader's frozen build (see
[mod-format.md](mod-format.md#modjson)), which Steam does not change. Port your mod when a loader release
moves its frozen build (its changelog says so), or earlier if you want it to play on the live Steam game too.

A new build changes the build id, and usually the minified names and positions in the bundles. The loader lists your
mod as not made for that game version until you port it:

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
4. Copy the ported patches in, add the new build to `builds` (keep the old one only while you still test against it),
   build (step 5) and play-test again (step 6).

## Programs

A **program** is a separate application that starts the game with the loader's mods, such as a multiplayer launcher.
It is not a mod and is not installed into the `mods` folder: the player adds it in the loader's window with **Add
program...** (choosing its `.exe` file where they unzipped it), and the window then shows a **Play with** button
named after it. The loader contains no code for any particular program; everything a program gets from the loader
is listed here.

**How the loader starts it.** As

```
<program>.exe --loader "<the loader's folder>" [--game "<the frozen game's folder>"]
```

with the program's own folder as the working folder, through Windows' ShellExecute (as Explorer starts a program): a
console program gets a console window of its own. (Windows shows no warning for a downloaded program started this
way; the loader asks the player itself, below.) The loader passes no other argument, and starts nothing else: it does
not build the mods or start the game for a program. Your program starts the game itself:

- Without `--game`, the player chose the live Steam game: start it through Steam (`steam -applaunch 940230`).
- With `--game`, the player chose the loader's frozen game: a folder holding one build of the game, outside the
  Steam library (loader 0.6.0: build `26403824`). The loader checked it just before (its `resources\app.asar` index
  and every file outside the archive match that build), but check it again yourself before you start anything in it,
  and refuse a folder that is not a build you support. Start its `Geoplanetical.exe` directly, with Steam running
  and `SteamAppId` and `SteamGameId` set to `940230` in its environment (the game then does not hand itself back to
  Steam), and a `--user-data-dir` of your own (the game keeps its saves and settings there; the loader's own data
  folder for the frozen game is not yours to use). Never write into the folder.

**What the loader's folder holds.**
- `mods\`: one folder per mod, in the [mod format](mod-format.md). Read the mods as the loader does: the same checks,
  the same load order, and a mod the loader would play is never left out silently. A mod your program cannot run
  (a newer format, or a feature such as page scripts that your program does not support) should stop the start with
  a message naming it, not be skipped.
- `launcher-settings.json`: the player's switches. A mod is off only when `enabled[<mod id>]` is `false`; a missing
  or unreadable file switches nothing off. Read it; never write it.

**When the loader refuses.** Before it starts a program, the loader checks what it checks before its own Play: that
the game was found and is not being updated by Steam (for the frozen game: that it is set up, matches its build and
Steam is running), that Geoplanetical is not already running, that the mods
switched on can load together (no required mod off or missing), and that the switches the window shows are the ones
saved in `launcher-settings.json`. A program may start with no mod switched on. Until your program exits, or for at
most a minute after it started, the loader starts neither the game nor another program and does not change the
switches or the `mods` folder, so the two never start the game at once and your program reads what the player saw.

**Adding your program from its installer.** An installer may add an entry to the `programs` list in
`launcher-settings.json` (beside the loader's executable):

```json
{ "programs": [{ "exe": "C:\\Games\\MyProgram\\MyProgram.exe", "name": "My Program" }] }
```

In JSON each backslash of the path is written twice. `exe` is the program's full path on one of the PC's drives (a
`.exe` file, not a `\\server` path). `name` (optional, at most 60 characters, no control or direction characters)
is shown on its button; without it the button shows the file name. Add your entry and keep every other key and entry
in the file as it is. The loader keeps at most 8 programs and one entry per file, and drops other fields. Do not
write `confirmed`: it is the loader's record that the player agreed to start that path. Before the first start of an
entry it did not see the player choose, or of a file Windows marks as downloaded from the internet, the loader shows
the full path and asks the player to confirm it. This confirmation keeps a player from starting a program they did
not expect; it is not a protection against a program already on the PC, which could start anything itself. The path
must be written plainly (no `.` or `..` folders, no `/`, no invisible or direction characters, at most 260
characters) and must not lie inside the loader's `mods` folder.
