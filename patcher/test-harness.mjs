// Offline test of the runtime patcher core (session.mjs) against headless Chrome: a fixture shaped like the game
// (file:// page, CSP script-src 'self', a worker that fetches relative to location.href and starts a nested
// worker) and a patched body the size of the real simulation worker. Touches neither the game nor Steam.
// Usage: node patcher/test-harness.mjs --dir <empty scratch dir> [--chrome <path>] [--mb 97] [--fault syntax|throw]
//   --fault syntax  the patched body does not compile: expect status "original" (the original runs untouched)
//   --fault throw   the patched body throws while starting: expect status "broken" (the original is not run)
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from './cdp.mjs';
import { attachAndServe, waitFor, SIM } from './session.mjs';
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
writeFileSync(join(site, 'page.js'), `window.sim = new Worker("${SIM}"); window.sim.postMessage("early");`);
const original = `(()=>{self.__orig=(self.__orig||0)+1;self.__runs=(self.__runs||[]).concat(typeof __gpModLoader);self.onmessage=e=>{self.__got=(self.__got||[]).concat(e.data)};fetch(new URL("t0.json",location.href).href).then(r=>r.json()).then(d=>{self.__data=d}).catch(e=>{self.__data="ERR "+e.message});self.__nested=new Worker(new URL("world-market-worker.bundle.js",location.href).href)})();`;
writeFileSync(join(site, SIM), original);
writeFileSync(join(site, 'world-market-worker.bundle.js'), 'self.__wm=1;');
writeFileSync(join(site, 't0.json'), '{"t0":"loaded"}');

const prefix = markerPrelude('harness', [{ id: 'harness', version: '0', patches: ['none'] }]);
const padding = `/*${'x'.repeat(Math.max(0, mb * 1e6 - original.length - prefix.length - 5))}*/`;
const faultText = { syntax: '\nfunction(', throw: '\nthrow new Error("harness fault");' }[fault] ?? '';
const patched = `${prefix}\n${original}\n${padding}${faultText}${HANDLER_POSTLUDE}`;
const payloads = new Map([[SIM, patched]]);
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
  await attachAndServe(cdp, {
    pageUrl: /\/renderer\/index\.html/, payloads, log, settleMs: 1500,
    onSwap: r => { swapStatus = r.status; if (r.status === 'patched') workerSession = r.sessionId; },
  });
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
  cdp.close();
} finally {
  stop();
}
log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
