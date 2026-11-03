// Page scripts (mod format 2) as they are injected into the game's main page, shared by the loader's check
// (patcher/mods.mjs, which parses exactly this text) and the runtime (patcher/session.mjs, which sends it). Nothing
// here runs a script.
//
// A mod's page scripts run in an isolated world of their own (WORLD): they share the page's elements with the game, but
// not its JavaScript, so they cannot reach the game's objects, its desktop functions (saves, Workshop, files) or
// another mod's scripts, and the game's code cannot reach them. A script runs only in the top frame of the game's
// main page, and once per page load: a check-and-set on a key in its world. It runs as the body of a function, so its
// top-level declarations stay its own. A throw while it starts is recorded on the key for the loader, then rethrown
// to the page's console.

export const WORLD = mod => `gpml:${mod}`;
export const scriptKey = (mod, path) => `gpml.pageScript:${mod}/${path}`;
// The mod id and script path are checked by patcher/mods.mjs (ids and plain [A-Za-z0-9_.-] segments), so they cannot
// end the comment or the string they are written into.
const sourceUrl = (mod, path) => `gpml/page/${mod}/${path}`;

// The script text inside the function it runs as. The loader's parse check and the injection use this same text.
export const wrap = text => `(function(){${text}\n})`;

export function pageScriptSource({ mod, path, text }) {
  const key = JSON.stringify(scriptKey(mod, path));
  return `if(window.top===window&&/\\/renderer\\/index\\.html$/i.test(location.pathname)&&` +
    `!Object.prototype.hasOwnProperty.call(globalThis,Symbol.for(${key}))){const r={ok:true};` +
    `Object.defineProperty(globalThis,Symbol.for(${key}),{value:r});` +
    `try{${wrap(text)}.call(globalThis)}catch(e){r.ok=false;r.error=String(e&&e.stack||e);throw e}}` +
    `\nvoid 0;\n//# sourceURL=${sourceUrl(mod, path)}`;
}

// Evaluated in a mod's world: null when the document is not the game page (the scripts do not run there), else one
// entry per script: true (ran), the start of its error (threw while starting), or null (did not run).
export function pageCheck(mod, paths) {
  return `JSON.stringify(window.top!==window||!/\\/renderer\\/index\\.html$/i.test(location.pathname)?null:` +
    `${JSON.stringify(paths.map(p => scriptKey(mod, p)))}.map(k=>{const r=globalThis[Symbol.for(k)];` +
    'return r?(r.ok===true?true:String(r.error).slice(0,1000)):null}))';
}
