import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputDirectory = resolve('tests/fixtures/formula-benchmark');
const variants = [
  { name: 'serif', family: 'STIX Two Math, Times New Roman, serif', size: 34 },
  { name: 'sans', family: 'Arial, sans-serif', size: 32 },
  {
    name: 'compact',
    family: 'STIX Two Math, Times New Roman, serif',
    size: 27,
  },
];
const formulas = [
  ['inline', 'x + y = z', 'x+y=z'],
  ['inline', 'E = mc²', 'E=mc^2'],
  ['scripts', 'aᵢ + bᵢ = cᵢ', 'a_i+b_i=c_i'],
  ['scripts', 'x² + y² = z²', 'x^2+y^2=z^2'],
  ['greek', 'α + β = γ', '\\alpha+\\beta=\\gamma'],
  ['greek', 'Δx → 0', '\\Delta x\\to0'],
  ['operator', '∑ᵢ₌₁ⁿ i', '\\sum_{i=1}^n i'],
  ['operator', '∫₀¹ x dx', '\\int_0^1x\\,dx'],
  ['relation', 'x ≠ y', 'x\\ne y'],
  ['relation', 'a ≤ b ≥ c', 'a\\le b\\ge c'],
  ['fraction', '(x + 1) / (y − 1)', '\\frac{x+1}{y-1}'],
  ['fraction', '(x² + α) / √y₁', '\\frac{x^2+\\alpha}{\\sqrt{y_1}}'],
  ['root', '√(x + y)', '\\sqrt{x+y}'],
  ['root', '³√(x² + 1)', '\\sqrt[3]{x^2+1}'],
  ['matrix', '[ a  b ; c  d ]', '\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}'],
  ['matrix', '( 1  0 ; 0  1 )', '\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}'],
  [
    'multiline',
    'f(x) = x² + 1\ng(x) = 2x − 3',
    '\\begin{aligned}f(x)&=x^2+1\\\\g(x)&=2x-3\\end{aligned}',
  ],
  ['rare-symbol', 'A ⊂ B ∪ C', 'A\\subset B\\cup C'],
  ['rare-symbol', '∀x ∈ R, x² ≥ 0', '\\forall x\\in\\mathbb{R},x^2\\ge0'],
  [
    'equation-number',
    'y = mx + b                                      (1)',
    'y=mx+b',
  ],
];

export async function generateFormulaBenchmarkCorpus(
  directory = outputDirectory,
) {
  await mkdir(directory, { recursive: true });
  const cases = [];
  for (const [formulaIndex, [category, visual, tex]] of formulas.entries()) {
    for (const variant of variants) {
      const id = `${category}-${String(formulaIndex + 1).padStart(2, '0')}-${variant.name}`;
      const file = `${id}.svg`;
      const lines = visual.split('\n');
      const height = lines.length > 1 ? 128 : 88;
      const width = Math.min(
        720,
        Math.max(
          128,
          Math.ceil(
            Math.max(...lines.map((line) => line.length)) *
              variant.size *
              0.58 +
              36,
          ),
        ),
      );
      const text = lines
        .map(
          (line, index) =>
            `<text x="18" y="${52 + index * 42}" font-family="${variant.family}" font-size="${variant.size}" fill="#111">${escapeXml(line)}</text>`,
        )
        .join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="white"/>${text}</svg>\n`;
      await writeFile(resolve(directory, file), svg);
      cases.push({
        id,
        file,
        category,
        variant: variant.name,
        tex,
        width,
        height,
        maxTokens: 128,
      });
    }
  }
  const manifest = {
    schema: 'wordconvert.formula-benchmark',
    version: 1,
    generatedAt: '2026-09-02T00:00:00.000Z',
    license: 'CC0-1.0 generated fixtures',
    preprocessing: {
      background: '#ffffff',
      horizontalPadding: 18,
      browserRasterization: true,
      productionCropLimits: true,
    },
    cases,
  };
  await writeFile(
    resolve(directory, 'corpus.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
)
  await generateFormulaBenchmarkCorpus();
