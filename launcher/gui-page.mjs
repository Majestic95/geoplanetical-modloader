// The launcher window's page (served by launcher/gui.mjs). Plain HTML, CSS and script; every text from a mod file is
// set with textContent, never as HTML. Kept free of backticks and dollar-brace so it can sit in this raw template string
// (raw, so the backslashes in the script and the folder example reach the browser unchanged).
// Four views, chosen here: setup (getting the frozen game; opened on its own once when the frozen game is chosen and
// missing, older or broken), mods (adding the first mods), main (the mods and Play) and settings (which game, the
// frozen copy, the Steam game's folder, programs). Nothing is downloaded or copied before the player clicks for it.
export default String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Geoplanetical Mod Loader</title>
<style>
  :root {
    --bg: #0f1419; --panel: #141b23; --panel2: #1d2631; --line: #22303c; --line2: #2a3542; --text: #e6edf3; --soft: #c9d4df; --muted: #93a1b0;
    --accent: #3fa7ff; --accent-dim: #1f4b70; --link: #6cbcff; --ok: #3fb950; --warn: #e3b341; --bad: #f85149;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
  .top { display: flex; align-items: center; gap: 10px; padding: 14px 24px; border-bottom: 1px solid #222c37; flex-wrap: wrap; }
  .top h1 { font-size: 18px; margin: 0; font-weight: 650; }
  main { max-width: 920px; margin: 0 auto; padding: 18px 24px 40px; }
  body.with-bar main { padding-bottom: 110px; }
  .spacer { flex: 1; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--panel2); color: var(--muted); border: 1px solid var(--line2); white-space: nowrap; }
  .chip.ok { color: var(--ok); border-color: #2a5a35; background: #12261a; }
  .chip.warn { color: var(--warn); border-color: #5a4a1f; background: #241d0e; }
  .chip.bad { color: #ff7b72; border-color: #6a2a27; background: #2a1414; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
  .card-title { font-weight: 650; font-size: 15px; margin-bottom: 8px; display: flex; align-items: center; gap: 10px; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .note { color: var(--muted); font-size: 13px; }
  .lead { color: var(--soft); font-size: 15px; margin: 0 0 18px; }
  .path { font-family: Consolas, monospace; font-size: 13px; word-break: break-all; color: var(--muted); }
  .hidden { display: none !important; }
  h2 { font-size: 24px; font-weight: 650; margin: 6px 0 10px; }
  h3 { font-size: 15px; font-weight: 650; margin: 0; }
  .narrow { max-width: 640px; margin: 0 auto; }
  /* Banners: how the last session ended, what the loader is doing, refusals */
  .banner { border-radius: 12px; padding: 12px 16px; margin-bottom: 14px; border: 1px solid var(--line2); background: var(--panel2); display: flex; gap: 12px; align-items: flex-start; }
  .banner .text { flex: 1; }
  .banner.ok { border-color: #2a5a35; background: #12261a; }
  .banner.warn { border-color: #5a4a1f; background: #2a2110; }
  .banner.bad { border-color: #6a2a27; background: #2a1414; }
  .banner.info { border-color: var(--accent-dim); background: #10233a; }
  /* Buttons */
  button.btn { font: inherit; border-radius: 8px; border: 1px solid var(--line2); background: var(--panel2); color: var(--text); padding: 7px 14px; cursor: pointer; }
  button.btn:hover:not(:disabled) { border-color: var(--accent); }
  button.btn:disabled { opacity: .5; cursor: not-allowed; }
  button.ghost { background: transparent; color: var(--soft); }
  button.link { background: transparent; border-color: transparent; color: var(--link); padding: 7px 8px; }
  button.link:hover:not(:disabled) { border-color: transparent; text-decoration: underline; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #04121f; font-weight: 700; font-size: 15px; padding: 10px 24px; }
  button.primary:hover:not(:disabled) { filter: brightness(1.1); }
  button.big { font-size: 16px; padding: 12px 34px; border-radius: 10px; }
  button.x { background: transparent; border: 0; color: inherit; font-size: 18px; line-height: 1; padding: 2px 6px; cursor: pointer; opacity: .8; }
  input[type=text] { font: inherit; flex: 1; min-width: 260px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line2); background: var(--bg); color: var(--text); }
  /* Setup steps in the header */
  .steps { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  .steps .num { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line2); display: inline-flex; align-items: center; justify-content: center; }
  .steps .step { display: inline-flex; align-items: center; gap: 6px; }
  .steps .step.now { color: var(--text); font-weight: 600; }
  .steps .step.now .num { background: var(--accent); border-color: var(--accent); color: #04121f; font-weight: 700; }
  .steps .step.done .num { background: #12261a; border-color: #2a5a35; color: var(--ok); }
  .steps .sep { width: 24px; height: 1px; background: var(--line2); }
  /* Setup: facts, the download's steps, the command */
  dl.facts { display: grid; grid-template-columns: 110px 1fr; gap: 6px 16px; margin: 4px 0 14px; font-size: 13px; }
  dl.facts dt { color: var(--muted); }
  dl.facts dd { margin: 0; }
  ol.stps { list-style: none; margin: 0 0 14px; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .stp { display: flex; gap: 14px; align-items: flex-start; padding: 10px 14px; border-radius: 12px; border: 1px solid transparent; opacity: .7; }
  .stp .n { width: 26px; height: 26px; flex: none; border-radius: 50%; border: 1px solid var(--line2); color: var(--muted); display: flex; align-items: center; justify-content: center; }
  .stp .t { font-weight: 600; }
  .stp.now { opacity: 1; background: #10233a; border-color: var(--accent-dim); }
  .stp.now .n { background: var(--accent); border-color: var(--accent); color: #04121f; font-weight: 700; }
  .stp.done { opacity: 1; }
  .stp.done .n { background: #12261a; border-color: #2a5a35; color: var(--ok); }
  .cmd { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0 2px; }
  .cmd code { flex: 1; min-width: 300px; font-family: Consolas, monospace; font-size: 13px; background: #0b1016; border: 1px solid var(--line2); border-radius: 8px; padding: 8px 10px; user-select: all; }
  progress { flex: 1; min-width: 200px; height: 10px; accent-color: var(--accent); }
  details.have { margin-top: 4px; }
  details.have summary, details.more summary, #log-box summary { cursor: pointer; color: var(--link); user-select: none; }
  .have-list { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; }
  /* Mods */
  .drop { font: inherit; width: 100%; min-height: 210px; border: 2px dashed #2f5f86; border-radius: 16px; background: #0f1a24; color: var(--text); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; cursor: pointer; margin-bottom: 16px; }
  .drop:hover:not(:disabled) { border-color: var(--accent); }
  .drop .big { font-size: 18px; font-weight: 600; }
  .list { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; margin-bottom: 14px; }
  .mod { background: var(--panel); border-bottom: 1px solid #1e2832; }
  .mod:last-child { border-bottom: 0; }
  .mod-row { display: flex; align-items: center; gap: 14px; padding: 12px 16px; }
  .mod-main { flex: 1; min-width: 0; }
  .mod-name { font-weight: 600; font-size: 15px; margin-right: 8px; }
  .mod-desc { color: var(--muted); font-size: 13px; }
  .mod-alert { color: #ffa198; font-size: 13px; }
  .mod-more { padding: 0 16px 14px 82px; color: var(--soft); font-size: 13px; }
  .mod-more .note { margin-bottom: 6px; }
  .group { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 10px 0 0; }
  ul.changes { margin: 4px 0 0; padding-left: 18px; }
  ul.changes li { margin-bottom: 4px; }
  .switch { width: 48px; height: 28px; border-radius: 999px; border: 1px solid var(--line2); background: #2b3644; position: relative; cursor: pointer; flex: none; padding: 0; }
  .switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #c9d4df; transition: left .15s; }
  .switch[aria-checked="true"] { background: var(--accent); border-color: var(--accent); }
  .switch[aria-checked="true"]::after { left: 23px; background: #fff; }
  .switch:disabled { opacity: .45; cursor: not-allowed; }
  .simple { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 8px; }
  /* The game line */
  .status { display: flex; align-items: center; gap: 14px; background: #131b23; border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; margin-bottom: 18px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; flex: none; background: var(--muted); }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); } .dot.info { background: var(--accent); }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
  /* Settings: the game choice */
  .choice { display: flex; gap: 10px; flex-wrap: wrap; }
  .pick { font: inherit; flex: 1; min-width: 240px; text-align: left; border-radius: 10px; border: 1px solid var(--line2); background: var(--panel2); color: var(--text); padding: 10px 14px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
  .pick:hover:not(:disabled) { border-color: var(--accent); }
  .pick[aria-checked="true"] { border-color: var(--accent); background: #10233a; box-shadow: inset 0 0 0 1px var(--accent); }
  .pick:disabled { opacity: .55; cursor: not-allowed; }
  .pick-name { font-weight: 650; }
  .pick-sub { color: var(--muted); font-size: 13px; }
  .prog { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 0; border-top: 1px solid var(--line); }
  pre.log { max-height: 260px; overflow: auto; background: var(--bg); border: 1px solid var(--line2); border-radius: 8px; padding: 10px; font: 12px/1.45 Consolas, monospace; color: #b8c4cf; white-space: pre-wrap; margin: 10px 0 0; }
  /* The bar at the bottom of the main view */
  .bar { position: fixed; left: 0; right: 0; bottom: 0; background: rgba(12,17,22,.97); border-top: 1px solid #222c37; display: none; }
  body.with-bar .bar { display: block; }
  .bar .inner { max-width: 920px; margin: 0 auto; padding: 14px 24px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  body.dropping main { outline: 2px dashed var(--accent); outline-offset: 6px; border-radius: 12px; }
  dialog { background: var(--panel); color: var(--text); border: 1px solid var(--line2); border-radius: 12px; padding: 18px 20px; max-width: 640px; }
  dialog::backdrop { background: rgba(0,0,0,.55); }
  dialog p { margin: 0 0 10px; }
</style>
</head>
<body>
<header class="top">
  <h1>Geoplanetical Mod Loader</h1><span class="chip" id="version"></span><span class="chip warn hidden" id="dry">Dry run</span>
  <span class="spacer"></span>
  <div class="steps hidden" id="steps" aria-label="Setup steps">
    <span class="step" id="step1"><span class="num">1</span>Game</span><span class="sep"></span>
    <span class="step" id="step2"><span class="num">2</span>Mods</span><span class="sep"></span>
    <span class="step" id="step3"><span class="num">3</span>Play</span>
  </div>
  <button class="btn ghost" id="open-mods">Mods folder</button>
  <button class="btn ghost" id="to-settings">Settings</button>
  <button class="btn ghost hidden" id="back">Back</button>
</header>

<main>
  <div id="end" class="banner hidden"><span class="text" id="end-text"></span><button class="x" id="dismiss" aria-label="Dismiss">&times;</button></div>
  <div id="banner" class="banner hidden"><span class="text" id="banner-text"></span></div>
  <div id="err" class="banner bad hidden" role="alert"><span class="text" id="err-text"></span></div>

  <!-- Setup, step 1: the frozen game -->
  <section id="v-setup" class="hidden"><div class="narrow">
    <h2 id="s-title"></h2>
    <p class="lead" id="s-lead"></p>
    <div id="s-done" class="card hidden">
      <div class="row"><span class="dot ok" id="s-done-dot"></span><span class="spacer" id="s-done-text"></span><button class="btn primary" id="s-next">Continue</button></div>
    </div>
    <div id="s-offer" class="card">
      <div class="card-title" id="s-ask"></div>
      <dl class="facts">
        <dt>What</dt><dd id="s-what"></dd>
        <dt>Free space</dt><dd>About 5 GB on the drive of your Windows user folder (usually C:), where the loader keeps the frozen game, and about 4 GB more on Steam’s drive while Steam downloads it (about 9 GB if they are the same drive). Steam’s download is removed once it is copied.</dd>
        <dt>Your part</dt><dd>One paste into Steam’s console: the loader opens it and shows you where.</dd>
        <dt>Needs</dt><dd>Steam running and signed in.</dd>
      </dl>
      <div class="row"><button class="btn primary" id="freeze-download">Yes, get it with Steam</button><button class="btn hidden" id="s-check">Refresh</button><button class="btn link" id="s-later">Not now</button></div>
      <div class="note" id="s-steam-note"></div>
    </div>
    <details class="have" id="s-have"><summary id="s-have-label"></summary>
      <div class="have-list">
        <div><div><strong>My Steam game is that version.</strong> <span class="note" id="s-live-note"></span></div><div class="row" style="margin-top:6px"><button class="btn" id="freeze-live">Copy from my Steam game</button></div></div>
        <div><div><strong>I have a copy of it in a folder.</strong></div><div class="row" style="margin-top:6px"><button class="btn" id="freeze-folder">Choose the folder&hellip;</button></div></div>
        <div class="note">The loader checks every file of a copy before it uses it, and never changes the folder it copies from.</div>
      </div>
    </details>
    <div id="s-task" class="hidden">
      <ol class="stps" id="s-steps">
        <li class="stp" id="s-st1"><span class="n">1</span><div><div class="t">Steam’s console opens</div><div class="note">A Steam window named Console. If Steam was not running, it starts first and opens the console once you are signed in.</div></div></li>
        <li class="stp" id="s-st2"><span class="n">2</span><div class="spacer"><div class="t">Click the box at the very bottom of the console, press Ctrl+V, then Enter</div><div class="note" id="s-st2-sub"></div>
          <div class="cmd hidden" id="s-cmd"><code id="s-cmd-text"></code><button class="btn" id="copy-cmd">Copy again</button><button class="btn" id="reopen-console">Open Steam’s console again</button></div></div></li>
        <li class="stp" id="s-st3"><span class="n">3</span><div><div class="t">Steam downloads it</div><div class="note" id="s-st3-sub"></div></div></li>
        <li class="stp" id="s-st4"><span class="n">4</span><div><div class="t">The loader copies and checks it</div><div class="note">Then it removes Steam’s download to free the space.</div></div></li>
      </ol>
      <div class="note" id="task-text"></div>
      <div class="row" style="margin-top:8px"><progress id="task-bar" max="1"></progress></div>
      <div class="row" style="margin-top:16px"><button class="btn" id="freeze-cancel">Cancel</button><span class="spacer"></span><button class="btn" id="s-meanwhile">Continue to mods meanwhile</button></div>
    </div>
  </div></section>

  <!-- Setup, step 2: the first mods -->
  <section id="v-mods" class="hidden"><div class="narrow">
    <h2>Add your mods</h2>
    <p class="lead">Download a mod’s .zip file from its author’s page, then drop it on this window. There is no need to unzip it, and you can add several at once.</p>
    <button class="drop" id="drop-zone"><span class="big">Drop mod .zip files or folders here</span><span class="note">or click to choose a file. Each mod is checked before it is added.</span></button>
    <div id="m-list"></div>
    <div class="row" style="margin-top:14px"><span class="note">You can add more mods any time from the main window.</span><span class="spacer"></span><button class="btn link" id="m-skip">Skip</button><button class="btn primary" id="m-done">Done</button></div>
  </div></section>

  <!-- Main: the game, the mods, Play (in the bar) -->
  <section id="v-main">
    <div class="status"><span class="dot" id="g-dot"></span><div class="spacer"><div id="g-title" style="font-weight:600"></div><div class="note" id="g-sub"></div></div><button class="btn link" id="g-action"></button></div>
    <div class="head">
      <h3>Mods</h3><span class="note" id="mods-count"></span><span class="spacer"></span>
      <span class="note">Drop a mod’s .zip here, or</span><button class="btn" id="add">Add mods&hellip;</button><button class="btn ghost" id="refresh">Refresh</button>
    </div>
    <div id="mods"></div>
    <div id="broken"></div>
    <details id="log-box"><summary>Details (log)</summary><pre class="log" id="log"></pre></details>
  </section>

  <!-- Settings -->
  <section id="v-settings" class="hidden">
    <h2>Settings</h2>
    <section class="card">
      <div class="card-title">Which game to play</div>
      <div class="choice" role="radiogroup" aria-label="Which game to play">
        <button class="pick" id="pick-frozen" role="radio"><span class="pick-name">Frozen game</span><span class="pick-sub" id="pick-frozen-sub"></span></button>
        <button class="pick" id="pick-live" role="radio"><span class="pick-name">Steam game</span><span class="pick-sub" id="pick-live-sub"></span></button>
      </div>
    </section>
    <section class="card">
      <div class="card-title" id="f-title"></div>
      <div class="row"><span class="chip" id="frozen-status"></span><span class="path" id="frozen-path"></span></div>
      <div class="note" id="frozen-note" style="margin-top:6px"></div>
      <div class="row" style="margin-top:10px"><button class="btn" id="to-setup"></button><button class="btn" id="f-check">Refresh</button><button class="btn" id="open-saves">Open its saves</button></div>
      <div class="note" id="saves-note" style="margin-top:8px"></div>
    </section>
    <section class="card">
      <div class="card-title">Steam game</div>
      <div class="row"><span class="chip" id="game-status"></span><span class="path" id="game-path"></span></div>
      <div class="note" id="game-note" style="margin-top:6px"></div>
      <div id="folder" class="hidden" style="margin-top:10px">
        <div class="note">Choose the game folder (the one with Geoplanetical.exe in it).</div>
        <div class="row" style="margin-top:6px">
          <input type="text" id="dir" aria-label="Game folder" placeholder="e.g. C:\Program Files (x86)\Steam\steamapps\common\Geoplanetical">
          <button class="btn" id="use">Use this folder</button>
          <button class="btn" id="browse">Browse&hellip;</button>
        </div>
      </div>
    </section>
    <section class="card">
      <div class="card-title"><span class="spacer">Programs</span><button class="btn" id="add-program">Add program&hellip;</button></div>
      <div class="note">Other programs that start the game with the mods switched on here, such as a multiplayer launcher: click Add program and choose its .exe file. Add only programs you trust: unlike a mod, a program can do anything on your PC.</div>
      <div id="programs" style="margin-top:8px"></div>
    </section>
    <section class="card">
      <div class="card-title">More</div>
      <div class="row"><button class="btn" id="open-mods2">Open mods folder</button><button class="btn" id="open-log">Open log</button><button class="btn" id="run-setup">Run setup again</button><button class="btn" id="quit2">Quit the loader</button></div>
    </section>
  </section>
</main>

<dialog id="ask">
  <p id="ask-text"></p>
  <p class="path" id="ask-path"></p>
  <p class="note" id="ask-note"></p>
  <div class="row"><span class="spacer"></span><button class="btn" id="ask-no">Cancel</button><button class="btn" id="ask-yes"></button></div>
</dialog>

<div class="bar"><div class="inner">
  <button class="btn primary big" id="play">Play</button>
  <span id="prog-buttons" class="row"></span>
  <span id="play-note" class="note"></span>
  <span class="spacer"></span>
  <button class="btn ghost" id="quit">Quit</button>
</div></div>

<script>
(function () {
  var token = new URLSearchParams(location.search).get('t');
  var st = null, modsKey = '', setupModsKey = '', programsKey = '', progButtonsKey = '', openMods = {}, gone = false, lastLogSeq = -1, adding = false;
  // view: setup | mods | main | settings ; decided: the first view was chosen from the first settled state
  var view = 'main', decided = false, errText = '', bannerText = '';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function hide(id, on) { $(id).classList.toggle('hidden', !!on); }
  function gb(n) { return (n / 1073741824).toFixed(1); }

  function api(method, path, body) {
    return fetch('/api/' + path, {
      method: method, headers: { 'X-Token': token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.json(); }).then(function (j) {
      // An action's refusal stays until the next action; the once-a-second state poll leaves it alone.
      if (method === 'POST') errText = j.error || '';
      if (j.state) render(j.state); else paintErr();
      return j;
    });
  }
  function banner(kind, text) {
    bannerText = text || '';
    $('banner').className = 'banner ' + kind + (text ? '' : ' hidden');
    $('banner-text').textContent = bannerText;
    paintErr();
  }
  // (the loader also shows a refusal as its message: shown once)
  function paintErr() { $('err-text').textContent = errText; hide('err', !errText || errText === bannerText); }
  function show(v) { view = v; errText = ''; if (st) render(st); window.scrollTo(0, 0); }
  // After the game step: the mods step while there is no mod yet, else the main view.
  function afterGame() { show(st && (st.mods.length || st.broken.length) ? 'main' : 'mods'); }

  var lastPhase = null;
  function render(s) {
    if (gone) return;
    if (lastPhase && lastPhase !== 'ready' && s.phase === 'ready') errText = '';
    lastPhase = s.phase;
    st = s;
    var f = s.frozen;
    // The first view, once the frozen game's first check is known: setup when the frozen game is chosen and must be got.
    if (!decided && f.status !== 'checking') {
      decided = true;
      if (s.play !== 'live' && (f.status === 'missing' || f.status === 'other' || f.status === 'broken')) view = 'setup';
      else if (!s.mods.length && !s.broken.length) view = 'mods';
    }
    var ready = s.phase === 'ready';
    $('version').textContent = 'v' + s.version;
    hide('dry', !s.dryRun);
    hide('v-setup', view !== 'setup'); hide('v-mods', view !== 'mods'); hide('v-main', view !== 'main'); hide('v-settings', view !== 'settings');
    document.body.classList.toggle('with-bar', view === 'main');
    hide('steps', view !== 'setup' && view !== 'mods');
    $('step1').className = 'step ' + (view === 'setup' ? 'now' : 'done');
    $('step2').className = 'step' + (view === 'mods' ? ' now' : '');
    hide('back', view !== 'settings'); hide('to-settings', view === 'settings'); hide('open-mods', view !== 'main');
    $('quit').disabled = $('quit2').disabled = s.phase === 'building';
    $('add').disabled = $('refresh').disabled = $('drop-zone').disabled = !ready || adding;
    $('add-program').disabled = !ready;

    renderBanners(s, ready);
    renderSetup(s, ready);
    if (view === 'mods') renderModsStep(s, ready);
    renderMain(s, ready);
    renderSettings(s, ready);

    // (the bar can wrap onto several rows: the list keeps that much room below it)
    document.querySelector('main').style.paddingBottom = view === 'main' ? (document.querySelector('.bar').offsetHeight + 24) + 'px' : '';
    if (s.logSeq !== lastLogSeq) {
      lastLogSeq = s.logSeq;
      var lg = $('log'), atEnd = lg.scrollTop + lg.clientHeight >= lg.scrollHeight - 8;
      lg.textContent = s.log.join('\n');
      if (atEnd) lg.scrollTop = lg.scrollHeight;
    }
  }

  function renderBanners(s, ready) {
    var e = ready && s.lastEnd;
    hide('end', !e);
    if (e) { $('end').className = 'banner ' + e.kind; $('end-text').textContent = e.text; }
    if (s.phase === 'building') banner('info', s.message || 'Building the mods…');
    else if (s.phase === 'playing' && s.problem) banner('bad', 'The mods could NOT be confirmed active in part of the game (see Details (log) in the main view). This session may be playing the unmodded game: close the game without saving, and report it with the log.');
    else if (s.phase === 'playing') {
      banner(s.warning ? 'warn' : 'ok', (s.message ? s.message + ' ' : '') + 'The game runs with the mods. ' +
        (s.warning ? 'A mod’s page script or wording change failed or did not run (see the log): what that mod shows on screen may be missing; the game itself is unaffected. ' : '') +
        'You can minimise or close this window: the loader keeps the mods active in the background until you quit the game. Saves made now need the mods to load correctly.');
    } else if (adding) banner('info', 'Adding the mod…');
    else if (s.message) banner('warn', s.message);
    else banner('ok', s.notice);
  }

  // --- Setup: the frozen game ---
  function renderSetup(s, ready) {
    var f = s.frozen, t = s.task, V = s.pin.version;
    var titles = {
      missing: 'Welcome! First, the game.', other: 'This loader plays game ' + V, broken: 'Your frozen game needs fixing',
      unreadable: 'Your frozen game could not be read', ready: 'Your frozen game is ready', checking: 'Checking your frozen game…',
      unavailable: 'The frozen game cannot be set up on this PC'
    };
    var leads = {
      missing: 'Mods are made for one version of Geoplanetical: game ' + V + '. The loader keeps its own copy of that version, the frozen game, so a Steam update never stops your mods. Your Steam game stays exactly as it is.',
      other: 'Your frozen game is an older version. Get game ' + V + ': the new copy replaces the old one once it is checked. Games saved in an older version may not load in game ' + V + '.',
      ready: 'It is game ' + V + ' (build ' + s.pin.build + '). Get it again only if something is wrong with it: the new copy replaces it once it is checked.',
      checking: ''
    };
    $('s-title').textContent = t ? (t.kind === 'download with Steam' ? 'Getting game ' + V + ' with Steam' : 'Copying game ' + V) : (titles[f.status] || f.status);
    $('s-lead').textContent = t ? '' : (f.status in leads ? leads[f.status] : (f.problem || ''));
    var canGet = f.status !== 'checking' && f.status !== 'unavailable';
    hide('s-offer', !!t || !canGet); hide('s-have', !!t || !canGet); hide('s-task', !t);
    hide('s-done', !!t || (f.status !== 'ready' && f.status !== 'unavailable'));
    $('s-done-dot').className = 'dot ' + (f.status === 'ready' ? 'ok' : 'bad');
    $('s-done-text').textContent = f.status === 'ready' ? 'Game ' + V + ' is ready to play with mods.' : 'You can still play your Steam game, with the mods made for its version (Settings).';
    $('s-ask').textContent = f.status === 'ready' ? 'Get it again from Steam?' : 'Get game ' + V + ' from Steam now?';
    $('s-what').textContent = 'Game ' + V + ' (build ' + s.pin.build + '), about 4.1 GB, from your own Steam account.';
    $('s-have-label').textContent = 'I already have game ' + V;
    $('freeze-download').disabled = !ready || !s.steamFound;
    // (could not be read: usually the game runs; checking again after it closes is the answer, not a new copy)
    hide('s-check', f.status !== 'unreadable'); $('s-check').disabled = !ready;
    $('s-steam-note').textContent = s.steamFound ? '' : 'Steam was not found on this PC. Install Steam and sign in, then open the loader again.';
    $('s-later').textContent = f.status === 'ready' ? 'Back' : 'Not now';
    var liveFits = !!(s.live && s.live.build === s.pin.build && !s.live.updating);
    $('freeze-live').disabled = !ready || !liveFits;
    $('s-live-note').textContent = liveFits ? 'It is now (build ' + s.pin.build + '), so the loader can copy it.'
      : s.live ? 'It is build ' + (s.live.build || 'unknown') + (s.live.updating ? ', being updated by Steam,' : '') + ' now. If Steam offers version ' + V + ' for Geoplanetical (right-click it in Steam, Properties, then Betas, called Game Versions & Betas in newer Steam), choose it, let Steam finish, then click Refresh in the main view.'
      : 'Your Steam game was not found.';
    $('freeze-folder').disabled = !ready;
    if (t) renderTask(s, t);
  }
  function renderTask(s, t) {
    var dl = t.kind === 'download with Steam';
    var at = { starting: 1, waiting: 2, downloading: 3, 'checking-download': 4, copying: 4, checking: 4 }[t.step] || 1;
    hide('s-steps', !dl);
    for (var i = 1; i <= 4; i++) {
      $('s-st' + i).className = 'stp' + (i < at ? ' done' : i === at ? ' now' : '');
      $('s-st' + i).querySelector('.n').textContent = i < at ? '✓' : String(i);
    }
    $('s-st2-sub').textContent = t.clipboard === false ? 'The loader could not copy the command: type the command below into the box, then press Enter.'
      : 'The command below is already copied. It asks Steam for game ' + s.pin.version + ' from your own account.';
    $('s-st3-sub').textContent = 'The loader notices when Steam starts and finishes: nothing to do here' + (t.mb ? ' (about ' + t.mb + ' MB). Steam’s console shows how far it is.' : '.');
    hide('s-cmd', !(dl && t.command && at <= 2));
    $('s-cmd-text').textContent = t.command || '';
    $('reopen-console').disabled = t.step !== 'waiting';
    var text = 'Starting…', bar = $('task-bar'), sized = t.total && (t.step === 'copying' || t.step === 'checking' || t.step === 'checking-download');
    if (t.step === 'waiting') text = 'Waiting for the command in Steam’s console…';
    else if (t.step === 'downloading') text = 'Steam is downloading game ' + s.pin.version + '. The loader takes it from there.';
    else if (t.step === 'checking-source') text = 'Checking the game files to copy…';
    else if (t.step === 'copying') text = 'Copying the game: ' + gb(t.done) + ' of ' + gb(t.total) + ' GB';
    else if (t.step === 'checking') text = 'Checking the copy: ' + gb(t.done) + ' of ' + gb(t.total) + ' GB';
    else if (t.step === 'checking-download') text = 'Checking Steam’s download: ' + gb(t.done) + ' of ' + gb(t.total) + ' GB';
    $('task-text').textContent = text;
    if (sized) { bar.max = t.total; bar.value = t.done; } else bar.removeAttribute('value');
  }

  // --- Setup: the first mods ---
  function renderModsStep(s) {
    var key = JSON.stringify([s.mods, s.broken]);
    if (key === setupModsKey) return;
    setupModsKey = key;
    var box = $('m-list'); box.textContent = '';
    s.mods.forEach(function (m) {
      var r = el('div', 'simple');
      r.appendChild(el('span', 'mod-name', m.name));
      r.appendChild(el('span', 'note', 'v' + m.version));
      r.appendChild(el('span', 'spacer'));
      // (a mod that changes the simulation fits the Steam game's build but plays only in the frozen game)
      var plays = m.fits && !(m.outside && !(s.game && s.game.frozen));
      r.appendChild(el('span', plays ? 'chip ok' : 'chip bad', plays ? 'Ready for your game' : m.fits ? 'Plays only in the frozen game' : 'Not for this game version'));
      box.appendChild(r);
    });
    s.broken.forEach(function (b) {
      var r = el('div', 'simple');
      r.appendChild(el('span', 'mod-name', b.folder)); r.appendChild(el('span', 'spacer')); r.appendChild(el('span', 'chip bad', 'Broken'));
      box.appendChild(r); box.appendChild(el('div', 'mod-alert', b.error));
    });
  }

  // --- Main ---
  function renderMain(s, ready) {
    var f = s.frozen, t = s.task, frozenOn = s.play !== 'live', V = s.pin.version;
    var running = s.gameRunning && ready ? ' Geoplanetical is running now: close it before pressing Play.' : '';
    var noSteam = s.steamFound ? '' : ' Steam was not found on this PC; the game needs Steam.';
    var dot = '', title = '', sub = '', action = '', go = null;
    if (frozenOn) {
      if (t) { dot = 'info'; title = 'Getting game ' + V + '…'; sub = 'You can add mods meanwhile.'; action = 'Show'; go = 'setup'; }
      else if (f.status === 'ready') { dot = 'ok'; title = 'Game ' + V + ' is ready'; sub = 'Your frozen game: Steam updates never change it.'; action = 'Change…'; go = 'settings'; }
      else if (f.status === 'checking') { title = 'Checking your frozen game…'; }
      else if (f.status === 'missing') { dot = 'warn'; title = 'Game ' + V + ' is not set up yet'; sub = 'The mods play in the loader’s own copy of game ' + V + ', the frozen game.'; action = 'Set it up'; go = 'setup'; }
      else if (f.status === 'other') { dot = 'warn'; title = 'Your frozen game is an older version'; sub = f.problem || ''; action = 'Get game ' + V; go = 'setup'; }
      else { dot = 'bad'; title = f.status === 'unreadable' ? 'Your frozen game could not be read' : f.status === 'unavailable' ? 'The frozen game is not available' : 'Your frozen game needs fixing'; sub = f.problem || ''; action = f.status === 'broken' ? 'Fix it' : 'Settings'; go = f.status === 'broken' ? 'setup' : 'settings'; }
    } else if (!s.live) { dot = 'bad'; title = 'Your Steam game was not found'; sub = 'Choose its folder in Settings.'; action = 'Settings'; go = 'settings'; }
    else if (s.live.updating) { dot = 'warn'; title = 'Steam is updating the game'; sub = 'Wait for the update' + (s.live.targetBuild ? ' to build ' + s.live.targetBuild : '') + ' to finish, then click Refresh.'; action = 'Change…'; go = 'settings'; }
    else { dot = 'ok'; title = 'Your Steam game (build ' + (s.live.build || 'unknown') + ')'; sub = 'It changes whenever Steam updates it, and mods that change the simulation play only in the frozen game.'; action = 'Change…'; go = 'settings'; }
    $('g-dot').className = 'dot ' + dot;
    $('g-title').textContent = title;
    $('g-sub').textContent = (sub + running + noSteam).trim();
    $('g-action').textContent = action; hide('g-action', !action);
    $('g-action').onclick = function () { if (go) show(go); };

    var on = s.mods.filter(function (m) { return m.fits && m.enabled; }).length;
    $('mods-count').textContent = s.mods.length ? on + ' of ' + s.mods.length + ' on' : '';
    var key = JSON.stringify([s.mods, s.broken, ready, s.game && s.game.build, s.game && s.game.frozen, s.play, s.live && s.live.build]);
    if (key !== modsKey) { modsKey = key; renderMods(s, ready); }

    // The bar: Play, the programs, what Play would do
    var play = $('play'), pn = $('play-note');
    if (s.phase === 'ready') {
      var notReady = !!(s.game && s.game.frozen && !s.game.ready);
      play.disabled = !s.game || !s.steamFound || on === 0 || !!(s.game && s.game.updating) || notReady || !!t;
      play.textContent = s.dryRun ? 'Check mods (dry run)' : s.lastEnd ? 'Play again' : 'Play';
      pn.textContent = t ? 'Wait until the frozen game is set up' : notReady ? (f.status === 'checking' ? 'Checking the frozen game…' : f.status === 'unreadable' ? 'Close the game if it runs, then click Refresh' : 'Set up the frozen game first')
        : !s.game ? 'Choose the game folder in Settings' : !s.steamFound ? 'Steam was not found on this PC'
        : on ? on + ' mod' + (on > 1 ? 's' : '') + ' on · ' + (frozenOn ? 'frozen game ' + V : 'Steam game') : 'Switch a mod on to play with it';
    } else if (s.phase === 'building') { play.disabled = true; play.textContent = 'Building…'; pn.textContent = ''; }
    else { play.disabled = true; play.textContent = 'Game running'; pn.textContent = ''; }
    var pk = JSON.stringify([s.programs, ready]);
    if (pk !== progButtonsKey) {
      progButtonsKey = pk;
      var pb = $('prog-buttons'); pb.textContent = '';
      s.programs.forEach(function (p) {
        var b = el('button', 'btn', 'Play with ' + p.name);
        b.disabled = !ready || !!p.problem;
        if (p.problem) b.title = 'It cannot be started: see Settings.';
        b.onclick = function () { startProgram(p); };
        pb.appendChild(b);
      });
    }
  }

  function renderMods(s, ready) {
    var box = $('mods'); box.textContent = '';
    if (!s.mods.length) {
      var d = el('button', 'drop');
      d.appendChild(el('span', 'big', 'No mods yet'));
      d.appendChild(el('span', 'note', 'Drop a mod’s .zip file or folder onto this window, or click here to choose one.'));
      d.disabled = !ready;
      d.onclick = function () { api('POST', 'add'); };
      box.appendChild(d);
    } else {
      var list = el('div', 'list');
      s.mods.forEach(function (m) { list.appendChild(modRow(s, m, ready)); });
      box.appendChild(list);
    }
    var bb = $('broken'); bb.textContent = '';
    s.broken.forEach(function (b) {
      var c = el('div', 'card'), h = el('div', 'row');
      h.appendChild(el('span', 'mod-name', b.folder)); h.appendChild(el('span', 'chip bad', 'Broken'));
      c.appendChild(h); c.appendChild(el('div', 'mod-alert', b.error)); bb.appendChild(c);
    });
  }
  // One mod: its switch, name, version, description; what stops it from playing, shown at once; the rest under Details.
  function modRow(s, m, ready) {
    var row = el('div', 'mod'), top = el('div', 'mod-row');
    var sw = el('button', 'switch');
    sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(m.fits && m.enabled));
    sw.setAttribute('aria-label', 'Switch ' + m.name + ' on or off');
    sw.disabled = !m.fits || !ready;
    sw.onclick = function () { api('POST', 'toggle', { id: m.id }); };
    top.appendChild(sw);
    var main = el('div', 'mod-main'), line = el('div');
    line.appendChild(el('span', 'mod-name', m.name));
    line.appendChild(el('span', 'note', 'v' + m.version + (m.author ? ' · by ' + m.author : '')));
    main.appendChild(line);
    if (m.description) main.appendChild(el('div', 'mod-desc', m.description));
    var frozenGame = !!(s.game && s.game.frozen);
    if (!m.fits) {
      var made = 'Made for game build ' + m.builds.join(', ');
      main.appendChild(el('div', 'mod-alert', !s.game ? made + '.'
        : frozenGame ? made + '; the frozen game is build ' + s.game.build + '. Wait for an updated version of this mod' + (s.live && m.builds.indexOf(s.live.build) >= 0 ? ', or play your Steam game (Settings), which it is made for.' : '.')
        : made + '; your Steam game is build ' + s.game.build + '. Wait for an updated version of this mod' + (m.builds.indexOf(s.pin.build) >= 0 ? ', or play the frozen game (Settings), which it is made for.' : '.')));
    } else if (m.outside && !frozenGame) {
      main.appendChild(el('div', 'mod-alert', 'Changes the simulation, which this game version runs outside the game window: it plays only in the frozen game, never in your Steam game.'));
    }
    top.appendChild(main);
    if (m.outside && frozenGame && m.fits) {
      var badge = el('span', 'chip warn', m.trusted ? 'Full PC access' : 'Full PC access · asks once');
      badge.title = 'Its code runs with the same access to your PC as any program you install.';
      top.appendChild(badge);
    }
    var more = el('div', 'mod-more');
    if (m.outside && frozenGame) more.appendChild(el('div', 'note', 'Changes the simulation, which this game version runs outside the game window: written into the frozen game while you play, it runs with the same access to your PC as any program you install. Use only mods from authors you trust.'));
    if (m.scripts) more.appendChild(el('div', 'note', 'Also runs its own script in the game’s window.'));
    if (m.wording) more.appendChild(el('div', 'note', 'Also changes wording in the game’s window (English and French).'));
    if (m.requires.length) {
      more.appendChild(el('div', 'note', 'Needs: ' + m.requires.map(function (id) {
        var r = s.mods.filter(function (o) { return o.id === id; })[0];
        return r ? r.name : id + ' (not installed)';
      }).join(', ')));
    }
    var count = m.changes.reduce(function (n, g) { return n + g.items.length; }, 0);
    if (count) {
      more.appendChild(el('div', 'group', 'What it changes (' + count + ')'));
      m.changes.forEach(function (g) {
        if (g.group) more.appendChild(el('div', 'group', g.group));
        var ul = el('ul', 'changes');
        g.items.forEach(function (c) { ul.appendChild(el('li', null, c)); });
        more.appendChild(ul);
      });
    }
    if (more.childNodes.length) {
      var open = openMods[m.id] === true;
      var tg = el('button', 'btn link', open ? 'Hide' : 'Details');
      tg.setAttribute('aria-expanded', String(open));
      tg.onclick = function () { openMods[m.id] = !open; modsKey = ''; render(st); };
      top.appendChild(tg);
      more.classList.toggle('hidden', !open);
    }
    row.appendChild(top);
    if (more.childNodes.length) row.appendChild(more);
    return row;
  }

  // --- Settings ---
  function renderSettings(s, ready) {
    var f = s.frozen, t = s.task, frozenOn = s.play !== 'live', V = s.pin.version;
    var fLabel = { ready: 'Ready', missing: 'Not set up', other: 'Older version', broken: 'Needs fixing', unreadable: 'Could not be read', checking: 'Checking…', unavailable: 'Unavailable' }[f.status] || f.status;
    $('pick-frozen').setAttribute('aria-checked', String(frozenOn));
    $('pick-live').setAttribute('aria-checked', String(!frozenOn));
    $('pick-frozen').disabled = $('pick-live').disabled = !ready;
    $('pick-frozen-sub').textContent = 'Game ' + V + ' (build ' + s.pin.build + '), the loader’s own copy: ' + (t ? 'being set up' : fLabel.toLowerCase()) + '. Steam updates never change it. Every mod made for it plays, including mods that change the simulation.';
    $('pick-live-sub').textContent = s.live ? 'Build ' + (s.live.build || 'unknown') + (s.live.updating ? ', being updated by Steam' : '') + '. It changes whenever Steam updates the game; only mods made for that version play, and never mods that change the simulation.' : 'Not found.';
    $('f-title').textContent = 'Frozen game (game ' + V + ')';
    var fsc = $('frozen-status');
    fsc.className = 'chip ' + (t ? '' : f.status === 'ready' ? 'ok' : f.status === 'checking' ? '' : f.status === 'missing' || f.status === 'other' ? 'warn' : 'bad');
    fsc.textContent = t ? 'Being set up…' : fLabel;
    $('frozen-path').textContent = f.status === 'ready' ? (f.dir || '') : '';
    $('frozen-note').textContent = f.status === 'ready' || f.status === 'checking' ? '' : (f.problem || '');
    $('to-setup').textContent = t ? 'Show progress' : f.status === 'ready' ? 'Get it again…' : 'Get it…';
    $('to-setup').disabled = f.status === 'unavailable' || f.status === 'checking';
    $('f-check').disabled = !ready || !!t || f.status === 'checking' || f.status === 'unavailable';
    $('saves-note').textContent = f.savesCopied
      ? 'The frozen game keeps its own saves, apart from the Steam game’s. Steam Cloud does not back them up.'
      : 'The frozen game keeps its own saves. The first time you play it, your Steam saves are copied into it; after that the two lists are separate, and Steam Cloud does not back up the frozen game’s saves.';
    hide('open-saves', !f.savesCopied);

    var gs = $('game-status'), note = '';
    if (!s.live) {
      gs.className = 'chip bad'; gs.textContent = 'Not found'; $('game-path').textContent = s.savedDir || '';
      note = s.savedDir ? 'The saved folder does not hold the game.' : 'Geoplanetical was not found in your Steam libraries.';
    } else {
      $('game-path').textContent = s.live.dir;
      if (s.live.updating) {
        gs.className = 'chip warn'; gs.textContent = 'Steam is updating';
        note = 'Steam is updating the game' + (s.live.targetBuild ? ' to build ' + s.live.targetBuild : '') + '. Wait for it to finish, then click Refresh.';
      } else { gs.className = 'chip ok'; gs.textContent = 'Build ' + (s.live.build || 'unknown'); }
    }
    $('game-note').textContent = note;
    hide('folder', !!(s.live && s.live.build) || !ready);
    $('use').disabled = $('browse').disabled = !ready;

    var pkey = JSON.stringify([s.programs, ready]);
    if (pkey !== programsKey) { programsKey = pkey; renderPrograms(s, ready); }
  }

  // One row per program: its name, its full path (the file the button starts), Play with and Remove.
  function renderPrograms(s, ready) {
    var box = $('programs'); box.textContent = '';
    if (!s.programs.length) box.appendChild(el('div', 'note', 'No programs added.'));
    s.programs.forEach(function (p) {
      var row = el('div', 'prog');
      row.appendChild(el('span', 'mod-name', p.name));
      if (p.problem) row.appendChild(el('span', 'chip bad', 'Cannot start'));
      row.appendChild(el('span', 'spacer'));
      var go = el('button', 'btn', 'Play with ' + p.name);
      go.disabled = !ready || !!p.problem;
      go.onclick = function () { startProgram(p); };
      var rm = el('button', 'btn', 'Remove');
      rm.disabled = !ready;
      rm.onclick = function () {
        ask('Remove ' + p.name + ' from this list?', p.exe, 'The program itself is not deleted.', 'Remove', function () {
          api('POST', 'program-remove', { exe: p.exe });
        });
      };
      row.appendChild(go); row.appendChild(rm);
      box.appendChild(row);
      box.appendChild(el('div', 'path', p.exe));
      if (p.problem) box.appendChild(el('div', 'mod-alert', 'It cannot be started: ' + p.problem + '. Remove it, or add it again from where it is now.'));
    });
  }
  // A program the player did not choose in this window (an entry another program or a person wrote into
  // launcher-settings.json) is started only after its full path is shown and confirmed, once.
  function startProgram(p) {
    trustThen(function (trust) {
      if (p.confirmed) return api('POST', 'program-start', { exe: p.exe, trust: trust });
      ask('Start this program?', p.exe, 'It was added to the settings of the loader from outside this window, not chosen here. ' +
        'Start it only if you installed it yourself and trust it.', 'Start it', function () {
        api('POST', 'program-start', { exe: p.exe, confirmed: true, trust: trust });
      });
    });
  }
  // Mods switched on that run with the same access to the PC as any program (they change code the game runs outside its
  // window, written into the frozen game) are confirmed before they play (again when their code changes); then(answer) goes on.
  function trustThen(then) {
    var asks = st && st.game && st.game.frozen && !st.dryRun ? st.mods.filter(function (m) { return m.fits && m.enabled && m.outside && !m.trusted; }) : [];
    if (!asks.length) return then(undefined);
    ask('Play mods that have the same access to your PC as any program?',
      // (each part cut on its own, so a long name never hides the id or the author)
      asks.map(function (m) { return m.name.slice(0, 60) + ' ' + m.version.slice(0, 20) + ' (' + m.id + ')' + (m.author ? ' by ' + m.author.slice(0, 40) : ''); }).join(', '),
      'They change the simulation, which this game version runs outside the game window. Written into the frozen game while you play, ' +
      'their code runs with the same access to your PC as any program you install: it could read, change or delete your files. ' +
      'Play them only if you trust their authors. You are asked again whenever the code of a mod changes.', 'Play them', function () {
        then(asks.map(function (m) { return m.id + '@' + m.trustKey; }));
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

  // The command shown during Steam's download, copied again (the browser's clipboard; else it is selected for Ctrl+C).
  function copyCommand() {
    var text = $('s-cmd-text').textContent;
    var selectIt = function () { var r = document.createRange(); r.selectNodeContents($('s-cmd-text')); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); $('copy-cmd').textContent = 'Selected: press Ctrl+C'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { $('copy-cmd').textContent = 'Copied'; }, selectIt);
    else selectIt();
    setTimeout(function () { $('copy-cmd').textContent = 'Copy again'; }, 3000);
  }

  $('play').onclick = function () { trustThen(function (trust) { api('POST', 'start', trust ? { trust: trust } : undefined); }); };
  $('dismiss').onclick = function () { api('POST', 'dismiss'); };
  $('to-settings').onclick = function () { show('settings'); };
  $('back').onclick = function () { show('main'); };
  $('run-setup').onclick = function () { show('setup'); };
  $('to-setup').onclick = function () { show('setup'); };
  // (Back, when the copy is ready: setup was opened from Settings; else on to the mods)
  $('s-later').onclick = function () { if (st && st.frozen.status === 'ready') show('main'); else afterGame(); };
  $('s-check').onclick = $('f-check').onclick = function () { api('POST', 'rescan'); };
  $('s-next').onclick = afterGame;
  $('s-meanwhile').onclick = afterGame;
  $('m-skip').onclick = function () { show('main'); };
  $('m-done').onclick = function () { show('main'); };
  $('drop-zone').onclick = function () { api('POST', 'add'); };
  $('pick-frozen').onclick = function () { api('POST', 'play', { which: 'frozen' }); };
  $('pick-live').onclick = function () { api('POST', 'play', { which: 'live' }); };
  $('freeze-live').onclick = function () { api('POST', 'freeze-live'); };
  $('freeze-download').onclick = function () { api('POST', 'freeze-download'); };
  $('freeze-folder').onclick = function () { api('POST', 'freeze-folder'); };
  $('freeze-cancel').onclick = function () { api('POST', 'freeze-cancel'); };
  $('copy-cmd').onclick = copyCommand;
  $('reopen-console').onclick = function () { api('POST', 'steam-console'); };
  $('open-saves').onclick = function () { api('POST', 'open', { what: 'saves' }); };
  $('add-program').onclick = function () { api('POST', 'program-add'); };
  $('use').onclick = function () { api('POST', 'gamedir', { dir: $('dir').value }); };
  $('browse').onclick = function () { api('POST', 'browse'); };
  $('add').onclick = function () { api('POST', 'add'); };
  $('refresh').onclick = function () { api('POST', 'rescan'); };
  $('open-mods').onclick = $('open-mods2').onclick = function () { api('POST', 'open', { what: 'mods' }); };
  $('open-log').onclick = function () { api('POST', 'open', { what: 'log' }); };

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
  function setErr(t) { errText = t; paintErr(); }
  function addDropped(entries) {
    var odd = entries.filter(function (en) { return en.isFile && !/\.zip$/i.test(en.name); })[0];
    if (odd) {
      setErr(odd.name.toLowerCase() === 'mod.json' ? 'Drop the whole mod folder, not only its mod.json.' : odd.name + ' is not a mod: drop a mod’s .zip file or its folder.');
      return;
    }
    adding = true; setErr(''); render(st);
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
      setErr('Could not add what was dropped: ' + ((e && e.message) || e));
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
      if (st && st.phase !== 'ready' && !gone) setErr('Mods can be added when no game session is running.');
      return;
    }
    var dt = e.dataTransfer, entries = [];
    // The entries must be taken now: the browser empties the drop's data when this handler returns.
    for (var i = 0; i < dt.items.length; i++) {
      var en = dt.items[i].kind === 'file' && dt.items[i].webkitGetAsEntry ? dt.items[i].webkitGetAsEntry() : null;
      if (en) entries.push(en);
    }
    if (!entries.length) {
      setErr(dt.getData('text/uri-list')
        ? 'To add a mod from a link, download its .zip file first, then drop the zip here.'
        : 'Drop a mod’s .zip file or its folder here.');
      return;
    }
    addDropped(entries);
  });
  $('quit').onclick = $('quit2').onclick = function () {
    if (st && st.phase === 'playing' && !confirm('The game is running. Quitting the loader turns the mods off for parts of the game that restart. Quit anyway?')) return;
    api('POST', 'quit').then(function (j) { if (!j.error) closed(); }, closed);
  };
  function closed() {
    hide('end', true); errText = '';
    banner('info', 'The loader has closed. You can close this window.');
    gone = true;
    Array.prototype.forEach.call(document.querySelectorAll('button, input'), function (b) { b.disabled = true; });
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
