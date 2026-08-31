import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MODEL_SCHEMA,
  DOCUMENT_MODEL_VERSION,
  type DocumentModel,
} from '@wordconvert/document-model';

import { detectDocumentLanguage, inferDocumentLanguage } from './language.ts';

describe('document language detection', () => {
  it.each([
    [
      'en',
      'The system is designed for the task and the information is available to support it.',
    ],
    [
      'nl',
      'Het systeem is ontworpen voor de taak en de informatie is beschikbaar voor ondersteuning.',
    ],
    [
      'de',
      'Das System ist für die Aufgabe entwickelt und die Informationen sind verfügbar.',
    ],
    [
      'fr',
      'Le système est conçu pour la tâche et les informations sont disponibles pour le soutien.',
    ],
    [
      'es',
      'El sistema está diseñado para la tarea y la información está disponible para el apoyo.',
    ],
  ])('detects %s from representative prose', (language, text) => {
    expect(detectDocumentLanguage(text)).toBe(language);
  });

  it('does not guess from too little or ambiguous text', () => {
    expect(detectDocumentLanguage('System report')).toBeUndefined();
  });

  it('fills missing language metadata without replacing an explicit language', () => {
    const model = modelWithText(
      'The document is written in English and the language is clear from the text.',
    );
    inferDocumentLanguage(model);
    expect(model.metadata.language).toMatchObject({
      value: 'en',
      provenance: { source: 'document content', method: 'inferred' },
    });

    model.metadata.language = {
      value: 'cy',
      provenance: {
        source: 'document',
        method: 'extracted',
        confidence: 'high',
      },
    };
    inferDocumentLanguage(model);
    expect(model.metadata.language.value).toBe('cy');
  });
});

function modelWithText(text: string): DocumentModel {
  return {
    schema: DOCUMENT_MODEL_SCHEMA,
    version: DOCUMENT_MODEL_VERSION,
    metadata: {
      authors: [],
      subjects: [],
      conversionDate: {
        value: '2026-08-31',
        provenance: {
          source: 'test',
          method: 'default',
          confidence: 'certain',
        },
      },
    },
    blocks: [{ type: 'paragraph', children: [{ type: 'text', text }] }],
    assets: {},
    equations: {},
    notes: {},
    styles: [],
    warnings: [],
  };
}
