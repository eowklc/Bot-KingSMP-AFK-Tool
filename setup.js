'use strict';

// Bộ khởi chạy KingSMP Panel.
// Giao diện nằm sẵn trong public/; không sinh đè các file giao diện khi khởi động.
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = __dirname;
const isWindows = process.platform === 'win32';

function run(command, args, label) {
  console.log('\n=== ' + label + ' ===');
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWindows,
    windowsHide: true
  });
  if (result.error) {
    console.error('[LOI] ' + result.error.message);
    process.exitCode = 1;
    return false;
  }
  if (result.status !== 0) {
    console.error('[LOI] Lenh ket thuc voi ma ' + result.status);
    process.exitCode = result.status || 1;
    return false;
  }
  return true;
}

console.log('KingSMP Multi-Bot Panel');
console.log('Thu muc: ' + path.resolve(ROOT));
console.log('Cac file giao dien hien tai se duoc giu nguyen.');

if (!run(isWindows ? 'npm.cmd' : 'npm', ['install'], 'Cai dat dependencies (npm install)')) {
  console.error('Thu chay thu cong: npm install && npm start');
  process.exit(process.exitCode || 1);
}

console.log('\nPanel se mo tai http://localhost:3001 khi server khoi dong.');
run(process.execPath, ['main.js'], 'Khoi dong bot panel');
