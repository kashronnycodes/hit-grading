import axios from 'axios';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';

const baseUrl = trimTrailingSlash(process.env.TCGDEX_BASE_URL ?? 'https://api.tcgdex.net/v2');
const timeoutMs = parsePositiveInt(process.env.POKEMON_SYNC_TIMEOUT_MS, 30000);
const diagnosticUrl = `${baseUrl}/en/sets`;
const host = new URL(baseUrl).hostname;

async function main() {
  console.log('Pokemon sync diagnostics');
  console.log('------------------------');
  console.log(`URL: ${diagnosticUrl}`);
  console.log(`Timeout: ${timeoutMs}ms`);

  await diagnoseDns();
  await diagnoseTcp(4);
  await diagnoseTcp(6);
  await diagnoseTls(4);
  await diagnoseTls(6);
  await diagnoseGet('auto');
  await diagnoseGet('ipv4');
}

async function diagnoseDns() {
  const started = performance.now();
  try {
    const records = await dns.lookup(host, { all: true });
    console.log(`\nDNS lookup (${elapsed(started)}):`);
    for (const record of records) {
      console.log(`- ${record.family === 4 ? 'IPv4' : 'IPv6'} ${record.address}`);
    }
  } catch (error) {
    console.log(`\nDNS lookup failed (${elapsed(started)}): ${formatError(error)}`);
  }
}

async function diagnoseTcp(family: 4 | 6) {
  const started = performance.now();
  try {
    const address = await firstAddressForFamily(family);
    await connectTcp(address.address, family);
    console.log(`TCP IPv${family} connect (${address.address}) succeeded in ${elapsed(started)}`);
  } catch (error) {
    console.log(`TCP IPv${family} connect failed in ${elapsed(started)}: ${formatError(error)}`);
  }
}

async function diagnoseTls(family: 4 | 6) {
  const started = performance.now();
  try {
    const address = await firstAddressForFamily(family);
    await connectTls(address.address, family);
    console.log(`TLS IPv${family} connect (${address.address}) succeeded in ${elapsed(started)}`);
  } catch (error) {
    console.log(`TLS IPv${family} connect failed in ${elapsed(started)}: ${formatError(error)}`);
  }
}

async function diagnoseGet(mode: 'auto' | 'ipv4') {
  const started = performance.now();
  try {
    const response = await axios.request<unknown[]>({
      url: diagnosticUrl,
      method: 'GET',
      timeout: timeoutMs,
      responseType: 'json',
      ...(mode === 'ipv4'
        ? {
            family: 4
          }
        : {})
    });
    const count = Array.isArray(response.data) ? response.data.length : 'non-array';
    console.log(`GET ${mode} succeeded in ${elapsed(started)}: status=${response.status} count=${count}`);
  } catch (error) {
    console.log(`GET ${mode} failed in ${elapsed(started)}: ${formatError(error)}`);
  }
}

async function firstAddressForFamily(family: 4 | 6): Promise<{ address: string; family: 4 | 6 }> {
  const records = await dns.lookup(host, { all: true, family });
  const record = records.find((item) => item.family === family);
  if (!record) throw new Error(`No IPv${family} address found for ${host}`);
  return record as { address: string; family: 4 | 6 };
}

function connectTcp(address: string, family: 4 | 6): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port: 443, family, timeout: timeoutMs }, () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('TCP connection timed out'));
    });
    socket.once('error', reject);
  });
}

function connectTls(address: string, family: 4 | 6): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: address,
        servername: host,
        port: 443,
        family,
        timeout: timeoutMs
      },
      () => {
        socket.destroy();
        resolve();
      }
    );
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('TLS connection timed out'));
    });
    socket.once('error', reject);
  });
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function elapsed(started: number): string {
  return `${Math.round(performance.now() - started)}ms`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error('Pokemon sync diagnostics failed.');
  console.error(formatError(error));
  process.exitCode = 1;
});
