import type {
  BlockNode,
  DocumentModel,
  InlineNode,
  TextMark,
} from '@wordconvert/document-model';
import { Lexer, type Token, type Tokens } from 'marked';

export function markdownToBlocks(
  markdown: string,
  model: DocumentModel,
): BlockNode[] {
  const assets = assetUrls(model);
  return blockTokens(Lexer.lex(markdown, { gfm: true }), assets);
}

export function withMarkdownContent(
  model: DocumentModel,
  markdown: string,
): DocumentModel {
  return { ...model, blocks: markdownToBlocks(markdown, model) };
}

function blockTokens(
  tokens: readonly Token[],
  assets: ReadonlyMap<string, string>,
): BlockNode[] {
  return tokens.flatMap((token): BlockNode[] => {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        return [
          {
            type: 'heading',
            level: Math.min(6, Math.max(1, heading.depth)) as
              1 | 2 | 3 | 4 | 5 | 6,
            children: inlineTokens(heading.tokens, assets),
          },
        ];
      }
      case 'paragraph': {
        const paragraph = token as Tokens.Paragraph;
        return [
          {
            type: 'paragraph',
            children: inlineTokens(paragraph.tokens, assets),
          },
        ];
      }
      case 'text': {
        const text = token as Tokens.Text;
        return [
          {
            type: 'paragraph',
            children: inlineTokens(
              text.tokens ?? [{ type: 'text', raw: text.raw, text: text.text }],
              assets,
            ),
          },
        ];
      }
      case 'list': {
        const list = token as Tokens.List;
        return [
          {
            type: 'list',
            ordered: list.ordered,
            ...(list.ordered && list.start !== '' ? { start: list.start } : {}),
            items: list.items.map((item) => ({
              blocks: blockTokens(item.tokens, assets),
            })),
          },
        ];
      }
      case 'blockquote':
        return [
          {
            type: 'blockquote',
            blocks: blockTokens((token as Tokens.Blockquote).tokens, assets),
          },
        ];
      case 'code': {
        const code = token as Tokens.Code;
        return [
          {
            type: 'codeBlock',
            text: code.text,
            ...(code.lang?.trim() ? { language: code.lang.trim() } : {}),
          },
        ];
      }
      case 'hr':
        return [{ type: 'thematicBreak' }];
      case 'table': {
        const table = token as Tokens.Table;
        return [
          {
            type: 'table',
            rows: [table.header, ...table.rows].map((row, rowIndex) => ({
              cells: row.map((cell) => ({
                header: rowIndex === 0,
                blocks: [
                  {
                    type: 'paragraph',
                    children: inlineTokens(cell.tokens, assets),
                  },
                ],
              })),
            })),
          },
        ];
      }
      case 'html':
        return [
          {
            type: 'paragraph',
            children: [{ type: 'text', text: (token as Tokens.HTML).text }],
          },
        ];
      default:
        return [];
    }
  });
}

function inlineTokens(
  tokens: readonly Token[],
  assets: ReadonlyMap<string, string>,
): InlineNode[] {
  return tokens.flatMap((token): InlineNode[] => {
    switch (token.type) {
      case 'text':
      case 'escape':
        return [{ type: 'text', text: (token as Tokens.Text).text }];
      case 'strong':
        return withMark(inlineTokens((token as Tokens.Strong).tokens, assets), {
          type: 'bold',
        });
      case 'em':
        return withMark(inlineTokens((token as Tokens.Em).tokens, assets), {
          type: 'italic',
        });
      case 'del':
        return withMark(inlineTokens((token as Tokens.Del).tokens, assets), {
          type: 'strikethrough',
        });
      case 'codespan':
        return [
          {
            type: 'text',
            text: (token as Tokens.Codespan).text,
            marks: [{ type: 'code' }],
          },
        ];
      case 'link': {
        const link = token as Tokens.Link;
        return [
          {
            type: 'link',
            href: link.href,
            children: inlineTokens(link.tokens, assets),
            ...(link.title ? { title: link.title } : {}),
          },
        ];
      }
      case 'image': {
        const image = token as Tokens.Image;
        const assetId = assets.get(image.href);
        return assetId
          ? [
              {
                type: 'image',
                assetId,
                ...(image.text ? { alt: image.text } : {}),
                ...(image.title ? { title: image.title } : {}),
              },
            ]
          : [{ type: 'text', text: image.text }];
      }
      case 'br':
        return [{ type: 'lineBreak' }];
      case 'html':
        return [{ type: 'text', text: (token as Tokens.HTML).text }];
      default:
        return [];
    }
  });
}

function withMark(nodes: InlineNode[], mark: TextMark): InlineNode[] {
  return nodes.map((node): InlineNode => {
    if (node.type === 'text')
      return { ...node, marks: [...(node.marks ?? []), mark] };
    if (node.type === 'link')
      return { ...node, children: withMark(node.children, mark) };
    return node;
  });
}

function assetUrls(model: DocumentModel): ReadonlyMap<string, string> {
  return new Map(
    Object.values(model.assets).map((asset) => [
      `data:${asset.mediaType.toLowerCase()};base64,${base64(asset.data)}`,
      asset.id,
    ]),
  );
}

function base64(data: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < data.length; offset += 0x8000)
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
