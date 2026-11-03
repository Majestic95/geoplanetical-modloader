import json, struct, sys, os
p, outdir = sys.argv[1], sys.argv[2]; pats = sys.argv[3:]
with open(p,'rb') as f:
    d = f.read(16)
    base = 8 + struct.unpack('<I', d[4:8])[0]
    hsize = struct.unpack('<I', d[12:16])[0]
    h = json.loads(f.read(hsize).decode('utf-8'))
    def walk(n, path):
        for k,v in n.get('files',{}).items():
            q = path+'/'+k
            if 'files' in v: walk(v,q)
            elif 'offset' in v and any(q.startswith(x) for x in pats):
                f.seek(base+int(v['offset'])); data=f.read(int(v['size']))
                dst=os.path.join(outdir,q.lstrip('/')); os.makedirs(os.path.dirname(dst),exist_ok=True)
                open(dst,'wb').write(data)
    walk(h,'')
