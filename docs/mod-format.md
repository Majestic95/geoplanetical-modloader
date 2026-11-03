# Mod format (format 1)

A Geoplanetical Mod Loader mod is a folder of plain data: a `mod.json` manifest and one or more patch files. A mod
never contains code that runs on its own. Each patch replaces exact pieces of the game's own code, and the loader
checks every replacement before the game starts. The loader is strict: an unknown field, a missing field or a
malformed value is an error that names the file, and the mod is listed as broken. A typo never silently drops a
change.

The reference implementation is [`patcher/mods.mjs`](../patcher/mods.mjs) (loading and validation) and
[`patcher/patch-engine.mjs`](../patcher/patch-engine.mjs) (applying edits).

## Folder layout

```
mods/
  my-mod/                 any folder name; the id inside mod.json identifies the mod
    mod.json
    patches/
      first-change.json
      second-change.json
```

Patch files can sit anywhere inside the mod folder, including sub-folders. They cannot be outside it.

## mod.json

```json
{
  "id": "my-mod",
  "name": "My Mod",
  "version": "1.0.0",
  "description": "What the mod does, in a sentence or two.",
  "author": "Your name",
  "format": 1,
  "builds": ["26368058"],
  "requires": ["some-other-mod"],
  "patches": ["patches/first-change.json", "patches/second-change.json"],
  "changes": [
    "A plain sentence for players about one change.",
    { "group": "Economy", "items": ["Another change.", "And another."] }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lower-case letters, digits and `-`, starting with a letter or digit, at most 64 characters. Unique among installed mods. |
| `name` | yes | Shown to players. |
| `version` | yes | Shown to players. Any non-empty text; [semantic versioning](https://semver.org) is recommended. |
| `description` | yes | Non-empty text. |
| `builds` | yes | The Steam build ids of the game this mod is made for, as strings of digits. The loader only applies a mod to a game whose installed build is listed. |
| `patches` | yes | Non-empty list of patch file paths, relative to the mod folder. Applied in this order. |
| `author` | no | Shown to players beside the mod's name. |
| `format` | no | The mod format the mod is written for. Defaults to 1; see [Format versions](#format-versions). |
| `requires` | no | Ids of mods that must be loaded with this one. They load before it. |
| `changes` | no | The changelog the launcher shows. Each entry is a sentence, or `{ "group": "Heading", "items": [sentences] }`. |

Finding the build id: Steam records it in `steamapps/appmanifest_940230.acf` (`"buildid"`), and the loader shows it
in its window. A game update changes the build id, so the mod must be checked and ported (see
[authoring.md](authoring.md#when-the-game-updates)) and its `builds` list updated. List more than one build only when
every edit has been checked against each of them.

## Patch files

```json
{
  "id": "first-change",
  "effect": "What this patch changes and why, for people reading the mod.",
  "bundle": "simulation-worker.bundle.js",
  "edits": [
    {
      "anchor": "stable text near the edit, such as an error message or event id",
      "find": "exact text of the game's code to replace",
      "replace": "the replacement text"
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Same rules as a mod id. Unique within the mod. |
| `effect` | yes | Non-empty text describing the change. |
| `bundle` | yes | The game code file the edits apply to: the name of a file in the game's `renderer` folder: lower-case letters, digits and `-`, then `.bundle.js`, such as `simulation-worker.bundle.js`. |
| `edits` | yes | Non-empty list of edits, applied in order. |
| `finding` | no | Your own reference for the patch (an issue number or a research note id), or `null`. |

### Edits

| Field | Required | Meaning |
|---|---|---|
| `find` | yes | Text that must occur **exactly once** in the bundle (as earlier edits left it). It is replaced by `replace`. |
| `replace` | yes | The replacement text. It may be empty. |
| `anchor` | yes | Text that must occur exactly once in the bundle and lie within `near` characters of `find`. |
| `near` | no | Positive whole number, default 2000. The largest distance in characters between `anchor` and `find`. |
| `determinismOk` | no | Text giving the reason a replacement may use something on the determinism list below. |

The game's code is minified: its function and variable names (`Fp`, `rjB`, ...) and the positions of everything
change with each game build. That is why an edit needs both `find` and `anchor`:

- `find` is the code you change. It must be unique, so it is usually a few dozen characters, not a single name.
- `anchor` pins the edit to the right place: a piece of text that does not change between builds, such as an error
  message, an event id or a config key, and that is close to the edit. If a game update moves or renames the code,
  either `find` or `anchor` stops matching, and the loader refuses the mod instead of patching the wrong function.

If anything does not match (`find` or `anchor` missing or repeated, or too far apart), the whole mod fails with a
message naming the mod, patch and edit. Nothing is half-applied.

## Determinism

Geoplanetical's simulation is deterministic: the same start and the same steps give the same world, and saves and
multiplayer depend on that. Replacement text runs inside that simulation, so the loader rejects an edit that adds
any of these near the edit:

- wall-clock time (`Date.now()`, `new Date()`, `performance.now()`)
- `Math.random()`, `crypto.getRandomValues`, `crypto.randomUUID`
- page, window or browser state (`document.`, `window.`, `localStorage.`, `sessionStorage.`, `navigator.`)
- locale formatting (`toLocaleString` and similar, `Intl.`)
- timers (`setTimeout`, `setInterval`, `requestAnimationFrame`)

If such an edit provably never feeds the simulation's state (for example display-only text), set `determinismOk` to
the reason. The check also catches a forbidden call assembled from the surrounding code, such as changing `max` to
`random` inside `Math.max(`.

Keep any state your mod adds under names that cannot collide with the game's or another mod's, for example a prefix
from your mod id. State the game saves (fields on its own objects) ends up in saves, and a save made with your mod
then needs your mod to load correctly.

## Load order, requirements and conflicts

Mods load one after another, and each edit applies to the code as the mods before it left it:

1. A mod loads after every mod it `requires`.
2. Otherwise mods load by id, or in the order given with `--mod` to the command-line tools.
3. Within a mod, patches apply in `patches` order and edits in `edits` order.

If a mod in `requires` is not switched on, is not installed, or is not made for the installed game build, the
launcher names it and starts nothing. Requirements that form a circle are an error.

Two mods **conflict** when an edit of the later one fits the game's own code but no longer fits after an earlier
mod's edits (the earlier mod replaced the text it looks for, its anchor, or made its text appear twice). The
launcher names both mods and the earlier patch and starts nothing, and the player switches one off. Mods that edit
different code, or that leave each other's `find` and `anchor` text intact, load together. The same check names
the earlier patch when two patches of one mod overlap.

## Format versions

The loader reads format 1. The format number rises only when a change would be misread by an older loader (a new
field, or a field whose meaning changes). A mod that uses only format-1 fields does not need a `format` field.

A mod that declares a format higher than the loader reads is listed as needing a newer loader. It is never
half-loaded, and the format is checked before any other field. Loaders older than 0.3.0 do not know `format`,
`author` or `requires` and require `finding` in every patch, so they list a mod that uses those fields or omits
`finding` as broken.

## Checklist before you release

- [ ] `builds` lists exactly the builds you tested against.
- [ ] Every `anchor` is stable text (not a minified name) and unique.
- [ ] `node <loader>/patcher/build.mjs` builds your mod without errors.
- [ ] You played a new game with the mod, saved, quit, and reloaded the save through the loader.
- [ ] `changes` tells players what changed in plain words.
