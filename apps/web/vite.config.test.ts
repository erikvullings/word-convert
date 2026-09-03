import { describe, expect, it } from 'vitest';

import { resolveTexTellerDevModelDirectory } from './vite.config.ts';
import { textTellerAssetPath } from './src/worker/texteller-assets.ts';

describe('Vite formula recognizer configuration', () => {
  it('uses the same relative asset directory in development and builds', () => {
    expect(textTellerAssetPath('tokenizer.json')).toBe(
      'texteller/tokenizer.json',
    );
  });

  it('uses an explicit model directory before the local development cache', () => {
    expect(
      resolveTexTellerDevModelDirectory('/models/texteller', () => false),
    ).toBe('/models/texteller');
  });

  it('discovers the local development cache only when it exists', () => {
    const checked: string[] = [];
    expect(
      resolveTexTellerDevModelDirectory(undefined, (path) => {
        checked.push(path);
        return path === '/tmp/texteller-q4';
      }),
    ).toBe('/tmp/texteller-q4');
    expect(checked.at(-1)).toBe('/tmp/texteller-q4');
    expect(
      resolveTexTellerDevModelDirectory(undefined, () => false),
    ).toBeUndefined();
  });
});
