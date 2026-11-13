# Classify resident anonymous memory of a live process. Samples up to MAXP resident pages.
import sys, os, struct, random, json, numpy as np, lz4.block, zstandard
pid=int(sys.argv[1]); label=sys.argv[2]; MAXP=16384; random.seed(1)
maps=[]
for l in open(f"/proc/{pid}/maps"):
    p=l.split(); a,b=[int(x,16) for x in p[0].split("-")]
    name=p[5] if len(p)>5 else ""
    maps.append((a,b,p[1],name))
anon=[(a,b) for a,b,perm,name in maps if perm.startswith("rw") and (name=="" or name=="[heap]" or name.startswith("[anon"))]
starts=np.array(sorted(a for a,b,_,_ in maps),dtype=np.uint64); ends=np.array(sorted(b for a,b,_,_ in maps),dtype=np.uint64)
pm=open(f"/proc/{pid}/pagemap","rb"); mem=open(f"/proc/{pid}/mem","rb",buffering=0)
present=[]
for a,b in anon:
    n=(b-a)//4096; pm.seek(a//4096*8); raw=np.frombuffer(pm.read(n*8),dtype=np.uint64)
    idx=np.nonzero(raw>>np.uint64(63))[0]
    present.extend((a+int(i)*4096) for i in idx)
total=len(present); sample=sorted(random.sample(present,min(MAXP,total)))
zc=zstandard.ZstdCompressor(level=1)
cnt=dict(zero=0,pointer=0,int8=0,int16=0,int32=0,text=0,other=0); words=0
lz=0; zs=0; zero_pages=0; pages=0; seen=set(); dup_pages=0
wk=0; # WKdm-like: words whose upper 22 bits match one of 16 recent dictionary words (approximated by upper-bits set)
for addr in sample:
    try: mem.seek(addr); buf=mem.read(4096)
    except OSError: continue
    if len(buf)!=4096: continue
    pages+=1
    if buf.count(0)==4096: zero_pages+=1
    h=hash(buf)
    if h in seen: dup_pages+=1
    seen.add(h)
    lz+=min(4096,len(lz4.block.compress(buf,store_size=False))); zs+=min(4096,len(zc.compress(buf)))
    w=np.frombuffer(buf,dtype=np.uint64); words+=512
    z=w==0; cnt["zero"]+=int(z.sum())
    i=np.searchsorted(starts,w,side="right"); ok=i>0; j=np.where(ok,i-1,0)
    ptr=ok&(w<ends[j])&~z&(w>np.uint64(0xffff)); cnt["pointer"]+=int(ptr.sum())
    rest=~z&~ptr
    cnt["int8"]+=int((rest&(w<256)).sum()); cnt["int16"]+=int((rest&(w>=256)&(w<65536)).sum()); cnt["int32"]+=int((rest&(w>=65536)&(w<2**32)).sum())
    big=rest&(w>=2**32)
    b8=np.frombuffer(buf,dtype=np.uint8).reshape(512,8)
    printable=(((b8>=32)&(b8<127))|(b8==0)|(b8==10)|(b8==9)).all(axis=1)&(((b8>=32)&(b8<127)).sum(axis=1)>=4)
    t=big&printable; cnt["text"]+=int(t.sum()); cnt["other"]+=int((big&~t).sum())
res=dict(label=label,resident_anon_mb=round(total*4096/2**20,1),sampled_pages=pages,
         words_pct={k:round(100*v/words,1) for k,v in cnt.items()},
         zero_pages_pct=round(100*zero_pages/pages,1),dup_pages_pct=round(100*dup_pages/pages,1),
         lz4_page_ratio=round(pages*4096/lz,2),zstd1_page_ratio=round(pages*4096/zs,2))
print(json.dumps(res))
