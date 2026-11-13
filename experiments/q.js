const fs=require('fs');const recs=fs.readFileSync(process.argv[2],'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
function med(f){const ts=[];let r;for(let i=0;i<9;i++){const t=process.hrtime.bigint();r=f();ts.push(Number(process.hrtime.bigint()-t)/1e6)}ts.sort((a,b)=>a-b);return [ts[4],r]}
console.log("node Q1",med(()=>{let s=0;for(const r of recs)if(r.status===404)s+=r.bytes;return s}));
console.log("node Q3",med(()=>{let s=0;for(const r of recs)if(r.ua.includes("curl"))s++;return s}));
console.log("node Q7",med(()=>{let s=0;for(const r of recs)s+=r.latency_us;return s}));
