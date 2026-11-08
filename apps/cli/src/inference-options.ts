import type { InferenceSession } from 'onnxruntime-node';

export const EXECUTION_PROVIDERS = ['cpu', 'coreml', 'webgpu'] as const;
export type ExecutionProvider = (typeof EXECUTION_PROVIDERS)[number];
export type ProviderSelection = ExecutionProvider | 'auto';

export function automaticProvider(
  backends: readonly { name: string; bundled: boolean }[],
  platform = process.platform,
): ExecutionProvider {
  const preferred: ExecutionProvider[] =
    platform === 'darwin' ? ['coreml', 'webgpu', 'cpu'] : ['webgpu', 'cpu'];
  const provider = preferred.find((name) =>
    backends.some((backend) => backend.name === name && backend.bundled),
  );
  if (!provider) throw new Error('No bundled inference provider is available.');
  return provider;
}

export function isExecutionProvider(value: string): value is ExecutionProvider {
  return EXECUTION_PROVIDERS.some((provider) => provider === value);
}

export function nativeSessionOptions(
  provider: ExecutionProvider,
  backends: readonly { name: string; bundled: boolean }[],
): InferenceSession.SessionOptions {
  if (!backends.some((backend) => backend.name === provider && backend.bundled))
    throw new Error(
      `Execution provider ${provider} is not bundled for this platform.`,
    );
  const executionProvider: InferenceSession.ExecutionProviderConfig =
    provider === 'coreml'
      ? // MLProgram + static-shape partitions + CPU/GPU, avoiding invalid dynamic CoreML shapes.
        { name: 'coreml', coreMlFlags: 0x010 | 0x008 | 0x020 }
      : provider === 'webgpu'
        ? { name: 'webgpu', validationMode: 'full' }
        : 'cpu';
  return {
    executionProviders: [executionProvider],
    graphOptimizationLevel: 'all',
    logSeverityLevel: 3,
  };
}
