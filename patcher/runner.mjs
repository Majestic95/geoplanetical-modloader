// Launch-and-attach, shared by the dev launcher (patcher/launch.mjs) and the player launcher (launcher/main.mjs):
// starts Geoplanetical through Steam with Chromium remote debugging, swaps the patched bundles into their workers
// (patcher/session.mjs), and stays attached until the game closes, re-attaching if the socket drops or the game's
// startup guard relaunches it.
import { spawn } from 'node:child_process';
import { connect } from './cdp.mjs';
import { attachAndServe, waitFor } from './session.mjs';
import { APP_ID, gameRunning } from './game.mjs';

// The game's startup guard can relaunch it (electron/main.js:388-392: app.relaunch keeps process.argv, minus the
// overlay flag, so the debug port returns). That leaves a short gap with no process: look a few times before
// concluding the game closed.
async function gameStillRunning() {
  for (let i = 0; i < 10; i++) {
    if (gameRunning()) return true;
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

const debugPort = port => waitFor('the debug port', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  return res.ok ? res.json() : null;
}, 180000);

// Launches through Steam and attaches. scripts: page scripts [{ mod, path, text }] (patcher/session.mjs). onSwap({ bundle,
// status }) reports each worker swap and the page scripts (bundle PAGE); onExit(code) is called when the game closes (0)
// or the patcher can no longer serve it (1).
export async function launchAndServe({ steam, port, payloads, scripts = [], log, onSwap, onExit }) {
  const pageState = {}; // which page load the page scripts last ran in, across re-attaches (patcher/session.mjs)
  // A failed start is logged; the wait for the debug port below then times out with its own error.
  spawn(steam, ['-applaunch', APP_ID, `--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' })
    .on('error', e => log(`Steam could not be started: ${e.message}`)).unref();
  log(`launched through Steam: ${steam} -applaunch ${APP_ID} --remote-debugging-port=${port}`);
  const version = await debugPort(port);
  log(`debug port up: ${version.Browser}`);
  await attach({ wsUrl: version.webSocketDebuggerUrl, port, payloads, scripts, pageState, log, onSwap, onExit });
}

// (Re)attaches. If the socket closes while the game is still running, wait for the port again. The same browser
// process (same debugger URL: only the socket dropped) is re-attached without a reload, since that could lose unsaved
// play; a new process (the startup guard relaunched the game) is attached like a fresh launch, reload included.
async function attach({ wsUrl, port, payloads, scripts, pageState, log, onSwap, onExit, previousWsUrl = null }) {
  const reattach = previousWsUrl === wsUrl;
  const cdp = await connect(wsUrl);
  cdp.onClose(async () => {
    let running;
    try { running = await gameStillRunning(); } catch (e) { log(`!!! ${e.message}`); onExit(1); return; }
    if (!running) { log('game closed'); onExit(0); return; }
    log('debug connection lost while the game is running; re-attaching');
    try {
      const v = await debugPort(port);
      if (v.webSocketDebuggerUrl !== wsUrl) log('the game was relaunched (new browser process); attaching as a fresh launch');
      await attach({ wsUrl: v.webSocketDebuggerUrl, port, payloads, scripts, pageState, log, onSwap, onExit, previousWsUrl: wsUrl });
      log('re-attached');
    } catch (e) {
      log(`!!! could not re-attach (${e.message}). Workers started from now on run UNMODDED code.`);
      onExit(1);
    }
  });
  await attachAndServe(cdp, { pageUrl: /\/renderer\/index\.html/, payloads, scripts, pageState, log, onSwap, reattach });
}
