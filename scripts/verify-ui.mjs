import './lib/load-env.mjs';
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1040}});
const page=await context.newPage();const errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await mkdir('evidence',{recursive:true});
  await page.goto(`http://127.0.0.1:${process.env.PORT??4720}`,{waitUntil:'domcontentloaded'});
  await page.getByLabel('Clave de operador').fill(process.env.OPERATOR_TOKEN);
  await page.getByRole('button',{name:'Acceder'}).click();
  await page.locator('#workspace').waitFor({state:'visible'});
  await page.locator('#mode').filter({hasText:/Preparación|Operación habilitada|Simulador WCE/}).waitFor();
  await page.screenshot({path:'evidence/panel-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Conexiones y requisitos'}).click();
  await page.getByRole('heading',{name:'Preparación para operar'}).waitFor();
  await page.screenshot({path:'evidence/panel-connections.png',fullPage:true});
  await page.getByRole('button',{name:'Revisión humana',exact:true}).click();
  await page.getByRole('heading',{name:'El bot continúa; el despacho resuelve las excepciones.'}).waitFor();
  await page.screenshot({path:'evidence/panel-automation.png',fullPage:true});
  await page.getByRole('button',{name:'Expedientes',exact:false}).first().click();
  const first=page.locator('.case-row').first();
  if(await first.count()){await first.click();await page.getByRole('heading',{name:'Continuidad y seguimiento'}).waitFor();await page.screenshot({path:'evidence/panel-case-continuity.png',fullPage:true});await page.locator('#case-dialog').getByRole('button',{name:'Cerrar',exact:true}).click();}
  await page.getByRole('button',{name:'+ Buscar en Kmaleon'}).click();
  await page.locator('#create-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#kmaleon-search-form').evaluate(f=>f.checkValidity()),false);
  await page.locator('#create-dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'evidence/panel-mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'mobile horizontal overflow');
  await page.getByRole('button',{name:'Cerrar sesión'}).click();
  await page.locator('#login').waitFor({state:'visible'});
  assert.deepEqual(errors,[]);
  const report={at:new Date().toISOString(),realBrowser:true,realServer:true,authentication:'PASS',navigation:'PASS',requiredRealCaseFields:'PASS',mobileOverflow:'NONE',pageErrors:errors,businessDataWritten:false,newAutomationUI:'PASS',legalFlows:'NOT_VERIFIED_READ_ONLY_UI_CHECK'};
  await writeFile('evidence/ui-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
