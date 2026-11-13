const fs=require('fs');
const recs=fs.readFileSync(process.argv[2],'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
global.recs=recs; console.log("ready"); setTimeout(()=>{},600000);
