# Changelog

## Unreleased

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
