// Bundles the game runs outside its window. From game 1.0.9 on, the simulation and its helper workers run in a Node
// process the game forks for each game session, loaded with require() from resources\app.asar.unpacked\renderer;
// the loader's DevTools connection cannot reach them. So for the loader's own frozen copy (never the Steam install),
// the patched text is written over the copy's file before the game starts, the original kept beside it, and the
// original is put back once the game has closed (settleCopy, which also repairs a copy left changed by a crash or a
// loader closed during play). At rest the copy is the pinned build, so its check (patcher/frozen.mjs checkFolder) is
// the same as before and a program handed the copy (--game) gets the pinned build.
//
// Code written this way runs inside the game with Node's access to the PC: the same as any program. The player is told
// so (launcher/core.mjs, the window).
//
// Confirmation: the written text is wrapped in a prelude and a postlude that each append one line to the loader's notes
// file, `{"gpml":<session nonce>,"bundle":<name>,"at":"start"|"end"}`, through Node's fs, and do nothing else: they
// never throw into the game, and do nothing where `require` is missing (a page worker). The file the game loads is the
// loader's, so the game's own code cannot run instead of it: a bundle with no note did not start (the game closed before
// it needed it), a "start" without its "end" threw while loading, and an "exit" note (see noteWrap) means it stopped
// with an error later. The notes file is read as untrusted text: code in those bundles can write anything there.
import { readFileSync, writeFileSync, renameSync, rmSync, readdirSync, lstatSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { gameRunning, asarEntry, matchesEntry } from './game.mjs';

export const RENDERER_OUTSIDE = ['resources', 'app.asar.unpacked', 'renderer'];
export const ORIGINAL = '.gpml-original';
export const NEW = '.gpml-new';
const BUNDLE = /^[a-z0-9-]+\.bundle\.js$/;
const sha256 = b => createHash('sha256').update(b).digest('hex');
const coded = (message, code) => Object.assign(new Error(message), { code });

// A rename Windows refuses for a moment (an antivirus scan of a file just written) is tried again a few times.
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function patiently(step) {
  for (let i = 0; ; i++) {
    try { return step(); } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      pause(200 * (i + 1));
    }
  }
}

// The loader's files left in the copy's renderer folder (an original kept aside, a new file not yet in place).
export function leftInCopy(dir) {
  let names;
  try { names = readdirSync(join(dir, ...RENDERER_OUTSIDE)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter(n => (n.endsWith(ORIGINAL) && BUNDLE.test(n.slice(0, -ORIGINAL.length))) ||
    (n.endsWith(NEW) && BUNDLE.test(n.slice(0, -NEW.length))));
}

// Puts the copy back to the game's own files: each original kept aside goes back in place when it matches the copy's
// archive index (its size and SHA-256); a new file not yet in place is removed. Never while Geoplanetical runs (one of
// its processes may load the file at any time). Returns { state: 'clean' | 'restored' | 'in-use', restored, refused }:
// refused lists the originals that did not match and were left where they are (the copy's check then says a file is
// changed: the player gets the copy again). Throws on a file error (with its code).
export function settleCopy(dir, { inUse = gameRunning, log = () => {} } = {}) {
  const left = leftInCopy(dir);
  if (!left.length) return { state: 'clean', restored: [], refused: [] };
  if (inUse()) return { state: 'in-use', restored: [], refused: [] };
  const folder = join(dir, ...RENDERER_OUTSIDE), asar = join(dir, 'resources', 'app.asar');
  const restored = [], refused = [];
  for (const n of left.filter(x => x.endsWith(NEW))) patiently(() => rmSync(join(folder, n), { force: true }));
  for (const n of left.filter(x => x.endsWith(ORIGINAL))) {
    const bundle = n.slice(0, -ORIGINAL.length), kept = join(folder, n);
    const entry = asarEntry(asar, `renderer/${bundle}`);
    const st = lstatSync(kept);
    if (!entry?.unpacked || !st.isFile() || st.size !== Number(entry.size) || !matchesEntry(readFileSync(kept), entry, true)) {
      log(`the frozen game's ${bundle} kept aside by the loader does not match the game's own record of it; left as it is`);
      refused.push(bundle);
      continue;
    }
    patiently(() => renameSync(kept, join(folder, bundle)));
    restored.push(bundle);
  }
  if (restored.length) log(`the frozen game's own ${restored.join(', ')} put back in place`);
  return { state: 'restored', restored, refused };
}

// Writes the patched text of each bundle (Map name -> text) over the copy's file, keeping the original beside it, in
// an order every interruption of which settleCopy repairs: the new text goes to <name>.gpml-new and is read back, the
// original is renamed to <name>.gpml-original, the new file to <name>. `dir` is the copy as checkFolder has just passed
// it (the game not running, nothing left by the loader). Returns Map name -> SHA-256 of the bytes written. On failure
// the copy is put back (unless the game runs by then) and the error thrown (with its code).
export function writeBundles(dir, texts, { inUse = gameRunning } = {}) {
  const folder = join(dir, ...RENDERER_OUTSIDE);
  const written = new Map();
  try {
    if (leftInCopy(dir).length) throw coded('the frozen game still holds files the loader changed', 'EEXIST');
    for (const [bundle, text] of texts) {
      if (!BUNDLE.test(bundle)) throw coded(`${bundle} is not a bundle name`, 'EINVAL');
      const target = join(folder, bundle);
      if (!lstatSync(target).isFile()) throw coded(`${bundle} is not a file in the frozen game`, 'EINVAL');
      const bytes = Buffer.from(text, 'utf8'), sum = sha256(bytes);
      writeFileSync(target + NEW, bytes, { flag: 'wx' });
      if (sha256(readFileSync(target + NEW)) !== sum) throw coded(`${bundle} reads back differently after it was written`, 'EIO');
      patiently(() => renameSync(target, target + ORIGINAL));
      patiently(() => renameSync(target + NEW, target));
      written.set(bundle, sum);
    }
  } catch (e) {
    // (not if the game has started meanwhile: then the next settle, once it has closed, puts it back)
    try { settleCopy(dir, { inUse }); } catch { /* the copy's check reports what is left */ }
    throw e;
  }
  return written;
}

// After the session: which written files are no longer what was written (`written`: writeBundles' result), then the
// copy put back (settleCopy). { changed, ...settleCopy's result }.
export function restoreBundles(dir, written, options) {
  const folder = join(dir, ...RENDERER_OUTSIDE);
  const changed = [];
  for (const [bundle, sum] of written) {
    let now = null;
    try { now = sha256(readFileSync(join(folder, bundle))); } catch { /* gone: changed */ }
    if (now !== sum) changed.push(bundle);
  }
  return { changed, ...settleCopy(dir, options) };
}

export const newNonce = () => randomBytes(16).toString('hex');

// The text written for `bundle`: its patched text between the two notes (the patched text itself is unchanged, byte
// for byte). `file`: the loader's notes file; `nonce`: this session's.
// The prelude also leaves an "exit" note if the thread the bundle runs in ends by itself with an error code: an error
// the code threw later (the 1.1.0 simulation finishes starting after an await). The game ends these threads only from
// outside (Worker.terminate, or its whole process closing), which runs no exit handler. The listener only appends.
export function noteWrap(text, { file, nonce, bundle }) {
  const line = at => JSON.stringify(`${JSON.stringify({ gpml: nonce, bundle, at })}\n`);
  const f = JSON.stringify(file);
  const start = ';(()=>{try{if(typeof require==="function"){const fs=require("node:fs");' +
    `fs.appendFileSync(${f},${line('start')});` +
    'if(typeof process==="object"&&process&&typeof process.on==="function")' +
    `process.on("exit",c=>{if(c){try{fs.appendFileSync(${f},${line('exit')})}catch(e){}}})}}catch(e){}})();\n`;
  const end = `;(()=>{try{if(typeof require==="function")require("node:fs").appendFileSync(${f},${line('end')})}catch(e){}})();\n`;
  return `${start}${text}\n${end}`;
}

const NOTES_MAX = 8 * 1024 * 1024;
// The notes of this session: Map bundle -> { start, end, exit } (counts), for the bundles in `bundles`. Lines of
// another session, of another bundle, or not notes at all are left out; only the start of the file is read.
export function readNotes(file, nonce, bundles) {
  const counts = new Map([...bundles].map(b => [b, { start: 0, end: 0, exit: 0 }]));
  let text = '';
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(fstatSync(fd).size, NOTES_MAX));
      text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    } finally { closeSync(fd); }
  } catch { return counts; }
  const ours = `{"gpml":${JSON.stringify(nonce)},`;
  for (const line of text.split('\n')) {
    // (anything else is skipped before it is parsed: junk lines cost nothing)
    if (!line.startsWith(ours) || line.length > 300) continue;
    let v;
    try { v = JSON.parse(line); } catch { continue; }
    if (!v || typeof v !== 'object' || v.gpml !== nonce || typeof v.bundle !== 'string' || !counts.has(v.bundle)) continue;
    if (v.at === 'start' || v.at === 'end' || v.at === 'exit') counts.get(v.bundle)[v.at]++;
  }
  return counts;
}

// What the notes say, as a session goes: poll(counts, now) returns the bundles whose state changed, [{ bundle, status,
// detail }]: patched (it started and finished loading; once), broken (a thread running it ended by itself, which the
// game's own threads never do: an error; or a start without its end for `stuckMs`: it threw while loading; once).
// end(counts) returns the final word on each bundle: patched, broken, or idle (never started).
export const STOPPED = 'the code stopped with an error while the game ran (the game shows its own message about it); ' +
  'with mods in it, a mod is the likely cause';
export function noteJudge(bundles, { stuckMs = 60000 } = {}) {
  const st = new Map([...bundles].map(b => [b, { patched: false, broken: false, since: 0 }]));
  return {
    poll(counts, now = Date.now()) {
      const out = [];
      for (const [bundle, s] of st) {
        const c = counts.get(bundle);
        if (!c) continue;
        if (c.end > 0 && !s.patched) { s.patched = true; out.push({ bundle, status: 'patched', detail: '' }); }
        if (c.exit > 0 && !s.broken) { s.broken = true; out.push({ bundle, status: 'broken', detail: STOPPED }); }
        if (c.start > c.end) {
          s.since ||= now;
          if (!s.broken && now - s.since >= stuckMs) {
            s.broken = true;
            out.push({ bundle, status: 'broken', detail: 'the patched code threw while starting (it started but never finished loading)' });
          }
        } else s.since = 0;
      }
      return out;
    },
    end(counts) {
      return [...st.keys()].map(bundle => {
        const c = counts.get(bundle) ?? { start: 0, end: 0, exit: 0 }, s = st.get(bundle);
        // (a load still under way when the game closed is not a failure once that bundle has loaded before)
        if (s.broken || c.exit > 0 || (c.start > c.end && c.end === 0)) {
          return { bundle, status: 'broken', reported: s.broken, detail: c.exit > 0 ? STOPPED : 'the patched code started but never finished loading' };
        }
        return { bundle, status: c.end > 0 ? 'patched' : 'idle', reported: s.patched };
      });
    },
  };
}
