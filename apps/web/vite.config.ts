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
  files.push('./', './index.html', './manifest.webmanifest', './icon.svg');

  return `const CACHE_NAME = 'wordconvert-${Date.now()}';
const PRECACHE_URLS = ${JSON.stringify(files.sort())};

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
  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    })),
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
