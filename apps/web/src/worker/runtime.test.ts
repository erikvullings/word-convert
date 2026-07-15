import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createWorkerRuntime } from './runtime.ts';
import type { WorkerResponse } from './protocol.ts';

const fixturePath = fileURLToPath(
  new URL(
    '../../../../tests/fixtures/docx/standard-comprehensive.docx',
    import.meta.url,
  ),
);

async function fixtureBuffer(): Promise<ArrayBuffer> {
  const bytes = await readFile(fixturePath);
  return Uint8Array.from(bytes).buffer;
}

describe('worker runtime', () => {
  it('analyses a transferred DOCX buffer, reports progress, and cleans up', async () => {
    const sent: WorkerResponse[] = [];
    const runtime = createWorkerRuntime((message) => sent.push(message));

    await runtime.handle({
      type: 'analyse',
      operationId: 'analyse-1',
      input: await fixtureBuffer(),
      filename: 'fixture.docx',
      conversionDate: '2026-07-15',
    });

    expect(sent.some((message) => message.type === 'progress')).toBe(true);
    expect(sent.at(-1)).toMatchObject({
      type: 'analysed',
      operationId: 'analyse-1',
    });
    expect(runtime.activeOperationCount()).toBe(0);
  });

  it('rebuilds the model with explicit edited style mappings', async () => {
    const sent: WorkerResponse[] = [];
    const runtime = createWorkerRuntime((message) => sent.push(message));
    await runtime.handle({
      type: 'analyse',
      operationId: 'initial',
      input: await fixtureBuffer(),
      filename: 'fixture.docx',
      conversionDate: '2026-07-15',
    });
    const initial = sent.find((message) => message.type === 'analysed');
    if (!initial || initial.type !== 'analysed') throw new Error('No model');
    const styleId = initial.model.styles[0]?.id;
    if (!styleId) throw new Error('No analysed style');

    await runtime.handle({
      type: 'analyse',
      operationId: 'rerun',
      input: await fixtureBuffer(),
      filename: 'fixture.docx',
      conversionDate: '2026-07-15',
      styleMappings: { [styleId]: 'ignore' },
    });

    const rerun = sent.find(
      (message) =>
        message.type === 'analysed' && message.operationId === 'rerun',
    );
    expect(
      rerun?.type === 'analysed' &&
        rerun.model.styles.find(({ id }) => id === styleId),
    ).toMatchObject({
      proposedMapping: 'ignore',
      provenance: { method: 'user', confidence: 'certain' },
    });
  });

  it.each([
    ['html', 'document.html', '<!doctype html>'],
    ['markdown', 'document.md', '#'],
  ] as const)(
    'converts an analysed fixture to downloadable %s',
    async (format, filename, contentStart) => {
      const sent: WorkerResponse[] = [];
      const runtime = createWorkerRuntime((message) => sent.push(message));
      await runtime.handle({
        type: 'analyse',
        operationId: 'analyse-2',
        input: await fixtureBuffer(),
        filename: 'fixture.docx',
        conversionDate: '2026-07-15',
      });
      const analysed = sent.find((message) => message.type === 'analysed');
      if (!analysed || analysed.type !== 'analysed')
        throw new Error('No model');

      await runtime.handle({
        type: 'convert',
        operationId: `convert-${format}`,
        model: analysed.model,
        format,
        conversionDate: '2026-07-15',
      });

      const output = sent.at(-1);
      expect(output).toMatchObject({ type: 'output', filename });
      if (!output || output.type !== 'output') throw new Error('No output');
      expect(new TextDecoder().decode(output.data)).toContain(contentStart);
      expect(runtime.activeOperationCount()).toBe(0);
    },
  );

  it('creates an EPUB and reports its internal file layout', async () => {
    const sent: WorkerResponse[] = [];
    const runtime = createWorkerRuntime((message) => sent.push(message));
    await runtime.handle({
      type: 'analyse',
      operationId: 'analyse-epub',
      input: await fixtureBuffer(),
      filename: 'fixture.docx',
      conversionDate: '2026-07-15',
    });
    const analysed = sent.find((message) => message.type === 'analysed');
    if (!analysed || analysed.type !== 'analysed') throw new Error('No model');
    const provenance = {
      source: 'test',
      method: 'user' as const,
      confidence: 'certain' as const,
    };
    analysed.model.metadata.title ??= { value: 'Fixture', provenance };
    analysed.model.metadata.language ??= { value: 'en', provenance };
    analysed.model.metadata.identifier ??= {
      value: 'urn:wordconvert:fixture',
      provenance,
    };

    await runtime.handle({
      type: 'convert',
      operationId: 'convert-epub',
      model: analysed.model,
      format: 'epub',
      conversionDate: '2026-07-15',
    });

    expect(sent.at(-1)).toMatchObject({
      type: 'output',
      filename: 'document.epub',
      mediaType: 'application/epub+zip',
      files: expect.arrayContaining([
        'mimetype',
        'META-INF/container.xml',
        'EPUB/package.opf',
        'EPUB/nav.xhtml',
      ]),
    });
  });

  it('returns private structured errors and supports cancellation', async () => {
    const sent: WorkerResponse[] = [];
    const runtime = createWorkerRuntime((message) => sent.push(message));
    await runtime.handle({ type: 'cancel', operationId: 'cancelled-1' });
    await runtime.handle({
      type: 'analyse',
      operationId: 'cancelled-1',
      input: new ArrayBuffer(0),
      filename: 'private words.docx',
      conversionDate: '2026-07-15',
    });

    const error = sent.at(-1);
    expect(error).toMatchObject({
      type: 'error',
      error: { code: 'cancelled', recoverable: true },
    });
    expect(JSON.stringify(error)).not.toContain('private words');
    expect(runtime.activeOperationCount()).toBe(0);
  });

  it('preserves and sanitizes an actual DOCX reader failure', async () => {
    const sent: WorkerResponse[] = [];
    const runtime = createWorkerRuntime((message) => sent.push(message));

    await runtime.handle({
      type: 'analyse',
      operationId: 'unsupported-1',
      input: Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0]).buffer,
      filename: 'private-name.docx',
      conversionDate: '2026-07-15',
    });

    const response = sent.at(-1);
    expect(response).toEqual({
      type: 'error',
      operationId: 'unsupported-1',
      error: {
        code: 'unsupported-format',
        message: 'Input is not a DOCX ZIP package.',
        recoverable: false,
        phase: 'read',
      },
    });
    expect(
      Object.getPrototypeOf(response?.type === 'error' ? response.error : {}),
    ).toBe(Object.prototype);
    expect(JSON.stringify(response)).not.toContain('private-name');
    expect(runtime.activeOperationCount()).toBe(0);
  });
});
