import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  createZip,
  createEntryCountLimitFixture,
  createExpandedSizeLimitFixture,
} from '../../../scripts/generate-docx-fixtures.mjs';
import { DocxReadError, secureDocxReader } from './index.ts';

const fixture = async (name: string) =>
  readFile(new URL(`../../../tests/fixtures/docx/${name}`, import.meta.url));
const options = { conversionDate: '2026-07-14T00:00:00.000Z' };

const docxWithSvg = (svg: string) =>
  createZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="svg" ContentType="image/svg+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Safe document</w:t><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p></w:body></w:document>`,
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.svg"/></Relationships>`,
    },
    { name: 'word/media/image.svg', data: svg },
  ]);

const macroEnabledDocx = () =>
  createZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/><Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>`,
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Corporate report</w:t></w:r></w:p></w:body></w:document>`,
    },
    { name: 'word/vbaProject.bin', data: 'not executed' },
  ]);

const styledLayoutDocx = () =>
  createZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="RapportTitel"/></w:pPr><w:r><w:t>Annual report</w:t></w:r></w:p><w:p><w:r><w:drawing/></w:r></w:p><w:p><w:pPr><w:pStyle w:val="PhotoNote"/></w:pPr><w:r><w:rPr><w:rStyle w:val="CaptionLabel"/></w:rPr><w:t>Fig.</w:t></w:r><w:r><w:t> Overview of the site</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:pPr><w:pStyle w:val="TableNote"/></w:pPr><w:r><w:t>Results by region</w:t></w:r></w:p><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>`,
    },
    {
      name: 'word/styles.xml',
      data: `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="RapportTitel"><w:name w:val="**RapportTitel"/><w:rPr><w:sz w:val="88"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="PhotoNote"><w:name w:val="Small note"/></w:style><w:style w:type="character" w:styleId="CaptionLabel"><w:name w:val="CaptionLabel"/></w:style><w:style w:type="paragraph" w:styleId="TableNote"><w:name w:val="Data note"/></w:style></w:styles>`,
    },
  ]);

describe('secure DOCX reader', () => {
  it('uses top-level figure and table adjacency when analysing styles', async () => {
    const model = await secureDocxReader.read(styledLayoutDocx(), options);
    const mappings = Object.fromEntries(
      model.styles.map(({ id, proposedMapping }) => [id, proposedMapping]),
    );

    expect(mappings).toMatchObject({
      RapportTitel: 'title',
      PhotoNote: 'caption',
      CaptionLabel: 'caption',
      TableNote: 'caption',
    });
    expect(model.blocks[0]).toMatchObject({
      type: 'heading',
      level: 1,
      styleId: 'RapportTitel',
    });
  });

  it('converts the comprehensive OOXML fixture into the neutral model', async () => {
    const model = await secureDocxReader.read(
      await fixture('standard-comprehensive.docx'),
      options,
    );

    expect(model.metadata.title?.value).toBe('Fixture Corpus');
    expect(model.metadata.authors[0]?.value.name).toBe('Ada Example');
    expect(model.metadata.language?.value).toBe('en-GB');
    expect(model.blocks.some((block) => block.type === 'heading')).toBe(true);
    expect(
      model.blocks.find(
        (block) => block.type === 'heading' && block.styleId === 'Heading1',
      ),
    ).toMatchObject({ type: 'heading', level: 2 });
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

  it('normalizes numeric language metadata and infers an identifier from filename', async () => {
    const input = createZip([
      {
        name: '[Content_Types].xml',
        data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
      },
      {
        name: 'word/document.xml',
        data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>`,
      },
      {
        name: 'docProps/core.xml',
        data: `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quarterly report</dc:title><dc:language>2057</dc:language></cp:coreProperties>`,
      },
    ]);

    const model = await secureDocxReader.read(input, {
      ...options,
      filename: 'Quarterly Report.docx',
    });

    expect(model.metadata.language?.value).toBe('en-GB');
    expect(model.metadata.identifier?.value).toBe(
      'urn:wordconvert:quarterly-report',
    );
  });

  it.each([
    ['malformed.zip', 'invalid-input'],
    ['path-traversal.docx', 'invalid-input'],
    ['compression-ratio.docx', 'resource-limit'],
    ['unsafe-link.docx', 'unsupported-format'],
    ['xml-entity-expansion.docx', 'invalid-input'],
  ])('rejects hostile fixture %s as %s', async (name, code) => {
    await expect(
      secureDocxReader.read(await fixture(name), options),
    ).rejects.toMatchObject({
      name: 'DocxReadError',
      code,
    });
  });

  it('disables VBA macros and reads the document body', async () => {
    const model = await secureDocxReader.read(macroEnabledDocx(), options);
    const standardDocumentWithVba = await secureDocxReader.read(
      await fixture('unsupported-macro.docm'),
      options,
    );

    expect(JSON.stringify(model.blocks)).toContain('Corporate report');
    const warning = {
      code: 'active-content-disabled',
      severity: 'warning',
      message: 'Active document content was disabled.',
    } as const;
    expect(model.warnings).toContainEqual(warning);
    expect(standardDocumentWithVba.warnings).toContainEqual(warning);
  });

  it('quarantines active SVG resources and reads the document body', async () => {
    const model = await secureDocxReader.read(
      await fixture('active-svg.docx'),
      options,
    );

    expect(model.warnings).toContainEqual({
      code: 'active-content-disabled',
      severity: 'warning',
      message: 'Active document content was disabled.',
    });
    expect(Object.values(model.assets)).toHaveLength(0);
  });

  it('quarantines packaged HTML resources', async () => {
    const input = createZip([
      {
        name: '[Content_Types].xml',
        data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="html" ContentType="text/html"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      },
      {
        name: 'word/document.xml',
        data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Report body</w:t></w:r></w:p></w:body></w:document>`,
      },
      {
        name: 'word/afchunk.html',
        data: '<script>alert(1)</script>',
      },
    ]);

    const model = await secureDocxReader.read(input, options);
    expect(JSON.stringify(model.blocks)).toContain('Report body');
    expect(model.warnings.map(({ code }) => code)).toContain(
      'active-content-disabled',
    );
  });

  it('allows a passive SVG package resource', async () => {
    const model = await secureDocxReader.read(
      docxWithSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#123456" d="M0 0h10v10H0z"/></svg>',
      ),
      options,
    );

    expect(JSON.stringify(model.blocks)).toContain('Safe document');
    expect(Object.values(model.assets)).toEqual([
      expect.objectContaining({ mediaType: 'image/svg+xml' }),
    ]);
  });

  it.each([
    ['scripts', '<script>alert(1)</script>'],
    ['event handlers', '<path onload="alert(1)"/>'],
    ['external references', '<image href="https://example.invalid/a.png"/>'],
    [
      'external paint servers',
      '<path fill="url(https://example.invalid/a.svg)"/>',
    ],
    ['active CSS', '<style>@import url(https://example.invalid/a.css)</style>'],
    ['processing instructions', '<?xml-stylesheet href="remote.css"?>'],
  ])(
    'quarantines SVG package resources containing %s',
    async (_name, content) => {
      const model = await secureDocxReader.read(
        docxWithSvg(`<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`),
        options,
      );

      expect(JSON.stringify(model.blocks)).toContain('Safe document');
      expect(Object.values(model.assets)).toHaveLength(0);
      expect(model.warnings.map(({ code }) => code)).toContain(
        'active-content-disabled',
      );
    },
  );

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
