#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function getInstallRoot() {
  return path.join(os.homedir(), '.claude', 'multi-account-switch');
}

function getStatuslineTargetPath() {
  return path.join(getInstallRoot(), 'hooks', 'statusline-target.json');
}

function readJsonIfExists(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getStatuslineLabel() {
  return 'use !ccs';
}

function isStaleDownstreamTarget(target) {
  if (!target || target.type !== 'command' || !target.command) {
    return true;
  }

  const command = String(target.command).toLowerCase();

  if (command.includes('tabber') || command.includes('omc-hud')) {
    return true;
  }

  if ((command.endsWith('.py') || command.includes('.py"') || command.includes(".py'")) && !command.includes('python')) {
    return true;
  }

  return false;
}

function runDownstream(input) {
  const target = readJsonIfExists(getStatuslineTargetPath(), null);
  if (isStaleDownstreamTarget(target)) {
    return '';
  }

  const result = spawnSync(target.command, {
    input,
    encoding: 'utf8',
    shell: true,
    windowsHide: true
  });

  if (result.error || result.status !== 0) {
    return '';
  }

  const output = (result.stdout || '').trimEnd();
  if (output.includes('Plugin not installed') || output.includes('[OMC HUD]')) {
    return '';
  }

  return output;
}

function prependLabel(label, downstream) {
  if (!downstream) {
    return label;
  }

  const lines = downstream.split(/\r?\n/);
  lines[0] = lines[0] ? `${label} │ ${lines[0]}` : label;
  return lines.join('\n');
}

const stdin = fs.readFileSync(0, 'utf8');
const label = getStatuslineLabel();
const downstream = runDownstream(stdin);
process.stdout.write(`${prependLabel(label, downstream)}\n`);
