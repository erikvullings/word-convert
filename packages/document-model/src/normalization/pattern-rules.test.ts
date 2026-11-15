import { describe, expect, it } from 'vitest';
import {
  MAX_TEXT_PATTERN_FILE_BYTES,
  PatternRulesFileError,
  compileTextReplacementRule,
  parseTextPatternRules,
} from '../index.ts';

describe('text pattern rules file', () => {
  it('parses ordered UTF-8 pairs, comments, and empty replacements', () => {
    expect(
      parseTextPatternRules(
        '# first rule\nold\nnew\n# second rule\nremove\n\n',
      ),
    ).toEqual([
      { id: 'text-rule-001', search: 'old', replace: 'new' },
      { id: 'text-rule-002', search: 'remove', replace: '' },
    ]);
  });

  it('rejects malformed or over-budget rule files with structured errors', () => {
    expect(() => parseTextPatternRules('search\n')).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(() =>
      parseTextPatternRules('x\n'.repeat(MAX_TEXT_PATTERN_FILE_BYTES / 2 + 1)),
    ).toThrow(
      expect.objectContaining({
        code: 'resource-limit',
        name: 'PatternRulesFileError',
      } satisfies Partial<PatternRulesFileError>),
    );
    expect(() =>
      parseTextPatternRules(
        Array.from(
          { length: 21 },
          (_, index) => `search-${index}\nreplace`,
        ).join('\n') + '\n',
      ),
    ).toThrow(/20-rule limit/u);
  });

  it('rejects patterns with unsafe backtracking or zero-width assertions before execution', () => {
    expect(
      compileTextReplacementRule({
        id: 'nested',
        search: '(?:a+)+$',
        replace: '',
      }).rejection,
    ).toContain('quantified groups');
    expect(
      compileTextReplacementRule({
        id: 'boundary',
        search: '\\bword',
        replace: '',
      }).rejection,
    ).toContain('word-boundary assertions');
    expect(
      compileTextReplacementRule({
        id: 'empty-match',
        search: 'a*',
        replace: '',
      }).rejection,
    ).toContain('empty text');
  });
});
