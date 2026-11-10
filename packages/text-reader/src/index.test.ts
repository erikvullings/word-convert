import { describe, expect, it } from 'vitest';
import { readTextDocument } from './index.ts';

const options = { filename: 'document.html', conversionDate: '2026-01-02' };
describe('semantic text reader', () => {
  it.each([
    ['html', '<p><strong>Abstract: </strong>In this paper...</p>'],
    ['html', '<p><b>Abstract:</b>In this paper...</p>'],
    ['markdown', '**Abstract: **In this paper...'],
    ['markdown', '**Abstract:**In this paper...'],
  ] as const)(
    'retains abstract emphasis from %s input: %s',
    async (format, source) => {
      const model = await readTextDocument(source, format, options);
      const paragraph = model.blocks[0];
      expect(paragraph?.type).toBe('paragraph');
      if (paragraph?.type !== 'paragraph') throw new Error('Missing paragraph');
      expect(paragraph.children[0]).toMatchObject({
        type: 'text',
        text: expect.stringMatching(/^Abstract:\s*$/),
        marks: [{ type: 'bold' }],
      });
      expect(paragraph.children.at(-1)).toMatchObject({
        type: 'text',
        text: 'In this paper...',
      });
      expect(JSON.stringify(model.blocks)).not.toContain('**');
    },
  );

  it('preserves nested HTML emphasis, adjacent words, and whitespace without leaking delimiters', async () => {
    const model = await readTextDocument(
      '<p><strong> bold <em>and italic </em></strong>tail <em>suffix</em>word <del> old </del>new</p>',
      'html',
      options,
    );
    expect(JSON.stringify(model.blocks)).not.toMatch(/\*\*|~~|<strong>/);
    const paragraph = model.blocks[0];
    if (paragraph?.type !== 'paragraph') throw new Error('Missing paragraph');
    expect(paragraph.children).toEqual(
      expect.arrayContaining([
        { type: 'text', text: ' bold ', marks: [{ type: 'bold' }] },
        {
          type: 'text',
          text: 'and italic ',
          marks: [{ type: 'bold' }, { type: 'italic' }],
        },
        { type: 'text', text: 'suffix', marks: [{ type: 'italic' }] },
        { type: 'text', text: ' old ', marks: [{ type: 'strikethrough' }] },
      ]),
    );
  });

  it('does not interpret escaped emphasis or code as formatting', async () => {
    const model = await readTextDocument(
      '\\*\\*Abstract: \\*\\*literal\n\n`**Abstract: **In code`\n\n```\n**Abstract: **In fenced code\n```\n\n**bold *nested italic* text**',
      'markdown',
      options,
    );
    const literal = model.blocks[0];
    if (literal?.type !== 'paragraph') throw new Error('Missing paragraph');
    expect(
      literal.children
        .map((node) => (node.type === 'text' ? node.text : ''))
        .join(''),
    ).toBe('**Abstract: **literal');
    expect(
      literal.children.every(
        (node) => node.type === 'text' && !node.marks?.length,
      ),
    ).toBe(true);
    expect(model.blocks[1]).toMatchObject({
      type: 'paragraph',
      children: [
        {
          type: 'text',
          text: '**Abstract: **In code',
          marks: [{ type: 'code' }],
        },
      ],
    });
    expect(model.blocks[2]).toMatchObject({
      type: 'codeBlock',
      text: '**Abstract: **In fenced code',
    });
    expect(model.blocks[3]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] },
        {
          type: 'text',
          text: 'nested italic',
          marks: [{ type: 'italic' }, { type: 'bold' }],
        },
        { type: 'text', text: ' text', marks: [{ type: 'bold' }] },
      ],
    });
  });

  it('imports HTML headings, lists, emphasis, tables and code without executing active content', async () => {
    const model = await readTextDocument(
      `<!doctype html><html lang="nl"><head><title>My book</title><meta name="author" content="Alice"></head><body>
      <h1>Chapter one</h1><p>Hello <strong>world</strong> &amp; <em>reader</em>.</p>
      <ol start="3"><li>First<ul><li>Nested</li></ul></li><li>Second</li></ol>
      <blockquote><p>Quote</p></blockquote><pre><code>if (x &lt; 2) {\n  run();\n}</code></pre>
      <table><tr><th>Name</th><th>Value</th></tr><tr><td>One</td><td>2</td></tr></table>
      <script>throw new Error("executed")</script><iframe src="https://example.com"></iframe>
      <p onclick="alert(1)" style="color:red">Safe text</p>
      </body></html>`,
      'html',
      options,
    );
    expect(model.metadata.title?.value).toBe('My book');
    expect(model.metadata.language?.value).toBe('nl');
    expect(model.metadata.authors[0]?.value.name).toBe('Alice');
    expect(model.blocks.map((block) => block.type)).toEqual(
      expect.arrayContaining([
        'heading',
        'paragraph',
        'list',
        'blockquote',
        'codeBlock',
        'table',
      ]),
    );
    expect(model.warnings.map((warning) => warning.code)).toContain(
      'text-active-content-omitted',
    );
    expect(JSON.stringify(model.blocks)).not.toContain('executed');
  });

  it('preserves Markdown semantics, TeX, and literal math inside code', async () => {
    const model = await readTextDocument(
      '# Book\n\nText **bold**, *italic* and $x_{1} + \\alpha$.\n\n$$\ny = x^2\n$$\n\n```js\nconst price = "$5";\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n',
      'markdown',
      options,
    );
    expect(
      Object.values(model.equations).map((equation) => equation.tex),
    ).toEqual(['x_{1} + \\alpha', 'y = x^2']);
    expect(model.blocks.map((block) => block.type)).toContain('equationBlock');
    expect(JSON.stringify(model.blocks)).toContain('const price');
  });

  it('does not fetch remote images and preserves alternative text with a warning', async () => {
    const model = await readTextDocument(
      '<h1>Book</h1><img src="https://tracking.example/pixel.png" alt="Diagram">',
      'html',
      options,
    );
    expect(model.assets).toEqual({});
    expect(JSON.stringify(model.blocks)).toContain('Diagram');
    expect(model.warnings.map((warning) => warning.code)).toContain(
      'text-image-omitted',
    );
  });

  it('prefers the main report over earlier article teasers and preserves nested publisher columns', async () => {
    const model = await readTextDocument(
      `<body><header><article><h1>Teaser</h1><p>Navigation teaser</p></article></header>
      <main id="main"><h1>Report</h1><div class="fusion-builder-row">
      <article><div class="fusion-text"><h2>Introduction</h2><p>First report section.</p></div></article>
      <div class="fusion-layout-column"><div class="fusion-text"><h2>Findings</h2><p>Second report section.</p></div></div>
      </div></main><footer>Publisher footer</footer></body>`,
      'html',
      options,
    );
    const content = JSON.stringify(model.blocks);
    expect(content).toContain('First report section.');
    expect(content).toContain('Second report section.');
    expect(content).not.toContain('Navigation teaser');
    expect(content).not.toContain('Publisher footer');
    expect(model.metadata.title?.value).toBe('Report');
  });

  it('retains publisher sections outside a nested title-only main', async () => {
    const model = await readTextDocument(
      `<header>Site navigation</header><div id="main"><section><main><h1>Report title</h1></main></section>
      <section id="av_section_2"><div class="avia_textblock"><p>Report introduction in a sibling section.</p>
      <p>Report conclusions in the same publisher container.</p></div></section></div>`,
      'html',
      options,
    );
    const content = JSON.stringify(model.blocks);
    expect(content).toContain('Report introduction in a sibling section.');
    expect(content).toContain(
      'Report conclusions in the same publisher container.',
    );
    expect(content).not.toContain('Site navigation');
  });

  it('selects ARIA main content inside a page-wide server form without importing controls', async () => {
    const model = await readTextDocument(
      `<form id="Form"><header>Site navigation</header><input type="hidden" value="server state">
      <div id="content" role="main"><h1>Report</h1><p>Report prose inside the server form.</p>
      <form><input value="Search"><button>Submit</button></form></div></form>`,
      'html',
      options,
    );
    const content = JSON.stringify(model.blocks);
    expect(content).toContain('Report prose inside the server form.');
    expect(content).not.toContain('server state');
    expect(content).not.toContain('Site navigation');
    expect(content).not.toContain('Submit');
  });

  it('selects the full content wrapper instead of navigation and author article cards', async () => {
    const model = await readTextDocument(
      `<nav><article>Navigation card</article></nav><section id="content">
      <header><article><h1>Report title</h1></article></header>
      <div><h2>Introduction</h2><p>First full report section.</p></div>
      <div><h2>Conclusions</h2><p>Last full report section.</p></div></section>`,
      'html',
      options,
    );
    const content = JSON.stringify(model.blocks);
    expect(content).toContain('First full report section.');
    expect(content).toContain('Last full report section.');
    expect(content).not.toContain('Navigation card');
  });
});
