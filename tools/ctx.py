import re,sys
s=open(sys.argv[1],encoding='utf-8',errors='replace').read()
pat=re.compile(sys.argv[2]); n=int(sys.argv[3]) if len(sys.argv)>3 else 10; w=int(sys.argv[4]) if len(sys.argv)>4 else 150
for k,m in enumerate(pat.finditer(s)):
    if k>=n: break
    print('@',m.start(),':',s[max(0,m.start()-w):m.end()+w].replace('\n',' '),'\n')
