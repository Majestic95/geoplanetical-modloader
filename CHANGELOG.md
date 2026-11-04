# Changelog

## Unreleased (0.7.0)

- **Mod format 3: wording changes.** A patch to `app.bundle.js`, the game's main-page bundle, can now correct the
  game's own English and French text ([docs/mod-format.md](docs/mod-format.md#wording-changes)), and only that: an edit
  must stay inside the quotes of one entry of the game's language tables, and the new text is at most 4096 characters
  and may not contain `<`, an HTML entity, `${` or `"` (checked after its escapes are read). Code, keys, new entries,
  every string outside those tables and the entries wording the game's saves and save settings, quitting, pause menu,
  mods screens and confirmation buttons are refused, because that bundle runs beside the game's functions for saves. The loader replaces
  the bundle before any of it runs, on every page load, and reports it as `mods active (app.bundle.js)` or names what
  went wrong; if the changed text cannot be used, the game's own bundle runs and the window shows an amber warning. The
  page may be reloaded at the start of a session to do this, never on a re-attach. The window lists which mods change
  wording, and the log names each entry changed.
- **Fixed: a patch the loader could not deliver was silently dropped.** A patch to `app.bundle.js` passed every check,
  built, and then never reached the game. Now a patch to it needs `"format": 3`, and a patch to any other bundle that is
  not a worker (`i18n-bootstrap.bundle.js`, or a typo) is refused when the mod is read, with a message naming the patch.
- Patched worker code is unchanged, byte for byte. Mods of formats 1 and 2 load as before, and loader 0.6.0 lists a
  format-3 mod as needing a newer loader.

## Unreleased (0.6.0)

- **The frozen game:** the loader plays one version of the game, build `26403824` (game 1.0.8), from its own copy in
  `%LOCALAPPDATA%\GeoplaneticalModLauncher\game`, which Steam updates do not change: a game update no longer stops the
  mods. The window offers three ways to get the copy, once: copy the Steam game while it is that build; download that
  build with Steam (the loader puts `download_depot 940230 940231 6610280059570798071` on the clipboard and opens
  Steam's console; the player pastes it, and when the console log says it is complete the loader copies Steam's
  download into its own folder and removes Steam's); or copy a folder the player already has. The loader always
  writes the copy itself, so it has the permissions of the player's own folder. Every copy is checked against the
  pin (the archive's size and index, every file outside the archive, and once the whole archive) before it is used,
  and the frozen game is checked again as the last step before each start, then started from the folder as checked.
  There is one copy: a newer pin's copy replaces the old one once it is checked.
- The frozen game is started from its folder with the loader's debugging port, its own `--user-data-dir`, Steam's ids
  in its environment, and Steam running (refused otherwise). Its saves are its own: the first time, the Steam game's
  saves are copied into it (only read, never overwritten); Steam Cloud does not back them up, and the window says so.
- **Frozen or live:** the window lets the player choose the frozen game (the default) or the live Steam game, which
  works as before. Mods are matched against the chosen game's build. `launcher-settings.json` keeps the choice as
  `play`.
- Programs: when the player plays the frozen game, **Play with** passes its folder as well:
  `<program> --loader "<loader folder>" --game "<frozen game folder>"`
  ([docs/authoring.md](docs/authoring.md#programs)).
- `patcher/launch.mjs --frozen` plays the frozen game from the command line.
- The game code the loader reads from `app.asar` (live or frozen) is checked against the archive's own SHA-256
  record of each file; a damaged game file is refused instead of being patched.
- The text menu (`--console`) now takes the same one-at-a-time lock as the window. Programs started by name
  (`tasklist`, `clip`, `powershell`) are never taken from the loader's current folder.
- No change to the mod format: `builds` lists the builds a mod is made for, now the loader's frozen build.

## 0.5.0 (2026-11-03)

- Page scripts: [docs/mod-format.md](docs/mod-format.md#page-scripts) now says how to read the game's language: the game
  writes it into the page as `<html lang>` and changes it there when the player switches language.
- **Programs:** the window can start another program with the mods switched on here, such as a multiplayer launcher.
  The player clicks **Add program...** once and chooses the program's `.exe`; its **Play with** button then starts it
  as `<program> --loader "<the loader's folder>"`, in a console window of its own. The program reads the mods folder
  and the switches and starts the game itself; the loader does not. A program's installer can add an entry to
  `launcher-settings.json`; the loader then shows its full path and asks once before the first start. A program is
  refused when the loader's own Play would be (the game running or being updated, switched-on mods that cannot load
  together). See [docs/authoring.md](docs/authoring.md#programs).
- A mod id or a patch id must be text: a number such as `123`, or `null` or `true`, is now refused with a message
  naming the file (loader 0.4.0 took `123` as the mod "123"). A patch `bundle` written as a list is refused too.
  (`requires` entries were already checked.) Mods with ids in quotes, which is every mod written to the format, are
  unaffected.

## 0.4.0 (2026-11-03)

- Add mods from the window: drop a mod's zip file or folder onto it, or click **Add mod...** and choose the zip (or
  the `mod.json` inside a folder). The loader checks the whole mod with its strict reader before anything in the
  `mods` folder changes, replaces every installed copy of the same mod (same `id`, whatever its version) and moves
  the replaced copy to the Recycle Bin, keeps the mod's on/off switch, and puts everything back if a step fails.
  Added files are marked as downloaded from the internet, as Windows' own Extract All does. A zip of the mod folder,
  of the files inside it, of a repository holding the mod, or of several mods at once all work. See
  [docs/authoring.md](docs/authoring.md#7-release).
- **Refresh** button: shows mods added to the `mods` folder by hand without restarting the loader.
- Mod format 2: page scripts ([docs/mod-format.md](docs/mod-format.md#page-scripts)). A mod can list `scripts`, `.js`
  files that change what the game's window shows; such a mod declares `"format": 2` and may leave out `patches`.
  Page scripts are walled off from the game's code: each mod's run in an isolated world of their own, with the page's
  elements but not the game's objects or its functions for saves, settings, files and the Workshop. The loader runs
  each script in the page's top frame only, once per page load (at the start of every page load and once in the page
  already open), as the body of a function so its declarations stay private, and reports a script that throws while
  it starts as an amber warning (the game and its simulation are unaffected). The list shows which mods run a page
  script. Loader 0.3.0 lists a format-2 mod as needing a newer loader; format-1 mods load as before and their patched
  code is unchanged.

## 0.3.0 (2026-11-02)

First release as a standalone, mod-agnostic loader. Versions 0.1 and 0.2 shipped inside the Geoplanetical Balance
playtest package.

- Renamed to Geoplanetical Mod Loader (`GeoplaneticalModLoader.exe`). The package holds the loader with an empty
  `mods` folder; mods are downloaded separately. Authors can still build a pack with their mods included
  (`launcher/package.mjs --mods`).
- Mod format 1 documented ([docs/mod-format.md](docs/mod-format.md)), with new optional fields: `format`, `author`,
  `requires` (mods load after the mods they require; Play is refused with both names when one is off or missing).
  A patch's `finding` is now optional.
- Conflicts between mods name the earlier mod and patch whenever an edit fits the game's code but not the code an
  earlier mod left, including a removed anchor or a find made ambiguous. Overlapping patches within one mod are named
  as such.
- The author tools (`patcher/build.mjs`, `patcher/launch.mjs`, `tools/*`) work from the author's own workspace
  folder instead of this repository.
- The marker the loader places in patched workers is now `__gpModLoader` (was `__geobal`). The name patched code
  shows under in developer tools is `gpml/<bundle>`. Patched code is otherwise identical to 0.2.0's for the same
  mods, so saves carry over.
- Dedicated to the public domain under CC0 1.0 ([LICENSE](LICENSE)).
- Compatible with 0.2.0's `launcher-settings.json`, and an old and a new launcher still refuse to run at the same
  time.

## 0.2.0 (2026-10-30)

Windowed launcher with an on/off switch and a grouped changelog per mod (inside the Geoplanetical Balance
playtest package).

## 0.1.0 (2026-10-29)

Text-menu launcher and the runtime patcher (inside the Geoplanetical Balance playtest package).
