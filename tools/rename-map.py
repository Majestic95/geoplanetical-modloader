# Port helper: finds what each minified game name used by the patches is called in a new game build. For each name,
# its definition in the old bundle ("function NAME(", "NAME=", "class NAME") and the code that follows become a
# pattern in which other short identifiers are wildcards (keywords, property names after a dot and string literals
# stay fixed); the pattern grows until it matches exactly once in the new bundle.
# Usage: python -I tools/rename-map.py <old bundle> <new bundle> NAME [NAME ...]
import re, sys

KEYWORDS = set('function return let const var if else for while do new this typeof instanceof in of try catch finally '
               'throw switch case default break continue async await class extends super null true false void delete '
               'yield static get set'.split())
TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|\s+|.', re.S)
IDENT = r'[A-Za-z_$][\w$]{0,4}'


def pattern(text):
    out, prev = [], ''
    for t in TOKEN.findall(text):
        if re.fullmatch(r'[A-Za-z_$][\w$]*', t) and t not in KEYWORDS and prev != '.' and len(t) <= 4:
            out.append(IDENT)
        else:
            out.append(re.escape(t))
        if not t.isspace():
            prev = t
    return ''.join(out)


def definition(src, name):
    for p in (r'function ' + re.escape(name) + r'\(', r'(?<![\w$.])' + re.escape(name) + r'=(?!=)',
              r'class ' + re.escape(name) + r'\b'):
        hits = [m.start() for m in re.finditer(p, src)]
        if len(hits) == 1:
            return hits[0], p
    return None, None


def main():
    old = open(sys.argv[1], encoding='utf-8').read()
    new = open(sys.argv[2], encoding='utf-8').read()
    for name in sys.argv[3:]:
        at, how = definition(old, name)
        if at is None:
            print(f'{name}: no single definition in the old bundle')
            continue
        found, count = None, 0
        for length in (60, 120, 240, 480, 960):
            rx = re.compile(pattern(old[at:at + len(name) + 40 + length]))
            hits = list(rx.finditer(new))
            count = len(hits)
            if count == 1:
                found = hits[0]
                break
            if not hits:
                break
        if not found:
            print(f'{name}: not found uniquely ({count} matches)')
            continue
        m = re.match(how.replace(re.escape(name), r'([A-Za-z_$][\w$]*)'), new[found.start():found.start() + len(name) + 20])
        print(f'{name} -> {m.group(1) if m else "?"} @ {found.start()}')


main()
