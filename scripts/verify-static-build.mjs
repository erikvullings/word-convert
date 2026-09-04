import { readFile, readdir } from 'node:fs/promises';
import { extname } from 'node:path';

const outputDirectory = new URL('../apps/web/dist/', import.meta.url);
const entries = await readdir(outputDirectory, { recursive: true });
const files = entries.filter((entry) => extname(entry) !== '');
const requiredFiles = [
  'index.html',
  '404.html',
  'manifest.webmanifest',
  'favicon.svg',
  'sw.js',
  'texteller/encoder.onnx',
  'texteller/decoder.onnx',
  'texteller/tokenizer.json',
];

for (const requiredFile of requiredFiles) {
  if (!files.includes(requiredFile)) {
    throw new Error(`Static build is missing ${requiredFile}.`);
  }
}

const index = await readFile(new URL('index.html', outputDirectory), 'utf8');
const manifest = JSON.parse(
  await readFile(new URL('manifest.webmanifest', outputDirectory), 'utf8'),
);
const serviceWorker = await readFile(new URL('sw.js', outputDirectory), 'utf8');
const precacheMatch = serviceWorker.match(/const PRECACHE_URLS = (\[[^;]+\]);/);
if (!precacheMatch?.[1]) {
  throw new Error('Service worker does not declare its precache URLs.');
}
const precacheUrls = new Set(JSON.parse(precacheMatch[1]));

function isDeferredRuntimeAsset(file) {
  return (
    file.startsWith('texteller/') ||
    file.endsWith('.onnx') ||
    (file.includes('/ort-wasm-') && file.endsWith('.wasm'))
  );
}

if (/\b(?:src|href)=["']https?:\/\//i.test(index)) {
  throw new Error('Built application shell requires an external network URL.');
}

if (manifest.start_url !== './' || manifest.scope !== './') {
  throw new Error('PWA manifest is not portable under the Pages base path.');
}

for (const file of files) {
  if (
    file !== 'sw.js' &&
    !isDeferredRuntimeAsset(file) &&
    !precacheUrls.has(`./${file}`)
  ) {
    throw new Error(`Service worker does not precache ${file}.`);
  }
}

for (const file of files.filter(isDeferredRuntimeAsset)) {
  if (precacheUrls.has(`./${file}`)) {
    throw new Error(`Service worker eagerly precaches ${file}.`);
  }
}

const forbiddenServerFiles = files.filter((file) =>
  /(^|\/)(?:server|api)(?:\.|\/)/i.test(file),
);
if (forbiddenServerFiles.length > 0) {
  throw new Error(
    `Static output contains server files: ${forbiddenServerFiles.join(', ')}`,
  );
}

console.log(`Verified ${files.length} static files with an offline PWA shell.`);
