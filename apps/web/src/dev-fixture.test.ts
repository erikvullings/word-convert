import { describe, expect, it } from 'vitest';

import { devFixtureRequested } from './dev-fixture.ts';

describe('development browser fixture', () => {
  it('is available only in development with the explicit fixture query', () => {
    expect(devFixtureRequested(true, '?browser-fixture=standard')).toBe(true);
    expect(devFixtureRequested(false, '?browser-fixture=standard')).toBe(false);
    expect(devFixtureRequested(true, '?browser-fixture=private')).toBe(false);
  });
});
