/** Labels the screenshots embedded in the firm's guide, so training clients send real Sede screens. */
import '../../src/config/load-env-file.js';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {conversationAiFromEnv} from '../../src/config/conversation-ai.js';
import {OpenAIVisionReader,imageMimeFromBytes} from '../../src/adapters/ai/openai-vision.js';
const ai=conversationAiFromEnv();if(ai.status!=='CONFIGURED')throw new Error('AI');
const reader=new OpenAIVisionReader(ai.config);const dir='.runtime/training-media/sede';
const labels:Record<string,{kind:string;description:string}>={};
for(const f of (await readdir(dir)).filter(f=>f.endsWith('.png'))){
  const bytes=await readFile(`${dir}/${f}`);if(bytes.length<15000)continue;
  const seen=await reader.read(bytes,imageMimeFromBytes(bytes)??'image/png');
  if(seen)labels[f]={kind:seen.kind,description:seen.description.slice(0,110)};
}
await writeFile(`${dir}/labels.json`,JSON.stringify(labels,null,1));
for(const [f,l] of Object.entries(labels))console.log(f,l.kind,'|',l.description);
