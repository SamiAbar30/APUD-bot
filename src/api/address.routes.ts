import type {FastifyInstance} from 'fastify';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import type {WorkflowService} from '../core/workflow-service.js';
import type {ActionExecutor} from '../queue/action-executor.js';
import {GeoNormalizer} from '../core/geo-normalizer.js';
import {AppError} from '../infrastructure/security.js';
export async function addressRoutes(api:FastifyInstance,flow:WorkflowService,executor:ActionExecutor){
  api.post('/cases/:id/address-from-kmaleon',async request=>{
    const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const b=z.object({version:z.number().int().nonnegative()}).strict().parse(request.body);
    const c=await flow.load(id);if(c.version!==b.version)throw new AppError('CASE_CHANGED_RELOAD');
    if(!c.identityVerified||!c.kmaleonExpedienteId)throw new AppError('VERIFIED_KMALEON_IDENTITY_REQUIRED');
    if(!executor.adapters.kmaleon)throw new AppError('KMALEON_NOT_CONFIGURED');
    const address=await executor.adapters.kmaleon.getVerifiedAddress({projectId:c.kmaleonExpedienteId,expectedDni:c.dni});
    const catalog=flow.env.GEO_CATALOG_FILE?GeoNormalizer.fromCatalog(JSON.parse(await readFile(flow.env.GEO_CATALOG_FILE,'utf8'))):GeoNormalizer.withoutCatalog();
    const geography=catalog.resolve(address);
    const fresh=await flow.load(id);if(fresh.version!==b.version)throw new AppError('CASE_CHANGED_RELOAD');
    // Return real source values for the operator to review before persisting form fields.
    return {address,geography};
  });
}
