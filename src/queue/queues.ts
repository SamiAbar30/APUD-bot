import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
export function createQueues(connection: Redis,prefix="apod") {
  const options = {connection, prefix,defaultJobOptions:{attempts:3,backoff:{type:'exponential',delay:2000},removeOnComplete:1000,removeOnFail:1000}};
  return {
    inbound:new Queue('inbound-messages',options),
    audit:new Queue('pdf-audit',options),
    kmaleon:new Queue('kmaleon-sync',options),
    notifications:new Queue('notifications',options),
    deadLetter:new Queue('dead-letter',{...options,defaultJobOptions:{attempts:1,removeOnComplete:false,removeOnFail:false}}),
  };
}
export type Queues = ReturnType<typeof createQueues>;
