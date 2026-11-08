import { describe, expect, it } from 'vitest';
import { analysePdf, pdfJsReader } from './index.ts';

function pdfWithXmp(creators: string[], author?: string): Uint8Array {
  const xml = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq>${creators.map((name) => `<rdf:li>${name}</rdf:li>`).join('')}</rdf:Seq></dc:creator><dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP book</rdf:li></rdf:Alt></dc:title><dc:language><rdf:Bag><rdf:li>en</rdf:li></rdf:Bag></dc:language></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Metadata 4 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>',
    `<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xml)} >>\nstream\n${xml}\nendstream`,
    `<< /Producer (WordConvert test)${author === undefined ? '' : ` /Author (${author})`} >>`,
  ];
  let source = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(source));
}

describe('PDF XMP metadata extraction', () => {
  it.each([{ creators: [] }, { creators: [''] }, { creators: [' ', ''] }])(
    'ignores empty creator sequences %j without crashing analysis',
    async ({ creators }) => {
      const options = {
        filename: 'xmp.pdf',
        conversionDate: '2026-01-02',
      };
      const raw = await pdfJsReader.readRaw(pdfWithXmp(creators), options);
      const { model } = await analysePdf(raw, options);
      expect(raw.metadata.author).toBeUndefined();
      expect(model.metadata.authors).toEqual([]);
      expect(raw.metadata.title).toBe('XMP book');
      expect(raw.metadata.language).toBe('en');
    },
  );

  it('normalizes nonempty creator sequences and ignores blank entries', async () => {
    const raw = await pdfJsReader.readRaw(pdfWithXmp([' Alice ', '', 'Bob']), {
      filename: 'xmp.pdf',
      conversionDate: '2026-01-02',
    });
    const { model } = await analysePdf(raw, {
      filename: 'xmp.pdf',
      conversionDate: '2026-01-02',
    });
    expect(raw.metadata.author).toBe('Alice, Bob');
    expect(model.metadata.authors[0]?.value.name).toBe('Alice, Bob');
  });

  it('keeps document-info author precedence over XMP creators', async () => {
    const raw = await pdfJsReader.readRaw(
      pdfWithXmp(['Alice', 'Bob'], 'Info author'),
      {
        filename: 'xmp.pdf',
        conversionDate: '2026-01-02',
      },
    );
    expect(raw.metadata.author).toBe('Info author');
  });
});
