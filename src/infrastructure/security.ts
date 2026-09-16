import { createHash, timingSafeEqual } from 'node:crypto';
export class AppError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 409) { super(code); }
}
export function constantEqual(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function errorCode(e: unknown): string {
  if (e instanceof AppError) return e.code;
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' && /^[A-Z0-9_]{2,80}$/.test(e.code)) return e.code;
  return 'OPERATION_FAILED';
}
export function assertEmailAuthorized(token?: string): void {
  const hash = '2f37b4c7861e6644a3b8a52d8d8400e495686e760f40d2a9f9262d8293263df4';
  if (!token || !constantEqual(createHash('sha256').update(token).digest('hex'), hash)) {
    throw new AppError('🛑 ACCESO DENEGADO: Se requiere el Token de Autorización Humana para proceder.', 403);
  }
}
export function requireOutbound(enabled: boolean): void { if (!enabled) throw new AppError('OUTBOUND_DISABLED'); }
