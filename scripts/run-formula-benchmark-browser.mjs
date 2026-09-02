import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const corpusPath = resolve('tests/fixtures/formula-benchmark/corpus.json');
const manifestPath = resolve(
  'apps/web/src/assets/formula-ocr/model-manifest.json',
);
const outputPath = resolve(
  'documentation/formula-benchmarks/rapid-latex-ocr-run.json',
);
const cdpUrl = process.env.WORDCONVERT_CDP_URL ?? 'http://localhost:9222';
const appUrl =
  process.env.WORDCONVERT_BENCHMARK_URL ?? 'http://127.0.0.1:5191/';
const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
const benchmarkCases = corpus.cases.map((testCase) => ({
  ...testCase,
  imageUrl: `/@fs${resolve('tests/fixtures/formula-benchmark', testCase.file)}`,
}));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const browser = await puppeteer.connect({
  browserURL: cdpUrl,
  defaultViewport: null,
});
let page = (await browser.pages()).find((candidate) =>
  candidate.url().startsWith(appUrl),
);
if (!page) page = await browser.newPage();
await page.goto(appUrl, { waitUntil: 'networkidle0' });

const run = await page.evaluate(async (cases) => {
  const { createRapidLatexFormulaRecognizer } =
    await import('/src/worker/formula-recognizer.ts');
  const tokenizer = await (
    await fetch('/src/assets/formula-ocr/tokenizer.json')
  ).text();
  const recognizer = createRapidLatexFormulaRecognizer(
    {
      imageResizer: '/src/assets/formula-ocr/image_resizer.onnx',
      encoder: '/src/assets/formula-ocr/encoder.onnx',
      decoder: '/src/assets/formula-ocr/decoder.onnx',
      tokenizer,
    },
    { maxTokens: 128 },
  );
  const memory = () => performance.memory?.usedJSHeapSize ?? null;
  const initialMemory = memory();
  const initializationStarted = performance.now();
  const prepared = await recognizer.prepare();
  const initializationMs = performance.now() - initializationStarted;
  if (!prepared) throw new Error('RapidLatexOCR could not initialize.');
  let peakMemoryBytes = memory();
  const results = [];
  for (const testCase of cases) {
    const image = new Image();
    image.src = testCase.imageUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const started = performance.now();
    try {
      const recognition = await recognizer.recognize({
        width: pixels.width,
        height: pixels.height,
        rgba: pixels.data,
      });
      results.push({
        id: testCase.id,
        tex: recognition.tex,
        durationMs: performance.now() - started,
        diagnostics: recognition.diagnostics,
      });
    } catch (cause) {
      results.push({
        id: testCase.id,
        durationMs: performance.now() - started,
        failure: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const currentMemory = memory();
    if (currentMemory !== null)
      peakMemoryBytes = Math.max(peakMemoryBytes ?? 0, currentMemory);
    canvas.width = 0;
    canvas.height = 0;
  }
  await recognizer.dispose();
  return {
    initializationMs,
    initialMemoryBytes: initialMemory,
    peakMemoryBytes,
    environment: {
      browser: navigator.userAgent,
      webGpuAvailable: Boolean(navigator.gpu),
      crossOriginIsolated,
      maxTokens: 128,
      corpusCases: cases.length,
    },
    results,
  };
}, benchmarkCases);

const output = {
  schema: 'wordconvert.formula-benchmark-run',
  version: 1,
  measuredAt: new Date().toISOString(),
  model: {
    implementation: 'rapid-latex-ocr-onnx',
    revision: manifest.revision,
    hashes: Object.fromEntries(
      manifest.files.map(({ path, sha256 }) => [path, sha256]),
    ),
  },
  transferBytes: manifest.files.reduce((total, { size }) => total + size, 0),
  ...run,
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
await browser.disconnect();
console.log(`Wrote ${run.results.length} benchmark results to ${outputPath}`);
