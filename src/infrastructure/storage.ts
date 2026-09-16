import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AppError } from './security.js';
export class DocumentStorage {
  readonly root: string;
  constructor(root: string, private maxBytes: number) { this.root = resolve(root); }
  async save(pdf: Buffer): Promise<{path: string; sha256: string}> {
    if (pdf.length > this.maxBytes || !pdf.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw new AppError('INVALID_PDF',400);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    await mkdir(this.root, {recursive: true, mode: 0o700});
    const path = `${sha256}.pdf`;
    try { await writeFile(join(this.root,path),pdf,{mode:0o600, flag:'wx'}); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const saved = await this.read(path, sha256);
    if (saved.length !== pdf.length) throw new AppError('STORAGE_INTEGRITY_FAILURE');
    return {path,sha256};
  }
  async read(path: string, hash: string) {
    if (!/^[a-f0-9]{64}\.pdf$/.test(path) || path !== `${hash}.pdf`) throw new AppError('INVALID_STORAGE_REFERENCE');
    const data = await readFile(join(this.root,path));
    if (data.length > this.maxBytes || createHash('sha256').update(data).digest('hex') !== hash) throw new AppError('DOCUMENT_HASH_MISMATCH');
    return data;
  }
}
