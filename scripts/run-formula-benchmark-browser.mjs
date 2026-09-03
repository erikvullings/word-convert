import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const corpusPath = resolve('tests/fixtures/formula-benchmark/corpus.json');
const outputPath = resolve(
  'documentation/formula-benchmarks/texteller-run.json',
);
const cdpUrl = process.env.WORDCONVERT_CDP_URL ?? 'http://localhost:9222';
const appUrl =
  process.env.WORDCONVERT_BENCHMARK_URL ?? 'http://127.0.0.1:5191/';
const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
const benchmarkCaseLimit = Number.parseInt(
  process.env.WORDCONVERT_BENCHMARK_CASES ?? '',
  10,
);
const selectedCases = Number.isFinite(benchmarkCaseLimit)
  ? corpus.cases.slice(0, Math.max(1, benchmarkCaseLimit))
  : corpus.cases;
const benchmarkCases = selectedCases.map((testCase) => ({
  ...testCase,
  imageUrl: `/@fs${resolve('tests/fixtures/formula-benchmark', testCase.file)}`,
}));
const texTellerModelDirectory = process.env.WORDCONVERT_TEXTELLER_MODEL_DIR;
if (!texTellerModelDirectory)
  throw new Error('WORDCONVERT_TEXTELLER_MODEL_DIR is required for TexTeller.');
const browser = await puppeteer.connect({
  browserURL: cdpUrl,
  defaultViewport: null,
});
let page = (await browser.pages()).find((candidate) =>
  candidate.url().startsWith(appUrl),
);
if (!page) page = await browser.newPage();
await page.goto(appUrl, { waitUntil: 'networkidle0' });

const run = await page.evaluate(
  async ({ cases }) => {
    const recognizer = await (async () => {
      const { createTexTellerBenchmarkRecognizer } =
        await import('/src/worker/texteller-benchmark-recognizer.ts');
      const { browserFormulaRecognizerDependencies } =
        await import('/src/worker/formula-model-runtime.ts');
      const tokenizer = await (
        await fetch('/__wordconvert_texteller__/tokenizer.json')
      ).text();
      return createTexTellerBenchmarkRecognizer(
        {
          encoder: '/__wordconvert_texteller__/encoder.onnx',
          decoder: '/__wordconvert_texteller__/decoder.onnx',
          tokenizer,
        },
        {
          dependencies: {
            ...browserFormulaRecognizerDependencies,
            validateTex: () => true,
          },
          maxTokens: 128,
        },
      );
    })();
    const memory = () => performance.memory?.usedJSHeapSize ?? null;
    const initialMemory = memory();
    const initializationStarted = performance.now();
    const prepared = await recognizer.prepare();
    const initializationMs = performance.now() - initializationStarted;
    if (!prepared) throw new Error('Formula recognizer could not initialize.');
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
  },
  { cases: benchmarkCases },
);

const texTellerFiles = await Promise.all(
  ['encoder.onnx', 'decoder.onnx', 'tokenizer.json'].map(async (file) => ({
    path: file,
    size: (await stat(resolve(texTellerModelDirectory, file))).size,
  })),
);

const output = {
  schema: 'wordconvert.formula-benchmark-run',
  version: 1,
  measuredAt: new Date().toISOString(),
  model: {
    implementation: 'texteller-onnx-q4',
    revision: '9727784d91d7f8437dc7140941c4335284ce075e',
    hashes: {
      'encoder.onnx':
        'de5fe45294a00f45af907b783f3f4764dbdc95386676f4e20175d912cfe8e59a',
      'decoder.onnx':
        'd937474a36f212cd704acc811b9eef32405f3aa20c5da812d7bf227abbc6004b',
      'tokenizer.json':
        'ec4ca954798a092faf6fefcfa47fb5f85d76cdf6ab170b624ae1a683d53dae14',
    },
  },
  transferBytes: texTellerFiles.reduce((total, { size }) => total + size, 0),
  ...run,
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
await browser.disconnect();
console.log(`Wrote ${run.results.length} benchmark results to ${outputPath}`);
