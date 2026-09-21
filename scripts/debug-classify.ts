/** Local classifier probe: no provider, no database, no network. */
import {classifyClientText,allowedConversationOptions} from '../src/core/conversation-policy.js';
import {ApodState} from '@prisma/client';

const cases=Object.values(ApodState).map(state=>({state,hasDigitalCert:null as boolean|null}));
const texts=process.argv.slice(2).length?process.argv.slice(2):[
  'Sí, tengo certificado digital','si tengo certificado','Lo tengo en el ordenador','en el ordenador','Hola buenas','Sí',
];
for(const c of cases){
  const expediente={currentState:c.state,hasDigitalCert:c.hasDigitalCert} as Parameters<typeof classifyClientText>[0];
  console.log(`state=${c.state} hasDigitalCert=${c.hasDigitalCert} options=${allowedConversationOptions(expediente).join(',')}`);
  for(const text of texts)console.log('  ',JSON.stringify(text),'->',JSON.stringify(classifyClientText(expediente,text)));
}
