import { defineConfig } from 'vite';

const repositoryName = 'word-convert';

export default defineConfig(({ command }) => ({
  base:
    process.env.WORDCONVERT_BASE_PATH ??
    (command === 'build' ? `/${repositoryName}/` : '/'),
  build: {
    target: 'es2022',
  },
}));
