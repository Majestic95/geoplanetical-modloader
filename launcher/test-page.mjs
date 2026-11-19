// Checks for the launcher window's page (launcher/gui-page.mjs): the rules that keep a mod's text from becoming page
// code (the page's Content-Security-Policy allows its own inline script, so these rules are the barrier), and the
// description cut the window applies (launcher/gui.mjs).
// Usage: node launcher/test-page.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PAGE from './gui-page.mjs';
import { shortText, DESCRIPTION_MAX } from './gui.mjs';

let failed = 0;
const expect = (name, ok, detail = '') => {
  if (ok) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`); }
};

const source = readFileSync(fileURLToPath(new URL('./gui-page.mjs', import.meta.url)), 'utf8');
const template = source.slice(source.indexOf('String.raw`') + 'String.raw`'.length, source.lastIndexOf('`;'));
const BACKTICK = String.fromCharCode(96), DOLLAR_BRACE = '$' + '{';
expect('the raw template holds no backtick and no dollar-brace', !template.includes(BACKTICK) && !template.includes(DOLLAR_BRACE));

const script = PAGE.slice(PAGE.indexOf('<script>') + '<script>'.length, PAGE.lastIndexOf('</script>'));
let compiles = true;
try { new Function(script); } catch (e) { compiles = false; }
expect('the page script compiles', compiles);

// Writing HTML, running text as code, or pointing the page somewhere else: none of it in the page.
const forbidden = [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /srcdoc/,
  /\.(href|src|action)\s*=/, /setAttribute\(\s*['"](href|src|on\w+|style)['"]/, /location\s*=/, /window\.open/];
const found = forbidden.filter(re => re.test(script));
expect('no HTML-writing or code-running APIs in the page script', !found.length, found.map(String).join(', '));

const ids = new Set([...PAGE.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const used = [...new Set([...script.matchAll(/(?:\$|hide)\('([^']+)'\s*[),]/g)].map(m => m[1]))];
const missing = used.filter(i => !ids.has(i));
expect('every element the script looks up exists', !missing.length, missing.join(', '));
const all = [...PAGE.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
const twice = all.filter((v, i) => all.indexOf(v) !== i);
expect('no element id is used twice', !twice.length, twice.join(', '));

// A mod's description as the window shows it.
const rlo = String.fromCharCode(0x202e), ls = String.fromCharCode(0x2028), nul = String.fromCharCode(0);
expect('a description is shown as it is when short and plain', shortText(' Adds a label. ', DESCRIPTION_MAX) === 'Adds a label.');
expect('control and direction characters become spaces', shortText(`a${rlo}b\nc${ls}d${nul}e`, DESCRIPTION_MAX) === 'a b c d e');
const long = shortText('x'.repeat(5000), DESCRIPTION_MAX);
expect('a long description is cut to the limit, with an ellipsis', long.length === DESCRIPTION_MAX && long.endsWith('…'), String(long.length));

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('page: all passed');
