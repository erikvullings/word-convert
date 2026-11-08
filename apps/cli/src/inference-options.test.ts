import { describe, expect, it } from 'vitest';
import {
  isExecutionProvider,
  nativeSessionOptions,
  automaticProvider,
} from './inference-options.ts';

const backends = [
  { name: 'cpu', bundled: true },
  { name: 'coreml', bundled: true },
  { name: 'webgpu', bundled: true },
];

describe('native inference providers', () => {
  it('automatically prefers macOS CoreML, otherwise WebGPU, then portable CPU', () => {
    expect(automaticProvider(backends, 'darwin')).toBe('coreml');
    expect(automaticProvider(backends, 'linux')).toBe('webgpu');
    expect(automaticProvider([{ name: 'cpu', bundled: true }], 'win32')).toBe(
      'cpu',
    );
    expect(() => automaticProvider([], 'linux')).toThrow('No bundled');
  });
  it('keeps CPU as the explicit portable configuration', () => {
    expect(nativeSessionOptions('cpu', backends).executionProviders).toEqual([
      'cpu',
    ]);
  });

  it('restricts CoreML to MLProgram static-shape partitions on CPU/GPU', () => {
    expect(nativeSessionOptions('coreml', backends).executionProviders).toEqual(
      [{ name: 'coreml', coreMlFlags: 0x010 | 0x008 | 0x020 }],
    );
  });

  it('enables full WebGPU validation', () => {
    expect(nativeSessionOptions('webgpu', backends).executionProviders).toEqual(
      [{ name: 'webgpu', validationMode: 'full' }],
    );
  });

  it.each(['coreml', 'webgpu'] as const)(
    'rejects unavailable %s rather than falling back silently',
    (provider) => {
      expect(() =>
        nativeSessionOptions(provider, [{ name: 'cpu', bundled: true }]),
      ).toThrow(`Execution provider ${provider} is not bundled`);
      expect(() =>
        nativeSessionOptions(provider, [{ name: provider, bundled: false }]),
      ).toThrow('not bundled');
    },
  );

  it('validates the complete provider input union', () => {
    for (const value of ['cpu', 'coreml', 'webgpu'])
      expect(isExecutionProvider(value)).toBe(true);
    for (const value of ['gpu', 'cuda', '', 'CPU'])
      expect(isExecutionProvider(value)).toBe(false);
  });
});
