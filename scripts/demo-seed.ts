import './lib/load-env.mjs';
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/config/env.js';
import { DEMO_FIXTURE_SOURCE, DEMO_PHONE_NUMBER, demoFixture } from '../src/demo/demo-fixture.js';

const env=loadEnv();
if(!env.DEMO_DATA_ENABLED)throw new Error('DEMO_DATA_DISABLED');
if(!env.DEMO_WHATSAPP_RECIPIENTS.includes(DEMO_PHONE_NUMBER))throw new Error('DEMO_PHONE_NOT_ALLOWLISTED');
const fixture=demoFixture(DEMO_PHONE_NUMBER);
const db=new PrismaClient({log:[]});
try{
  await db.$connect();
  const matches=await db.botApodExpediente.findMany({where:{OR:[{telefono:fixture.telefono},{dni:fixture.dni},{kmaleonExpedienteId:fixture.kmaleonExpedienteId}]},take:5});
  if(matches.length>1)throw new Error('DEMO_FIXTURE_CONFLICT');
  const existing=matches[0];
  let row;
  let created=false;
  if(existing){
    if(existing.source!==DEMO_FIXTURE_SOURCE||existing.dni!==fixture.dni||existing.nombre!==fixture.nombre||existing.telefono!==fixture.telefono||existing.kmaleonExpedienteId!==fixture.kmaleonExpedienteId)throw new Error('DEMO_FIXTURE_CONFLICT');
    row=existing;
  }else{
    created=true;
    row=await db.$transaction(async tx=>{
      const createdRow=await tx.botApodExpediente.create({data:{...fixture,identityVerified:true}});
      await tx.botApodAuditLog.create({data:{expedienteId:createdRow.id,event:'DEMO_FIXTURE_SEEDED',operator:'DEMO_SETUP',metadata:{source:DEMO_FIXTURE_SOURCE,fixtureVersion:1}}});
      return createdRow;
    });
  }
  console.log(JSON.stringify({result:'PASS',created,source:row.source,caseId:row.id,fixtureCount:await db.botApodExpediente.count({where:{source:DEMO_FIXTURE_SOURCE}}),externalProviderCalls:0,secretValuesPrinted:false}));
}finally{await db.$disconnect();}
