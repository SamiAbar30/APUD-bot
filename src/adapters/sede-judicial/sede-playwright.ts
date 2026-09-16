import {chromium,type Browser,type BrowserContext,type Page} from 'playwright';
import {Agent,request} from 'undici';
import {AdapterError,checkedHttpsUrl,requireValue,sha256} from '../common/http.js';
export type DraftStep={kind:'fill';selector:string;field:string}|{kind:'select';selector:string;field:string}|{kind:'check';selector:string}|{kind:'click';selector:string}|{kind:'wait';selector:string};
export interface SedeDraftRecipe {
  id:string;reviewEvidenceRef:string;reviewedDraftOnly:true;officialOrigins:string[];startUrl:string;
  /** Each network endpoint must have been reviewed as authentication, read or draft-only. */
  allowedRequests:Array<{origin:string;pathname:string;method:'GET'|'POST';purpose:'authentication'|'read'|'draft'}>;
  steps:DraftStep[];identitySelector:string;draftReadySelector:string;draftPdfLinkSelector:string;
}
export interface SedeOptions {recipe:SedeDraftRecipe;writesEnabled?:boolean;timeoutMs?:number;maxPdfBytes?:number}
export interface SedeDraftInput {
  clientId:string;expectedDni:string;
  consent:{granted:true;clientId:string;dni:string;scope:'SEDE_DRAFT_ONLY';expiresAt:string;evidenceRef:string};
  certificate:{pfx:Buffer;passphrase:string};
  fields:Record<string,string>;
}
const normalizeDni=(dni:string)=>dni.toUpperCase().replace(/[\s.-]/g,'');
function officialOrigin(origin:string):boolean{
  try{const url=checkedHttpsUrl(origin);return url.origin===origin&&!url.port&&(url.hostname==='justicia.gob.es'||url.hostname.endsWith('.justicia.gob.es')||url.hostname==='administracion.gob.es'||url.hostname.endsWith('.administracion.gob.es'));}catch{return false;}
}
export class SedePlaywright {
  constructor(private readonly options:SedeOptions){
    const r=options.recipe;requireValue(r.id,'SEDE_RECIPE_ID');requireValue(r.reviewEvidenceRef,'SEDE_RECIPE_REVIEW');
    if(r.reviewedDraftOnly!==true||r.officialOrigins.length===0||r.officialOrigins.some(o=>!officialOrigin(o)))throw new AdapterError('SEDE_RECIPE_NOT_REVIEWED');
    checkedHttpsUrl(r.startUrl,r.officialOrigins);
    if(r.steps.length>100||r.allowedRequests.length===0||r.allowedRequests.some(p=>!r.officialOrigins.includes(p.origin)||!p.pathname.startsWith('/')||/[?*#]/.test(p.pathname)||!['GET','POST'].includes(p.method)))throw new AdapterError('SEDE_RECIPE_NETWORK_POLICY_INVALID');
    // Real selectors and endpoint effects require human review; no live selectors ship with this adapter.
    if(!r.identitySelector||!r.draftReadySelector||!r.draftPdfLinkSelector)throw new AdapterError('SEDE_RECIPE_SELECTORS_MISSING');
  }
  private allowed(url:URL,method:string):boolean{return this.options.recipe.allowedRequests.some(r=>r.origin===url.origin&&r.pathname===url.pathname&&r.method===method);}
  private async step(page:Page,step:DraftStep,fields:Record<string,string>):Promise<void>{
    const locator=page.locator(step.selector);if(await locator.count()!==1)throw new AdapterError('SEDE_SELECTOR_NOT_UNIQUE');
    if(step.kind==='fill'||step.kind==='select'){
      const value=fields[step.field];if(typeof value!=='string'||value.length>2000)throw new AdapterError('SEDE_FIELD_REQUIRED');
      if(step.kind==='fill')await locator.fill(value);else await locator.selectOption(value);
    }else if(step.kind==='check')await locator.check();else if(step.kind==='click')await locator.click();else await locator.waitFor({state:'visible'});
  }
  private async pdf(context:BrowserContext,url:URL,pfx:Buffer,passphrase:string):Promise<Buffer>{
    if(!this.allowed(url,'GET'))throw new AdapterError('SEDE_PDF_ENDPOINT_NOT_REVIEWED');
    const agent=new Agent({connect:{pfx,passphrase,rejectUnauthorized:true}});
    const cookies=await context.cookies(url.href);
    try{
      const result=await request(url,{method:'GET',dispatcher:agent,signal:AbortSignal.timeout(30_000),headers:{Accept:'application/pdf',Cookie:cookies.map(c=>`${c.name}=${c.value}`).join('; ')}});
      const max=this.options.maxPdfBytes??20*1024*1024;
      if(result.statusCode!==200||!String(result.headers['content-type']??'').toLowerCase().startsWith('application/pdf')||Number(result.headers['content-length'])>max){result.body.destroy();throw new AdapterError('SEDE_DRAFT_PDF_RESPONSE_INVALID');}
      const chunks:Buffer[]=[];let count=0;
      try{for await(const chunk of result.body){const b=Buffer.from(chunk);count+=b.length;if(count>max)throw new AdapterError('SEDE_DRAFT_PDF_TOO_LARGE');chunks.push(b);}}
      finally{result.body.destroy();}
      const content=Buffer.concat(chunks,count);if(content.subarray(0,5).toString()!=='%PDF-')throw new AdapterError('SEDE_DRAFT_PDF_INVALID');return content;
    }finally{await agent.close();}
  }
  async prepareDraft(input:SedeDraftInput):Promise<{status:'DRAFT_REQUIRES_HUMAN_SUBMISSION';pdf:Buffer;sha256:string;recipeId:string}>{
    if(!this.options.writesEnabled)throw new AdapterError('SEDE_DRAFT_AUTOMATION_DISABLED');
    const c=input.consent;
    if(c.granted!==true||c.clientId!==input.clientId||normalizeDni(c.dni)!==normalizeDni(input.expectedDni)||c.scope!=='SEDE_DRAFT_ONLY'||!c.evidenceRef||!Number.isFinite(Date.parse(c.expiresAt))||Date.parse(c.expiresAt)<=Date.now())throw new AdapterError('SEDE_EXPLICIT_SCOPED_CONSENT_REQUIRED');
    if(input.certificate.pfx.length===0||input.certificate.pfx.length>1024*1024)throw new AdapterError('SEDE_CERTIFICATE_INVALID');
    const pfx=Buffer.from(input.certificate.pfx);let browser:Browser|undefined;let deadline:ReturnType<typeof setTimeout>|undefined;
    try{
      browser=await chromium.launch({headless:true});
      const context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block',clientCertificates:this.options.recipe.officialOrigins.map(origin=>({origin,pfx,passphrase:input.certificate.passphrase})),locale:'es-ES',timezoneId:'Europe/Madrid'});
      deadline=setTimeout(()=>{void context.close().catch(()=>undefined);},Math.min(this.options.timeoutMs??180_000,300_000));
      context.setDefaultTimeout(15_000);
      let forbidden=false;
      await context.routeWebSocket('**/*',socket=>{forbidden=true;socket.close();});
      await context.route('**/*',async route=>{try{const req=route.request();const url=checkedHttpsUrl(req.url(),this.options.recipe.officialOrigins);if(Date.parse(c.expiresAt)<=Date.now()||!this.allowed(url,req.method())){forbidden=true;await route.abort('blockedbyclient');}else await route.continue();}catch{forbidden=true;await route.abort('blockedbyclient');}});
      const page=await context.newPage();await page.goto(this.options.recipe.startUrl,{waitUntil:'domcontentloaded'});
      const initialIdentity=page.locator(this.options.recipe.identitySelector);await initialIdentity.waitFor({state:'visible'});
      const initialIds=(await initialIdentity.innerText()).toUpperCase().match(/(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z])/g)??[];
      if(await initialIdentity.count()!==1||initialIds.length!==1||initialIds[0]!==normalizeDni(input.expectedDni))throw new AdapterError('SEDE_SESSION_IDENTITY_MISMATCH');
      for(const step of this.options.recipe.steps){if(forbidden)throw new AdapterError('SEDE_UNREVIEWED_NETWORK_REQUEST');await this.step(page,step,input.fields);}
      if(forbidden)throw new AdapterError('SEDE_UNREVIEWED_NETWORK_REQUEST');
      const identity=page.locator(this.options.recipe.identitySelector);if(await identity.count()!==1)throw new AdapterError('SEDE_IDENTITY_SELECTOR_AMBIGUOUS');
      const identities=(await identity.innerText()).toUpperCase().match(/(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z])/g)??[];
      if(identities.length!==1||identities[0]!==normalizeDni(input.expectedDni))throw new AdapterError('SEDE_DRAFT_IDENTITY_MISMATCH');
      await page.locator(this.options.recipe.draftReadySelector).waitFor({state:'visible'});
      const link=page.locator(this.options.recipe.draftPdfLinkSelector);if(await link.count()!==1)throw new AdapterError('SEDE_DRAFT_LINK_AMBIGUOUS');
      const href=await link.getAttribute('href');if(!href)throw new AdapterError('SEDE_DRAFT_PDF_UNAVAILABLE');
      const url=checkedHttpsUrl(new URL(href,page.url()).href,this.options.recipe.officialOrigins);
      if(Date.parse(c.expiresAt)<=Date.now()||forbidden)throw new AdapterError('SEDE_EXPLICIT_SCOPED_CONSENT_REQUIRED');
      const pdf=await this.pdf(context,url,pfx,input.certificate.passphrase);
      // Nothing in this adapter submits, signs or revokes. The context always closes here.
      return {status:'DRAFT_REQUIRES_HUMAN_SUBMISSION',pdf,sha256:sha256(pdf),recipeId:this.options.recipe.id};
    }catch(error){if(error instanceof AdapterError)throw error;throw new AdapterError('SEDE_DRAFT_AUTOMATION_FAILED','uncertain');}
    finally{if(deadline)clearTimeout(deadline);await browser?.close().catch(()=>undefined);pfx.fill(0);}
  }
}
