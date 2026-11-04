// Offline test of the runtime patcher core (session.mjs) against headless Chrome: a fixture shaped like the game
// (file:// page, CSP script-src 'self', a worker that fetches relative to location.href and starts a nested
// worker) and a patched body the size of the real simulation worker. Touches neither the game nor Steam.
// Also page scripts (mod format 2): injected into the fixture page despite its CSP, only into the top frame (the page
// holds a same-path iframe), once per page load (checked again after a reload), with their declarations kept private,
// and in an isolated world: the page's own code cannot see them, and they cannot see the page's globals (a stand-in
// for the game's desktop bridge included).
// Also the main page's bundle (wording changes): the page asks for it as the game does, in a script element it adds after
// a fetch; it is replaced before any of it runs, on every page load, and the page is never reloaded on a re-attach.
// Usage: node patcher/test-harness.mjs --dir <empty scratch dir> [--chrome <path>] [--mb 97] [--fault syntax|throw|script|bundle-syntax|bundle-throw]
//   --fault syntax  the patched body does not compile: expect status "original" (the original runs untouched)
//   --fault throw   the patched body throws while starting: expect status "broken" (the original is not run)
//   --fault script  a page script throws: expect page status "broken", the other page script still runs
//   --fault bundle-syntax  the page bundle's replacement does not compile: the original is served, reported "original"
//   --fault bundle-throw   it throws while starting: the page is reloaded once with the original, reported "original"
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from './cdp.mjs';
import { attachAndServe, waitFor, SIM, PAGE, PAGE_BUNDLE } from './session.mjs';
import { WORLD } from './page-script.mjs';
import { markerPrelude, HANDLER_POSTLUDE } from './patch-engine.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const dir = arg('--dir');
if (!dir) throw new Error('--dir <empty scratch dir> is required');
const chrome = arg('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const mb = Number(arg('--mb', '97'));
const fault = arg('--fault', null);
const port = 9444;
const log = msg => console.log(`[harness] ${msg}`);

const site = join(dir, 'renderer');
mkdirSync(site, { recursive: true });
writeFileSync(join(site, 'index.html'), `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' blob:"><script src="page.js"></script>`);
// Only the top frame starts the worker and adds the iframe (index.html again: the same path as the game page).
// It also sets two page globals, the second standing in for the game's desktop bridge: page scripts must not see them.
writeFileSync(join(site, 'page.js'), 'window.gameSecret = 1; window.desktop = { saves: { remove() {} } }; ' +
  `if (window.top === window) { window.sim = new Worker("${SIM}"); window.sim.postMessage("early"); ` +
  'document.addEventListener("DOMContentLoaded", () => { const f = document.createElement("iframe"); f.src = "index.html?frame"; document.body.appendChild(f); ' +
  `fetch("t0.json").finally(() => { const s = document.createElement("script"); s.src = "${PAGE_BUNDLE}"; s.async = false; document.body.appendChild(s); }); }); }`);
const original = `(()=>{self.__orig=(self.__orig||0)+1;self.__runs=(self.__runs||[]).concat(typeof __gpModLoader);self.onmessage=e=>{self.__got=(self.__got||[]).concat(e.data)};fetch(new URL("t0.json",location.href).href).then(r=>r.json()).then(d=>{self.__data=d}).catch(e=>{self.__data="ERR "+e.message});self.__nested=new Worker(new URL("world-market-worker.bundle.js",location.href).href)})();`;
writeFileSync(join(site, SIM), original);
writeFileSync(join(site, 'world-market-worker.bundle.js'), 'self.__wm=1;');
writeFileSync(join(site, 't0.json'), '{"t0":"loaded"}');
const pageBundle = label => `window.__appRuns = (window.__appRuns || 0) + 1; window.__ranWith = "${label}"; document.documentElement.setAttribute("data-label", "${label}");`;
writeFileSync(join(site, PAGE_BUNDLE), pageBundle('ORIGINAL'));

const prefix = markerPrelude('harness', [{ id: 'harness', version: '0', patches: ['none'] }]);
const padding = `/*${'x'.repeat(Math.max(0, mb * 1e6 - original.length - prefix.length - 5))}*/`;
const faultText = { syntax: '\nfunction(', throw: '\nthrow new Error("harness fault");' }[fault] ?? '';
const patched = `${prefix}\n${original}\n${padding}${faultText}${HANDLER_POSTLUDE}`;
// As large as the game's, with a character outside ASCII to check the text arrives as UTF-8.
const PATCHED_LABEL = `PATCHED ${String.fromCharCode(0xe9)}`;
const bundleFault = { 'bundle-syntax': '\nfunction(', 'bundle-throw': '\nthrow new Error("harness bundle fault");' }[fault] ?? '';
const patchedBundle = `${prefix}${pageBundle(PATCHED_LABEL)}/*${'y'.repeat(35e6)}*/${bundleFault}${HANDLER_POSTLUDE}`;
const payloads = new Map([[SIM, patched], [PAGE_BUNDLE, patchedBundle]]);
// The page scripts: the first counts its runs and marks the document with what it sees once the page's own script has
// run (read through the DOM, which the worlds share, also in the iframe); "hidden" must stay private to it. The second
// throws only with --fault script.
const mark = 'const mark = () => { const d = document.documentElement; d.setAttribute("data-ps", String(window.__ps)); ' +
  'd.setAttribute("data-sees", typeof window.gameSecret + "," + typeof window.desktop); }; ' +
  'if (document.readyState !== "loading") mark(); else document.addEventListener("DOMContentLoaded", mark);';
const scripts = [
  { mod: 'harness', path: 'page/count.js', text: `"use strict";\nvar hidden = 1;\nwindow.__ps = (window.__ps || 0) + 1;\nwindow.__psThis = this === globalThis;\n${mark}` },
  { mod: 'harness', path: 'page/second.js', text: fault === 'script' ? 'throw new Error("page script fault");' : 'window.__ps2 = true;' },
];
log(`patched body ${(patched.length / 1e6).toFixed(1)} MB`);

if (!existsSync(chrome)) throw new Error(`no browser at ${chrome}`);
const child = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`,
  '--allow-file-access-from-files', '--no-first-run', '--no-default-browser-check',
  pathToFileURL(join(site, 'index.html')).href], { stdio: 'ignore' });
const stop = () => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });

let ok = false;
try {
  const version = await waitFor('the debug port', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok ? res.json() : null;
  }, 30000);
  log(`browser ${version.Browser}`);
  const cdp = await connect(version.webSocketDebuggerUrl);
  let workerSession = null, swapStatus = null;
  const pageStatus = [], bundleStatus = [];
  let reloads = 0;
  const firstSend = cdp.send;
  cdp.send = (method, params, sid) => { if (method === 'Page.reload') reloads++; return firstSend(method, params, sid); };
  const pageState = {}; // kept across the re-attach below, as patcher/runner.mjs keeps it
  const { pageSession } = await attachAndServe(cdp, {
    pageUrl: /\/renderer\/index\.html/, payloads, scripts, pageState, log, settleMs: 1500,
    onSwap: r => {
      if (r.bundle === PAGE) return void pageStatus.push(r);
      if (r.bundle === PAGE_BUNDLE) return void bundleStatus.push(r);
      swapStatus = r.status; if (r.status === 'patched') workerSession = r.sessionId;
    },
  });
  // The page's own world, and the world the harness mod's scripts run in.
  const inPage = async expression => JSON.parse((await cdp.send('Runtime.evaluate',
    { expression: `JSON.stringify(${expression})`, returnByValue: true }, pageSession)).result.value);
  const inWorld = async expression => {
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, pageSession);
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD('harness') }, pageSession);
    const r = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify(${expression})`, contextId: executionContextId, returnByValue: true }, pageSession);
    return JSON.parse(r.result.value);
  };
  // The iframe's document, read from an isolated world (its page globals are not visible there, its DOM is).
  const inFrame = async () => {
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, pageSession);
    const child = frameTree.childFrames?.[0]?.frame;
    if (!child) return null;
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: child.id, worldName: 'harness-check' }, pageSession);
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ ready: document.readyState, ps: document.documentElement.getAttribute("data-ps") })',
      contextId: executionContextId, returnByValue: true,
    }, pageSession);
    return JSON.parse(r.result.value);
  };
  // What the page's own world ran, once its bundle has run.
  const bundleRan = () => waitFor('the page bundle', async () => {
    const v = await inPage('({ runs: window.__appRuns, label: window.__ranWith, attr: document.documentElement.getAttribute("data-label"), marker: typeof __gpModLoader })');
    return v.runs ? v : null;
  }, 60000, 100);
  if (fault === 'bundle-syntax' || fault === 'bundle-throw') {
    const r = await waitFor('the bundle result', async () => bundleStatus.find(x => x.status !== 'patched'), 60000);
    const ran = await bundleRan();
    const named = fault === 'bundle-syntax' ? /does not compile/ : /threw while starting/;
    ok = r.status === 'original' && named.test(r.detail) && ran.label === 'ORIGINAL' && ran.runs === 1 && ran.marker === 'undefined' &&
      bundleStatus.every(x => x.status !== 'patched') && reloads <= 2 && (fault !== 'bundle-throw' || reloads >= 1);
    log(`fault ${fault}: ${r.status} (${r.detail}); page ran ${JSON.stringify(ran)}; reloads ${reloads}`);
    cdp.close();
    stop();
    log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
  if (fault === 'script') {
    const r = await waitFor('the page script result', async () => pageStatus[0], 30000);
    const ran = await inWorld('window.__ps');
    ok = r.status === 'broken' && /page\/second\.js threw: Error: page script fault/.test(r.detail) && ran === 1;
    log(`fault script: page status ${r.status} (${r.detail}); the other script ran ${ran} time(s)`);
    cdp.close();
    stop();
    log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
  if (fault) {
    await waitFor('the swap result', async () => swapStatus, 60000);
    const expected = { syntax: 'original', throw: 'broken' }[fault];
    ok = swapStatus === expected;
    log(`fault ${fault}: status ${swapStatus} (expected ${expected})`);
    cdp.close();
    stop();
    log(ok ? 'PASS' : 'FAIL');
    process.exit(ok ? 0 : 1);
  }
  await waitFor('the marker', async () => workerSession, 60000);
  const state = await waitFor('the worker state', async () => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({orig:self.__orig,runs:self.__runs,got:self.__got,data:self.__data,nested:!!self.__nested})', returnByValue: true,
    }, workerSession);
    const v = JSON.parse(r.result.value);
    return v.data ? v : null;
  }, 30000);
  log(`swap status ${swapStatus}, worker state ${JSON.stringify(state)}`);
  ok = state.orig === 1 && state.runs?.join() === 'object' && state.got?.join() === 'early' && state.data?.t0 === 'loaded' && state.nested;

  // Page scripts: ran once in the top frame, declarations private, not in the iframe, isolated both ways; again once
  // after a reload (a state reported only when it changes, so the page itself is checked).
  const first = await waitFor('the page scripts', async () => pageStatus.find(r => r.status === 'patched'), 30000);
  const top = await inWorld('({ ps: window.__ps, ps2: window.__ps2, hidden: typeof hidden, self: window.__psThis })');
  const page = await waitFor('the page marks', async () => {
    const v = await inPage('({ ps: typeof window.__ps, ps2: typeof window.__ps2, sees: document.documentElement.getAttribute("data-sees") })');
    return v.sees ? v : null;
  }, 30000);
  const frame = await waitFor('the iframe', async () => { const f = await inFrame(); return f?.ready === 'complete' ? f : null; }, 30000);
  log(`page scripts: ${first.status}; their world ${JSON.stringify(top)}; the page's world ${JSON.stringify(page)}; iframe ${JSON.stringify(frame)}`);
  // The page bundle: replaced, run once, its text intact, reported patched. The reload just below must replace it again.
  const firstRun = await bundleRan();
  const firstReport = await waitFor('the bundle report', async () => bundleStatus.find(r => r.status === 'patched'), 60000);
  log(`page bundle: ${firstReport.status}, ran ${JSON.stringify(firstRun)}, reloads to get there ${reloads}`);
  ok = ok && firstRun.label === PATCHED_LABEL && firstRun.attr === PATCHED_LABEL && firstRun.runs === 1 && firstRun.marker === 'object' && reloads <= 1;
  await cdp.send('Page.reload', {}, pageSession);
  const reloaded = await waitFor('the reloaded page', async () => {
    const v = await inWorld('({ ps: window.__ps, ready: document.readyState })');
    return v.ready === 'complete' ? v : null;
  }, 30000);
  log(`after reload: ${JSON.stringify(reloaded)}; reports ${pageStatus.map(r => r.status).join(', ')}`);
  ok = ok && top.ps === 1 && top.ps2 === true && top.hidden === 'undefined' && top.self === true &&
    page.ps === 'undefined' && page.ps2 === 'undefined' && page.sees === 'undefined,undefined' && frame.ps === null &&
    reloaded.ps === 1 && pageStatus.length >= 1 && pageStatus.every(r => r.status === 'patched');
  const reloadedRun = await bundleRan();
  log(`page bundle after reload: ${JSON.stringify(reloadedRun)}; reports ${bundleStatus.map(r => r.status).join(', ')}`);
  ok = ok && reloadedRun.label === PATCHED_LABEL && reloadedRun.runs === 1 && bundleStatus.every(r => r.status === 'patched');
  // The record the re-attach below relies on: written by the check after this page load, which runs on its own.
  const { frameTree: open } = await cdp.send('Page.getFrameTree', {}, pageSession);
  await waitFor('the record of this page load', async () => pageState.loaderId === open.frame.loaderId && pageState.ran.size === scripts.length, 30000, 50);
  cdp.close();

  // A re-attach over a new DevTools connection, as after a dropped socket: the scripts must not run again in this page
  // load, and nothing may be reported as failed or missing.
  const cdp2 = await connect(version.webSocketDebuggerUrl);
  // Counts the page scripts this session sends to run in the open page: the loader's own record must stop it, not only
  // a world that happens to be shared with the first session (as it is in current Chrome).
  let sentAgain = 0, reloadsAgain = 0;
  const send = cdp2.send;
  cdp2.send = (method, params, sid) => {
    if (method === 'Page.reload') reloadsAgain++;
    if (method === 'Runtime.evaluate' && String(params?.expression).includes('//# sourceURL=gpml/page/')) sentAgain++;
    return send(method, params, sid);
  };
  const again = [], bundleAgain = [];
  const { pageSession: s2 } = await attachAndServe(cdp2, {
    pageUrl: /\/renderer\/index\.html/, payloads, scripts, pageState, log, settleMs: 500, reattach: true,
    onSwap: r => { if (r.bundle === PAGE) again.push(r); if (r.bundle === PAGE_BUNDLE) bundleAgain.push(r); },
  });
  const { frameTree } = await cdp2.send('Page.getFrameTree', {}, s2);
  const { executionContextId } = await cdp2.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD('harness') }, s2);
  const after = JSON.parse((await cdp2.send('Runtime.evaluate', { expression: 'JSON.stringify({ ps: window.__ps })', contextId: executionContextId, returnByValue: true }, s2)).result.value);
  const marked = JSON.parse((await cdp2.send('Runtime.evaluate', { expression: 'JSON.stringify(document.documentElement.getAttribute("data-ps"))', returnByValue: true }, s2)).result.value);
  log(`after re-attach: world ${JSON.stringify(after)}, page mark ${marked}; scripts sent again ${sentAgain}; reports ${again.map(r => r.status).join(', ') || 'none'}`);
  ok = ok && (after.ps === undefined || after.ps === 1) && marked === '1' && sentAgain === 0 &&
    again.length >= 1 && again.every(r => r.status === 'patched');
  await waitFor('the bundle report after re-attach', async () => bundleAgain[0], 30000);
  log(`page bundle after re-attach: ${bundleAgain.map(r => r.status).join(', ')}; reloads ${reloadsAgain}`);
  ok = ok && bundleAgain.every(r => r.status === 'patched') && reloadsAgain === 0;
  cdp2.close();
} finally {
  stop();
}
log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
