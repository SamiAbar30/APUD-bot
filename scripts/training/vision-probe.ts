import '../../src/config/load-env-file.js';
import {readFile} from 'node:fs/promises';
const img=(await readFile(process.argv[2]!)).toString('base64');
const t=Date.now();
const r=await fetch(`${process.env.AI_BASE_URL}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.AI_API_KEY}`},body:JSON.stringify({model:process.env.AI_MODEL,response_format:{type:'json_object'},messages:[{role:'system',content:'Devuelve SOLO JSON {"que_es":"...","texto_visible":"..."}'},{role:'user',content:[{type:'text',text:'¿Qué muestra esta imagen?'},{type:'image_url',image_url:{url:`data:image/png;base64,${img}`}}]}]})});
console.log(r.status,Date.now()-t,'ms',(await r.text()).slice(0,600));
