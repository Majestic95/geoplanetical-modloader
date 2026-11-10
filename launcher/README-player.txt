GEOPLANETICAL MOD LOADER
========================

The Geoplanetical Mod Loader starts Geoplanetical with the mods you choose. Each mod has a switch; the mods you
switch on are applied to the game's code when the game starts. Your Steam game's files are never changed.
Single player only.


WHAT YOU NEED
-------------
- Windows, Steam, and Geoplanetical bought on Steam.
- About 4 GB of free space for the frozen game (below).


THE FROZEN GAME
---------------
Steam updates Geoplanetical often, and every update used to stop the mods until their authors caught up.
So the loader plays one version of the game (shown in its window), from its own copy of it, which Steam
never updates: the frozen game. Your mods are made for that version. Set it up once, in the loader's window,
in one of these ways:
- "Copy from your Steam game": possible while your Steam game is that same version.
- "Download with Steam": the loader opens Steam's console and copies a command; click in the console,
  press Ctrl+V, then Enter. Steam downloads that version of the game (from your own account), and the
  loader moves it into its folder when Steam is done.
- "Copy from a folder...": a copy of that version you already have.
The loader checks every copy before it uses it. It lives in
%LOCALAPPDATA%\GeoplaneticalModLauncher\game. When a new loader version plays a newer game version, get
it the same way; the new copy replaces the old one.
You can also choose "Live Steam game" in the window: then the loader starts your normal Steam game, and
a mod plays only if it is made for that game's current version.


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
3. The game starts (the frozen game needs Steam running and signed in). You can minimise the loader
   window while you play. If you close it, the loader keeps the mods active in the background and closes
   itself after you quit the game; leave it open to see its end-of-session report. If the window ever
   shows a red warning during play, the mods are not active: quit the game without saving and send the
   mod's author launcher.log.
   "Open log" shows what it did; "Quit" closes it (do not quit while the game is running).

What the loader does: it reads the game's own code, applies the mods' changes as the game starts (in
memory, or for the simulation in the frozen game's folder: see below), and starts the game. Without
the loader the game is the normal game, and starting it from Steam as usual plays your normal Steam
game without mods.


MODS THAT CHANGE THE SIMULATION
-------------------------------
From game 1.0.9 on, the game runs its simulation (economy, politics, war) in a background process of its
own, outside the game's window. A mod that changes it is written into the frozen game's folder while you
play, and the loader puts the game's own file back when the game closes (or, if the PC or the loader
stopped first, the next time the loader opens). So:
- Such a mod plays only in the frozen game, never in your Steam game. The window says so beside the mod.
- Its code runs inside the game with the same access to your PC as any program you install. Use only
  mods from authors you trust. The first time you play such a mod, and again whenever its version or its
  code changes, the loader asks you to confirm it.
- A program you start from the loader (below) gets such mods written into the frozen game the same way;
  the loader keeps its window open in a session until the program and the game have closed, then puts
  the game's own file back.


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
- The frozen game keeps its own saves, apart from your Steam game's. The first time you play it, your
  Steam saves are copied into it; after that the two save lists are separate. Steam Cloud does NOT back
  up the frozen game's saves: "Open its saves" in the window shows where they are
  (%LOCALAPPDATA%\GeoplaneticalModLauncher\game-data\saves), if you want to back them up yourself.
- Steam Cloud syncs your Steam game's saves. When you try a new mod, start a new game and save it under
  a new name so you do not overwrite a campaign you care about.
- A save made with mods needs the same mods to load correctly: load it through the loader with the
  same mods switched on.


WHEN SOMETHING GOES WRONG
-------------------------
- A mod listed as broken: its files are damaged or incomplete, or it needs a newer loader. The list
  says which. Download the mod again, or update the loader.
- Two mods that change the same part of the game cannot run together; the loader names both and
  starts nothing. Switch one of them off.
- An amber warning while you play: a mod's page script (a script some mods run in the game's window)
  failed, or a mod's wording change is not active (the game shows its own text). The game runs with
  the mods, but what that mod shows on screen may be missing.
- Report a problem with a mod to its author, with launcher.log from this folder, the game date and
  the country you play, and the save file if you can.


IF THE GAME IS NOT FOUND OR MOVES
---------------------------------
(This is about the live Steam game.) The loader finds it through Steam. If it cannot, its window asks
for the game folder (type it or click "Browse...") and remembers it in launcher-settings.json. If you
later move or reinstall the game, delete launcher-settings.json and start the loader again. While Steam
is updating the game, the loader waits for the update to finish.


UPDATING THE LOADER
-------------------
Unzip the new version over this folder. Your mods and launcher-settings.json stay.


REMOVING IT
-----------
Delete this folder, and %LOCALAPPDATA%\GeoplaneticalModLauncher (the frozen game, its saves and the
window's settings): back up the saves in its game-data\saves folder first if you want to keep them.
Nothing else was installed or changed. Saves you made with mods in the live Steam game stay in your
normal save list; load them only through the loader.
