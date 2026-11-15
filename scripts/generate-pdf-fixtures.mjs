import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PDFDocument,
  PDFName,
  PDFOperator,
  PDFString,
  StandardFonts,
  lineTo,
  moveTo,
  rgb,
  setLineWidth,
  setStrokingGrayscaleColor,
  stroke,
} from 'pdf-lib';
import { format } from 'prettier';

const outputDirectory = resolve('tests/fixtures/pdf');
const fixedDate = new Date('2026-08-29T12:00:00.000Z');
await mkdir(outputDirectory, { recursive: true });

await save('one-column-book.pdf', await oneColumnBook());
await save('two-column-article.pdf', await twoColumnArticle());
await save('tagged-article.pdf', await taggedArticle());
await save('tagged-table.pdf', await taggedTable());
await save('tagged-table-spans.pdf', await taggedTableSpans());
await save('ruled-table.pdf', await ruledTable());
await save('borderless-table.pdf', await borderlessTable());
await save('ruled-non-tables.pdf', await ruledNonTables());
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
          file: 'tagged-table-spans.pdf',
          covers: [
            'tagged structure',
            'tagged table row span',
            'tagged table column span',
          ],
        },
        {
          file: 'tagged-table.pdf',
          covers: [
            'tagged structure',
            'tagged table',
            'tagged table header cells',
            'tagged table caption',
          ],
        },
        {
          file: 'scanned-page.pdf',
          covers: ['image-only page', 'OCR warning'],
        },
        {
          file: 'ruled-table.pdf',
          covers: ['ruled table', 'stroked cell borders', 'table caption'],
        },
        {
          file: 'borderless-table.pdf',
          covers: [
            'aligned columns without rules',
            'heading outside the grid',
            'bulleted list',
          ],
        },
        {
          file: 'ruled-non-tables.pdf',
          covers: [
            'separator rule',
            'bordered box',
            'chart axes',
            'open grid',
            'unresolved rules',
          ],
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

async function taggedTable() {
  const document = await baseDocument('Tagged Table');
  const body = await document.embedFont(StandardFonts.TimesRoman);
  const bold = await document.embedFont(StandardFonts.TimesRomanBold);
  const italic = await document.embedFont(StandardFonts.TimesRomanItalic);
  const page = document.addPage([600, 800]);
  const caption = {
    text: 'Table 1: quarterly revenue',
    x: 60,
    y: 724,
    font: italic,
  };
  const cells = [
    { text: 'Period', x: 60, y: 700, font: bold, role: 'TH' },
    { text: 'Revenue', x: 300, y: 700, font: bold, role: 'TH' },
    { text: 'Q1', x: 60, y: 676, font: body, role: 'TD' },
    { text: '100', x: 300, y: 676, font: body, role: 'TD' },
    { text: 'Q2', x: 60, y: 652, font: body, role: 'TD' },
    { text: '120', x: 300, y: 652, font: body, role: 'TD' },
  ];
  const marks = [caption, ...cells];

  for (const [markedContentId, mark] of marks.entries()) {
    page.pushOperators(
      PDFOperator.of('BDC', [
        PDFName.of(mark.role ?? 'Caption'),
        document.context.obj({ MCID: markedContentId }),
      ]),
    );
    page.drawText(mark.text, {
      x: mark.x,
      y: mark.y,
      size: 12,
      font: mark.font,
    });
    page.pushOperators(PDFOperator.of('EMC'));
  }

  const root = document.context.obj({ Type: 'StructTreeRoot', K: [] });
  const rootReference = document.context.register(root);
  // PDF.js only accepts a StructElem when its /P parent link points at the
  // element that lists it in /K, so sections and rows are created before the
  // elements below them and their /K is filled in afterwards.
  const element = (role, parent, children = []) => {
    const dict = document.context.obj({
      Type: 'StructElem',
      S: role,
      Pg: page.ref,
      K: [],
    });
    dict.set(PDFName.of('P'), parent);
    const reference = document.context.register(dict);
    if (children.length > 0)
      dict.set(PDFName.of('K'), document.context.obj(children));
    return { dict, reference };
  };
  const table = element('Table', rootReference);
  const captionElement = element('Caption', table.reference);
  captionElement.dict.set(PDFName.of('K'), document.context.obj(0));
  const head = element('THead', table.reference);
  const tableBody = element('TBody', table.reference);
  const headRow = element('TR', head.reference);
  const firstRow = element('TR', tableBody.reference);
  const secondRow = element('TR', tableBody.reference);
  const cell = (index, row) => {
    const created = element(cells[index].role, row.reference);
    created.dict.set(PDFName.of('K'), document.context.obj(index + 1));
    return created.reference;
  };
  headRow.dict.set(
    PDFName.of('K'),
    document.context.obj([cell(0, headRow), cell(1, headRow)]),
  );
  firstRow.dict.set(
    PDFName.of('K'),
    document.context.obj([cell(2, firstRow), cell(3, firstRow)]),
  );
  secondRow.dict.set(
    PDFName.of('K'),
    document.context.obj([cell(4, secondRow), cell(5, secondRow)]),
  );
  head.dict.set(PDFName.of('K'), document.context.obj([headRow.reference]));
  tableBody.dict.set(
    PDFName.of('K'),
    document.context.obj([firstRow.reference, secondRow.reference]),
  );
  table.dict.set(
    PDFName.of('K'),
    document.context.obj([
      captionElement.reference,
      head.reference,
      tableBody.reference,
    ]),
  );
  root.set(PDFName.of('K'), document.context.obj([table.reference]));
  root.set(
    PDFName.of('ParentTree'),
    document.context.obj({
      Nums: [
        0,
        document.context.obj([
          captionElement.reference,
          headRow.reference,
          firstRow.reference,
          secondRow.reference,
        ]),
      ],
    }),
  );
  root.set(PDFName.of('ParentTreeNextKey'), document.context.obj(1));
  page.node.set(PDFName.of('StructParents'), document.context.obj(0));
  document.catalog.set(PDFName.of('StructTreeRoot'), rootReference);
  document.catalog.set(
    PDFName.of('MarkInfo'),
    document.context.obj({ Marked: true }),
  );
  document.catalog.set(PDFName.of('Lang'), PDFString.of('en'));
  return document;
}

async function taggedTableSpans() {
  const document = await baseDocument('Tagged Table Spans');
  const body = await document.embedFont(StandardFonts.TimesRoman);
  const bold = await document.embedFont(StandardFonts.TimesRomanBold);
  const page = document.addPage([600, 800]);
  // Declared spans live in the cell's `/A` attribute dictionary with `/O /Table`,
  // which is what PDF.js reads into `rowSpan` and `colSpan`.
  const cells = [
    { text: 'Metric', x: 60, y: 700, font: bold, role: 'TH', rowSpan: 2 },
    { text: 'Revenue', x: 300, y: 700, font: bold, role: 'TH' },
    { text: 'Cost', x: 300, y: 676, font: bold, role: 'TH' },
    {
      text: 'Total revenue',
      x: 60,
      y: 652,
      font: body,
      role: 'TD',
      colSpan: 2,
    },
  ];

  for (const [markedContentId, cell] of cells.entries()) {
    page.pushOperators(
      PDFOperator.of('BDC', [
        PDFName.of(cell.role),
        document.context.obj({ MCID: markedContentId }),
      ]),
    );
    page.drawText(cell.text, {
      x: cell.x,
      y: cell.y,
      size: 12,
      font: cell.font,
    });
    page.pushOperators(PDFOperator.of('EMC'));
  }

  const root = document.context.obj({ Type: 'StructTreeRoot', K: [] });
  const rootReference = document.context.register(root);
  const element = (role, parent, children, attributes = undefined) => {
    const dict = document.context.obj({
      Type: 'StructElem',
      S: role,
      Pg: page.ref,
      K: [],
    });
    dict.set(PDFName.of('P'), parent);
    if (attributes) dict.set(PDFName.of('A'), document.context.obj(attributes));
    if (children !== undefined)
      dict.set(PDFName.of('K'), document.context.obj(children));
    return { dict, reference: document.context.register(dict) };
  };
  const table = element('Table', rootReference);
  const tableBody = element('TBody', table.reference);
  const rows = [
    element('TR', tableBody.reference),
    element('TR', tableBody.reference),
    element('TR', tableBody.reference),
  ];
  const cellRows = [0, 0, 1, 2];
  const cellElements = cells.map((cell, index) =>
    element(cell.role, rows[cellRows[index]].reference, index, {
      O: 'Table',
      ...(cell.colSpan === undefined ? {} : { ColSpan: cell.colSpan }),
      ...(cell.rowSpan === undefined ? {} : { RowSpan: cell.rowSpan }),
    }),
  );
  rows[0].dict.set(
    PDFName.of('K'),
    document.context.obj([
      cellElements[0].reference,
      cellElements[1].reference,
    ]),
  );
  rows[1].dict.set(
    PDFName.of('K'),
    document.context.obj([cellElements[2].reference]),
  );
  rows[2].dict.set(
    PDFName.of('K'),
    document.context.obj([cellElements[3].reference]),
  );
  tableBody.dict.set(
    PDFName.of('K'),
    document.context.obj(rows.map((row) => row.reference)),
  );
  table.dict.set(PDFName.of('K'), document.context.obj([tableBody.reference]));
  root.set(PDFName.of('K'), document.context.obj([table.reference]));
  root.set(
    PDFName.of('ParentTree'),
    document.context.obj({
      Nums: [
        0,
        document.context.obj(cellElements.map((cell) => cell.reference)),
      ],
    }),
  );
  root.set(PDFName.of('ParentTreeNextKey'), document.context.obj(1));
  page.node.set(PDFName.of('StructParents'), document.context.obj(0));
  document.catalog.set(PDFName.of('StructTreeRoot'), rootReference);
  document.catalog.set(
    PDFName.of('MarkInfo'),
    document.context.obj({ Marked: true }),
  );
  document.catalog.set(PDFName.of('Lang'), PDFString.of('en'));
  return document;
}

/**
 * A table that states itself as geometry instead of structure: stroked rules
 * close every cell, so detection has to work from vector strokes alone.
 */
async function ruledTable() {
  const document = await baseDocument('Quarterly Results');
  const body = await document.embedFont(StandardFonts.TimesRoman);
  const page = document.addPage([400, 300]);
  const left = 40;
  const middle = 190;
  const right = 340;
  // Cell boundaries from the top of the grid down, in PDF user space.
  const boundaries = [240, 200, 160, 120];
  page.pushOperators(setLineWidth(1), setStrokingGrayscaleColor(0));
  for (const x of [left, middle, right])
    page.pushOperators(
      moveTo(x, boundaries.at(-1)),
      lineTo(x, boundaries[0]),
      stroke(),
    );
  for (const y of boundaries)
    page.pushOperators(moveTo(left, y), lineTo(right, y), stroke());
  const cells = [
    ['Period', 'Revenue'],
    ['Q1', '100'],
    ['Q2', '120'],
  ];
  cells.forEach((row, rowIndex) =>
    row.forEach((text, columnIndex) =>
      page.drawText(text, {
        x: (columnIndex === 0 ? left : middle) + 10,
        y: boundaries[rowIndex] - 26,
        size: 11,
        font: body,
      }),
    ),
  );
  page.drawText('Quarterly revenue', { x: left, y: 262, size: 11, font: body });
  return document;
}

/**
 * Rules that must never become a table: a separator, a bordered box, chart
 * axes, and a grid whose middle rule stops short. Detection has to refuse all
 * four and keep every word as prose.
 */
async function borderlessTable() {
  // Three aligned columns down four rows with no rules at all, alongside a
  // heading and a bulleted list that must not be mistaken for tables.
  const document = await baseDocument('Distribution by Region');
  const body = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage([600, 800]);
  const columns = [40, 190, 330];
  const rows = [680, 656, 632, 608];
  const values = [
    ['Region', 'Units', 'Share'],
    ['North', '120', '31%'],
    ['South', '98', '25%'],
    ['East', '141', '44%'],
  ];
  page.drawText('Distribution by region', {
    x: 24,
    y: 740,
    size: 13,
    font: bold,
  });
  rows.forEach((y, rowIndex) =>
    columns.forEach((x, columnIndex) =>
      page.drawText(values[rowIndex][columnIndex], {
        x,
        y,
        size: 11,
        font: body,
      }),
    ),
  );
  page.drawText('Notes', { x: 24, y: 550, size: 11, font: bold });
  const notes = [
    'figures are unaudited',
    'share is rounded',
    'east includes islands',
    'source is internal',
  ];
  notes.forEach((note, index) => {
    const y = 520 - index * 24;
    page.drawText('\u2022', { x: 24, y, size: 11, font: body });
    page.drawText(note, { x: 48, y, size: 11, font: body });
  });
  return document;
}

async function ruledNonTables() {
  const document = await baseDocument('Rules That Are Not Tables');
  const body = await document.embedFont(StandardFonts.TimesRoman);
  const page = document.addPage([400, 300]);
  const rule = (x1, y1, x2, y2) => {
    page.pushOperators(moveTo(x1, y1), lineTo(x2, y2), stroke());
  };
  page.pushOperators(setLineWidth(1), setStrokingGrayscaleColor(0));
  // A running-head separator across the whole page.
  rule(40, 282, 360, 282);
  page.drawText('Chapter heading', { x: 40, y: 288, size: 12, font: body });
  // A bordered quotation: one box, so one row and one column.
  rule(40, 200, 200, 200);
  rule(40, 250, 200, 250);
  rule(40, 200, 40, 250);
  rule(200, 200, 200, 250);
  page.drawText('Indented quotation', { x: 50, y: 220, size: 11, font: body });
  // Chart axes: one vertical and one horizontal meeting at a corner.
  rule(60, 40, 60, 120);
  rule(60, 40, 200, 40);
  page.drawText('Figure 2', { x: 150, y: 110, size: 9, font: body });
  // A grid whose middle rule stops short, leaving the right column open.
  rule(250, 60, 350, 60);
  rule(250, 100, 300, 100);
  rule(250, 140, 350, 140);
  rule(250, 60, 250, 140);
  rule(300, 60, 300, 140);
  rule(350, 60, 350, 140);
  page.drawText('Alpha', { x: 255, y: 114, size: 10, font: body });
  page.drawText('Beta', { x: 305, y: 114, size: 10, font: body });
  page.drawText('Gamma', { x: 255, y: 74, size: 10, font: body });
  page.drawText('Delta', { x: 305, y: 74, size: 10, font: body });
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
