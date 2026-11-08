import {
  createTexTellerRecognizer,
  type FormulaRecognizerDependencies,
  type TexTellerModelAssets,
} from '@wordconvert/pdf-reader';
import { browserFormulaRecognizerDependencies } from './formula-model-runtime.ts';

export {
  normalizeTexTellerLatex,
  prepareTexTellerInput,
  splitTexTellerRows,
  type TexTellerBenchmarkRecognizer,
  type TexTellerModelAssets,
} from '@wordconvert/pdf-reader';

export function createTexTellerBenchmarkRecognizer(
  assets: TexTellerModelAssets,
  options: {
    dependencies?: FormulaRecognizerDependencies;
    maxTokens?: number;
  } = {},
) {
  return createTexTellerRecognizer(assets, {
    ...options,
    dependencies: options.dependencies ?? browserFormulaRecognizerDependencies,
  });
}
