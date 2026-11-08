import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { hasContentImageSignature } from '@wordconvert/text-reader/content-editor';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicImageAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 &&
        globalV6.check(address, 'ipv6') &&
        !blocked.check(address, 'ipv6');
}

export function externalImageUrl(source: string): URL {
  const url = new URL(source.startsWith('//') ? `https:${source}` : source);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  )
    throw new Error(
      'External images require credential-free HTTPS on port 443.',
    );
  return url;
}

const mediaTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

export async function downloadExternalImage(source: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const signal = controller.signal;
  let abortLookup: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortLookup = () =>
      reject(new Error('External image download exceeded 15 seconds.'));
    signal.addEventListener('abort', abortLookup, { once: true });
  });
  try {
    let url = externalImageUrl(source);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = await Promise.race([
        lookup(hostname, { all: true }),
        aborted,
      ]);
      if (
        !addresses.length ||
        addresses.some(({ address }) => !isPublicImageAddress(address))
      )
        throw new Error(
          'External image resolves to a non-public network address.',
        );
      const address = addresses[0]!;
      // Pin the validated address while retaining TLS verification for the original host.
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(
          {
            hostname: address.address,
            family: address.family,
            servername: isIP(hostname) ? '' : hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
              Host: url.host,
              Accept: [...mediaTypes].join(', '),
              'Accept-Encoding': 'identity',
            },
            agent: false,
            signal,
          },
          resolve,
        );
        req.once('error', reject);
        req.end();
      });
      try {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          if (!response.headers.location || redirects === 3)
            throw new Error(
              'External image exceeds the three-redirect limit or has no redirect location.',
            );
          url = externalImageUrl(new URL(response.headers.location, url).href);
          continue;
        }
        if (response.statusCode !== 200)
          throw new Error(
            `External image returned HTTP ${response.statusCode}.`,
          );
        const mediaType = response.headers['content-type']
          ?.split(';')[0]
          ?.trim()
          .toLowerCase();
        if (!mediaType || !mediaTypes.has(mediaType))
          throw new Error(
            'External image is not a supported passive raster media type.',
          );
        if (
          response.headers['content-encoding'] &&
          response.headers['content-encoding'] !== 'identity'
        )
          throw new Error(
            'Compressed external image responses are not supported.',
          );
        const limit = 10 * 1024 * 1024;
        if (Number(response.headers['content-length']) > limit)
          throw new Error('External image exceeds the 10 MiB limit.');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response) {
          size += chunk.byteLength;
          if (size > limit)
            throw new Error('External image exceeds the 10 MiB limit.');
          chunks.push(chunk);
        }
        const data = new Uint8Array(Buffer.concat(chunks, size));
        if (!hasContentImageSignature(mediaType, data))
          throw new Error(
            'External image bytes do not match their raster media type.',
          );
        return { mediaType, data };
      } finally {
        response.destroy();
      }
    }
    throw new Error('External image redirect limit exceeded.');
  } finally {
    clearTimeout(timer);
    if (abortLookup) signal.removeEventListener('abort', abortLookup);
  }
}
