import m from 'mithril';
import 'mithril-materialized/index.min.css';
import 'mithril-markdown-wysiwyg/dist/index.css';

import { App } from './app.ts';
import { createBrowserController } from './controller.ts';
import { devFixtureKind } from './dev-fixture.ts';
import './styles.css';

const root = document.querySelector<HTMLElement>('#app');

if (root === null) {
  throw new Error('WordConvert application root was not found.');
}

const controller = createBrowserController();
m.mount(root, App(controller));

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    controller.dispose?.();
    m.mount(root, null);
  });
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
    });
  });
}

const fixtureKind = devFixtureKind(import.meta.env.DEV, window.location.search);
if (fixtureKind) {
  const fixture =
    fixtureKind === 'pdf'
      ? {
          url: '/__wordconvert_browser_fixture__.pdf',
          name: 'one-column-book.pdf',
          mediaType: 'application/pdf',
        }
      : {
          url: '/__wordconvert_browser_fixture__.docx',
          name: 'standard-comprehensive.docx',
          mediaType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        };
  void fetch(fixture.url)
    .then(async (response) => {
      if (!response.ok) throw new Error('Browser fixture could not be loaded.');
      const data = await response.arrayBuffer();
      controller.selectFiles([
        new File([data], fixture.name, {
          type: fixture.mediaType,
        }),
      ]);
      m.redraw.sync();
    })
    .catch(() => undefined);
}
