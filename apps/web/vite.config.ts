import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const repositoryName = 'word-convert';
const browserFixture = fileURLToPath(
  new URL(
    '../../tests/fixtures/docx/standard-comprehensive.docx',
    import.meta.url,
  ),
);

function serviceWorkerSource(
  bundle: Record<string, { fileName: string }>,
): string {
  const files = Object.values(bundle).map((entry) => `./${entry.fileName}`);
  files.push(
    './',
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

export default defineConfig(({ command }) => ({
  base:
    process.env.WORDCONVERT_BASE_PATH ??
    (command === 'build' ? `/${repositoryName}/` : '/'),
  build: {
    target: 'es2022',
  },
  plugins: [
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
      },
    },
  ],
}));
