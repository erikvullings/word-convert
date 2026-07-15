import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  createEntryCountLimitFixture,
  createExpandedSizeLimitFixture,
} from '../../../scripts/generate-docx-fixtures.mjs';
import { DocxReadError, secureDocxReader } from './index.ts';

const fixture = async (name: string) =>
  readFile(new URL(`../../../tests/fixtures/docx/${name}`, import.meta.url));
const options = { conversionDate: '2026-07-14T00:00:00.000Z' };

describe('secure DOCX reader', () => {
  it('converts the comprehensive OOXML fixture into the neutral model', async () => {
    const model = await secureDocxReader.read(
      await fixture('standard-comprehensive.docx'),
      options,
    );

    expect(model.metadata.title?.value).toBe('Fixture Corpus');
    expect(model.metadata.authors[0]?.value.name).toBe('Ada Example');
    expect(model.metadata.language?.value).toBe('en-GB');
    expect(model.blocks.some((block) => block.type === 'heading')).toBe(true);
    expect(model.blocks.some((block) => block.type === 'list')).toBe(true);
    const list = model.blocks.find((block) => block.type === 'list');
    expect(
      list?.type === 'list' &&
        list.items[0]?.blocks.some((block) => block.type === 'list'),
    ).toBe(true);
    expect(model.blocks.some((block) => block.type === 'table')).toBe(true);
    expect(JSON.stringify(model.blocks)).toContain(
      'https://example.invalid/safe',
    );
    expect(Object.keys(model.notes)).toEqual(['footnote-1', 'endnote-1']);
    expect(Object.keys(model.assets)).toHaveLength(2);
    expect(Object.keys(model.equations)).toHaveLength(2);
    expect(model.styles.map((style) => style.id)).toContain('Heading1');
    expect(model.warnings.map((warning) => warning.code)).toContain(
      'decorative-furniture-omitted',
    );
    expect(model.warnings.map((warning) => warning.code)).toContain(
      'comments-omitted',
    );
    expect(JSON.stringify(model.blocks)).not.toContain('Repeated header');
    expect(JSON.stringify(model.blocks)).not.toContain('Deleted text');
  });

  it.each([
    ['malformed.zip', 'invalid-input'],
    ['path-traversal.docx', 'invalid-input'],
    ['compression-ratio.docx', 'resource-limit'],
    ['unsafe-link.docx', 'unsupported-format'],
    ['active-svg.docx', 'unsupported-format'],
    ['xml-entity-expansion.docx', 'invalid-input'],
    ['unsupported-macro.docm', 'unsupported-format'],
  ])('rejects hostile fixture %s as %s', async (name, code) => {
    await expect(
      secureDocxReader.read(await fixture(name), options),
    ).rejects.toMatchObject({
      name: 'DocxReadError',
      code,
    });
  });

  it('enforces configurable entry and expanded-size limits before extraction', async () => {
    await expect(
      secureDocxReader.read(createEntryCountLimitFixture(10), {
        ...options,
        limits: { maxEntries: 5 },
      }),
    ).rejects.toMatchObject({ code: 'resource-limit' });
    await expect(
      secureDocxReader.read(createExpandedSizeLimitFixture(1024), {
        ...options,
        limits: { maxUncompressedBytes: 512 },
      }),
    ).rejects.toMatchObject({ code: 'resource-limit' });
  });

  it('rejects legacy input and honours cancellation without exposing content', async () => {
    await expect(
      secureDocxReader.read(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), options),
    ).rejects.toMatchObject({ code: 'unsupported-format' });
    const error = await secureDocxReader
      .read(await fixture('standard-comprehensive.docx'), {
        ...options,
        filename: 'private-name.docx',
        cancellation: { cancelled: true },
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DocxReadError);
    expect(JSON.stringify(error)).not.toContain('private-name.docx');
  });

  it('rejects encrypted ZIP entries before extraction', async () => {
    const encrypted = Uint8Array.from(
      await fixture('standard-comprehensive.docx'),
    );
    encrypted[6] = encrypted[6]! | 1;
    for (let index = 0; index < encrypted.length - 4; index += 1) {
      if (
        encrypted[index] === 0x50 &&
        encrypted[index + 1] === 0x4b &&
        encrypted[index + 2] === 0x01 &&
        encrypted[index + 3] === 0x02
      ) {
        encrypted[index + 8] = encrypted[index + 8]! | 1;
        break;
      }
    }
    await expect(
      secureDocxReader.read(encrypted, options),
    ).rejects.toMatchObject({ code: 'encrypted-document' });
  });

  it('analyzes every used style with effective formatting, examples, confidence, and reasons', async () => {
    const model = await secureDocxReader.read(
      await fixture('standard-comprehensive.docx'),
      options,
    );
    expect(model.styles.length).toBeGreaterThan(0);
    expect(model.styles.every(({ usageCount }) => usageCount > 0)).toBe(true);
    expect(model.styles.every(({ examples }) => examples.length > 0)).toBe(
      true,
    );
    expect(
      model.styles.every(
        ({ provenance }) =>
          Boolean(provenance.reason) && Boolean(provenance.confidence),
      ),
    ).toBe(true);
    expect(model.styles.find(({ id }) => id === 'Heading1')).toMatchObject({
      proposedMapping: 'heading1',
      formatting: { outlineLevel: 0 },
    });
  });

  it('uses localized aliases as fallback and applies explicit rerun mappings deterministically', async () => {
    const input = await fixture('localized-european-styles.docx');
    const proposed = await secureDocxReader.read(input, options);
    expect(
      proposed.styles.find(({ id }) => id === 'Untertitel')?.proposedMapping,
    ).toBe('heading1');
    expect(
      proposed.styles.find(({ id }) => id === 'Citat')?.provenance.reason,
    ).toContain('OOXML outline level');

    const rerunOptions = {
      ...options,
      stylePreset: { Kop1: 'heading2' as const },
      styleMappings: { Kop1: 'blockquote' as const },
    };
    const first = await secureDocxReader.read(input, rerunOptions);
    const second = await secureDocxReader.read(input, rerunOptions);
    expect(first).toEqual(second);
    expect(first.styles.find(({ id }) => id === 'Kop1')).toMatchObject({
      proposedMapping: 'blockquote',
      provenance: { method: 'user', confidence: 'certain' },
    });
  });

  it('keeps large unstyled text as a paragraph when font size is the only heading signal', async () => {
    const model = await secureDocxReader.read(
      await fixture('visual-heading.docx'),
      options,
    );
    expect(model.styles.find(({ id }) => id === 'Normal')).toMatchObject({
      usageCount: 2,
      proposedMapping: 'body',
    });
    expect(model.blocks.every(({ type }) => type === 'paragraph')).toBe(true);
  });
});
