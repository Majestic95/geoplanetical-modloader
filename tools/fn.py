"""Light bundle lookup for running several lookups at once (tools/bq.mjs needs an 8 GB heap each; this needs about 1 GB).

usage: python -I <loader>/tools/fn.py [--build ID] def NAME [maxchars]   source of NAME's definition(s), brace-matched
       python -I <loader>/tools/fn.py [--build ID] refs NAME [max]       occurrences of NAME, enclosing named function
       python -I <loader>/tools/fn.py [--build ID] at OFFSET [width]     text around a UTF-16 offset
       python -I <loader>/tools/fn.py [--build ID] find REGEX [max] [width]
Run from your mod workspace (docs/authoring.md): reads the simulation bundle of the workspace's tools/GAME_BUILD
(or --build) from its .modding/decompiled/app-<build>/renderer/ (GEO_DECOMPILED: the folder holding app-<build>/).
Offsets printed are UTF-16 offsets, the same as tools/bq.mjs. The brace matcher skips string literals but not
regex literals, so cross-check a long `def` with `at`.
"""
import bisect, os, re, sys

ROOT = os.path.abspath(os.environ.get("GPML_WORKSPACE") or os.getcwd())
if sys.argv[1:2] == ["--build"]:
    build = sys.argv[2]
    sys.argv = sys.argv[:1] + sys.argv[3:]
else:
    pin = os.path.join(ROOT, "tools", "GAME_BUILD")
    if not os.path.exists(pin):
        sys.exit(f"fn: no --build and no {pin}")
    build = open(pin, encoding="utf-8").read().strip()
DECOMPILED = os.environ.get("GEO_DECOMPILED") or os.path.join(ROOT, ".modding", "decompiled")
BUNDLE = os.path.join(DECOMPILED, f"app-{build}", "renderer", "simulation-worker.bundle.js")
s = open(BUNDLE, encoding="utf-8", errors="replace").read()
astral = [m.start() for m in re.finditer("[\U00010000-\U0010FFFF]", s)]


def u16(i):
    return i + bisect.bisect_left(astral, i)


def from_u16(o):
    lo, hi = 0, len(s)
    while lo < hi:
        mid = (lo + hi) // 2
        if u16(mid) < o:
            lo = mid + 1
        else:
            hi = mid
    return lo


def match_end(i):
    """From the index of an opening bracket, return the index after its match (skips string literals)."""
    depth, j, n = 0, i, len(s)
    while j < n:
        c = s[j]
        if c in "\"'`":
            q = c
            j += 1
            while j < n and s[j] != q:
                if s[j] == "\\":
                    j += 1
                j += 1
        elif c in "({[":
            depth += 1
        elif c in ")}]":
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    return n


def body_start(st):
    """Index of the bracket that opens the definition's body."""
    m = re.compile(r"function\*?\s*[\w$]*\s*\(").match(s, st)
    if m:
        k = match_end(m.end() - 1)
        return s.index("{", k)
    eq = s.index("=", st)
    k = eq + 1
    while s[k] == " ":
        k += 1
    if s.startswith("Object.freeze(", k):
        return k + len("Object.freeze")
    if s[k] == "(" or re.compile(r"(async\s*)?[\w$]+\s*=>").match(s, k):
        j = match_end(k) if s[k] == "(" else s.index("=>", k)
        a = s.index("=>", j if s[k] == "(" else k) + 2
        return a if s[a] in "{(" else a
    return k


def defs(name):
    e = re.escape(name)
    pats = [rf"function\*?\s*{e}\s*\(", rf"(?<![\w$.]){e}\s*=(?!=)"]
    return sorted({m.start() for p in pats for m in re.finditer(p, s)})


def enclosing(i):
    best = None
    lo = max(0, i - 300000)
    for m in re.finditer(r"function\*?\s*([\w$]+)\s*\(", s[lo:i]):
        best = (m.group(1), lo + m.start())
    return best


cmd = sys.argv[1]
if cmd == "def":
    cap = int(sys.argv[3]) if len(sys.argv) > 3 else 6000
    for st in defs(sys.argv[2]):
        try:
            k = body_start(st)
            end = match_end(k) if s[k] in "{[(" else s.find(",", k)
        except ValueError:
            end = st + cap
        txt = s[st:end]
        print(f"@{u16(st)} ({len(txt)} chars)")
        print(txt[:cap] + (" ...[truncated]" if len(txt) > cap else ""))
        print()
elif cmd == "refs":
    cap = int(sys.argv[3]) if len(sys.argv) > 3 else 40
    for k, m in enumerate(re.finditer(rf"(?<![\w$]){re.escape(sys.argv[2])}(?![\w$])", s)):
        if k >= cap:
            print("...more")
            break
        enc = enclosing(m.start())
        where = f"in {enc[0]}@{u16(enc[1])}" if enc else "top"
        print(f"@{u16(m.start())} {where}: {s[max(0, m.start() - 70):m.end() + 70]}")
elif cmd == "at":
    o = from_u16(int(sys.argv[2]))
    w = int(sys.argv[3]) if len(sys.argv) > 3 else 400
    print(s[max(0, o - w):o + w])
elif cmd == "find":
    cap = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    w = int(sys.argv[4]) if len(sys.argv) > 4 else 120
    for k, m in enumerate(re.finditer(sys.argv[2], s)):
        if k >= cap:
            print("...more")
            break
        print(f"@{u16(m.start())}: {s[max(0, m.start() - w):m.end() + w]}")
        print()
