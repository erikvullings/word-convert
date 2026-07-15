import { describe, expect, it } from 'vitest';

import { renderApp, type AppController } from './app.ts';
import { createInitialState, WORKFLOW_STAGES } from './state.ts';

describe('App', () => {
  it('renders the complete local workflow with accessible file selection', () => {
    const controller: AppController = {
      state: createInitialState('2026-07-15'),
      selectFiles: () => undefined,
      cancel: () => undefined,
      convert: () => undefined,
      download: () => undefined,
      setTheme: () => undefined,
      setOutputFormat: () => undefined,
    };

    const rendered = JSON.stringify(renderApp(controller));

    for (const stage of WORKFLOW_STAGES) expect(rendered).toContain(stage);
    expect(rendered).toContain('All processing stays on this device');
    expect(rendered).toContain('Choose a DOCX document');
    expect(rendered).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
});
