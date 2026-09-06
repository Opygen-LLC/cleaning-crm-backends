#!/usr/bin/env node
/** Keep staging-only test hooks out of production builds, including future E2E keys. */
import { spawnSync } from 'node:child_process';
const [command,...args]=process.argv.slice(2);
if(!command) { console.error('Usage: withoutE2E.mjs command [arguments...]');process.exit(2); }
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('E2E_')));
const child=spawnSync(command,args,{env,stdio:'inherit',shell:false});
if(child.error) { console.error('Production qualification command could not start');process.exitCode=1; }
else process.exitCode=child.status ?? 1;
