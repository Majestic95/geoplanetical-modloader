GEOPLANETICAL MOD LOADER
========================

The Geoplanetical Mod Loader starts Geoplanetical with the mods you choose. Each mod has a switch; the mods you
switch on are applied to the game's code in memory when the game starts. The game's files are never changed.
Single player only.


WHAT YOU NEED
-------------
- Windows, Steam, and Geoplanetical installed through Steam.
- Mods made for your version of the game. If the game updates, a mod waits until its author releases an
  updated version; the loader shows which mods are ready.


INSTALLING MODS
---------------
1. Unzip this folder anywhere (for example your Desktop). Keep the files together.
2. Start GeoplaneticalModLoader.exe and drop each mod's .zip file (or its unzipped folder) onto the loader's
   window, or click "Add mod..." and choose the zip. The loader checks the mod before adding it and puts it in
   the "mods" folder here. Adding a new version of a mod replaces the old one (which goes to the Recycle Bin);
   its switch stays as you left it.
   You can also unzip a mod into the "mods" folder yourself (see mods\README.txt) and click "Refresh".


PLAYING
-------
1. Double-click GeoplaneticalModLoader.exe.
   Windows may warn that the program is from an unknown publisher (it is not code-signed). Choose
   "More info" and then "Run anyway". Some antivirus programs may ask too.
2. The loader opens in its own window. It shows your game, the mods it found, who made each one and
   what each changes. Use the switch beside a mod to turn it on or off, then click "Play with mods".
3. The game starts through Steam. You can minimise the loader window while you play. If you close
   it, the loader keeps the mods active in the background and closes itself after you quit the
   game; leave it open to see its end-of-session report. If the window ever shows a red warning during
   play, the mods are not active: quit the game without saving and send the mod's author launcher.log.
   "Open log" shows what it did; "Quit" closes it (do not quit while the game is running).

What the loader does: it reads the game's own code, applies the mods' changes in memory, and starts
the game through Steam. Without the loader the game is the normal game, and starting it from Steam as
usual plays without mods.


PLAYING THROUGH ANOTHER PROGRAM (FOR EXAMPLE MULTIPLAYER)
--------------------------------------------------------
Some programs, such as a multiplayer launcher, start the game with the mods switched on in this loader.
1. Download and unzip the program anywhere, as its author explains.
2. In the loader's window, under "Programs", click "Add program..." and choose the program's .exe file.
3. Switch on the mods you want, then click "Play with <the program's name>". The program opens its own
   window and starts the game; follow what it says there. The loader does not start the game itself.
Add only programs you trust: unlike a mod, a program can do anything on your PC. If a program added itself
to the loader, or was downloaded from the internet, the loader shows its full path and asks you once before
starting it. "Remove" takes a program
off the list; it does not delete the program.


SAVES
-----
- Steam Cloud syncs your saves. When you try a new mod, start a new game and save it under a new name
  so you do not overwrite a campaign you care about.
- A save made with mods needs the same mods to load correctly: load it through the loader with the
  same mods switched on.


WHEN SOMETHING GOES WRONG
-------------------------
- A mod listed as broken: its files are damaged or incomplete, or it needs a newer loader. The list
  says which. Download the mod again, or update the loader.
- Two mods that change the same part of the game cannot run together; the loader names both and
  starts nothing. Switch one of them off.
- An amber warning while you play: a mod's page script (a script some mods run in the game's window)
  failed. The game runs with the mods, but what that mod shows on screen may be missing.
- Report a problem with a mod to its author, with launcher.log from this folder, the game date and
  the country you play, and the save file if you can.


IF THE GAME IS NOT FOUND OR MOVES
---------------------------------
The loader finds the game through Steam. If it cannot, its window asks for the game folder (type it or
click "Browse...") and remembers it in launcher-settings.json. If you later move or reinstall the game,
delete launcher-settings.json and start the loader again. While Steam is updating the game, the loader
waits for the update to finish.


UPDATING THE LOADER
-------------------
Unzip the new version over this folder. Your mods and launcher-settings.json stay.


REMOVING IT
-----------
Delete this folder. Nothing else was installed or changed. Saves you made with mods stay in your
normal save list; load them only through the loader.
