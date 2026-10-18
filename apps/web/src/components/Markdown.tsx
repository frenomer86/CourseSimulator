import { useMemo } from 'react';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

/** Renders trusted lab content (our own Markdown files), not user input. */
export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const html = useMemo(() => marked.parse(source) as string, [source]);
  return <div className={`prose-lab ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** One line of trusted Markdown with no wrapping paragraph, for option labels and short notes. */
export function InlineMarkdown({ source, className = '' }: { source: string; className?: string }) {
  const html = useMemo(() => marked.parseInline(source) as string, [source]);
  return <span className={`prose-lab ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
