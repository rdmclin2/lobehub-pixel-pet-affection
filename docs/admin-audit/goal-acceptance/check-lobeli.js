// Cross-check every design.lobe.li rule id cited in the deliverables against the live site bundle.
const fs=require('fs');const [bundle,...docs]=process.argv.slice(2);
const js=fs.readFileSync(bundle,'utf8');
const site=new Set(js.match(/\b[PKWCM]-\d{2}\b/g));
for(const d of docs){const t=fs.readFileSync(d,'utf8');
 const urls=[...t.matchAll(/https:\/\/design\.lobe\.li\/(rules|models)\/([PKWCM]-\d{2})/g)].map(m=>m[2]);
 const cited=new Set(urls);const missing=[...cited].filter(x=>!site.has(x));
 console.log(`${d.split('/').pop()}: design.lobe.li links=${urls.length}, distinct rule ids=${cited.size}, ids not on live site=${missing.length?missing.join(','):'none'}`);}
// titles for a sample of ids, extracted from the bundle near the id literal
for(const id of ['P-02','P-03','P-04','P-05','C-15','C-17','K-05','W-01','W-03','W-04','W-05','W-07','M-02','M-03','M-08']){const m=js.match(new RegExp(`"${id}","series":"[A-Z]","number":"\\d+","title":"([^"]+)"`));console.log(`${id} → ${m?m[1]:'(title not found)'}`);}
