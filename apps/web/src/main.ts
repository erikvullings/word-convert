import m from 'mithril';

import './styles.css';

const root = document.querySelector<HTMLElement>('#app');

if (root === null) {
  throw new Error('WordConvert application root was not found.');
}

m.mount(root, {
  view: () =>
    m('main.app-shell', [
      m('h1', 'WordConvert'),
      m(
        'p',
        'Convert Word documents to Markdown, standalone HTML, or EPUB—all processing stays on this device.',
      ),
    ]),
});
