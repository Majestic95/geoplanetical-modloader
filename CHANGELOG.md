# Changelog

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
