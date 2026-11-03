# Mod format (formats 1 and 2)

A Geoplanetical Mod Loader mod is a folder with a `mod.json` manifest and the files it names:

- **Patch files** (format 1 and later): plain data that replaces exact pieces of the game's own code. The loader
  checks every replacement before the game starts.
- **Page scripts** (format 2): scripts that change what the game's window shows. They run walled off from the game's
  own code: they can read and change the page's elements, but not the game's objects, its saves or its files (see
  [Page scripts](#page-scripts)).

Nothing in a mod runs on the player's computer outside the game. The loader is strict: an unknown field, a missing
field or a malformed value is an error that names the file, and the mod is listed as broken. A typo never silently
drops a change.

The reference implementation is [`patcher/mods.mjs`](../patcher/mods.mjs) (loading and validation),
[`patcher/patch-engine.mjs`](../patcher/patch-engine.mjs) (applying edits) and
[`patcher/session.mjs`](../patcher/session.mjs) (running page scripts).

## Folder layout

```
mods/
  my-mod/                 any folder name; the id inside mod.json identifies the mod
    mod.json
    patches/
      first-change.json
      second-change.json
    page/
      labels.js           a page script (format 2)
```

Patch files and page scripts can sit anywhere inside the mod folder, including sub-folders. They cannot be outside it.

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

A mod with only a page script (format 2):

```json
{
  "id": "my-labels",
  "name": "My Labels",
  "version": "1.0.0",
  "description": "Adds a label to each country on the map. Changes only what the screen shows.",
  "format": 2,
  "builds": ["26368058"],
  "scripts": ["page/labels.js"]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Text (in quotes) of lower-case letters, digits and `-`, starting with a letter or digit, at most 64 characters. Unique among installed mods. A number such as `123`, or `null` or `true`, is not an id. |
| `name` | yes | Shown to players. |
| `version` | yes | Shown to players. Any non-empty text; [semantic versioning](https://semver.org) is recommended. |
| `description` | yes | Non-empty text. |
| `builds` | yes | The Steam build ids of the game this mod is made for, as strings of digits. The loader only applies a mod (its patches and its page scripts) to a game whose installed build is listed. |
| `patches` | yes, unless the mod has `scripts` | Non-empty list of patch file paths, relative to the mod folder. Applied in this order. A format-2 mod with `scripts` may leave it out. |
| `scripts` | no (format 2) | Non-empty list of at most 20 page script paths, relative to the mod folder, each listed once: `.js` files run in the game's window, in this order. A path is made of letters, digits, `_`, `.` and `-`, with `/` between folders, and each folder and file name starts with a letter, digit or `_` (`page/labels.js`). See [Page scripts](#page-scripts). A mod that uses it declares `"format": 2`. |
| `author` | no | Shown to players beside the mod's name. |
| `format` | no | The mod format the mod is written for: 1 or 2. Defaults to 1; a mod with `scripts` must say 2. See [Format versions](#format-versions). |
| `requires` | no | Ids (text) of mods that must be loaded with this one. They load before it. |
| `changes` | no | The changelog the launcher shows. Each entry is a sentence, or `{ "group": "Heading", "items": [sentences] }`. |

Finding the build id: Steam records it in `steamapps/appmanifest_940230.acf` (`"buildid"`), and the loader shows it
in its window. A game update changes the build id, so the mod must be checked and ported (see
[authoring.md](authoring.md#when-the-game-updates)) and its `builds` list updated. List more than one build only when
every edit and every page script has been checked against each of them.

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
| `id` | yes | Same rules as a mod id (text). Unique within the mod. |
| `effect` | yes | Non-empty text describing the change. |
| `bundle` | yes | The game code file the edits apply to: the name (text) of a file in the game's `renderer` folder: lower-case letters, digits and `-`, then `.bundle.js`, such as `simulation-worker.bundle.js`. |
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

## Page scripts

Format 2. A page script changes what the game's window shows: a label, a description, a tooltip the game does not
have. It is a `.js` file of UTF-8 text, at most 2 MB (and at most 4 MB for all of a mod's scripts together), written
as a classic script (no `import` or `export`).

**What it can reach.** The page's elements (the DOM), and nothing of the game's code. Each mod's page scripts run in
an isolated world of their own: they share the page's elements with the game, but not its JavaScript. A page script
cannot see or call the game's objects or functions, including the game's own functions for saves, settings, files and
the Workshop, and the game's code cannot see it. Scripts of other mods are walled off the same way. So a page script
can read what the page shows and add or change elements, but it cannot change the simulation, saves or settings.
A script that needs something only the game's code knows (its data) has to read it from the page's elements instead;
for the game's language, see **The game's language** below.

**Where it runs.** In the game's main page (`renderer/index.html`), in its top frame only. Never in the simulation or
any other worker, and never in a frame inside the page.

**When it runs.** At the start of every page load, and once in the page already open when the loader starts serving
the game. At the start of a page load the page's own code has not run yet and `document.body` may not exist: wait for
what you need (`DOMContentLoaded`, a `MutationObserver` for the game's elements). The loader runs each script at most
once per page load. The game changes screens inside one page load too, without running the script again: watch the
page's elements for the ones you need rather than looking for them once.

**How it runs.** As the body of a function, called with `this` set to the global object of its world. Top-level
`var`, `let`, `const` and function declarations stay private to the script; to share something between your mod's
scripts, set a property on `window` named with your mod id (it is visible only to your mod's scripts). `"use strict"`
at the top works, and `return` at the top level ends the script.

**Order.** In `scripts` order, and the mods in load order (see below), so a mod's scripts run after those of the mods
it `requires`.

**When it fails.** A script that throws while it starts is reported in the launcher as a page script that failed
(amber), and its error is in the game's developer tools console. An error later, in a callback the script set up, is
only in the console. The game and its simulation keep running with the mods' patches; only what the failed script
would have shown is missing.

**Checked when the mod is read.** The loader reads every script and lists the mod as broken if a script is missing,
is not a `.js` file, is not UTF-8 text, is over the size limits, has a path that does not follow the rules above, is
listed twice (also in another letter case), lies outside the mod folder (also through a link), or does not parse as
the body of a function (where `return` at the top level is allowed and `import`, `export` and top-level `await` are
not). The loader parses scripts; it never runs them itself.

**The game's language.** The game writes its language into the page: `<html lang="...">`, that is
`document.documentElement.lang`. It sets it when its main code starts (after its language files have loaded, usually
after `DOMContentLoaded`) and again whenever the player changes the language in its settings (the page is not
reloaded). The codes are the game's own: `en`, `fr`, `de`, `es`, `it`, `pt-BR`, `nl`,
`pl`, `cs`, `hu`, `uk`, `ru`, `tr`, `id`, `zh-Hans`, `ja`, `ko` and `th` (builds 26368058 and 26391432). Before the
game's code has run, the attribute holds the page's default, `en`, so the first read can be `en` for a player of
another language, and the game also sets the attribute to the value it already has. A script started at the beginning
of a page load must wait for the page's root element, then read the language and watch it, redrawing its text each
time (it may be told the same code twice):

```js
const showLanguage = code => { /* replace (do not add to) your text, in `code` */ };
const start = () => {
  const read = () => showLanguage(document.documentElement.lang);
  read();
  new MutationObserver(read).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
};
if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
```

This is the game's behaviour, not a promise of the loader: check it on each game build, as for any element you use.
Another mod's script could change the attribute too (all scripts share the page's elements); a mod should never
write it. A mod that adds text only to the game's own screens (a panel, a tooltip) draws once those screens exist,
and by then the game has set its language.

**What the loader cannot check, and you must keep to.**
- Add or change only what the screen shows, with elements of your own where you can.
- No code from elsewhere: no network requests for code, no `eval` or `new Function`.
- Keep working when the game redraws: the game replaces its own elements often.
- Check the script on each game build before adding the build to `builds`: an update can rename or remove the elements
  it uses.

The launcher shows players which mods run a page script. The determinism list below does not apply to page scripts:
they run outside the simulation, and timers and page state are what they are for.

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
3. Within a mod, patches apply in `patches` order and edits in `edits` order; page scripts run in `scripts` order.

If a mod in `requires` is not switched on, is not installed, or is not made for the installed game build, the
launcher names it and starts nothing. Requirements that form a circle are an error.

Two mods **conflict** when an edit of the later one fits the game's own code but no longer fits after an earlier
mod's edits (the earlier mod replaced the text it looks for, its anchor, or made its text appear twice). The
launcher names both mods and the earlier patch and starts nothing, and the player switches one off. Mods that edit
different code, or that leave each other's `find` and `anchor` text intact, load together. The same check names
the earlier patch when two patches of one mod overlap. Page scripts are not checked against each other: two mods'
scripts that change the same element of the page are for their authors to sort out.

## Format versions

The loader reads formats 1 and 2. The format number rises only when a change would be misread by an older loader (a
new field, or a field whose meaning changes). A mod that uses only format-1 fields does not need a `format` field.

- **Format 1** (loader 0.3.0): patches, with `format`, `author` and `requires`.
- **Format 2** (loader 0.4.0): adds `scripts`, and lets a mod with scripts leave out `patches`. A mod that uses them
  declares `"format": 2`.

A mod that declares a format higher than the loader reads is listed as needing a newer loader: loader 0.3.0 lists a
format-2 mod that way. It is never half-loaded, and the format is checked before any other field. Loaders older than
0.3.0 do not know `format`, `author` or `requires` and require `finding` in every patch, so they list a mod that uses
those fields or omits `finding` as broken.

## Checklist before you release

- [ ] `builds` lists exactly the builds you tested against.
- [ ] Every `anchor` is stable text (not a minified name) and unique.
- [ ] `node <loader>/patcher/build.mjs` builds your mod without errors (it also reads and checks the page scripts).
- [ ] You played a new game with the mod, saved, quit, and reloaded the save through the loader.
- [ ] Page scripts: they keep working when you change screens, return to the menu and start
      another game.
- [ ] `changes` tells players what changed in plain words.
