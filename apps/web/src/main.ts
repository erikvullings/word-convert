import m from 'mithril';
import 'mithril-materialized/index.min.css';

import { App } from './app.ts';
import { createBrowserController } from './controller.ts';
import './styles.css';

const root = document.querySelector<HTMLElement>('#app');

if (root === null) {
  throw new Error('WordConvert application root was not found.');
}

m.mount(root, App(createBrowserController()));
