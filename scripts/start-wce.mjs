#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const project = resolve(new URL('..', import.meta.url).pathname);
const wceRoot = resolve(project, 'wce-emulator');
const envFile = resolve(project, '.env.wce');
if (!existsSync(resolve(wceRoot, 'bridge/index.js'))) throw new Error('WCE_REPOSITORY_MISSING_RUN_NPM_RUN_WCE_INSTALL');
const run = (cmd, args, cwd, env = process.env) => {
  const result = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
};
run(process.execPath, ['scripts/setup-wce.mjs'], project);
if (!existsSync(resolve(wceRoot, 'bridge/node_modules'))) run('npm', ['install'], wceRoot);
if (!existsSync(resolve(wceRoot, 'emulator/node_modules'))) run('npm', ['install'], resolve(wceRoot, 'emulator'));

// The bridge must use the exact signing secret APOD loads from .env.wce.
// Loading it here also keeps the three child processes on one local config.
const shared = { ...process.env, ...parse(readFileSync(envFile, 'utf8')), ENV_FILE: envFile };
const children = [
  spawn(process.execPath, ['bridge/index.js'], { cwd: wceRoot, env: { ...shared, BOT_WEBHOOK_URL: 'http://127.0.0.1:4720/webhooks/whatsapp', WCE_PHONE_NUMBER_ID: '999000000000', WCE_SENDER_PHONE: '34600000000', WCE_BUSINESS_ACCOUNT_ID: 'wce-local-business', WCE_APP_SECRET: shared.WA_APP_SECRET, WCE_BRIDGE_PORT: '3001' }}),
  spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1'], { cwd: resolve(wceRoot, 'emulator'), env: shared, stdio: 'inherit' }),
  spawn('npm', ['run', 'local:start'], { cwd: project, env: shared, stdio: 'inherit' }),
];
children[0].stdout?.pipe(process.stdout); children[0].stderr?.pipe(process.stderr);
let stopping = false;
const stop = (code = 0) => { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGINT'); setTimeout(() => process.exit(code), 500); };
for (const child of children) child.once('exit', (code) => { if (!stopping) stop(code ?? 1); });
process.once('SIGINT', () => stop(0)); process.once('SIGTERM', () => stop(0));
console.log(JSON.stringify({ ui: 'http://127.0.0.1:8080', bridge: 'http://127.0.0.1:3001', apod: 'http://127.0.0.1:4720', recipient: '34600000000', externalMetaCalls: false }));
