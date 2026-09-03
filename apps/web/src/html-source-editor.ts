import m from 'mithril';
import type { EditorView } from 'codemirror';
import type { Compartment } from '@codemirror/state';

export interface HtmlSourceEditorAttrs {
  content: string;
  theme: 'light' | 'dark';
  onContentChange(content: string): void;
}

export class HtmlSourceEditor implements m.ClassComponent<HtmlSourceEditorAttrs> {
  private editor: EditorView | undefined;
  private themeCompartment: Compartment | undefined;
  private updating = false;
  private host: HTMLElement | undefined;
  private attrs: HtmlSourceEditorAttrs | undefined;

  oncreate(vnode: m.VnodeDOM<HtmlSourceEditorAttrs>): void {
    this.host =
      (vnode.dom as HTMLElement).querySelector<HTMLElement>(
        '.html-source-editor__mount',
      ) ?? undefined;
    this.attrs = vnode.attrs;
    void Promise.all([
      import('codemirror'),
      import('@codemirror/lang-html'),
      import('@codemirror/state'),
      import('@codemirror/theme-one-dark'),
      import('@codemirror/search'),
      import('./html-source-search.ts'),
    ]).then(
      ([
        { basicSetup, EditorView },
        { html },
        { Compartment },
        { oneDark },
        { openSearchPanel },
        { htmlSourceSearchExtension },
      ]) => {
        if (!this.host || !this.attrs) return;
        this.themeCompartment = new Compartment();
        this.editor = new EditorView({
          doc: this.attrs.content,
          parent: this.host,
          extensions: [
            basicSetup,
            htmlSourceSearchExtension(),
            html(),
            EditorView.lineWrapping,
            this.themeCompartment.of(
              this.attrs.theme === 'dark' ? oneDark : [],
            ),
            EditorView.updateListener.of((update) => {
              if (update.docChanged && !this.updating)
                this.attrs?.onContentChange(update.state.doc.toString());
            }),
          ],
        });
        openSearchPanel(this.editor);
      },
    );
  }

  onupdate(vnode: m.VnodeDOM<HtmlSourceEditorAttrs>): void {
    const previousTheme = this.attrs?.theme;
    this.attrs = vnode.attrs;
    if (
      this.editor &&
      this.themeCompartment &&
      previousTheme !== vnode.attrs.theme
    )
      void import('@codemirror/theme-one-dark').then(({ oneDark }) => {
        const editor = this.editor;
        const themeCompartment = this.themeCompartment;
        if (!editor || !themeCompartment) return;
        editor.dispatch({
          effects: themeCompartment.reconfigure(
            vnode.attrs.theme === 'dark' ? oneDark : [],
          ),
        });
      });
    if (
      !this.editor ||
      this.editor.state.doc.toString() === vnode.attrs.content
    )
      return;
    this.updating = true;
    this.editor.dispatch({
      changes: {
        from: 0,
        to: this.editor.state.doc.length,
        insert: vnode.attrs.content,
      },
    });
    this.updating = false;
  }

  onremove(): void {
    this.host = undefined;
    this.attrs = undefined;
    this.editor?.destroy();
    this.editor = undefined;
    this.themeCompartment = undefined;
  }

  view(): m.Vnode {
    return m('.html-source-editor', m('.html-source-editor__mount'));
  }
}
