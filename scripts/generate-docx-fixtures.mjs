import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const encoder = new TextEncoder();
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x21; // 1980-01-01

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function asBytes(value) {
  return typeof value === 'string' ? encoder.encode(value) : value;
}

export function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = asBytes(entry.data);
    const method = entry.store ? 0 : 8;
    const compressed = method === 0 ? data : deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    const local = Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(method),
      uint16(FIXED_DOS_TIME),
      uint16(FIXED_DOS_DATE),
      uint32(checksum),
      uint32(compressed.length),
      uint32(data.length),
      uint16(name.length),
      uint16(0),
      name,
      compressed,
    ]);
    localParts.push(local);
    centralParts.push(
      Buffer.concat([
        uint32(0x02014b50),
        uint16(20),
        uint16(20),
        uint16(0x0800),
        uint16(method),
        uint16(FIXED_DOS_TIME),
        uint16(FIXED_DOS_DATE),
        uint32(checksum),
        uint32(compressed.length),
        uint32(data.length),
        uint16(name.length),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(0),
        uint32(offset),
        name,
      ]),
    );
    offset += local.length;
  }

  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(central.length),
    uint32(offset),
    uint16(0),
  ]);
}

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>
</Relationships>`;

const baseTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const wordRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  <Relationship Id="rFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rEndnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
  <Relationship Id="rComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
  <Relationship Id="rHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  <Relationship Id="rImage2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/>
  <Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/safe" TargetMode="External"/>
</Relationships>`;

const standardDocument = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Fixture Corpus</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr><w:r><w:t>Cover subtitle</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Author"/></w:pPr><w:r><w:t>Ada Example</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Standard heading</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="CustomHeading"/></w:pPr><w:r><w:t>Custom heading</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>List item</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested item</w:t></w:r></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  <w:p><w:hyperlink r:id="rLink"><w:r><w:t>Safe hyperlink</w:t></w:r></w:hyperlink></w:p>
  <w:p><w:commentRangeStart w:id="0"/><w:ins w:id="1" w:author="Editor" w:date="2024-01-01T00:00:00Z"><w:r><w:t>Inserted text</w:t></w:r></w:ins><w:del w:id="2" w:author="Editor" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>Deleted text</w:delText></w:r></w:del><w:commentRangeEnd w:id="0"/><w:r><w:footnoteReference w:id="1"/><w:endnoteReference w:id="1"/></w:r></w:p>
  <w:p><w:r><w:t>Unicode: café, Ελληνικά, 中文, 😀</w:t></w:r></w:p>
  <w:p><w:pPr><w:bidi/></w:pPr><w:r><w:rPr><w:rtl/><w:lang w:bidi="ar-SA"/></w:rPr><w:t>مرحبا بالعالم</w:t></w:r></w:p>
  <w:p><m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></w:p>
  <w:p><m:oMathPara><m:oMath><m:rad><m:deg/><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup><m:sSub><m:e><m:r><m:t>a</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub></m:sSub><m:m><m:mr><m:e><m:r><m:t>1</m:t></m:r></m:e><m:e><m:r><m:t>0</m:t></m:r></m:e></m:mr></m:m></m:oMath></m:oMathPara></w:p>
  <w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rImage1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
  <w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rImage2"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
  <w:sectPr><w:headerReference w:type="default" r:id="rHeader"/><w:footerReference w:type="default" r:id="rFooter"/></w:sectPr>
</w:body></w:document>`;

const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Author"><w:name w:val="Author"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CustomHeading"><w:name w:val="Project section"/><w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
</w:styles>`;

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function standardEntries() {
  return [
    { name: '[Content_Types].xml', data: baseTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: standardDocument },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/_rels/document.xml.rels', data: wordRels },
    {
      name: 'word/numbering.xml',
      data: `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    },
    {
      name: 'word/footnotes.xml',
      data: `<?xml version="1.0"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>Footnote text</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    },
    {
      name: 'word/endnotes.xml',
      data: `<?xml version="1.0"?><w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:endnote w:id="1"><w:p><w:r><w:t>Endnote text</w:t></w:r></w:p></w:endnote></w:endnotes>`,
    },
    {
      name: 'word/comments.xml',
      data: `<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Reviewer"><w:p><w:r><w:t>Review comment</w:t></w:r></w:p></w:comment></w:comments>`,
    },
    {
      name: 'word/header1.xml',
      data: `<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Repeated header</w:t></w:r><w:pict><w:shape><w:textbox><w:txbxContent><w:p><w:r><w:t>CONFIDENTIAL WATERMARK</w:t></w:r></w:p></w:txbxContent></w:textbox></w:shape></w:pict></w:p></w:hdr>`,
    },
    {
      name: 'word/footer1.xml',
      data: `<?xml version="1.0"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Repeated footer</w:t></w:r></w:p></w:ftr>`,
    },
    {
      name: 'docProps/core.xml',
      data: `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>Fixture Corpus</dc:title><dc:creator>Ada Example</dc:creator><dc:subject>Testing</dc:subject><dc:description>Generated, public-domain test content</dc:description><dc:language>en-GB</dc:language><dcterms:created>2024-01-01T00:00:00Z</dcterms:created><dcterms:modified>2024-01-02T00:00:00Z</dcterms:modified></cp:coreProperties>`,
    },
    {
      name: 'docProps/app.xml',
      data: `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>WordConvert Fixture Generator</Application><Company>Example Publisher</Company></Properties>`,
    },
    {
      name: 'docProps/custom.xml',
      data: `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Version"><vt:lpwstr>1.2.3</vt:lpwstr></property></Properties>`,
    },
    { name: 'word/media/image1.png', data: tinyPng },
    { name: 'word/media/image2.png', data: tinyPng },
  ];
}

function minimalDocx(documentXml, extraEntries = []) {
  const entries = [
    { name: '[Content_Types].xml', data: baseTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: styles },
    ...extraEntries,
  ];
  return createZip([
    ...new Map(entries.map((entry) => [entry.name, entry])).values(),
  ]);
}

const localizedStyles = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
${[
  ['Kop1', 'Kop 1'],
  ['Ueberschrift1', 'Überschrift 1'],
  ['Titre1', 'Titre 1'],
  ['Titulo1', 'Título 1'],
  ['Titolo1', 'Titolo 1'],
  ['Naglowek1', 'Nagłówek 1'],
  ['Rubrik1', 'Rubrik 1'],
  ['Citat', 'Citat'],
  ['Bijschrift', 'Bijschrift'],
  ['Untertitel', 'Untertitel'],
]
  .map(
    ([id, name]) =>
      `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>`,
  )
  .join('')}
</w:styles>`;

export function createEntryCountLimitFixture(count = 2048) {
  return createZip(
    Array.from({ length: count }, (_, index) => ({
      name: `entries/${index.toString().padStart(4, '0')}.txt`,
      data: '',
    })),
  );
}

export function createExpandedSizeLimitFixture(size = 8 * 1024 * 1024) {
  return createZip([
    { name: 'word/large.xml', data: new Uint8Array(size).fill(65) },
  ]);
}

const fixtures = [
  {
    name: 'standard-comprehensive.docx',
    category: 'valid',
    features: [
      'standard-headings',
      'custom-styles',
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
    ],
    bytes: () => createZip(standardEntries()),
    entries: () => standardEntries().map((entry) => entry.name),
  },
  {
    name: 'localized-european-styles.docx',
    category: 'localized',
    features: [
      'dutch',
      'german',
      'french',
      'spanish',
      'italian',
      'polish',
      'swedish',
      'caption',
      'quotation',
      'subtitle',
    ],
    bytes: () =>
      minimalDocx(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${['Kop1', 'Ueberschrift1', 'Titre1', 'Titulo1', 'Titolo1', 'Naglowek1', 'Rubrik1', 'Citat', 'Bijschrift', 'Untertitel'].map((id) => `<w:p><w:pPr><w:pStyle w:val="${id}"/></w:pPr><w:r><w:t>${id}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
        [{ name: 'word/styles.xml', data: localizedStyles }],
      ),
    entries: () => [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
    ],
  },
  {
    name: 'visual-heading.docx',
    category: 'edge-case',
    features: [
      'unstyled-visual-heading',
      'font-size',
      'bold',
      'spacing',
      'short-paragraph',
    ],
    bytes: () =>
      minimalDocx(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:spacing w:before="360" w:after="180"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="40"/></w:rPr><w:t>Visual heading candidate</w:t></w:r></w:p><w:p><w:r><w:t>Dominant body paragraph used for comparison.</w:t></w:r></w:p></w:body></w:document>`,
      ),
    entries: () => [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
    ],
  },
  {
    name: 'path-traversal.docx',
    category: 'hostile',
    features: ['zip-path-traversal'],
    bytes: () =>
      createZip([
        { name: '../outside.xml', data: '<outside/>' },
        ...standardEntries().slice(0, 3),
      ]),
    entries: () => [
      '../outside.xml',
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ],
  },
  {
    name: 'compression-ratio.docx',
    category: 'hostile',
    features: ['extreme-compression-ratio'],
    bytes: () =>
      createZip([
        {
          name: 'word/document.xml',
          data: new Uint8Array(256 * 1024).fill(65),
        },
      ]),
    entries: () => ['word/document.xml'],
  },
  {
    name: 'unsafe-link.docx',
    category: 'hostile',
    features: ['javascript-url', 'remote-resource'],
    bytes: () =>
      minimalDocx(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:hyperlink r:id="bad"><w:r><w:t>unsafe</w:t></w:r></w:hyperlink></w:p></w:body></w:document>`,
        [
          {
            name: 'word/_rels/document.xml.rels',
            data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="bad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="remote" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/tracker.png" TargetMode="External"/></Relationships>`,
          },
        ],
      ),
    entries: () => [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/_rels/document.xml.rels',
    ],
  },
  {
    name: 'active-svg.docx',
    category: 'hostile',
    features: [
      'active-svg',
      'script',
      'event-handler',
      'external-svg-resource',
    ],
    bytes: () =>
      minimalDocx(standardDocument, [
        {
          name: 'word/media/active.svg',
          data: `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><image href="https://example.invalid/tracker.png"/></svg>`,
        },
      ]),
    entries: () => [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/media/active.svg',
    ],
  },
  {
    name: 'xml-entity-expansion.docx',
    category: 'hostile',
    features: ['doctype', 'external-entity', 'entity-expansion'],
    bytes: () =>
      minimalDocx(
        `<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&xxe;&b;</w:t></w:r></w:p></w:body></w:document>`,
      ),
    entries: () => [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
    ],
  },
  {
    name: 'unsupported-macro.docm',
    category: 'unsupported',
    features: ['macro-enabled-content'],
    bytes: () =>
      createZip([
        ...standardEntries(),
        { name: 'word/vbaProject.bin', data: 'fixture-not-executable' },
      ]),
    entries: () => [
      ...standardEntries().map((entry) => entry.name),
      'word/vbaProject.bin',
    ],
  },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function generateFixtureCorpus(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const matrix = [];
  for (const fixture of fixtures) {
    const bytes = fixture.bytes();
    await writeFile(join(outputDirectory, fixture.name), bytes);
    const manifest = {
      name: fixture.name,
      category: fixture.category,
      features: fixture.features,
      sha256: sha256(bytes),
      byteLength: bytes.length,
      entries: fixture.entries(),
    };
    await writeFile(
      join(outputDirectory, `${fixture.name}.manifest.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    matrix.push(manifest);
  }
  const malformed = Buffer.from(
    'PK\x03\x04truncated-central-directory',
    'binary',
  );
  const malformedManifest = {
    name: 'malformed.zip',
    category: 'hostile',
    features: ['malformed-zip'],
    sha256: sha256(malformed),
    byteLength: malformed.length,
    entries: [],
  };
  await writeFile(join(outputDirectory, malformedManifest.name), malformed);
  await writeFile(
    join(outputDirectory, `${malformedManifest.name}.manifest.json`),
    `${JSON.stringify(malformedManifest, null, 2)}\n`,
  );
  matrix.push(malformedManifest);
  await writeFile(
    join(outputDirectory, 'corpus.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: '2024-01-01T00:00:00.000Z',
        fixtures: matrix,
        generatedOnDemand: [
          {
            name: 'entry-count-limit.zip',
            features: ['excessive-entry-count'],
            defaults: { entries: 2048 },
          },
          {
            name: 'expanded-size-limit.zip',
            features: ['excessive-expanded-size', 'memory-exhaustion'],
            defaults: { bytes: 8388608 },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const root = resolve(dirname(scriptPath), '..');
  await generateFixtureCorpus(join(root, 'tests/fixtures/docx'));
}
