import net from 'node:net';
import os from 'node:os';

const frontendPort = Number(process.env.VITE_PORT ?? 5173);
const apiPort = Number(process.env.PORT ?? 8787);

type AddressInfo = {
  name: string;
  address: string;
};

function getPrivateIpv4Addresses(): AddressInfo[] {
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

function canConnect(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 1500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function main() {
  const addresses = getPrivateIpv4Addresses();

  console.log('HIT Grading network doctor');
  console.log('--------------------------');
  console.log(`Frontend port: ${frontendPort}`);
  console.log(`Backend port:  ${apiPort}`);

  if (!addresses.length) {
    console.warn('\nNo private IPv4 addresses found. Connect the laptop to Wi-Fi/hotspot and run ipconfig.');
  } else {
    console.log('\nDetected private IPv4 addresses:');
    for (const address of addresses) console.log(`- ${address.name}: ${address.address}`);
  }

  console.log('\nLocal port checks:');
  const localFrontend = await canConnect('127.0.0.1', frontendPort);
  const localApi = await canConnect('127.0.0.1', apiPort);
  console.log(`- 127.0.0.1:${frontendPort} ${localFrontend ? 'reachable' : 'not reachable'}`);
  console.log(`- 127.0.0.1:${apiPort} ${localApi ? 'reachable' : 'not reachable'}`);

  if (addresses.length) {
    console.log('\nLAN self-checks from this laptop:');
    for (const { address } of addresses) {
      const frontend = await canConnect(address, frontendPort);
      const api = await canConnect(address, apiPort);
      console.log(`- http://${address}:${frontendPort} ${frontend ? 'reachable from laptop' : 'not reachable from laptop'}`);
      console.log(`- http://${address}:${apiPort}/api/health ${api ? 'reachable from laptop' : 'not reachable from laptop'}`);
    }

    console.log('\nPhone URLs to try:');
    for (const { address } of addresses) {
      console.log(`- App:         http://${address}:${frontendPort}`);
      console.log(`- Static test: http://${address}:${frontendPort}/mobile-test.html`);
      console.log(`- API health:  http://${address}:${apiPort}/api/health`);
    }
  }

  console.log('\nIf laptop self-checks pass but phone cannot open /mobile-test.html:');
  console.log('- The problem is outside React/Vite app code.');
  console.log('- Confirm phone and laptop are on the same non-guest Wi-Fi.');
  console.log('- Turn off VPN, iCloud Private Relay, and mobile data assist while testing.');
  console.log('- Check router AP isolation/client isolation/guest isolation.');
  console.log('- As a short test only, disable Windows Private firewall, retry, then re-enable it.');
  console.log('- Try connecting the laptop to the phone hotspot, then rerun this doctor for the new IP.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
