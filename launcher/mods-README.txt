MODS FOLDER
===========

The easiest way to add a mod is to drop its .zip file onto the loader's window, or to click "Add mod...":
the loader checks it, puts it here and replaces an older version of the same mod.

To add a mod by hand, put it in its own folder here, as it came in the mod's download. A mod folder holds a
mod.json file and a patches folder, for example:

  mods\
    some-mod\
      mod.json
      patches\
        ...

Then click "Refresh" in the loader (or open it): the mod appears in its list with a switch.

- Do not put two versions of the same mod here by hand. Delete the old folder first, or let the loader add the
  new version for you.
- A mod made for another version of the game is listed but cannot be switched on until its author updates it.
- A mod that needs another mod says so in the list; switch both on.
- The loader checks every change a mod makes to the game's code before the game starts, and never changes
  the game's own files. Some mods also run a script that changes what the game's window shows (the
  loader's list says which); such a script cannot reach your saves or the game's settings. Changes to the
  game's code are still code from the mod's author: add mods only from authors you trust.
