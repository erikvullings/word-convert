import m from 'mithril';
import 'mithril-materialized/index.min.css';

import { App } from './app.ts';
import { createBrowserController } from './controller.ts';
import { devFixtureRequested } from './dev-fixture.ts';
import './styles.css';

const root = document.querySelector<HTMLElement>('#app');

if (root === null) {
  throw new Error('WordConvert application root was not found.');
}

const controller = createBrowserController();
m.mount(root, App(controller));

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
    });
  });
}

if (devFixtureRequested(import.meta.env.DEV, window.location.search)) {
  void fetch('/__wordconvert_browser_fixture__.docx')
    .then(async (response) => {
      if (!response.ok) throw new Error('Browser fixture could not be loaded.');
      const data = await response.arrayBuffer();
      controller.selectFiles([
        new File([data], 'standard-comprehensive.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ]);
    })
    .catch(() => undefined);
}
