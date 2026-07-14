import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createEntryCountLimitFixture,
  createExpandedSizeLimitFixture,
  generateFixtureCorpus,
} from '../scripts/generate-docx-fixtures.mjs';

const fixtureDirectory = new URL('./fixtures/docx/', import.meta.url);

interface Manifest {
  name: string;
  category: string;
  features: string[];
  sha256: string;
  byteLength: number;
  entries: string[];
}

interface Corpus {
  schemaVersion: number;
  fixtures: Manifest[];
  generatedOnDemand: Array<{ name: string; features: string[] }>;
}

const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

describe('DOCX fixture corpus', () => {
  it('matches every committed fixture manifest', async () => {
    const corpus = JSON.parse(
      await readFile(new URL('corpus.json', fixtureDirectory), 'utf8'),
    ) as Corpus;
    expect(corpus.schemaVersion).toBe(1);

    for (const fixture of corpus.fixtures) {
      const bytes = await readFile(new URL(fixture.name, fixtureDirectory));
      const individual = JSON.parse(
        await readFile(
          new URL(`${fixture.name}.manifest.json`, fixtureDirectory),
          'utf8',
        ),
      ) as Manifest;
      expect(individual).toEqual(fixture);
      expect(bytes.length).toBe(fixture.byteLength);
      expect(hash(bytes)).toBe(fixture.sha256);
    }
  });

  it('covers the required valid, localized, mathematical, and hostile cases', async () => {
    const corpus = JSON.parse(
      await readFile(new URL('corpus.json', fixtureDirectory), 'utf8'),
    ) as Corpus;
    const features = new Set([
      ...corpus.fixtures.flatMap((fixture) => fixture.features),
      ...corpus.generatedOnDemand.flatMap((fixture) => fixture.features),
    ]);
    const required = [
      'standard-headings',
      'custom-styles',
      'unstyled-visual-heading',
      'lists',
      'nested-lists',
      'tables',
      'hyperlinks',
      'footnotes',
      'endnotes',
      'comments',
      'tracked-changes',
      'headers',
      'footers',
      'watermark',
      'multiple-images',
      'cover-page',
      'metadata',
      'omml-inline',
      'omml-display',
      'fraction',
      'root',
      'matrix',
      'superscript',
      'subscript',
      'unicode',
      'rtl',
      'dutch',
      'german',
      'french',
      'spanish',
      'italian',
      'polish',
      'swedish',
      'malformed-zip',
      'zip-path-traversal',
      'extreme-compression-ratio',
      'excessive-entry-count',
      'excessive-expanded-size',
      'javascript-url',
      'remote-resource',
      'active-svg',
      'doctype',
      'entity-expansion',
      'macro-enabled-content',
    ];
    expect(required.filter((feature) => !features.has(feature))).toEqual([]);
  });

  it('regenerates byte-for-byte', async () => {
    const output = await mkdtemp(join(tmpdir(), 'wordconvert-fixtures-'));
    await generateFixtureCorpus(output);
    for (const name of await readdir(output)) {
      expect(await readFile(join(output, name))).toEqual(
        await readFile(new URL(name, fixtureDirectory)),
      );
    }
  });

  it('generates exceptional security limits on demand', () => {
    const entryCount = createEntryCountLimitFixture(1100);
    const expandedSize = createExpandedSizeLimitFixture(1024 * 1024);
    expect(entryCount.length).toBeGreaterThan(1000);
    expect(expandedSize.length).toBeLessThan(2048);
    expect(entryCount.subarray(0, 4).toString()).toBe('PK\u0003\u0004');
    expect(expandedSize.subarray(0, 4).toString()).toBe('PK\u0003\u0004');
  });
});
