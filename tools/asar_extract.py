"""Copy files out of an Electron app.asar archive.

Usage: python -I asar_extract.py <app.asar> <output folder> <prefix> [<prefix> ...]

Every file whose archive path starts with one of the prefixes (for example /renderer/simulation-worker.bundle.js or
/renderer/runtime-data) is written under the output folder at the same path. Files the archive keeps outside itself
(index entries marked "unpacked", stored in <app.asar>.unpacked) are copied from there after checking their size and,
when the index records one, their SHA-256; a file that differs from the index is refused. The archive is only read.
"""
import hashlib, json, os, struct, sys, tempfile

CHUNK = 1 << 20
# Names Windows treats as devices whatever the extension, so writing to them would not create a file.
DEVICES = {'con', 'prn', 'aux', 'nul', 'conin$', 'conout$'} | {f'{d}{n}' for d in ('com', 'lpt') for n in '123456789¹²³'}


class Refused(Exception):
    pass


def parts_of(path):
    """Split an archive path into folder names, refusing any that could leave the output folder or not be a file."""
    parts = path.lstrip('/').split('/')
    for part in parts:
        if (part in ('', '.', '..') or '\\' in part or ':' in part or part[-1] in '. '
                or part.split('.')[0].rstrip(' ').lower() in DEVICES):
            raise Refused(f'unsafe path in the archive index: {path!r}')
    return parts


def remove(path):
    if os.path.lexists(path):
        os.remove(path)


def copy_unpacked(asar, path, entry, dst):
    """Copy one unpacked file, refusing it when it does not match the index. Returns (problem, warning).

    The SHA-256 is taken over the bytes as they are written, so the file kept is the file checked. A refused file
    leaves nothing at dst, not even an older extraction of it."""
    src = os.path.join(asar + '.unpacked', *parts_of(path))
    if not os.path.isfile(src):
        remove(dst)
        return f'{path}: marked unpacked but {src} is missing', None
    integrity = entry.get('integrity') or {}
    want = str(integrity.get('hash', '')).lower() if str(integrity.get('algorithm', '')).upper() == 'SHA256' else None
    warning = None if want else f'{path}: the index has no SHA-256 for it; only its size was checked'
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    # A fresh temporary name (created exclusively), so it can never be another file the run writes.
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dst), prefix='.asar-extract-')
    h, size = hashlib.sha256(), 0
    try:
        with open(src, 'rb') as i, os.fdopen(fd, 'wb') as o:
            for block in iter(lambda: i.read(CHUNK), b''):
                h.update(block)
                size += len(block)
                o.write(block)
        problem = None
        if size != int(entry['size']):
            problem = f'{path}: {src} is {size} bytes, the index says {entry["size"]}'
        elif want and h.hexdigest() != want:
            problem = f'{path}: SHA-256 of {src} is {h.hexdigest()}, the index says {integrity.get("hash")}'
        if problem:
            remove(dst)
            return problem, None
        os.replace(tmp, dst)
        return None, warning
    finally:
        remove(tmp)


def main(argv):
    if len(argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    asar, outdir, prefixes = argv[0], argv[1], argv[2:]
    packed = unpacked = 0
    problems = []
    with open(asar, 'rb') as f:
        head = f.read(16)
        base = 8 + struct.unpack('<I', head[4:8])[0]
        header_size = struct.unpack('<I', head[12:16])[0]
        index = json.loads(f.read(header_size).decode('utf-8'))

        # Collect every match first so an unsafe path in the index refuses the run before anything is written.
        matches = []
        matched = set()

        def walk(node, path):
            for name, entry in node.get('files', {}).items():
                q = path + '/' + name
                if 'files' in entry:
                    walk(entry, q)
                elif 'offset' in entry or entry.get('unpacked'):
                    hits = [x for x in prefixes if q.startswith(x)]
                    if hits:
                        matched.update(hits)
                        matches.append((q, entry, os.path.join(outdir, *parts_of(q))))

        walk(index, '')
        unmatched = [x for x in prefixes if x not in matched]
        if unmatched:
            raise Refused('no file in the archive starts with ' + ', '.join(unmatched))
        for q, entry, dst in matches:
            if 'offset' in entry:
                f.seek(base + int(entry['offset']))
                data = f.read(int(entry['size']))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                with open(dst, 'wb') as out:
                    out.write(data)
                packed += 1
            else:
                problem, warning = copy_unpacked(asar, q, entry, dst)
                if warning:
                    print('warning: ' + warning, file=sys.stderr)
                if problem:
                    problems.append(problem)
                else:
                    unpacked += 1
    for problem in problems:
        print('refused: ' + problem, file=sys.stderr)
    print(f'extracted {packed + unpacked} files ({packed} from the archive, {unpacked} from {os.path.basename(asar)}.unpacked)')
    return 1 if problems else 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except Refused as e:
        print('refused: ' + str(e), file=sys.stderr)
        sys.exit(1)
