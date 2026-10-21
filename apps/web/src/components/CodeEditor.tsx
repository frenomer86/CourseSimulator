import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import type { CodeLanguage } from '@cslab/engine-code';

const theme = EditorView.theme({
  '&': { fontSize: '14px', backgroundColor: 'var(--color-surface)', borderRadius: '8px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { padding: '10px 0', minHeight: '220px' },
  '.cm-gutters': { backgroundColor: 'var(--color-bench)', color: 'var(--color-ink-faint)', borderRight: '1px solid var(--color-line)' },
  '.cm-activeLine': { backgroundColor: 'rgba(15, 110, 86, 0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(15, 110, 86, 0.10)' },
  '&.cm-focused': { outline: 'none' },
});

/** A CodeMirror 6 editor for one language. `value` is the source of truth; typing calls onChange. */
export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  ariaLabel = 'Code editor',
}: {
  value: string;
  onChange: (next: string) => void;
  language: CodeLanguage;
  readOnly?: boolean;
  ariaLabel?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const langCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        theme,
        langCompartment.current.of(language === 'python' ? python() : javascript()),
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once; later prop changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (reset, loading a shared solution) replace the document.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: langCompartment.current.reconfigure(language === 'python' ? python() : javascript()) });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({ effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  return <div ref={host} className="rounded-lg border border-line overflow-hidden bg-surface" />;
}
