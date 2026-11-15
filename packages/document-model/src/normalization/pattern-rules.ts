export const MAX_TEXT_PATTERN_RULES = 20;
export const MAX_TEXT_PATTERN_LENGTH = 256;
export const MAX_TEXT_REPLACEMENT_LENGTH = 1_024;
export const MAX_TEXT_PATTERN_FILE_BYTES = 32 * 1_024;
export const MAX_TEXT_PATTERN_LINE_LENGTH = 2_048;
export const MAX_TEXT_PATTERN_CANDIDATE_LINES = 50_000;
export const MAX_TEXT_PATTERN_MATCHES = 10_000;
export const MAX_TEXT_PATTERN_WORK_MS = 1_000;

export interface TextReplacementRule {
  id: string;
  search: string;
  replace: string;
}

export interface CompiledTextReplacementRule extends TextReplacementRule {
  pattern?: RegExp;
  rejection?: string;
}

export class PatternRulesFileError extends Error {
  constructor(
    readonly code: 'invalid-input' | 'resource-limit',
    message: string,
  ) {
    super(message);
    this.name = 'PatternRulesFileError';
  }
}

export function parseTextPatternRules(source: string): TextReplacementRule[] {
  let encodedBytes = 0;
  for (const character of source) {
    const point = character.codePointAt(0)!;
    encodedBytes +=
      point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  if (encodedBytes > MAX_TEXT_PATTERN_FILE_BYTES)
    throw new PatternRulesFileError(
      'resource-limit',
      `Search/replace rules file exceeds ${MAX_TEXT_PATTERN_FILE_BYTES} bytes.`,
    );

  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const entries = lines.filter((line) => !line.trimStart().startsWith('#'));
  if (entries.length % 2 !== 0)
    throw new PatternRulesFileError(
      'invalid-input',
      'Search/replace rules file must contain alternating search and replacement lines.',
    );
  const count = entries.length / 2;
  if (count > MAX_TEXT_PATTERN_RULES)
    throw new PatternRulesFileError(
      'resource-limit',
      `Search/replace rules file exceeds the ${MAX_TEXT_PATTERN_RULES}-rule limit.`,
    );

  const rules: TextReplacementRule[] = [];
  for (let index = 0; index < entries.length; index += 2) {
    const search = entries[index]!;
    const replace = entries[index + 1]!;
    if (!search)
      throw new PatternRulesFileError(
        'invalid-input',
        `Search pattern on rule ${index / 2 + 1} must not be empty.`,
      );
    if (search.length > MAX_TEXT_PATTERN_LENGTH)
      throw new PatternRulesFileError(
        'resource-limit',
        `Search pattern on rule ${index / 2 + 1} exceeds ${MAX_TEXT_PATTERN_LENGTH} characters.`,
      );
    if (replace.length > MAX_TEXT_REPLACEMENT_LENGTH)
      throw new PatternRulesFileError(
        'resource-limit',
        `Replacement on rule ${index / 2 + 1} exceeds ${MAX_TEXT_REPLACEMENT_LENGTH} characters.`,
      );
    rules.push({
      id: `text-rule-${String(rules.length + 1).padStart(3, '0')}`,
      search,
      replace,
    });
  }
  return rules;
}

export function compileTextReplacementRule(
  rule: TextReplacementRule,
): CompiledTextReplacementRule {
  if (!rule.search || rule.search.length > MAX_TEXT_PATTERN_LENGTH)
    return { ...rule, rejection: 'empty or over-length search pattern' };
  if (rule.replace.length > MAX_TEXT_REPLACEMENT_LENGTH)
    return { ...rule, rejection: 'over-length replacement' };
  const rejection = validatePatternStructure(rule.search);
  if (rejection) return { ...rule, rejection };
  try {
    const pattern = new RegExp(rule.search, 'gu');
    if (pattern.test(''))
      return {
        ...rule,
        rejection: 'patterns that match empty text are unsupported',
      };
    pattern.lastIndex = 0;
    return { ...rule, pattern };
  } catch {
    return { ...rule, rejection: 'invalid regular expression' };
  }
}

function validatePatternStructure(source: string): string | undefined {
  if (
    /\\(?:[1-9]|k<|[bB])/u.test(source) ||
    /\(\?(?:[=!]|<[=!]|<[A-Za-z])/u.test(source)
  )
    return 'lookarounds, backreferences, and word-boundary assertions are unsupported';

  let inClass = false;
  let variableQuantifiers = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === '\\') {
      index++;
      continue;
    }
    if (character === '[' && !inClass) {
      inClass = true;
      continue;
    }
    if (character === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (character === '(') {
      if (source[index + 1] === '?' && source[index + 2] !== ':')
        return 'only noncapturing groups are supported';
      continue;
    }
    if (character === ')') {
      if (/^[*+?{]/u.test(source.slice(index + 1)))
        return 'quantified groups are unsupported';
      continue;
    }
    if (character === '*' || character === '+' || character === '?') {
      if (character === '?' && source[index - 1] === '(') continue;
      if (
        source[index - 1] === '*' ||
        source[index - 1] === '+' ||
        source[index - 1] === '?'
      )
        return 'stacked quantifiers are unsupported';
      variableQuantifiers++;
      continue;
    }
    if (character === '{') {
      const quantifier = /^\{(\d+)(?:,(\d*))?\}/u.exec(source.slice(index));
      if (!quantifier) continue;
      const lower = Number(quantifier[1]);
      const upper =
        quantifier[2] === undefined ? lower : Number(quantifier[2] || Infinity);
      if (!Number.isSafeInteger(lower) || upper > 1_000)
        return 'quantifier bounds must not exceed 1000';
      if (upper !== lower) variableQuantifiers++;
      index += quantifier[0].length - 1;
    }
  }
  if (variableQuantifiers > 1)
    return 'at most one variable quantifier is supported';
  return undefined;
}
