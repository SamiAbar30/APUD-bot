import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PROVINCES,COMUNIDADES} from '../src/core/geo-normalizer.js';
const url='https://www.ine.es/daco/daco42/codmun/cod_ccaa_provincia.htm';
const r=await fetch(url,{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);
const html=await r.text();
const rows=[...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(row=>[...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(cell=>cell[1]!.replace(/<[^>]+>/g,'').trim())).filter(cells=>cells.length===4&&/^\d{2}$/.test(cells[0]!)&&/^\d{2}$/.test(cells[2]!));
assert.equal(rows.length,PROVINCES.length,'official table shape/count changed');
const codes=new Set<string>();const communities=new Set<string>();
for(const row of rows){const province=PROVINCES.find(p=>p.ineCode===row[2]);assert.ok(province,`Province ${row[2]}`);assert.equal(province.comunidadIneCode,row[0]);codes.add(row[2]!);communities.add(row[0]!);}
assert.equal(codes.size,PROVINCES.length);assert.deepEqual([...communities].sort(),COMUNIDADES.map(c=>c.ineCode).sort());
const report={at:new Date().toISOString(),source:url,sourceSha256:createHash('sha256').update(html).digest('hex'),provinces:codes.size,communities:communities.size,status:'VERIFIED_OFFICIAL_PROVINCE_COMMUNITY_CODE_MAPPING',judicialDistricts:'NOT_VERIFIED_REVIEWED_CATALOG_REQUIRED'};
await mkdir('evidence',{recursive:true});await writeFile('evidence/geography-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
