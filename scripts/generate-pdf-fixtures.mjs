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
import { format } from 'prettier';

const outputDirectory = resolve('tests/fixtures/pdf');
const fixedDate = new Date('2026-08-29T12:00:00.000Z');
await mkdir(outputDirectory, { recursive: true });

await save('one-column-book.pdf', await oneColumnBook());
await save('two-column-article.pdf', await twoColumnArticle());
await save('tagged-article.pdf', await taggedArticle());
await save('scanned-page.pdf', await scannedPage());
await save('formula-layouts.pdf', await formulaLayouts());
await save('formula-false-positives.pdf', await formulaFalsePositives());
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
  await format(
    JSON.stringify({
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
        {
          file: 'formula-layouts.pdf',
          covers: [
            'inline formula',
            'display formula',
            'scripts',
            'Greek and operators',
            'complex fraction',
            'sum and integral',
            'equation number',
            'nearby figure',
            'two-column formulas',
          ],
          expectedEquations: [
            { page: 1, display: 'inline', tex: 'E=mc^2' },
            {
              page: 1,
              display: 'block',
              tex: '\\frac{x^2+\\alpha}{\\sqrt{y_1}}',
            },
            {
              page: 1,
              display: 'block',
              tex: '\\sum_{i=1}^{n}i+\\int_0^1x\\,dx',
              number: '(1)',
            },
            { page: 2, display: 'inline', tex: 'a_i+b_i=c_i' },
            { page: 2, display: 'block', tex: 'x^2+y^2=z^2' },
          ],
          expectedFigures: [{ page: 1, label: 'Figure 1' }],
        },
        {
          file: 'formula-false-positives.pdf',
          covers: [
            'false-positive prose',
            'false-positive heading',
            'false-positive code',
            'false-positive chemistry',
            'false-positive numeric table',
          ],
          expectedEquations: [],
        },
        { file: 'encrypted.pdf', covers: ['password-protected PDF error'] },
        { file: 'malformed.pdf', covers: ['invalid PDF error'] },
      ],
    }),
    { parser: 'json' },
  ),
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

async function formulaLayouts() {
  const document = await baseDocument('Formula Layouts');
  const body = await document.embedFont(StandardFonts.TimesRoman);
  const italic = await document.embedFont(StandardFonts.TimesRomanItalic);
  const bold = await document.embedFont(StandardFonts.TimesRomanBold);
  const symbol = await document.embedFont(StandardFonts.Symbol);
  const page = document.addPage([600, 800]);
  page.drawText('Formula Layouts', { x: 60, y: 740, size: 22, font: bold });
  page.drawText('Mass and energy satisfy E = mc', {
    x: 60,
    y: 680,
    size: 12,
    font: body,
  });
  page.drawText('2', { x: 231, y: 687, size: 8, font: body });
  page.drawText(' in the simplest model.', {
    x: 237,
    y: 680,
    size: 12,
    font: body,
  });

  page.drawText('x', { x: 225, y: 596, size: 18, font: italic });
  page.drawText('2', { x: 236, y: 606, size: 10, font: body });
  page.drawText('+', { x: 251, y: 596, size: 18, font: body });
  page.drawText('α', { x: 270, y: 596, size: 18, font: symbol });
  page.drawLine({ start: { x: 215, y: 588 }, end: { x: 310, y: 588 } });
  page.drawText('y', { x: 250, y: 562, size: 18, font: italic });
  page.drawText('1', { x: 261, y: 558, size: 10, font: body });
  page.drawText('Complex fraction with scripts and Greek.', {
    x: 170,
    y: 530,
    size: 10,
    font: body,
  });

  page.drawText('∑', { x: 180, y: 430, size: 28, font: symbol });
  page.drawText('n', { x: 188, y: 453, size: 9, font: italic });
  page.drawText('i=1', { x: 181, y: 416, size: 8, font: italic });
  page.drawText('i +', { x: 214, y: 432, size: 18, font: italic });
  page.drawText('∫', { x: 255, y: 427, size: 30, font: symbol });
  page.drawText('1', { x: 266, y: 452, size: 9, font: body });
  page.drawText('0', { x: 264, y: 414, size: 9, font: body });
  page.drawText('x dx', { x: 286, y: 432, size: 18, font: italic });
  page.drawText('(1)', { x: 505, y: 432, size: 12, font: body });

  page.drawRectangle({
    x: 70,
    y: 215,
    width: 180,
    height: 110,
    borderWidth: 1,
    borderColor: rgb(0, 0, 0),
  });
  page.drawLine({ start: { x: 85, y: 235 }, end: { x: 225, y: 300 } });
  page.drawText('Figure 1. Linear response.', {
    x: 78,
    y: 195,
    size: 10,
    font: body,
  });
  page.drawText('The nearby figure remains independent of equation (1).', {
    x: 285,
    y: 270,
    size: 11,
    font: body,
  });

  const columns = document.addPage([600, 800]);
  columns.drawText('Two-column formula layout', {
    x: 60,
    y: 740,
    size: 20,
    font: bold,
  });
  columns.drawText('Left prose introduces a', {
    x: 60,
    y: 680,
    size: 11,
    font: body,
  });
  columns.drawText('i', { x: 180, y: 676, size: 8, font: body });
  columns.drawText('+ b', { x: 185, y: 680, size: 11, font: body });
  columns.drawText('i', { x: 205, y: 676, size: 8, font: body });
  columns.drawText('= c', { x: 210, y: 680, size: 11, font: body });
  columns.drawText('i', { x: 229, y: 676, size: 8, font: body });
  columns.drawText('Right prose follows.', {
    x: 330,
    y: 680,
    size: 11,
    font: body,
  });
  columns.drawText('x', { x: 390, y: 590, size: 18, font: italic });
  columns.drawText('2', { x: 401, y: 600, size: 9, font: body });
  columns.drawText('+ y', { x: 415, y: 590, size: 18, font: italic });
  columns.drawText('2', { x: 448, y: 600, size: 9, font: body });
  columns.drawText('= z', { x: 462, y: 590, size: 18, font: italic });
  columns.drawText('2', { x: 495, y: 600, size: 9, font: body });
  return document;
}

async function formulaFalsePositives() {
  const document = await baseDocument('Formula False Positives');
  const body = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const mono = await document.embedFont(StandardFonts.Courier);
  const page = document.addPage([600, 800]);
  page.drawText('Q4 RESULTS + 20% GROWTH', {
    x: 60,
    y: 730,
    size: 22,
    font: bold,
  });
  page.drawText('The product name X appears in prose, not as mathematics.', {
    x: 60,
    y: 675,
    size: 11,
    font: body,
  });
  page.drawText('const total = items.length + 1;', {
    x: 60,
    y: 625,
    size: 11,
    font: mono,
  });
  page.drawText('The sample contains H2O, CO2, NaCl, and pH 7.', {
    x: 60,
    y: 575,
    size: 11,
    font: body,
  });
  page.drawText('Year      2023      2024      2025', {
    x: 60,
    y: 500,
    size: 11,
    font: mono,
  });
  page.drawText('Revenue   120       135       149', {
    x: 60,
    y: 475,
    size: 11,
    font: mono,
  });
  page.drawText('Margin    18%       20%       21%', {
    x: 60,
    y: 450,
    size: 11,
    font: mono,
  });
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
