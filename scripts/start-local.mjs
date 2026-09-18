import './setup-env.mjs';
await import('./lib/load-env.mjs');
import { spawn,spawnSync } from 'node:child_process';
import {mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
mkdirSync('.runtime',{recursive:true,mode:0o700});mkdirSync('evidence',{recursive:true,mode:0o700});
function run(command,args,extra={}){const result=spawnSync(command,args,{stdio:'inherit',...extra});if(result.status!==0)throw new Error(`${command} failed`)}
import { createConnection } from 'node:net';
const checkPort = (port) => new Promise(res => {
  const s = createConnection({ port, host: '127.0.0.1' }, () => { s.end(); res(true); });
  s.on('error', () => res(false));
});
if (!(await checkPort(55432))) {
  if(!existsSync('.runtime/postgres/PG_VERSION'))run('initdb',['-D','.runtime/postgres','-U','apod','--auth-local=trust','--auth-host=scram-sha-256','--pwfile=/dev/stdin'],{input:process.env.POSTGRES_PASSWORD,stdio:['pipe','inherit','inherit']});
  const status=spawnSync('pg_ctl',['-D','.runtime/postgres','status'],{stdio:'ignore'});if(status.status!==0)run('pg_ctl',['-D','.runtime/postgres','-l',resolve('evidence/postgres.log'),'-o','-h 127.0.0.1 -p 55432 -k /tmp','start']);
}
const redis=spawnSync('redis-cli',['-p','56379','ping'],{stdio:'ignore'});if(redis.status!==0)run('redis-server',['--bind','127.0.0.1','--port','56379','--dir',resolve('.runtime'),'--appendonly','yes','--daemonize','yes','--pidfile',resolve('.runtime/redis.pid'),'--logfile',resolve('evidence/redis.log'),'--maxmemory-policy','noeviction']);
run(process.execPath,['scripts/create-local-db.mjs']);run('npx',['prisma','migrate','deploy']);run('npm',['run','build']);
const child=spawn(process.execPath,['dist/src/main.js'],{stdio:'inherit',env:process.env});child.on('exit',code=>process.exit(code??1));process.on('SIGINT',()=>child.kill('SIGINT'));process.on('SIGTERM',()=>child.kill('SIGTERM'));
