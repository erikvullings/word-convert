import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PDFDocument,
  PDFName,
  PDFOperator,
  PDFString,
  StandardFonts,
  rgb,
} from 'pdf-lib';

const outputDirectory = resolve('tests/fixtures/pdf');
const fixedDate = new Date('2026-08-29T12:00:00.000Z');
await mkdir(outputDirectory, { recursive: true });

await save('one-column-book.pdf', await oneColumnBook());
await save('two-column-article.pdf', await twoColumnArticle());
await save('tagged-article.pdf', await taggedArticle());
await save('scanned-page.pdf', await scannedPage());
await writeFile(resolve(outputDirectory, 'malformed.pdf'), '%PDF-invalid\n');
const encrypted = spawnSync(
  'qpdf',
  [
    '--encrypt',
    'fixture-password',
    'fixture-owner',
    '256',
    '--',
    resolve(outputDirectory, 'one-column-book.pdf'),
    resolve(outputDirectory, 'encrypted.pdf'),
  ],
  { stdio: 'inherit' },
);
if (encrypted.error)
  console.warn('qpdf is unavailable; encrypted.pdf was not regenerated.');

await writeFile(
  resolve(outputDirectory, 'corpus.json'),
  `${JSON.stringify(
    {
      generatedAt: fixedDate.toISOString(),
      fixtures: [
        {
          file: 'one-column-book.pdf',
          covers: ['metadata', 'running headers', 'page numbers', 'link'],
        },
        {
          file: 'two-column-article.pdf',
          covers: ['two-column reading order', 'footer'],
        },
        {
          file: 'tagged-article.pdf',
          covers: ['tagged structure', 'marked content'],
        },
        {
          file: 'scanned-page.pdf',
          covers: ['image-only page', 'OCR warning'],
        },
        { file: 'encrypted.pdf', covers: ['password-protected PDF error'] },
        { file: 'malformed.pdf', covers: ['invalid PDF error'] },
      ],
    },
    null,
    2,
  )}\n`,
);

async function baseDocument(title) {
  const document = await PDFDocument.create();
  document.setTitle(title);
  document.setAuthor('WordConvert fixture generator');
  document.setSubject('Deterministic PDF conversion fixture');
  document.setKeywords(['wordconvert', 'pdf', 'fixture']);
  document.setCreationDate(fixedDate);
  document.setModificationDate(fixedDate);
  return document;
}

async function oneColumnBook() {
  const document = await baseDocument('A Practical Book');
  const body = await document.embedFont(StandardFonts.TimesRoman);
  const bold = await document.embedFont(StandardFonts.TimesRomanBold);
  for (let index = 0; index < 6; index++) {
    const number = index + 1;
    const page = document.addPage([600, 800]);
    page.drawText(number % 2 === 0 ? 'A Practical Book' : 'Chapter One', {
      x: number % 2 === 0 ? 390 : 60,
      y: 770,
      size: 9,
      font: body,
    });
    if (number === 1)
      page.drawText('A Practical Book', {
        x: 60,
        y: 700,
        size: 28,
        font: bold,
      });
    page.drawText(`Body paragraph on page ${number}.`, {
      x: 60,
      y: 640,
      size: 11,
      font: body,
    });
    const linkText = 'Project website';
    page.drawText(linkText, {
      x: 60,
      y: 610,
      size: 11,
      font: body,
      color: rgb(0, 0, 0.7),
    });
    addLink(document, page, [60, 608, 145, 622], 'https://example.com/');
    page.drawText(`Page ${number} of 6`, {
      x: 270,
      y: 20,
      size: 9,
      font: body,
    });
  }
  addOutline(document, 'Chapter One', document.getPage(0));
  return document;
}

async function twoColumnArticle() {
  const document = await baseDocument('Two Column Article');
  const body = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  for (let index = 0; index < 2; index++) {
    const page = document.addPage([600, 800]);
    page.drawText('Two Column Article', {
      x: 60,
      y: 735,
      size: 22,
      font: bold,
    });
    page.drawText(`Left column first ${index + 1}`, {
      x: 60,
      y: 680,
      size: 11,
      font: body,
    });
    page.drawText(`Left column second ${index + 1}`, {
      x: 60,
      y: 650,
      size: 11,
      font: body,
    });
    page.drawText(`Right column first ${index + 1}`, {
      x: 330,
      y: 680,
      size: 11,
      font: body,
    });
    page.drawText(`Right column second ${index + 1}`, {
      x: 330,
      y: 650,
      size: 11,
      font: body,
    });
    page.drawText('Journal footer', {
      x: 250,
      y: 20,
      size: 9,
      font: body,
    });
  }
  return document;
}

async function taggedArticle() {
  const document = await baseDocument('Tagged Article');
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([600, 800]);
  page.pushOperators(
    PDFOperator.of('BDC', [PDFName.of('P'), document.context.obj({ MCID: 0 })]),
  );
  page.drawText('Tagged paragraph.', { x: 60, y: 700, size: 12, font });
  page.pushOperators(PDFOperator.of('EMC'));

  const root = document.context.obj({
    Type: 'StructTreeRoot',
    K: [],
  });
  const rootReference = document.context.register(root);
  const element = document.context.obj({
    Type: 'StructElem',
    S: 'P',
    P: rootReference,
    Pg: page.ref,
    K: 0,
  });
  const elementReference = document.context.register(element);
  root.set(PDFName.of('K'), document.context.obj([elementReference]));
  root.set(
    PDFName.of('ParentTree'),
    document.context.obj({ Nums: [0, [elementReference]] }),
  );
  page.node.set(PDFName.of('StructParents'), document.context.obj(0));
  document.catalog.set(PDFName.of('StructTreeRoot'), rootReference);
  document.catalog.set(
    PDFName.of('MarkInfo'),
    document.context.obj({ Marked: true }),
  );
  document.catalog.set(PDFName.of('Lang'), PDFString.of('en'));
  return document;
}

async function scannedPage() {
  const document = await baseDocument('Scanned Page');
  const page = document.addPage([600, 800]);
  const image = await document.embedPng(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nS8AAAAASUVORK5CYII=',
  );
  page.drawImage(image, { x: 50, y: 50, width: 500, height: 700 });
  return document;
}

function addLink(document, page, rectangle, href) {
  const annotation = document.context.register(
    document.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: rectangle,
      Border: [0, 0, 0],
      A: {
        Type: 'Action',
        S: 'URI',
        URI: PDFString.of(href),
      },
    }),
  );
  page.node.set(PDFName.of('Annots'), document.context.obj([annotation]));
}

function addOutline(document, title, page) {
  const root = document.context.obj({ Type: 'Outlines', Count: 1 });
  const rootReference = document.context.register(root);
  const item = document.context.obj({
    Title: PDFString.of(title),
    Parent: rootReference,
    Dest: [page.ref, PDFName.of('Fit')],
  });
  const itemReference = document.context.register(item);
  root.set(PDFName.of('First'), itemReference);
  root.set(PDFName.of('Last'), itemReference);
  document.catalog.set(PDFName.of('Outlines'), rootReference);
}

async function save(name, document) {
  const bytes = await document.save({
    addDefaultPage: false,
    objectsPerTick: 50,
    useObjectStreams: false,
    updateFieldAppearances: false,
  });
  await writeFile(resolve(outputDirectory, name), bytes);
}
