import type { PdfFormulaRecognizer } from '@wordconvert/pdf-reader';

import { textTellerAssetPath } from './texteller-assets.ts';

export function createConfiguredFormulaRecognizer(): PdfFormulaRecognizer {
  let recognizer:
    | Promise<
        import('./texteller-benchmark-recognizer.ts').TexTellerBenchmarkRecognizer
      >
    | undefined;
  return {
    implementation: 'texteller-onnx-q4',
    async recognize(image, options) {
      let loaded: import('./texteller-benchmark-recognizer.ts').TexTellerBenchmarkRecognizer;
      try {
        loaded = await (recognizer ??= loadFormulaRecognizer());
      } catch {
        recognizer = undefined;
        throw new Error('Formula recognizer is unavailable.');
      }
      return loaded.recognize(image, options);
    },
    async dispose() {
      const active = recognizer;
      recognizer = undefined;
      await (await active?.catch(() => undefined))?.dispose();
    },
  };
}

async function loadFormulaRecognizer() {
  const base = new URL(__WORDCONVERT_BASE_PATH__, self.location.origin);
  const tokenizerUrl = new URL(textTellerAssetPath('tokenizer.json'), base);
  const [{ createTexTellerBenchmarkRecognizer }, response] = await Promise.all([
    import('./texteller-benchmark-recognizer.ts'),
    fetch(tokenizerUrl),
  ]);
  if (!response.ok) throw new Error('TexTeller tokenizer is unavailable.');
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json'))
    throw new Error('TexTeller tokenizer response is not JSON.');
  const tokenizer = await response.text();
  try {
    JSON.parse(tokenizer);
  } catch {
    throw new Error('TexTeller tokenizer response is invalid.');
  }
  return createTexTellerBenchmarkRecognizer({
    encoder: new URL(textTellerAssetPath('encoder.onnx'), base).href,
    decoder: new URL(textTellerAssetPath('decoder.onnx'), base).href,
    tokenizer,
  });
}
