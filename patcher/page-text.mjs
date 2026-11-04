// Which game bundles the loader can deliver, and the rule for the one that is not a worker.
//
// app.bundle.js runs in the game's main page, beside the desktop bridge that writes and deletes saves, so a patch to it
// may change wording and nothing else (mod format 3, docs/mod-format.md): the text of one entry of the game's English
// and French tables. Outside those tables a string cannot be told apart from an internal id or a file name, and code
// could reach the saves. Inside them the values already differ per language, so the game's logic does not rest on them.
// The entries that word the game's saves and save settings, quitting, pause menu, its own mods screens and its
// confirmation buttons stay as they are: changed text there could talk a player into deleting something ("Delete" reading "Back up").
//
// The tables are found by shape and read with a strict literal reader instead of a parser: the reader accepts a subset
// of JavaScript's string and template literals, so where it finds a literal's end the game's own lexer does too. If an
// edit's new text reads as one literal of exactly the rebuilt extent, every token after it is unchanged. Anything not
// recognised fails closed: the mod is refused and names why.

export const PAGE_BUNDLE = 'app.bundle.js';
const WORKER_BUNDLE = /-worker\.bundle\.js$/;

// The bundles a patch can reach: the workers (patcher/session.mjs swaps them as they start) and PAGE_BUNDLE.
export const deliverable = bundle => bundle === PAGE_BUNDLE || WORKER_BUNDLE.test(bundle);

const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '`': '`' };
const LINE_SEPARATOR = 0x2028, PARAGRAPH_SEPARATOR = 0x2029;
const hexValue = hex => (/^[0-9a-fA-F]+$/.test(hex) ? parseInt(hex, 16) : null);

// The escape at text[at] (the character after the backslash): { value, next } or null when outside the subset.
function readEscape(text, at) {
  const c = text[at];
  if (c in SIMPLE_ESCAPES) return { value: SIMPLE_ESCAPES[c], next: at + 1 };
  if (c === '0') return /[0-9]/.test(text[at + 1] ?? '') ? null : { value: '\0', next: at + 1 };
  if (c === 'x' || (c === 'u' && text[at + 1] !== '{')) {
    const digits = c === 'x' ? 2 : 4;
    const code = text.length >= at + 1 + digits ? hexValue(text.slice(at + 1, at + 1 + digits)) : null;
    return code === null ? null : { value: String.fromCharCode(code), next: at + 1 + digits };
  }
  if (c === 'u') {
    const close = text.indexOf('}', at + 2);
    const code = close === -1 ? null : hexValue(text.slice(at + 2, close));
    return code === null || code > 0x10ffff ? null : { value: String.fromCodePoint(code), next: close + 1 };
  }
  return null;
}

// The string or substitution-free template literal starting at text[at]: { value (decoded), end (past the closing
// quote) }, or null when text[at] does not start one this reader accepts.
export function readLiteral(text, at) {
  const quote = text[at];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let value = '';
  for (let i = at + 1; i < text.length;) {
    const c = text[i], code = text.charCodeAt(i);
    if (c === quote) return { value, end: i + 1 };
    if (c === '\r' || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR) return null;
    if (c === '\n' && quote !== '`') return null;
    if (c === '$' && quote === '`' && text[i + 1] === '{') return null;
    if (c === '\\') {
      const e = readEscape(text, i + 1);
      if (!e) return null;
      value += e.value;
      i = e.next;
    } else {
      value += c;
      i++;
    }
  }
  return null;
}

// The value literals of the flat table `name={"key":literal,...}`, as { key, start, end } (offsets with the quotes).
function tableValues(text, name, what) {
  const unrecognised = `${what}: the game's wording tables in ${PAGE_BUNDLE} are not in the shape this loader knows, ` +
    'so the change cannot be checked';
  const heads = [...text.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}=\\{`, 'g'))];
  if (heads.length !== 1) throw new Error(unrecognised);
  const values = [];
  for (let at = heads[0].index + heads[0][0].length; ;) {
    const key = readLiteral(text, at);
    if (!key || text[key.end] !== ':') throw new Error(unrecognised);
    const value = readLiteral(text, key.end + 1);
    if (!value) throw new Error(unrecognised);
    values.push({ key: key.value, start: key.end + 1, end: value.end });
    if (text[value.end] === '}') return values;
    if (text[value.end] !== ',') throw new Error(unrecognised);
    at = value.end + 1;
  }
}

// The entries a wording change may not touch, and the longest new text (the longest entry in the game is about 1,000
// characters; the game's message parser overflows its stack on syntax nested thousands deep).
const HELD_KEYS = /^((saves|settings\.saves|quit|mods|modal|pause)\.|menu\.quit$)/;
const MAX_TEXT = 4096;

// Why this decoded text may not go into the game's page, or null. On the decoded text, since "\x3cimg" is a "<" too.
// The game writes table text into its HTML and into double-quoted attributes, so markup or a quote that ends the
// attribute would take effect. Every "<" is refused, not only one that starts a tag: the game's message syntax expands
// `{...}` after this check, so "<{x,select,other{img}}>" becomes a tag. That syntax only joins text, so it cannot make
// a "<" or a '"' that is not here. Entities are refused as text the game may decode and write back as HTML (the bare
// forms too, which HTML decodes without a semicolon; "R&D" is fine), and so is a "&" that a brace may join to the rest
// of one ("&{x}lt;", "{x,select,other{&}}lt;"). "${" is refused as code-shaped text.
export function wordingProblem(value) {
  if (value.length > MAX_TEXT) return `more than ${MAX_TEXT} characters`;
  if (value.includes('<')) return 'a "<"';
  if (/&(#|[a-z0-9]+;|lt|gt|quot|amp|[a-z0-9#]*[{}])/i.test(value)) return 'an HTML entity';
  if (value.includes('${')) return '"${"';
  if (value.includes('"')) return 'a double quote (use typographic quotes instead)';
  return null;
}

// The largest index in the sorted `values` whose start is at or before `at`, or -1.
function valueAt(values, at) {
  let lo = 0, hi = values.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid].start <= at) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// A guard over the bundle's original text. check(text, at, edit, what) is called for each edit in the order applied,
// with the text before that edit and the edit's offset; it throws a message starting with `what` unless the edit is a
// wording change, keeps its offsets in step with the text, and returns the entry's key (null for an edit that changes
// nothing). It only holds while every edit to this text goes through it.
export function wordingGuard(original, what) {
  const tables = [...original.matchAll(/(?<![\w$.])[\w$]+=\{fr:([\w$]+),en:([\w$]+)\}/g)];
  if (tables.length !== 1) {
    throw new Error(`${what}: the game's wording tables in ${PAGE_BUNDLE} are not in the shape this loader knows, so the change cannot be checked`);
  }
  const values = [...tableValues(original, tables[0][1], what), ...tableValues(original, tables[0][2], what)]
    .sort((a, b) => a.start - b.start);
  return {
    check(text, at, { find, replace }, where) {
      if (find === replace) return null;
      let same = 0;
      while (same < find.length && same < replace.length && find[same] === replace[same]) same++;
      let tail = 0;
      while (tail < find.length - same && tail < replace.length - same &&
        find[find.length - 1 - tail] === replace[replace.length - 1 - tail]) tail++;
      const from = at + same, to = at + find.length - tail;
      const index = valueAt(values, from);
      const entry = values[index];
      // Strictly between the quotes: an edit that moves a quote, or reaches past one, changes code.
      if (!entry || from <= entry.start || to >= entry.end) {
        throw new Error(`${where}: a patch to ${PAGE_BUNDLE} can only change the text of one entry of the game's English ` +
          'and French wording tables, and this edit changes something else (code, an entry\'s key, a new entry, or more than one entry)');
      }
      if (HELD_KEYS.test(entry.key)) {
        throw new Error(`${where}: the entry "${entry.key}" cannot be changed: the wording of the game's saves and save settings, quitting, pause menu, mods screens and confirmation buttons stays the game's own`);
      }
      const rebuilt = text.slice(entry.start, from) + replace.slice(same, replace.length - tail) + text.slice(to, entry.end);
      const read = readLiteral(rebuilt, 0);
      if (!read || read.end !== rebuilt.length) {
        throw new Error(`${where}: the new text is not plain quoted text (it ends the game's quotes early, or uses an escape this loader does not read)`);
      }
      const problem = wordingProblem(read.value);
      if (problem) throw new Error(`${where}: the new text of a wording entry may not contain ${problem}`);
      const delta = rebuilt.length - (entry.end - entry.start);
      entry.end += delta;
      for (let i = index + 1; i < values.length; i++) { values[i].start += delta; values[i].end += delta; }
      return entry.key;
    },
  };
}
