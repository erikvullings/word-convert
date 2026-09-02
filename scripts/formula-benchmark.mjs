import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import katex from 'katex';

export function normalizeBenchmarkTex(value) {
  let normalized = value
    .trim()
    .replace(/^\$\$?|\$\$?$/g, '')
    .replaceAll(/\\left|\\right/g, '')
    .replaceAll(/\s+/g, '');
  while (normalized.startsWith('{') && normalized.endsWith('}')) {
    const inner = normalized.slice(1, -1);
    if (!isBalanced(inner)) break;
    normalized = inner;
  }
  return normalized;
}

export function editDistance(left, right) {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + Number(left[row - 1] !== right[column - 1]),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

export function summarizeFormulaBenchmark(corpus, run) {
  const predictions = new Map(run.results.map((result) => [result.id, result]));
  const cases = corpus.cases.map((testCase) => {
    const result = predictions.get(testCase.id);
    const expected = normalizeBenchmarkTex(testCase.tex);
    const actual = normalizeBenchmarkTex(result?.tex ?? '');
    const distance = editDistance(expected, actual);
    return {
      id: testCase.id,
      category: testCase.category,
      exact: expected === actual,
      parseSuccess: actual !== '' && parses(actual),
      editDistance: distance,
      normalizedEditDistance:
        expected.length === 0 ? 0 : distance / expected.length,
      durationMs: result?.durationMs ?? null,
      failure: result?.failure ?? null,
    };
  });
  const completed = cases.filter(({ durationMs }) => durationMs !== null);
  const durations = completed
    .map(({ durationMs }) => durationMs)
    .sort((a, b) => a - b);
  const categories = Object.fromEntries(
    [...new Set(cases.map(({ category }) => category))].map((category) => {
      const subset = cases.filter((entry) => entry.category === category);
      return [category, metrics(subset)];
    }),
  );
  return {
    schema: 'wordconvert.formula-benchmark-report',
    version: 1,
    model: run.model,
    environment: run.environment,
    initializationMs: run.initializationMs,
    transferBytes: run.transferBytes,
    peakMemoryBytes: run.peakMemoryBytes ?? null,
    totals: metrics(cases),
    timing: {
      completed: completed.length,
      medianMs: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
    },
    categories,
    cases,
  };
}

function metrics(cases) {
  return {
    cases: cases.length,
    exact: cases.filter(({ exact }) => exact).length,
    parseSuccess: cases.filter(({ parseSuccess }) => parseSuccess).length,
    meanNormalizedEditDistance:
      cases.reduce((sum, entry) => sum + entry.normalizedEditDistance, 0) /
      Math.max(1, cases.length),
    failures: cases.filter(({ failure }) => failure !== null).length,
  };
}

function parses(tex) {
  try {
    katex.renderToString(tex, {
      strict: 'error',
      throwOnError: true,
      trust: false,
    });
    return true;
  } catch {
    return false;
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  return values[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ];
}

function isBalanced(value) {
  let depth = 0;
  for (const character of value) {
    if (character === '{') depth++;
    if (character === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const [corpusPath, runPath, outputPath] = process.argv.slice(2);
  if (!corpusPath || !runPath || !outputPath)
    throw new Error(
      'Usage: formula-benchmark <corpus.json> <run.json> <report.json>',
    );
  const corpus = JSON.parse(await readFile(resolve(corpusPath), 'utf8'));
  const run = JSON.parse(await readFile(resolve(runPath), 'utf8'));
  const report = summarizeFormulaBenchmark(corpus, run);
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
}
