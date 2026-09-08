import { defineConfig, type Plugin } from 'vite';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  textTellerAssetPath,
  type TexTellerAsset,
} from './src/worker/texteller-assets.ts';
import {
  pdfJsDecoderAssetPath,
  pdfJsDecoderAssets,
  pdfJsWorkerAssetPath,
} from './src/pdfjs-assets.ts';

const repositoryName = 'word-convert';
const browserFixture = fileURLToPath(
  new URL(
    '../../tests/fixtures/docx/standard-comprehensive.docx',
    import.meta.url,
  ),
);
const pdfBrowserFixture = fileURLToPath(
  new URL('../../tests/fixtures/pdf/one-column-book.pdf', import.meta.url),
);
const configuredRecognizer = fileURLToPath(
  new URL(
    './src/worker/configured-formula-recognizer.texteller.ts',
    import.meta.url,
  ),
);
const pdfJsDecoderDirectory = fileURLToPath(
  new URL('./node_modules/pdfjs-dist/wasm/', import.meta.url),
);
const pdfJsWorkerFile = fileURLToPath(
  new URL(
    './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    import.meta.url,
  ),
);

export function resolveTexTellerDevModelDirectory(
  configured: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (configured) return configured;
  const candidates = [
    resolve(tmpdir(), 'texteller-q4'),
    resolve('/tmp', 'texteller-q4'),
  ];
  return candidates.find((candidate) => exists(candidate));
}

function formulaRecognizerPlugin(): Plugin {
  return {
    name: 'wordconvert-formula-recognizer',
    resolveId(source) {
      return source === 'virtual:wordconvert-formula-recognizer'
        ? configuredRecognizer
        : undefined;
    },
  };
}

function pdfJsDecoderAssetsPlugin(base: string): Plugin {
  const developmentOrigin = 'http://wordconvert.invalid';
  const developmentBase = new URL(base, developmentOrigin);
  return {
    name: 'wordconvert-pdfjs-decoder-assets',
    configureServer(server) {
      const workerRequestPath = new URL(pdfJsWorkerAssetPath, developmentBase)
        .pathname;
      server.middlewares.use(workerRequestPath, (_request, response) => {
        void readFile(pdfJsWorkerFile).then(
          (asset) => {
            response.statusCode = 200;
            response.setHeader(
              'Content-Type',
              'text/javascript; charset=utf-8',
            );
            response.end(asset);
          },
          () => {
            response.statusCode = 404;
            response.end();
          },
        );
      });
      for (const file of pdfJsDecoderAssets) {
        const requestPath = new URL(
          pdfJsDecoderAssetPath(file),
          developmentBase,
        ).pathname;
        server.middlewares.use(requestPath, (_request, response) => {
          void readFile(resolve(pdfJsDecoderDirectory, file)).then(
            (asset) => {
              response.statusCode = 200;
              response.setHeader(
                'Content-Type',
                file.endsWith('.wasm')
                  ? 'application/wasm'
                  : file.endsWith('.js')
                    ? 'text/javascript; charset=utf-8'
                    : 'text/plain; charset=utf-8',
              );
              response.end(asset);
            },
            () => {
              response.statusCode = 404;
              response.end();
            },
          );
        });
      }
    },
    async generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: pdfJsWorkerAssetPath,
        source: await readFile(pdfJsWorkerFile),
      });
      await Promise.all(
        pdfJsDecoderAssets.map(async (file) => {
          this.emitFile({
            type: 'asset',
            fileName: pdfJsDecoderAssetPath(file),
            source: await readFile(resolve(pdfJsDecoderDirectory, file)),
          });
        }),
      );
    },
  };
}

function serviceWorkerSource(
  bundle: Record<string, { fileName: string }>,
): string {
  const files = Object.values(bundle)
    .map((entry) => `./${entry.fileName}`)
    .filter(
      (file) =>
        !file.endsWith('.onnx') &&
        !(file.includes('/ort-wasm-') && file.endsWith('.wasm')),
    );
  files.push(
    './',
    './404.html',
    './index.html',
    './manifest.webmanifest',
    './wc.svg',
    './favicon.svg',
    './favicon.ico',
    './favicon-96x96.png',
    './apple-touch-icon.png',
    './web-app-manifest-192x192.png',
    './web-app-manifest-512x512.png',
  );

  return `const CACHE_NAME = 'wordconvert-${Date.now()}';
const PRECACHE_URLS = ${JSON.stringify(files.sort())};

function updateCache(request, response) {
  if (!response.ok) return response;
  const copy = response.clone();
  void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  return response;
}

function isNavigationRequest(request) {
  return request.mode === 'navigate';
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name.startsWith('wordconvert-') && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    )),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (isNavigationRequest(event.request)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => updateCache(event.request, response))
        .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match('./index.html'))),
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request).then((response) => updateCache(event.request, response))),
  );
});
`;
}

export default defineConfig(({ command }) => {
  const base =
    process.env.WORDCONVERT_BASE_PATH ??
    (command === 'build' ? `/${repositoryName}/` : '/');
  const configuredTexTellerDirectory =
    process.env.WORDCONVERT_TEXTELLER_MODEL_DIR;
  const texTellerModelDirectory =
    command === 'serve'
      ? resolveTexTellerDevModelDirectory(configuredTexTellerDirectory)
      : configuredTexTellerDirectory;
  if (command === 'build' && !texTellerModelDirectory)
    throw new Error(
      'WORDCONVERT_TEXTELLER_MODEL_DIR is required for a TexTeller build.',
    );
  return {
    base,
    define: {
      __WORDCONVERT_BASE_PATH__: JSON.stringify(base),
    },
    build: {
      target: 'es2022',
    },
    worker: {
      format: 'es',
      plugins: () => [formulaRecognizerPlugin()],
    },
    plugins: [
      formulaRecognizerPlugin(),
      pdfJsDecoderAssetsPlugin(base),
      {
        name: 'wordconvert-route-fallback',
        apply: 'build',
        async writeBundle(options) {
          const outputDirectory = resolve(String(options.dir ?? 'dist'));
          await copyFile(
            resolve(outputDirectory, 'index.html'),
            resolve(outputDirectory, '404.html'),
          );
        },
      },
      {
        name: 'wordconvert-service-worker',
        apply: 'build',
        generateBundle(_options, bundle) {
          this.emitFile({
            type: 'asset',
            fileName: 'sw.js',
            source: serviceWorkerSource(bundle),
          });
        },
      },
      {
        name: 'wordconvert-browser-fixture',
        configureServer(server) {
          for (const file of [
            'encoder.onnx',
            'decoder.onnx',
            'tokenizer.json',
          ] satisfies TexTellerAsset[])
            server.middlewares.use(
              `/${textTellerAssetPath(file)}`,
              (_request, response) => {
                if (!texTellerModelDirectory) {
                  response.statusCode = 404;
                  response.end();
                  return;
                }
                void readFile(resolve(texTellerModelDirectory, file)).then(
                  (asset) => {
                    response.statusCode = 200;
                    response.setHeader(
                      'Content-Type',
                      file.endsWith('.json')
                        ? 'application/json'
                        : 'application/octet-stream',
                    );
                    response.end(asset);
                  },
                  () => {
                    response.statusCode = 404;
                    response.end();
                  },
                );
              },
            );
          server.middlewares.use(
            '/__wordconvert_browser_fixture__.docx',
            (_request, response) => {
              void readFile(browserFixture).then((fixture) => {
                response.statusCode = 200;
                response.setHeader(
                  'Content-Type',
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                );
                response.end(fixture);
              });
            },
          );
          server.middlewares.use(
            '/__wordconvert_browser_fixture__.pdf',
            (_request, response) => {
              void readFile(pdfBrowserFixture).then((fixture) => {
                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/pdf');
                response.end(fixture);
              });
            },
          );
        },
      },
      texTellerModelDirectory
        ? {
            name: 'wordconvert-texteller-build-assets',
            async writeBundle(options) {
              const outputDirectory = resolve(
                String(options.dir ?? 'dist'),
                'texteller',
              );
              await mkdir(outputDirectory, { recursive: true });
              await Promise.all(
                ['encoder.onnx', 'decoder.onnx', 'tokenizer.json'].map((file) =>
                  copyFile(
                    resolve(texTellerModelDirectory, file),
                    resolve(outputDirectory, file),
                  ),
                ),
              );
            },
          }
        : undefined,
    ],
  };
});
