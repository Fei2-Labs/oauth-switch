#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const cliPath = path.join(__dirname, '..', 'bin', 'oauth-switch.cjs');
spawnSync('node', [cliPath, '--touch-current'], { stdio: 'ignore' });
spawnSync('node', [cliPath, 'auto'], { stdio: 'inherit' });

console.log('OAuth Switch is available.');
console.log('Use !oauth-switch or !oas to list/switch accounts.');
console.log('Use !oauth-sync or !oso to sync the active account into oauthList.');
