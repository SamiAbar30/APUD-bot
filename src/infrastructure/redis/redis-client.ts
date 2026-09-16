import { Redis } from 'ioredis';
import Redlock from 'redlock';
export function createRedis(url: string) {
  const redis = new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
  const redlock = new Redlock([redis], { retryCount: 8, retryDelay: 250, retryJitter: 150, automaticExtensionThreshold: 60000 });
  return { redis, redlock };
}
