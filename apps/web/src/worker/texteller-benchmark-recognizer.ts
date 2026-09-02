import type {
  PdfFormulaImage,
  PdfFormulaRecognition,
  PdfFormulaRecognizer,
} from '@wordconvert/pdf-reader';

interface TexTellerOutput {
  generated_text: string;
}

interface TexTellerPipeline {
  (
    image: unknown,
    options: { max_new_tokens: number },
  ): Promise<TexTellerOutput[]>;
  dispose(): Promise<void>;
}

interface TexTellerImageFactory {
  create(image: PdfFormulaImage): unknown;
}

export interface TexTellerDependencies {
  load(): Promise<{
    pipeline: TexTellerPipeline;
    images: TexTellerImageFactory;
  }>;
  validateTex(tex: string): boolean;
}

export interface TexTellerBenchmarkRecognizer extends PdfFormulaRecognizer {
  prepare(): Promise<boolean>;
  dispose(): Promise<void>;
}

export function createTexTellerBenchmarkRecognizer(
  dependencies: TexTellerDependencies,
  maxTokens = 128,
): TexTellerBenchmarkRecognizer {
  let loaded: ReturnType<TexTellerDependencies['load']> | undefined;
  let disposed = false;
  const load = () => {
    if (disposed)
      throw new Error('TexTeller benchmark recognizer is disposed.');
    return (loaded ??= dependencies.load());
  };
  return {
    implementation: 'texteller-onnx-q4f16',
    async prepare() {
      try {
        await load();
        return true;
      } catch {
        loaded = undefined;
        return false;
      }
    },
    async recognize(image, options) {
      if (options?.cancellation?.cancelled)
        throw new Error('Conversion cancelled.');
      const active = await load();
      const output = await active.pipeline(active.images.create(image), {
        max_new_tokens: Math.min(512, Math.max(1, maxTokens)),
      });
      if (options?.cancellation?.cancelled)
        throw new Error('Conversion cancelled.');
      const tex = output[0]?.generated_text.trim() ?? '';
      if (!tex || !dependencies.validateTex(tex))
        throw new Error('TexTeller returned invalid TeX.');
      return { tex } satisfies PdfFormulaRecognition;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const pending = loaded;
      loaded = undefined;
      const active = pending ? await pending.catch(() => undefined) : undefined;
      await active?.pipeline.dispose();
    },
  };
}
