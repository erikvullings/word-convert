import type { Extension } from '@codemirror/state';
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
} from '@codemirror/search';
import { EditorView } from 'codemirror';

export function htmlSourceSearchExtension(): Extension {
  let replaceVisible = false;
  let setReplaceVisible: ((visible: boolean) => void) | undefined;

  const toggleReplace = (view: EditorView): boolean => {
    replaceVisible = !replaceVisible;
    if (!setReplaceVisible) openSearchPanel(view);
    setReplaceVisible?.(replaceVisible);
    return true;
  };

  return [
    search({
      top: true,
      createPanel: (view) =>
        createSearchPanel(view, {
          replaceVisible,
          setReplaceVisible: (handler) => {
            setReplaceVisible = handler;
          },
          toggleReplace: () => toggleReplace(view),
          resetReplace: () => {
            replaceVisible = false;
            setReplaceVisible = undefined;
          },
        }),
    }),
    EditorView.domEventHandlers({
      keydown: (event, view) => {
        if (
          !(event.metaKey || event.ctrlKey) ||
          event.key.toLowerCase() !== 'h'
        )
          return false;
        event.preventDefault();
        return toggleReplace(view);
      },
    }),
  ];
}

interface SearchPanelOptions {
  replaceVisible: boolean;
  setReplaceVisible(handler: ((visible: boolean) => void) | undefined): void;
  toggleReplace(): boolean;
  resetReplace(): void;
}

function createSearchPanel(view: EditorView, options: SearchPanelOptions) {
  const panel = element('div', 'cm-search cm-search--compact');
  const findRow = element('div', 'cm-search__row');
  const replaceRow = element('div', 'cm-search__row cm-search__replace');
  const findInput = searchInput('Find', 'search');
  const replaceInput = searchInput('Replace', 'replace');
  findInput.setAttribute('main-field', 'true');

  const optionButtons = new Map<
    'caseSensitive' | 'regexp' | 'wholeWord',
    HTMLButtonElement
  >();
  let query = getSearchQuery(view.state);

  const commit = (): void => {
    const nextQuery = new SearchQuery({
      search: findInput.value,
      replace: replaceInput.value,
      caseSensitive: pressed(optionButtons.get('caseSensitive')),
      regexp: pressed(optionButtons.get('regexp')),
      wholeWord: pressed(optionButtons.get('wholeWord')),
      literal: query.literal,
    });
    if (nextQuery.eq(query)) return;
    query = nextQuery;
    view.dispatch({ effects: setSearchQuery.of(nextQuery) });
  };

  findInput.addEventListener('input', commit);
  replaceInput.addEventListener('input', commit);
  findInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    (event.shiftKey ? findPrevious : findNext)(view);
  });
  replaceInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    replaceNext(view);
  });

  findRow.append(findInput);
  addCommandButton(findRow, '↑', 'Previous match', () => findPrevious(view));
  addCommandButton(findRow, '↓', 'Next match', () => findNext(view));
  const replaceToggle = searchButton('↔', 'Toggle replace');
  replaceToggle.addEventListener('click', options.toggleReplace);
  findRow.append(replaceToggle);
  addOptionButton(
    findRow,
    optionButtons,
    'Aa',
    'Match case',
    'caseSensitive',
    commit,
  );
  addOptionButton(
    findRow,
    optionButtons,
    '.*',
    'Use regular expression',
    'regexp',
    commit,
  );
  addOptionButton(
    findRow,
    optionButtons,
    'ab',
    'Match whole word',
    'wholeWord',
    commit,
  );
  const close = searchButton('×', 'Close search');
  close.addEventListener('click', () => closeSearchPanel(view));
  findRow.append(close);

  replaceRow.append(replaceInput);
  addCommandButton(replaceRow, '↵', 'Replace next', () => replaceNext(view));
  addCommandButton(replaceRow, '≡', 'Replace all', () => replaceAll(view));
  panel.append(findRow, replaceRow);

  const showReplace = (visible: boolean): void => {
    replaceRow.hidden = !visible;
    replaceToggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
    if (visible) replaceInput.focus();
  };
  options.setReplaceVisible(showReplace);
  showReplace(options.replaceVisible);

  panel.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'h') {
      event.preventDefault();
      options.toggleReplace();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
    }
  });

  return {
    dom: panel,
    top: true,
    mount: () => findInput.select(),
    update: () => {
      const nextQuery = getSearchQuery(view.state);
      if (nextQuery.eq(query)) return;
      query = nextQuery;
      findInput.value = query.search;
      replaceInput.value = query.replace;
      setPressed(optionButtons.get('caseSensitive'), query.caseSensitive);
      setPressed(optionButtons.get('regexp'), query.regexp);
      setPressed(optionButtons.get('wholeWord'), query.wholeWord);
    },
    destroy: options.resetReplace,
  };
}

function addCommandButton(
  row: HTMLElement,
  icon: string,
  label: string,
  command: () => boolean,
): void {
  const button = searchButton(icon, label);
  button.addEventListener('click', command);
  row.append(button);
}

function addOptionButton(
  row: HTMLElement,
  buttons: Map<'caseSensitive' | 'regexp' | 'wholeWord', HTMLButtonElement>,
  icon: string,
  label: string,
  option: 'caseSensitive' | 'regexp' | 'wholeWord',
  commit: () => void,
): void {
  const button = searchButton(icon, label);
  setPressed(button, false);
  button.addEventListener('click', () => {
    setPressed(button, !pressed(button));
    commit();
  });
  buttons.set(option, button);
  row.append(button);
}

function searchInput(placeholder: string, name: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cm-textfield';
  input.placeholder = placeholder;
  input.name = name;
  input.setAttribute('aria-label', placeholder);
  return input;
}

function searchButton(icon: string, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-search__button';
  button.textContent = icon;
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

function element(tag: 'div', className: string): HTMLDivElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function pressed(button: HTMLButtonElement | undefined): boolean {
  return button?.getAttribute('aria-pressed') === 'true';
}

function setPressed(
  button: HTMLButtonElement | undefined,
  value: boolean,
): void {
  button?.setAttribute('aria-pressed', value ? 'true' : 'false');
}
