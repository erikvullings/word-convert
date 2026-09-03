// @vitest-environment jsdom

import m from 'mithril';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HtmlSourceEditor } from './html-source-editor.ts';

describe('HtmlSourceEditor', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('opens a compact search panel with replace hidden by default', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    m.mount(root, {
      view: () =>
        m(HtmlSourceEditor, {
          content: '<p>Searchable source</p>',
          theme: 'light',
          onContentChange: () => undefined,
        }),
    });

    await vi.waitFor(() => {
      expect(
        root.querySelector('.cm-search input[main-field="true"]'),
      ).toBeInstanceOf(HTMLInputElement);
    });
    const panel = root.querySelector<HTMLElement>('.cm-search--compact');
    const replace = panel?.querySelector<HTMLElement>('.cm-search__replace');
    const find = panel?.querySelector<HTMLInputElement>('input[name="search"]');
    expect(panel).not.toBeNull();
    expect(replace?.hidden).toBe(true);
    expect(panel?.querySelector('[aria-label="Next match"]')?.textContent).toBe(
      '↓',
    );

    find?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'h',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(replace?.hidden).toBe(false);

    panel
      ?.querySelector<HTMLButtonElement>('[aria-label="Close search"]')
      ?.click();
    expect(root.querySelector('.cm-search')).toBeNull();

    m.mount(root, null);
  });
});
