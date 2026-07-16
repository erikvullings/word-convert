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

export default defineConfig(({ command }) => ({
  base:
    process.env.WORDCONVERT_BASE_PATH ??
    (command === 'build' ? `/${repositoryName}/` : '/'),
  build: {
    target: 'es2022',
  },
  plugins: [
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
