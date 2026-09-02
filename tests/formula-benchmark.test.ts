import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  editDistance,
  normalizeBenchmarkTex,
  summarizeFormulaBenchmark,
} from '../scripts/formula-benchmark.mjs';

describe('formula benchmark metrics', () => {
  it('commits 60 generated cases across every difficult benchmark category', async () => {
    const corpus = JSON.parse(
      await readFile(
        fileURLToPath(
          new URL('./fixtures/formula-benchmark/corpus.json', import.meta.url),
        ),
        'utf8',
      ),
    ) as { cases: Array<{ category: string; width: number; height: number }> };

    expect(corpus.cases).toHaveLength(60);
    expect(new Set(corpus.cases.map(({ category }) => category))).toEqual(
      new Set([
        'inline',
        'scripts',
        'greek',
        'operator',
        'relation',
        'fraction',
        'root',
        'matrix',
        'multiline',
        'rare-symbol',
        'equation-number',
      ]),
    );
    expect(
      corpus.cases.every(({ width, height }) => width > 0 && height > 0),
    ).toBe(true);
  });

  it('normalizes only harmless TeX presentation differences', () => {
    expect(normalizeBenchmarkTex(' $$ { \\left(x + y\\right) } $$ ')).toBe(
      '(x+y)',
    );
    expect(normalizeBenchmarkTex('x^2')).not.toBe(normalizeBenchmarkTex('x*x'));
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('reports exact, parse, distance, timing, and difficult subsets', () => {
    const report = summarizeFormulaBenchmark(
      {
        cases: [
          { id: 'a', category: 'inline', tex: 'x + y' },
          {
            id: 'b',
            category: 'matrix',
            tex: '\\begin{bmatrix}1\\end{bmatrix}',
          },
        ],
      },
      {
        model: { implementation: 'test', revision: '1', hashes: {} },
        environment: { browser: 'test', provider: 'wasm' },
        initializationMs: 10,
        transferBytes: 20,
        peakMemoryBytes: 30,
        results: [
          { id: 'a', tex: 'x+y', durationMs: 4 },
          { id: 'b', tex: 'invalid{', durationMs: 8 },
        ],
      },
    );

    expect(report.totals).toMatchObject({
      cases: 2,
      exact: 1,
      parseSuccess: 1,
    });
    expect(report.categories.matrix).toMatchObject({ cases: 1, exact: 0 });
    expect(report.timing).toEqual({ completed: 2, medianMs: 8, p95Ms: 8 });
  });
});
