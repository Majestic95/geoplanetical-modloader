// Attach-and-swap core of the runtime patcher, shared by launch.mjs and the offline harness test.
//
// Chromium does not let the Fetch domain see a file:// dedicated worker's script, and Debugger.setScriptSource is
// gone, so the swap happens inside the worker: every worker starts paused (waitForDebuggerOnStart); a patched one
// stops again just before its script runs (beforeScriptExecution), the patched bundle is syntax-checked and then
// evaluated in the worker's own global scope (same location.href and origin, so relative loads and nested workers
// still work), the original script's run is terminated, and the worker resumes. Workers without a patch, and any
// other target, are released untouched.
//
// Each swap ends in one status, reported through onSwap({ bundle, status, marker, detail }):
//   patched           the patched code's message handler is the one installed after resume (verified)
//   unverified        the patched code ran but installed no handler at top level, so it cannot be checked
//   original          the swap was skipped before anything ran (compile error, oversized message): vanilla runs
//   broken            the patched code threw part-way; the original was terminated too, so the worker is dead
//   original-serving  the original's run was not terminated and replaced the patched handler
//
// Page scripts (mod format 2) go into the game page through the page session, each mod's in an isolated world of its
// own (patcher/page-script.mjs): registered to run at the start of every later page load, and run once in the page
// already open. They are reported like a bundle named PAGE when their state changes: patched (every script ran),
// broken (a script threw while starting; the game's own code is untouched), original (one did not run).

import { MARKER, HANDLER_MARKER } from './patch-engine.mjs';
import { Script } from 'node:vm';
import { WORLD, wrap, pageScriptSource, pageCheck } from './page-script.mjs';

export const SIM = 'simulation-worker.bundle.js';
export const PAGE = 'page';

// Chromium's DevTools receive limit is believed to be 100 MiB per message; a larger evaluate would drop the socket.
const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const basename = url => decodeURIComponent(String(url).split(/[?#]/)[0].split('/').pop());
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
const SERVING_CHECK = `(()=>{const h=globalThis.${HANDLER_MARKER};return JSON.stringify({marker:globalThis.${MARKER}??null,` +
  'handler:typeof h,same:typeof h==="function"&&h===globalThis.onmessage})})()';
// Where the patched code shows in the game's developer tools.
const SOURCE_URL = bundle => `gpml/${bundle}`;

export async function waitFor(what, fn, timeoutMs, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: no reply in ${ms} ms`); })]);

// Reads which code serves an already-running worker (used on re-attach, where the worker may have been swapped
// earlier in the session).
async function servingStatus(cdp, sid) {
  const res = await cdp.send('Runtime.evaluate', { expression: SERVING_CHECK, returnByValue: true }, sid);
  const v = JSON.parse(res.result.value ?? 'null');
  if (!v?.marker) return { status: 'original', marker: null };
  return { status: v.handler !== 'function' ? 'unverified' : v.same ? 'patched' : 'original-serving', marker: v.marker };
}

// payloads: Map(bundle -> patched source text); empty for a baseline run. scripts: page scripts [{ mod, path, text }] in
// load order; pageState: an object the caller keeps across re-attaches (servePage). reattach: the game was already
// running under this patcher; never reload the page (it would lose unsaved play), and report what running workers serve.
export async function attachAndServe(cdp, { pageUrl, payloads, scripts = [], pageState = {}, log, onSwap = () => {}, settleMs = 3000, reattach = false }) {
  const page = await waitFor('the game page', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find(t => t.type === 'page' && pageUrl.test(t.url)) || null;
  }, 120000);
  const { sessionId: pageSession } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  log(`attached to page ${page.url}`);

  const expressions = new Map([...payloads].map(([b, text]) => [b, `${text}\n//# sourceURL=${SOURCE_URL(b)}`]));
  const messageBytes = new Map([...expressions].map(([b, e]) => [b, Buffer.byteLength(JSON.stringify(e)) + 256]));
  const swaps = new Map(); // worker sessionId -> { bundle, breakpointId }
  const results = [];
  let staleWorker = false;
  const report = r => { results.push(r); onSwap(r); };

  cdp.on('Target.attachedToTarget', async p => {
    const { sessionId, targetInfo, waitingForDebugger } = p;
    const release = () => (waitingForDebugger ? cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId) : null);
    if (targetInfo.type !== 'worker') return void (await release()?.catch(() => {}));
    const bundle = basename(targetInfo.url);
    try {
      await cdp.send('Target.setAutoAttach', AUTO_ATTACH, sessionId);
      if (!payloads.has(bundle)) {
        log(`worker ${bundle}: original`);
        return void (await release());
      }
      if (!waitingForDebugger) {
        if (reattach) {
          // A failed check says nothing about which code runs: unverified, not original.
          const r = await servingStatus(cdp, sessionId).catch(e => ({ status: 'unverified', marker: null, error: e.message }));
          log(`worker ${bundle}: already running (re-attach): ${r.status}`);
          return void report({ bundle, ...r, detail: 're-attach', sessionId });
        }
        staleWorker = true;
        return log(`worker ${bundle}: already running before attach, ORIGINAL`);
      }
      await cdp.send('Debugger.enable', {}, sessionId);
      const { breakpointId } = await cdp.send('Debugger.setInstrumentationBreakpoint',
        { instrumentation: 'beforeScriptExecution' }, sessionId);
      swaps.set(sessionId, { bundle, breakpointId });
      await release();
    } catch (e) {
      swaps.delete(sessionId);
      log(`worker ${bundle}: attach failed (${e.message}); releasing`);
      if (payloads.has(bundle)) report({ bundle, status: 'original', marker: null, detail: `attach failed: ${e.message}` });
      await release()?.catch(() => {});
    }
  });

  cdp.on('Debugger.paused', async (p, sid) => {
    const swap = swaps.get(sid);
    if (!swap) return;
    swaps.delete(sid);
    const { bundle, breakpointId } = swap;
    let status = 'original', detail = '', terminated = null;
    try {
      if (p.reason !== 'instrumentation' || basename(p.data?.url) !== bundle) {
        throw new Error(`unexpected first pause ${p.reason} ${p.data?.url}`);
      }
      if (messageBytes.get(bundle) > MAX_MESSAGE_BYTES) {
        throw new Error(`patched ${bundle} is ${messageBytes.get(bundle)} bytes as a DevTools message (limit ${MAX_MESSAGE_BYTES})`);
      }
      const t0 = Date.now();
      // Compile first: a syntax error leaves the worker untouched and the original runs. The Runtime domain is
      // needed for compile/run only; it is disabled again below so the game's console is not streamed to us.
      await cdp.send('Runtime.enable', {}, sid);
      const c = await cdp.send('Runtime.compileScript', {
        expression: expressions.get(bundle), sourceURL: SOURCE_URL(bundle), persistScript: true,
      }, sid);
      if (c.exceptionDetails || !c.scriptId) {
        throw new Error(`patched ${bundle} does not compile: ${c.exceptionDetails?.exception?.description || c.exceptionDetails?.text}`);
      }
      const r = await cdp.send('Runtime.runScript', { scriptId: c.scriptId }, sid);
      // From here the worker holds patched state: the original must not run, whatever happened.
      // The reply only comes once the original's run is terminated, i.e. after the resume below.
      terminated = cdp.send('Runtime.terminateExecution', {}, sid);
      if (r.exceptionDetails) {
        status = 'broken';
        detail = `patched ${bundle} threw while starting: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`;
      } else {
        status = 'evaluated';
        log(`worker ${bundle}: patched code evaluated in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      }
    } catch (e) {
      detail = e.message;
    }
    await cdp.send('Debugger.removeBreakpoint', { breakpointId }, sid).catch(() => {});
    await cdp.send('Debugger.resume', {}, sid).catch(e => log(`resume ${bundle}: ${e.message}`));
    await cdp.send('Debugger.disable', {}, sid).catch(() => {});
    await cdp.send('Runtime.disable', {}, sid).catch(() => {});
    if (terminated) {
      await withTimeout(terminated, 60000, 'terminate').catch(e => {
        log(`worker ${bundle}: terminating the original failed (${e.message})`);
        if (status === 'evaluated') detail = e.message;
      });
    }
    let marker = null;
    if (status === 'evaluated') {
      const v = await waitFor('the serving check', async () => {
        const res = await cdp.send('Runtime.evaluate', { expression: SERVING_CHECK, returnByValue: true }, sid);
        return JSON.parse(res.result.value ?? 'null');
      }, 60000, 250).catch(e => ({ error: e.message }));
      marker = v?.marker ?? null;
      if (v?.error) { status = 'unverified'; detail = v.error; }
      else if (v.handler !== 'function') status = 'unverified';
      else status = v.same ? 'patched' : 'original-serving';
    }
    const line = { patched: 'PATCHED, serving', unverified: 'patched code ran, serving not verifiable', original: 'ORIGINAL (swap skipped)',
      broken: 'BROKEN (mod failed while starting; worker stopped)', 'original-serving': 'ORIGINAL is serving (swap failed)' }[status];
    log(`worker ${bundle}: ${line}${detail ? `: ${detail}` : ''}${marker ? ` ${JSON.stringify(marker)}` : ''}`);
    report({ bundle, status, marker, detail, sessionId: sid });
  });

  cdp.on('Target.detachedFromTarget', p => { swaps.delete(p.sessionId); });

  for (const [b, n] of messageBytes) {
    if (n > 0.9 * MAX_MESSAGE_BYTES) log(`WARNING ${b}: ${(n / 1048576).toFixed(1)} MiB as one DevTools message, near the ${MAX_MESSAGE_BYTES / 1048576} MiB limit`);
  }
  await cdp.send('Target.setAutoAttach', AUTO_ATTACH, pageSession);
  log(`watching workers for ${[...payloads.keys()].join(', ') || 'nothing (baseline)'}`);
  // After the workers are watched, so a worker starting now is not missed.
  if (scripts.length) await servePage(cdp, pageSession, scripts, log, onSwap, reattach, pageState);

  await sleep(settleMs);
  if (!reattach && staleWorker && !results.length) {
    log('a patched worker started before attach; reloading the page once');
    staleWorker = false;
    await cdp.send('Page.reload', { ignoreCache: true }, pageSession);
  }
  return { pageSession, results };
}

// Text from the page (a script's error) goes to the log: control and direction characters out, and kept short.
// eslint-disable-next-line no-control-regex
const clean = s => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '?').slice(0, 300);

// Page scripts: the check is set up first (it waits until the first injection is done), then each script is registered
// for every later page load in its mod's world and run in the page already open. The state is reported when it
// changes: at the first check, and after page loads. `pageState` outlives one attach (patcher/runner.mjs): for one page
// load (its loaderId, from DevTools, which the page cannot change) it holds the scripts known to have run there, after
// the loader ran them or a check saw them. A re-attach into that page load does not run those again, whether or not the
// new session sees the same isolated world as the old one.
async function servePage(cdp, pageSession, scripts, log, onSwap, reattach, pageState) {
  const mods = [...new Set(scripts.map(s => s.mod))];
  const when = reattach ? 're-attach' : 'attach';
  const name = s => `${s.mod}/${s.path}`;
  let ready = false, last = null;
  const report = (status, detail, at) => {
    if (`${status}|${detail}` === last) return;
    last = `${status}|${detail}`;
    log(`page scripts (${at}): ${status === 'patched' ? `${scripts.length} running` : status.toUpperCase()}${detail ? `: ${detail}` : ''}`);
    onSwap({ bundle: PAGE, status, marker: null, detail, sessionId: pageSession });
  };
  const ran = (loaderId, names) => {
    if (!loaderId) return;
    if (pageState.loaderId !== loaderId) { pageState.loaderId = loaderId; pageState.ran = new Set(); }
    for (const n of names) pageState.ran.add(n);
  };
  const ranHere = (frame, s) => reattach && !!frame.loaderId && pageState.loaderId === frame.loaderId && pageState.ran.has(name(s));
  const mainFrame = async () => (await cdp.send('Page.getFrameTree', {}, pageSession)).frameTree.frame;
  const inWorld = async (frame, mod, expression) => {
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD(mod) }, pageSession);
    return cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true }, pageSession);
  };
  const check = async at => {
    try {
      const frame = await mainFrame();
      // Whether this is the game page is decided here, from DevTools, not from an answer a mod's world gives.
      if (!/\/renderer\/index\.html$/i.test(new URL(frame.url).pathname)) return;
      const failed = [], missing = [], seen = [], trusted = [];
      for (const mod of mods) {
        const mine = scripts.filter(s => s.mod === mod);
        const res = await inWorld(frame, mod, pageCheck(mod, mine.map(s => s.path)));
        // The answer comes from a world mod scripts share: checked before it is trusted.
        const v = JSON.parse(typeof res.result?.value === 'string' ? res.result.value : '"bad"');
        if (!Array.isArray(v) || v.length !== mine.length) throw new Error('unexpected answer from the page');
        v.forEach((r, i) => {
          if (r === true || typeof r === 'string') seen.push(name(mine[i]));
          if (typeof r === 'string') failed.push(`${name(mine[i])} threw: ${clean(r.split('\n')[0])}`);
          else if (r !== true) (ranHere(frame, mine[i]) ? trusted : missing).push(name(mine[i]));
        });
      }
      if (trusted.length) {
        log(`page scripts (${at}): this session cannot see ${trusted.join(', ')}, which ran in this page load before the ` +
          're-attach; counted as running');
      }
      ran(frame.loaderId, seen);
      report(failed.length ? 'broken' : missing.length ? 'original' : 'patched',
        [...failed, ...(missing.length ? [`not run: ${missing.join(', ')}`] : [])].join('; '), at);
    } catch (e) {
      log(`page scripts (${at}): could not check (${clean(e.message)})`);
    }
  };
  cdp.on('Page.loadEventFired', (p, sid) => (sid === pageSession && ready ? check('page load') : undefined));
  // The loader already checked this when it read the mods; checked again here for any other caller, since a script
  // that does not parse inside its function could otherwise run outside the guard.
  for (const s of scripts) {
    try { new Script(wrap(s.text)); } catch (e) {
      return report('broken', `${name(s)} does not parse as a script (${clean(e.message)}); no page script was injected`, when);
    }
  }
  try {
    await cdp.send('Page.enable', {}, pageSession);
    for (const s of scripts) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: pageScriptSource(s), worldName: WORLD(s.mod) }, pageSession);
    }
    const frame = await mainFrame();
    // A throw is recorded by the script's wrapper and read by the check; the evaluation's own result is not used.
    // Recorded once the reply comes: if the connection drops between the run and the reply, a re-attach runs that
    // script again (twice rather than never).
    for (const s of scripts) {
      if (ranHere(frame, s)) continue;
      await inWorld(frame, s.mod, pageScriptSource(s));
      ran(frame.loaderId, [name(s)]);
    }
  } catch (e) {
    report('original', `injection failed: ${clean(e.message)}`, when);
  }
  ready = true;
  await check(when);
}
