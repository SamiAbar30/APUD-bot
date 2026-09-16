import './lib/load-env.mjs';
import {spawnSync} from 'node:child_process';
const r=spawnSync('createdb',['-h','127.0.0.1','-p','55432','-U','apod','apoderamientos'],{env:{...process.env,PGPASSWORD:process.env.POSTGRES_PASSWORD},encoding:'utf8'});if(r.status && !r.stderr.includes('already exists')){console.error('Local DB creation failed');process.exit(1)}else console.log('Local APOD database ready');
