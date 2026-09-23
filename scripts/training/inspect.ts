import '../../src/config/load-env-file.js';
import {PrismaClient} from '@prisma/client';
const db=new PrismaClient();
for(const c of await db.botApodExpediente.findMany({where:{kmaleonExpedienteId:{startsWith:'train-'}},select:{id:true,telefono:true,currentState:true,automationPaused:true}})){
  const inbox=await db.botApodInbox.findMany({where:{expedienteId:c.id,status:'PENDING'},select:{eventType:true,createdAt:true,notBefore:true}});
  const acts=await db.botApodAccion.findMany({where:{expedienteId:c.id,status:{notIn:['EXECUTED','AWAITING_DELIVERY']}},select:{actionType:true,status:true,lastError:true,createdAt:true,expectedVersion:true}});
  console.log(c.telefono,c.currentState,c.automationPaused,JSON.stringify(inbox),JSON.stringify(acts));
}
await db.$disconnect();
