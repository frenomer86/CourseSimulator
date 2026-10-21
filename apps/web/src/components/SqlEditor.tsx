import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { sql, SQLite } from '@codemirror/lang-sql';

const theme = EditorView.theme({
  '&': { fontSize: '14px', backgroundColor: 'var(--color-surface)', borderRadius: '8px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { padding: '10px 0', minHeight: '160px' },
  '.cm-gutters': { backgroundColor: 'var(--color-bench)', color: 'var(--color-ink-faint)', borderRight: '1px solid var(--color-line)' },
  '.cm-activeLine': { backgroundColor: 'rgba(15, 110, 86, 0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(15, 110, 86, 0.10)' },
  '&.cm-focused': { outline: 'none' },
});

/** A CodeMirror 6 editor for SQLite SQL. */
export function SqlEditor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          theme,
          sql({ dialect: SQLite, upperCaseKeywords: true }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ 'aria-label': 'SQL editor' }),
        ],
      }),
      parent: host.current,
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={host} className="rounded-lg border border-line overflow-hidden bg-surface" />;
}
