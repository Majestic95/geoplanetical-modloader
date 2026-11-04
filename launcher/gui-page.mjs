// The launcher window's page (served by launcher/gui.mjs). Plain HTML, CSS and script; every text from a mod file is
// set with textContent, never as HTML. Kept free of backticks and dollar-brace so it can sit in this raw template string
// (raw, so the backslashes in the script and the folder example reach the browser unchanged).
export default String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Geoplanetical Mod Loader</title>
<style>
  :root {
    --bg: #0f1419; --panel: #171e26; --panel2: #1d2631; --line: #2a3542; --text: #e6edf3; --muted: #93a1b0;
    --accent: #3fa7ff; --accent-dim: #1f4b70; --ok: #3fb950; --warn: #d29922; --bad: #f85149;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 20px 20px 120px; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
  h1 { font-size: 22px; margin: 0; font-weight: 650; }
  .sub { color: var(--muted); margin: 0 0 18px; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--panel2); color: var(--muted); border: 1px solid var(--line); }
  .chip.ok { color: var(--ok); border-color: #2a5a35; background: #12261a; }
  .chip.warn { color: var(--warn); border-color: #5a4a1f; background: #2a2110; }
  .chip.bad { color: var(--bad); border-color: #6a2a27; background: #2a1414; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
  .label { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 6px; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .path { font-family: Consolas, monospace; font-size: 13px; word-break: break-all; }
  .banner { border-radius: 10px; padding: 12px 16px; margin-bottom: 12px; border: 1px solid var(--line); background: var(--panel2); }
  .banner.ok { border-color: #2a5a35; background: #12261a; }
  .banner.warn { border-color: #5a4a1f; background: #2a2110; }
  .banner.bad { border-color: #6a2a27; background: #2a1414; }
  .banner.info { border-color: var(--accent-dim); background: #10233a; }
  .mod-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .mod-name { font-size: 16px; font-weight: 600; }
  .mod-note { color: var(--muted); font-size: 13px; margin-top: 6px; }
  .by { color: var(--muted); font-size: 13px; }
  details { margin-top: 10px; }
  summary { cursor: pointer; color: var(--accent); user-select: none; }
  .group { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 14px 0 0; padding-bottom: 3px; border-bottom: 1px solid var(--line); }
  ul.changes { margin: 6px 0 0; padding-left: 20px; }
  ul.changes li { margin-bottom: 6px; }
  .switch { margin-left: auto; width: 52px; height: 28px; border-radius: 999px; border: 1px solid var(--line); background: #2b3644; position: relative; cursor: pointer; flex: none; }
  .switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #c9d4df; transition: left .15s; }
  .switch[aria-checked="true"] { background: var(--accent); border-color: var(--accent); }
  .switch[aria-checked="true"]::after { left: 27px; background: #fff; }
  .switch:disabled { opacity: .45; cursor: not-allowed; }
  button.btn { font: inherit; border-radius: 8px; border: 1px solid var(--line); background: var(--panel2); color: var(--text); padding: 7px 14px; cursor: pointer; }
  button.btn:hover:not(:disabled) { border-color: var(--accent); }
  button.btn:disabled { opacity: .5; cursor: not-allowed; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #04121f; font-weight: 700; font-size: 16px; padding: 10px 26px; }
  button.primary:hover:not(:disabled) { filter: brightness(1.1); }
  input[type=text] { font: inherit; flex: 1; min-width: 260px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  .bar { position: fixed; left: 0; right: 0; bottom: 0; background: rgba(15,20,25,.96); border-top: 1px solid var(--line); }
  .bar .inner { max-width: 960px; margin: 0 auto; padding: 12px 20px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .bar .spacer { flex: 1; }
  pre.log { max-height: 260px; overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font: 12px/1.45 Consolas, monospace; color: #b8c4cf; white-space: pre-wrap; margin: 10px 0 0; }
  .error { color: var(--bad); margin-top: 8px; }
  .hidden { display: none !important; }
  body.dropping main { outline: 2px dashed var(--accent); outline-offset: 6px; border-radius: 10px; }
  dialog { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; max-width: 640px; }
  dialog::backdrop { background: rgba(0,0,0,.55); }
  dialog p { margin: 0 0 10px; }
  .choice { display: flex; gap: 10px; flex-wrap: wrap; }
  .pick { font: inherit; flex: 1; min-width: 240px; text-align: left; border-radius: 8px; border: 1px solid var(--line); background: var(--panel2); color: var(--text); padding: 10px 14px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
  .pick:hover:not(:disabled) { border-color: var(--accent); }
  .pick[aria-checked="true"] { border-color: var(--accent); background: #10233a; box-shadow: inset 0 0 0 1px var(--accent); }
  .pick:disabled { opacity: .55; cursor: not-allowed; }
  .pick-name { font-weight: 650; }
  .pick-sub { color: var(--muted); font-size: 13px; }
  progress { flex: 1; min-width: 200px; height: 10px; accent-color: var(--accent); }
</style>
</head>
<body>
<main>
  <header><h1>Geoplanetical Mod Loader</h1><span class="chip" id="version"></span><span class="chip warn hidden" id="dry">Dry run</span></header>
  <p class="sub">Starts Geoplanetical with the mods you switch on (single player): your frozen copy of the game, or the live Steam game. Or hands them to a program you add below. Game files are never changed.</p>

  <div id="banner" class="banner hidden"></div>

  <section class="card" id="game-card">
    <div class="label">Game</div>
    <div class="choice" role="radiogroup" aria-label="Which game to play">
      <button class="pick" id="pick-frozen" role="radio"><span class="pick-name">Frozen game</span><span class="pick-sub" id="pick-frozen-sub"></span></button>
      <button class="pick" id="pick-live" role="radio"><span class="pick-name">Live Steam game</span><span class="pick-sub" id="pick-live-sub"></span></button>
    </div>
    <div id="frozen-box" style="margin-top:12px">
      <div class="row"><span id="frozen-status"></span><span class="path" id="frozen-path"></span></div>
      <div id="frozen-note" class="mod-note"></div>
      <div id="frozen-get" class="row hidden" style="margin-top:8px">
        <span class="mod-note" id="get-label" style="margin:0"></span>
        <button class="btn" id="freeze-live">Copy from your Steam game</button>
        <button class="btn" id="freeze-download">Download with Steam</button>
        <button class="btn" id="freeze-folder">Copy from a folder&hellip;</button>
      </div>
      <div id="frozen-task" class="hidden" style="margin-top:8px">
        <div class="mod-note" id="task-text"></div>
        <div class="path hidden" id="task-command" style="margin-top:4px"></div>
        <div class="row" style="margin-top:6px"><progress id="task-bar" max="1"></progress><button class="btn" id="freeze-cancel">Cancel</button></div>
      </div>
      <div class="row" style="margin-top:8px"><span class="mod-note" id="saves-note" style="margin:0;flex:1"></span><button class="btn hidden" id="open-saves">Open its saves</button></div>
    </div>
    <div id="live-box" class="hidden" style="margin-top:12px">
    <div class="row"><span id="game-status"></span><span class="path" id="game-path"></span></div>
    <div id="game-note" class="mod-note"></div>
    <div id="folder" class="hidden" style="margin-top:10px">
      <div class="mod-note">Choose the game folder (the one with Geoplanetical.exe in it).</div>
      <div class="row" style="margin-top:6px">
        <input type="text" id="dir" placeholder="e.g. C:\Program Files (x86)\Steam\steamapps\common\Geoplanetical">
        <button class="btn" id="use">Use this folder</button>
        <button class="btn" id="browse">Browse&hellip;</button>
      </div>
    </div>
    </div>
  </section>

  <div class="row" style="margin-top:18px">
    <div class="label" style="margin:0">Mods</div>
    <span style="flex:1"></span>
    <button class="btn" id="add">Add mod&hellip;</button>
    <button class="btn" id="refresh">Refresh</button>
  </div>
  <div class="mod-note" style="margin:4px 0 10px">To add a mod, drop its .zip file or its folder onto this window, or click Add mod.</div>
  <div id="mods"></div>
  <div id="broken"></div>

  <div class="row" style="margin-top:18px">
    <div class="label" style="margin:0">Programs</div>
    <span style="flex:1"></span>
    <button class="btn" id="add-program">Add program&hellip;</button>
  </div>
  <div class="mod-note" style="margin:4px 0 10px">Other programs that start the game with the mods switched on here, such as a multiplayer launcher: click Add program and choose its .exe file. Add only programs you trust: unlike a mod, a program can do anything on your PC.</div>
  <div id="programs"></div>

  <section class="card">
    <details id="log-box"><summary>Details (log)</summary><pre class="log" id="log"></pre></details>
  </section>
</main>

<dialog id="ask">
  <p id="ask-text"></p>
  <p class="path" id="ask-path"></p>
  <p class="mod-note" id="ask-note"></p>
  <div class="row"><span style="flex:1"></span><button class="btn" id="ask-no">Cancel</button><button class="btn" id="ask-yes"></button></div>
</dialog>

<div class="bar"><div class="inner">
  <button class="btn primary" id="play">Play with mods</button>
  <span id="play-note" class="mod-note" style="margin:0"></span>
  <span id="err" class="error" style="margin:0"></span>
  <span class="spacer"></span>
  <button class="btn" id="open-mods">Open mods folder</button>
  <button class="btn" id="open-log">Open log</button>
  <button class="btn" id="quit">Quit</button>
</div></div>

<script>
(function () {
  var token = new URLSearchParams(location.search).get('t');
  var st = null, modsKey = '', programsKey = '', openMods = {}, gone = false, lastLogSeq = -1, adding = false;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function api(method, path, body) {
    return fetch('/api/' + path, {
      method: method, headers: { 'X-Token': token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.state) render(j.state);
      // An action's refusal stays until the next action; the once-a-second state poll leaves it alone.
      if (method === 'POST') $('err').textContent = j.error || '';
      return j;
    });
  }

  function banner(kind, text) {
    var b = $('banner');
    if (!text) { b.className = 'banner hidden'; return; }
    b.className = 'banner ' + kind; b.textContent = text;
  }

  function render(s) {
    st = s;
    $('version').textContent = 'v' + s.version;
    $('dry').classList.toggle('hidden', !s.dryRun);
    var ready = s.phase === 'ready';
    $('quit').disabled = s.phase === 'building';
    $('add').disabled = $('refresh').disabled = !ready || adding || gone;
    $('add-program').disabled = !ready || gone;

    // Game card: the choice (frozen or live), then the chosen game's details.
    var frozenOn = s.play !== 'live', f = s.frozen, t = s.task;
    var running = s.gameRunning && ready ? 'Geoplanetical is running now: close it before pressing Play.' : '';
    var noSteam = s.steamFound ? '' : 'Steam was not found on this PC; the game needs Steam.';
    $('pick-frozen').setAttribute('aria-checked', String(frozenOn));
    $('pick-live').setAttribute('aria-checked', String(!frozenOn));
    $('pick-frozen').disabled = $('pick-live').disabled = !ready || gone;
    var fLabel = { ready: 'Ready', missing: 'Not set up', other: 'Older version', broken: 'Needs fixing', unreadable: 'Could not be read', checking: 'Checking\u2026', unavailable: 'Unavailable' }[f.status] || f.status;
    $('pick-frozen-sub').textContent = 'Game ' + s.pin.version + ' (build ' + s.pin.build + '): ' + (t ? 'being set up' : fLabel.toLowerCase()) + '. Steam updates never change it.';
    $('pick-live-sub').textContent = s.live ? 'Build ' + (s.live.build || 'unknown') + (s.live.updating ? ', being updated by Steam' : '') + '. Changes whenever Steam updates the game.' : 'Not found.';
    $('frozen-box').classList.toggle('hidden', !frozenOn);
    $('live-box').classList.toggle('hidden', frozenOn);

    var fsc = $('frozen-status');
    fsc.className = 'chip ' + (t ? '' : f.status === 'ready' ? 'ok' : f.status === 'checking' ? '' : f.status === 'missing' || f.status === 'other' ? 'warn' : 'bad');
    fsc.textContent = t ? 'Setting up\u2026' : fLabel;
    $('frozen-path').textContent = f.status === 'ready' ? (f.dir || '') : '';
    var fnote = f.status === 'missing'
      ? 'The frozen game is your own copy of game ' + s.pin.version + ', kept by the loader so that a Steam update never stops the mods. Get it once, in one of these ways (about 3.9 GB):'
      : f.status === 'ready' || f.status === 'checking' ? '' : (f.problem || '');
    $('frozen-note').textContent = [fnote, f.status === 'ready' ? running : '', noSteam].filter(Boolean).join(' ');
    // (also when it is ready: getting it again replaces it, should it ever be damaged)
    $('frozen-get').classList.toggle('hidden', !!t || f.status === 'checking' || f.status === 'unavailable');
    $('get-label').textContent = f.status === 'ready' ? 'Get it again (replaces it):' : '';
    var liveFits = !!(s.live && s.live.build === s.pin.build && !s.live.updating);
    $('freeze-live').disabled = !ready || !liveFits || gone;
    $('freeze-live').title = liveFits ? '' : 'Your Steam game is another version now: download with Steam instead.';
    $('freeze-download').disabled = !ready || !s.steamFound || gone;
    $('freeze-folder').disabled = !ready || gone;
    $('frozen-task').classList.toggle('hidden', !t);
    if (t) {
      var text = 'Starting\u2026', bar = $('task-bar'), sized = t.total && (t.step === 'copying' || t.step === 'checking' || t.step === 'checking-download');
      if (t.step === 'waiting') text = t.clipboard ? 'Steam\u2019s console is opening. Click in it, press Ctrl+V, then Enter. The command (already copied):' : 'Steam\u2019s console is opening. Type this command in it, then press Enter:';
      else if (t.step === 'downloading') text = 'Steam is downloading game ' + s.pin.version + (t.mb ? ' (' + t.mb + ' MB)' : '') + '. Its console says when it is done; the loader takes it from there.';
      else if (t.step === 'checking-source') text = 'Checking the game files to copy\u2026';
      else if (t.step === 'copying') text = 'Copying the game: ' + gb(t.done) + ' of ' + gb(t.total) + ' GB';
      else if (t.step === 'checking') text = 'Checking the copy: ' + gb(t.done) + ' of ' + gb(t.total) + ' GB';
      else if (t.step === 'checking-download') text = 'Checking Steam\u2019s download: ' + gb(t.done) + ' of ' + gb(t.total) + ' GB';
      $('task-text').textContent = text;
      $('task-command').textContent = t.command || '';
      $('task-command').classList.toggle('hidden', !(t.step === 'waiting' && t.command));
      if (sized) { bar.max = t.total; bar.value = t.done; } else bar.removeAttribute('value');
    }
    $('saves-note').textContent = f.savesCopied
      ? 'The frozen game keeps its own saves, apart from the Steam game\u2019s. Steam Cloud does not back them up.'
      : 'The frozen game keeps its own saves. The first time you play it, your Steam saves are copied into it; after that the two lists are separate, and Steam Cloud does not back up the frozen game\u2019s saves.';
    $('open-saves').classList.toggle('hidden', !f.savesCopied);

    var gs = $('game-status'), note = '';
    if (!s.live) {
      gs.className = 'chip bad'; gs.textContent = 'Not found'; $('game-path').textContent = s.savedDir || '';
      note = s.savedDir ? 'The saved folder does not hold the game.' : 'Geoplanetical was not found in your Steam libraries.';
    } else {
      $('game-path').textContent = s.live.dir;
      if (s.live.updating) {
        gs.className = 'chip warn'; gs.textContent = 'Steam is updating';
        note = 'Steam is updating the game' + (s.live.targetBuild ? ' to build ' + s.live.targetBuild : '') + '. Wait for it to finish, then reopen the loader.';
      } else { gs.className = 'chip ok'; gs.textContent = 'Build ' + (s.live.build || 'unknown'); }
    }
    $('game-note').textContent = [note, running, noSteam].filter(Boolean).join(' ');
    $('folder').classList.toggle('hidden', !!(s.live && s.live.build) || !ready);

    // Mods (rebuilt only when they change, so open changelogs stay open)
    var key = JSON.stringify([s.mods, s.broken, ready, s.game && s.game.build, s.play, s.live && s.live.build]);
    if (key !== modsKey) { modsKey = key; renderMods(s, ready); }
    var pkey = JSON.stringify([s.programs, ready, gone]);
    if (pkey !== programsKey) { programsKey = pkey; renderPrograms(s, ready); }

    // Banner and play button
    var on = s.mods.filter(function (m) { return m.fits && m.enabled; }).length;
    var play = $('play'), pn = $('play-note');
    if (s.phase === 'ready') {
      var notReady = !!(s.game && s.game.frozen && !s.game.ready);
      play.disabled = !s.game || !s.steamFound || on === 0 || !!(s.game && s.game.updating) || notReady || !!t;
      play.textContent = s.dryRun ? 'Check mods (dry run)' : 'Play with mods';
      pn.textContent = t ? 'Wait until the frozen game is set up' : notReady ? 'Get the frozen game first (above)'
        : on ? on + ' mod' + (on > 1 ? 's' : '') + ' on, ' + (frozenOn ? 'frozen game' : 'live Steam game') : 'Switch a mod on to play with it';
      if (adding) banner('info', 'Adding the mod\u2026');
      else if (s.message) banner('warn', s.message);
      else banner('ok', s.notice);
    } else if (s.phase === 'building') {
      play.disabled = true; play.textContent = 'Building\u2026'; pn.textContent = '';
      banner('info', s.message || 'Building the mods\u2026');
    } else if (s.phase === 'playing' && s.problem) {
      play.disabled = true; play.textContent = 'Game running'; pn.textContent = '';
      banner('bad', 'The mods could NOT be confirmed active in part of the game (see Details below). This session may be playing the unmodded game: close the game without saving, and report it with the log.');
    } else if (s.phase === 'playing') {
      play.disabled = true; play.textContent = 'Game running'; pn.textContent = '';
      banner(s.warning ? 'warn' : 'ok', (s.message ? s.message + ' ' : '') + 'The game runs with the mods. ' +
        (s.warning ? 'A mod\u2019s page script failed or did not run (see Details below): what that mod shows on screen may be missing; the game itself is unaffected. ' : '') +
        'You can minimise or close this window: the loader keeps the mods active in the background until you quit the game. Saves made now need the mods to load correctly.');
    } else {
      play.disabled = true; play.textContent = 'Session over'; pn.textContent = 'You can close the loader.';
      banner(s.problem ? 'bad' : s.warning ? 'warn' : 'ok', s.message);
    }

    // Log
    if (s.logSeq !== lastLogSeq) {
      lastLogSeq = s.logSeq;
      var lg = $('log'), atEnd = lg.scrollTop + lg.clientHeight >= lg.scrollHeight - 8;
      lg.textContent = s.log.join('\n');
      if (atEnd) lg.scrollTop = lg.scrollHeight;
    }
  }

  function renderMods(s, ready) {
    var box = $('mods'); box.textContent = '';
    if (!s.mods.length) box.appendChild(el('div', 'card mod-note', 'No mods yet. Drop a mod\u2019s .zip file or folder onto this window, or click Add mod.'));
    s.mods.forEach(function (m) {
      var card = el('section', 'card'), head = el('div', 'mod-head');
      head.appendChild(el('span', 'mod-name', m.name));
      head.appendChild(el('span', 'chip', 'v' + m.version));
      if (m.author) head.appendChild(el('span', 'by', 'by ' + m.author));
      head.appendChild(el('span', m.fits ? 'chip ok' : 'chip bad', m.fits ? 'Ready for your game' : 'Not for this game version'));
      var sw = el('button', 'switch');
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(m.fits && m.enabled));
      sw.setAttribute('aria-label', 'Switch ' + m.name + ' on or off');
      sw.disabled = !m.fits || !ready;
      sw.onclick = function () { api('POST', 'toggle', { id: m.id }); };
      head.appendChild(sw);
      card.appendChild(head);
      if (!m.fits) {
        var made = 'Made for game build ' + m.builds.join(', ');
        card.appendChild(el('div', 'mod-note', !s.game ? made + '.'
          : s.game.frozen ? made + '; the frozen game is build ' + s.game.build + '. Wait for an updated version of this mod' + (s.live && m.builds.indexOf(s.live.build) >= 0 ? ', or play the live Steam game, which it is made for.' : '.')
          : made + '; your Steam game is build ' + s.game.build + '. The game has updated: wait for an updated version of this mod' + (m.builds.indexOf(s.pin.build) >= 0 ? ', or play the frozen game, which it is made for.' : '.')));
      }
      if (m.scripts) card.appendChild(el('div', 'mod-note', 'Also runs its own script in the game\u2019s window.'));
      if (m.requires.length) {
        var needs = m.requires.map(function (id) {
          var r = s.mods.filter(function (o) { return o.id === id; })[0];
          return r ? r.name : id + ' (not installed)';
        });
        card.appendChild(el('div', 'mod-note', 'Needs: ' + needs.join(', ')));
      }
      var count = m.changes.reduce(function (n, g) { return n + g.items.length; }, 0);
      if (count) {
        var d = el('details'); d.open = openMods[m.id] !== false;
        d.ontoggle = function () { openMods[m.id] = d.open; };
        d.appendChild(el('summary', null, 'What it changes (' + count + ')'));
        m.changes.forEach(function (g) {
          if (g.group) d.appendChild(el('div', 'group', g.group));
          var ul = el('ul', 'changes');
          g.items.forEach(function (c) { ul.appendChild(el('li', null, c)); });
          d.appendChild(ul);
        });
        card.appendChild(d);
      }
      box.appendChild(card);
    });
    var bb = $('broken'); bb.textContent = '';
    s.broken.forEach(function (b) {
      var c = el('section', 'card'), h = el('div', 'mod-head');
      h.appendChild(el('span', 'mod-name', b.folder)); h.appendChild(el('span', 'chip bad', 'Broken'));
      c.appendChild(h); c.appendChild(el('div', 'mod-note', b.error)); bb.appendChild(c);
    });
  }

  // One card per program: its name, its full path (the file the button starts), Play with and Remove.
  function renderPrograms(s, ready) {
    var box = $('programs'); box.textContent = '';
    s.programs.forEach(function (p) {
      var card = el('section', 'card'), head = el('div', 'mod-head');
      head.appendChild(el('span', 'mod-name', p.name));
      if (p.problem) head.appendChild(el('span', 'chip bad', 'Cannot start'));
      var gap = el('span'); gap.style.flex = '1'; head.appendChild(gap);
      var go = el('button', 'btn', 'Play with ' + p.name);
      go.disabled = !ready || !!p.problem || gone;
      go.onclick = function () { startProgram(p); };
      var rm = el('button', 'btn', 'Remove');
      rm.disabled = !ready || gone;
      rm.onclick = function () {
        ask('Remove ' + p.name + ' from this list?', p.exe, 'The program itself is not deleted.', 'Remove', function () {
          api('POST', 'program-remove', { exe: p.exe });
        });
      };
      head.appendChild(go); head.appendChild(rm);
      card.appendChild(head);
      card.appendChild(el('div', 'path mod-note', p.exe));
      if (p.problem) card.appendChild(el('div', 'mod-note', 'It cannot be started: ' + p.problem + '. Remove it, or add it again from where it is now.'));
      box.appendChild(card);
    });
  }
  // A program the player did not choose in this window (an entry another program or a person wrote into
  // launcher-settings.json) is started only after its full path is shown and confirmed, once.
  function startProgram(p) {
    if (p.confirmed) return api('POST', 'program-start', { exe: p.exe });
    ask('Start this program?', p.exe, 'It was added to the settings of the loader from outside this window, not chosen here. ' +
      'Start it only if you installed it yourself and trust it.', 'Start it', function () {
      api('POST', 'program-start', { exe: p.exe, confirmed: true });
    });
  }
  // A question in the page itself (not the browser confirm(), which would stop the polling meanwhile).
  function ask(text, path, note, yes, then) {
    var d = $('ask');
    $('ask-text').textContent = text; $('ask-path').textContent = path; $('ask-note').textContent = note; $('ask-yes').textContent = yes;
    $('ask-yes').onclick = function () { d.close(); then(); };
    $('ask-no').onclick = function () { d.close(); };
    if (!d.open) d.showModal();
  }

  $('play').onclick = function () { api('POST', 'start'); };
  $('pick-frozen').onclick = function () { api('POST', 'play', { which: 'frozen' }); };
  $('pick-live').onclick = function () { api('POST', 'play', { which: 'live' }); };
  $('freeze-live').onclick = function () { api('POST', 'freeze-live'); };
  $('freeze-download').onclick = function () { api('POST', 'freeze-download'); };
  $('freeze-folder').onclick = function () { api('POST', 'freeze-folder'); };
  $('freeze-cancel').onclick = function () { api('POST', 'freeze-cancel'); };
  $('open-saves').onclick = function () { api('POST', 'open', { what: 'saves' }); };
  function gb(n) { return (n / 1073741824).toFixed(1); }
  $('add-program').onclick = function () { api('POST', 'program-add'); };
  $('use').onclick = function () { api('POST', 'gamedir', { dir: $('dir').value }); };
  $('browse').onclick = function () { api('POST', 'browse'); };
  $('add').onclick = function () { api('POST', 'add'); };
  $('refresh').onclick = function () { api('POST', 'rescan'); };
  $('open-mods').onclick = function () { api('POST', 'open', { what: 'mods' }); };

  // Dropping onto the window. Every drop is caught, so a dropped file never replaces this page. A zip is sent as it is;
  // a folder as its files (paths starting with the folder's name). The loader checks everything before it installs.
  var MAX_BYTES = 32 * 1024 * 1024, MAX_FILES = 5000, dragTimer = null;
  var canAdd = function () { return !!st && st.phase === 'ready' && !adding && !gone; };
  function base64(file) {
    return new Promise(function (ok, fail) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result); ok(s.slice(s.indexOf(',') + 1)); };
      r.onerror = function () { fail(r.error); };
      r.readAsDataURL(file);
    });
  }
  function fileOf(entry) { return new Promise(function (ok, fail) { entry.file(ok, fail); }); }
  function children(dir) {
    var reader = dir.createReader(), all = [];
    return new Promise(function (ok, fail) {
      (function more() {
        reader.readEntries(function (batch) { if (!batch.length) return ok(all); all = all.concat(batch); more(); }, fail);
      })();
    });
  }
  function readSized(entry, size) {
    return fileOf(entry).then(function (f) {
      size.bytes += f.size;
      if (size.bytes > MAX_BYTES) throw new Error('it is larger than 32 MB, too large to be a mod');
      return base64(f);
    });
  }
  function walk(entry, out, size) {
    if (entry.isFile) {
      if (out.length >= MAX_FILES) return Promise.reject(new Error('it holds more than ' + MAX_FILES + ' files'));
      var item = { path: entry.fullPath.replace(/^\//, ''), data: '' };
      out.push(item);
      return readSized(entry, size).then(function (d) { item.data = d; });
    }
    return children(entry).then(function (list) {
      return list.reduce(function (p, e) { return p.then(function () { return walk(e, out, size); }); }, Promise.resolve());
    });
  }
  function addDropped(entries) {
    var odd = entries.filter(function (en) { return en.isFile && !/\.zip$/i.test(en.name); })[0];
    if (odd) {
      $('err').textContent = odd.name.toLowerCase() === 'mod.json' ? 'Drop the whole mod folder, not only its mod.json.' : odd.name + ' is not a mod: drop a mod\u2019s .zip file or its folder.';
      return;
    }
    adding = true; $('err').textContent = ''; render(st);
    var items = [], size = { bytes: 0 };
    entries.reduce(function (p, en) {
      return p.then(function () {
        if (en.isFile) return readSized(en, size).then(function (d) { items.push({ name: en.name, zip: d }); });
        var files = [];
        return walk(en, files, size).then(function () { items.push({ name: en.name, files: files }); });
      });
    }, Promise.resolve()).then(function () {
      return api('POST', 'install', { items: items });
    }).catch(function (e) {
      $('err').textContent = 'Could not add what was dropped: ' + ((e && e.message) || e);
    }).then(function () { adding = false; if (st) render(st); });
  }
  document.addEventListener('dragover', function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = canAdd() ? 'copy' : 'none';
    document.body.classList.toggle('dropping', canAdd());
    clearTimeout(dragTimer);
    dragTimer = setTimeout(function () { document.body.classList.remove('dropping'); }, 250);
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    document.body.classList.remove('dropping');
    if (!canAdd()) {
      if (st && st.phase !== 'ready' && !gone) $('err').textContent = 'Mods can be added when no game session is running.';
      return;
    }
    var dt = e.dataTransfer, entries = [];
    // The entries must be taken now: the browser empties the drop's data when this handler returns.
    for (var i = 0; i < dt.items.length; i++) {
      var en = dt.items[i].kind === 'file' && dt.items[i].webkitGetAsEntry ? dt.items[i].webkitGetAsEntry() : null;
      if (en) entries.push(en);
    }
    if (!entries.length) {
      $('err').textContent = dt.getData('text/uri-list')
        ? 'To add a mod from a link, download its .zip file first, then drop the zip here.'
        : 'Drop a mod\u2019s .zip file or its folder here.';
      return;
    }
    addDropped(entries);
  });
  $('open-log').onclick = function () { api('POST', 'open', { what: 'log' }); };
  $('quit').onclick = function () {
    if (st && st.phase === 'playing' && !confirm('The game is running. Quitting the loader turns the mods off for parts of the game that restart. Quit anyway?')) return;
    api('POST', 'quit').then(function (j) { if (!j.error) closed(); }, closed);
  };
  function closed() {
    gone = true;
    banner('info', 'The loader has closed. You can close this window.');
    ['play', 'quit', 'open-mods', 'open-log', 'add', 'refresh', 'add-program', 'pick-frozen', 'pick-live', 'freeze-live', 'freeze-download', 'freeze-folder', 'freeze-cancel', 'open-saves']
      .forEach(function (id) { $(id).disabled = true; });
    renderPrograms(st || { programs: [] }, false);
    setTimeout(function () { window.close(); }, 400);
  }
  // Three failed polls in a row (not one) mean the launcher has gone.
  var failures = 0;
  function poll() {
    if (gone) return;
    api('GET', 'state').then(function () { failures = 0; setTimeout(poll, 1000); }, function () {
      failures++;
      if (st && failures >= 3) closed(); else setTimeout(poll, 1000);
    });
  }
  poll();
})();
</script>
</body>
</html>
`;
