import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {AppError} from './security.js';

/** Case-bound authenticated encryption. The key is supplied separately from stored ciphertext. */
export class CredentialVault {
  constructor(private readonly root:string, private readonly keyHex:string|undefined) {}
  private key():Buffer {
    if(!this.keyHex||!/^[a-f0-9]{64}$/i.test(this.keyHex))throw new AppError('CREDENTIAL_VAULT_KEY_REQUIRED',503);
    return Buffer.from(this.keyHex,'hex');
  }
  async save(caseId:string,certificate:Buffer,password:Buffer):Promise<{ref:string;certificateSha256:string}> {
    const key=this.key(),iv=randomBytes(12),ref=randomUUID();
    const plain=Buffer.alloc(4+certificate.length+password.length);
    plain.writeUInt32BE(certificate.length);certificate.copy(plain,4);password.copy(plain,4+certificate.length);
    try {
      const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(`${caseId}:${ref}`));
      const body=Buffer.concat([cipher.update(plain),cipher.final()]);
      await mkdir(join(this.root,'credentials'),{recursive:true,mode:0o700});
      await writeFile(join(this.root,'credentials',`${ref}.bin`),Buffer.concat([iv,cipher.getAuthTag(),body]),{mode:0o600,flag:'wx'});
      return {ref,certificateSha256:createHash('sha256').update(certificate).digest('hex')};
    } finally {key.fill(0);plain.fill(0);}
  }
  async read(caseId:string,ref:string,expectedSha256:string):Promise<{certificate:Buffer;password:Buffer}> {
    if(!/^[0-9a-f-]{36}$/.test(ref)||!/^[a-f0-9]{64}$/.test(expectedSha256))throw new AppError('CREDENTIAL_REFERENCE_INVALID');
    const key=this.key();let plain:Buffer|undefined;
    try {
      const bytes=await readFile(join(this.root,'credentials',`${ref}.bin`));
      if(bytes.length<32||bytes.length>1024*1024+8192)throw new AppError('CREDENTIAL_CIPHERTEXT_INVALID');
      const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));decipher.setAAD(Buffer.from(`${caseId}:${ref}`));
      plain=Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]);
      const length=plain.readUInt32BE();
      if(length===0||length>plain.length-4||createHash('sha256').update(plain.subarray(4,4+length)).digest('hex')!==expectedSha256)throw new AppError('CREDENTIAL_INTEGRITY_FAILURE');
      return {certificate:Buffer.from(plain.subarray(4,4+length)),password:Buffer.from(plain.subarray(4+length))};
    } finally {key.fill(0);plain?.fill(0);}
  }
}
