import type {
  BlockNode,
  DocumentModel,
  InlineNode,
} from '@wordconvert/document-model';

const LANGUAGE_WORDS: Record<string, ReadonlySet<string>> = {
  en: new Set([
    'a',
    'and',
    'are',
    'as',
    'at',
    'be',
    'for',
    'from',
    'in',
    'is',
    'it',
    'of',
    'on',
    'that',
    'the',
    'this',
    'to',
    'was',
    'with',
  ]),
  nl: new Set([
    'aan',
    'als',
    'de',
    'een',
    'en',
    'het',
    'in',
    'is',
    'met',
    'niet',
    'op',
    'te',
    'van',
    'voor',
    'wordt',
    'zijn',
  ]),
  de: new Set([
    'auf',
    'das',
    'der',
    'die',
    'ein',
    'eine',
    'für',
    'im',
    'in',
    'ist',
    'mit',
    'nicht',
    'sind',
    'und',
    'von',
    'zu',
  ]),
  fr: new Set([
    'avec',
    'dans',
    'de',
    'des',
    'du',
    'en',
    'est',
    'et',
    'la',
    'le',
    'les',
    'ne',
    'pas',
    'pour',
    'sont',
    'un',
    'une',
  ]),
  es: new Set([
    'con',
    'de',
    'del',
    'el',
    'en',
    'es',
    'está',
    'la',
    'las',
    'los',
    'no',
    'para',
    'por',
    'que',
    'son',
    'un',
    'una',
    'y',
  ]),
};

export function detectDocumentLanguage(text: string): string | undefined {
  const words = text.toLocaleLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 8) return undefined;
  const scores = Object.entries(LANGUAGE_WORDS)
    .map(([language, commonWords]) => ({
      language,
      score: words.reduce(
        (total, word) => total + Number(commonWords.has(word)),
        0,
      ),
    }))
    .sort((left, right) => right.score - left.score);
  const best = scores[0];
  const runnerUp = scores[1];
  if (!best || best.score < 3 || best.score - (runnerUp?.score ?? 0) < 2)
    return undefined;
  return best.language;
}

export function inferDocumentLanguage(model: DocumentModel): void {
  if (model.metadata.language?.value.trim()) return;
  const language = detectDocumentLanguage(documentText(model));
  if (!language) return;
  model.metadata.language = {
    value: language,
    provenance: {
      source: 'document content',
      method: 'inferred',
      confidence: 'medium',
      reason: 'Detected from common words in the document text.',
    },
  };
}

function documentText(model: DocumentModel): string {
  const parts: string[] = [];
  appendBlockText(model.blocks, parts);
  for (const note of Object.values(model.notes))
    appendBlockText(note.blocks, parts);
  return parts.join(' ').slice(0, 20_000);
}

function appendBlockText(blocks: BlockNode[], parts: string[]): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        appendInlineText(block.children, parts);
        break;
      case 'list':
        for (const item of block.items) appendBlockText(item.blocks, parts);
        break;
      case 'table':
        if (block.caption) appendInlineText(block.caption, parts);
        for (const row of block.rows)
          for (const cell of row.cells) appendBlockText(cell.blocks, parts);
        break;
      case 'blockquote':
        appendBlockText(block.blocks, parts);
        break;
      case 'imageBlock':
        if (block.alt) parts.push(block.alt);
        if (block.caption) appendInlineText(block.caption, parts);
        break;
      case 'codeBlock':
      case 'equationBlock':
      case 'pageBreak':
      case 'thematicBreak':
        break;
    }
  }
}

function appendInlineText(inlines: InlineNode[], parts: string[]): void {
  for (const inline of inlines) {
    if (inline.type === 'text') parts.push(inline.text);
    else if (inline.type === 'link') appendInlineText(inline.children, parts);
    else if (inline.type === 'image' && inline.alt) parts.push(inline.alt);
  }
}
