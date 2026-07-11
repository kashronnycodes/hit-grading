import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const frontendPort = Number(process.env.VITE_PORT ?? 5173);
const apiPort = Number(process.env.PORT ?? 8787);
const noHmr = process.argv.includes('--no-hmr');

function getPrivateIpv4Addresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .filter((entry) =>
        /^192\.168\.\d{1,3}\.\d{1,3}$/.test(entry.address) ||
        /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(entry.address) ||
        /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(entry.address)
      )
      .map((entry) => ({ name, address: entry.address }))
  );
}

function printMobileUrls() {
  const addresses = getPrivateIpv4Addresses();
  console.log('\nHIT Grading mobile dev');
  console.log('----------------------');
  console.log(`Frontend local: http://127.0.0.1:${frontendPort}`);
  console.log(`Backend local:  http://127.0.0.1:${apiPort}`);
  console.log(`HMR: ${noHmr ? 'disabled for mobile troubleshooting' : 'enabled'}`);

  if (!addresses.length) {
    console.warn('\nNo private IPv4 address was detected. Connect to Wi-Fi/hotspot, then run ipconfig.');
    return;
  }

  console.log('\nTry these on your phone while it is on the same Wi-Fi:');
  for (const { name, address } of addresses) {
    console.log(`- ${name}`);
    console.log(`  App:         http://${address}:${frontendPort}`);
    console.log(`  Static test: http://${address}:${frontendPort}/mobile-test.html`);
    console.log(`  API health:  http://${address}:${apiPort}/api/health`);
  }

  console.log('\nIf /mobile-test.html does not open on the phone, the block is firewall/router/client isolation, not React.');
}

function spawnLogged(name: string, command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`${name} exited with code ${code}`);
  });

  return child;
}

printMobileUrls();

const nodeBin = process.execPath;
const tsxCli = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');
const viteCli = path.join('node_modules', 'vite', 'bin', 'vite.js');
const api = spawnLogged('api', nodeBin, ['--use-system-ca', tsxCli, 'watch', 'server/src/index.ts'], {
  ...process.env,
  HOST: process.env.HOST || '0.0.0.0',
  PORT: String(apiPort)
});
const frontend = spawnLogged('frontend', nodeBin, [viteCli, '--host', '0.0.0.0', '--port', String(frontendPort)], {
  ...process.env,
  VITE_DISABLE_HMR: noHmr ? 'true' : process.env.VITE_DISABLE_HMR || ''
});

process.on('SIGINT', () => {
  api.kill('SIGINT');
  frontend.kill('SIGINT');
  process.exit(0);
});
