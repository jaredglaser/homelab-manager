import type { ReactNode } from 'react';

const INLINE_TOKEN = /(`[^`]+`)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
const EMPHASIS_TOKEN = /(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;

const HEADING_CLASS: Record<number, string> = {
  1: 'text-lg font-semibold mt-3 mb-1',
  2: 'text-base font-semibold mt-3 mb-1',
  3: 'text-sm font-semibold mt-2 mb-1',
  4: 'text-sm font-semibold mt-2 mb-1',
  5: 'text-sm font-semibold mt-2 mb-1',
  6: 'text-sm font-semibold mt-2 mb-1',
};

function renderEmphasis(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const match of text.matchAll(EMPHASIS_TOKEN)) {
    const start = match.index;
    if (start > last) nodes.push(text.slice(last, start));
    const bold = match.at(1);
    const italic = match.at(2);
    if (bold !== undefined) {
      nodes.push(
        <strong key={`${keyPrefix}-b${k++}`} className="font-semibold">
          {bold.slice(2, -2)}
        </strong>,
      );
    } else if (italic !== undefined) {
      nodes.push(<em key={`${keyPrefix}-i${k++}`}>{italic.slice(1, -1)}</em>);
    }
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const start = match.index;
    if (start > last) nodes.push(...renderEmphasis(text.slice(last, start), `${keyPrefix}p${k}`));
    const code = match.at(1);
    const linkText = match.at(3);
    const linkUrl = match.at(4);
    if (code !== undefined) {
      nodes.push(
        <code
          key={`${keyPrefix}c${k++}`}
          className="font-mono text-xs bg-level1 border border-border rounded px-1 py-0.5"
        >
          {code.slice(1, -1)}
        </code>,
      );
    } else if (linkText !== undefined && linkUrl !== undefined) {
      nodes.push(
        <a
          key={`${keyPrefix}a${k++}`}
          href={linkUrl}
          target="_blank"
          rel="noreferrer"
          className="text-info underline underline-offset-2 hover:opacity-80"
        >
          {linkText}
        </a>,
      );
    }
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(...renderEmphasis(text.slice(last), `${keyPrefix}p${k}`));
  return nodes;
}

function parseBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <div key={key++} className="my-2 rounded border border-border bg-level1 overflow-hidden">
          {fence[1] && (
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border">
              {fence[1]}
            </div>
          )}
          <pre className="p-3 overflow-x-auto">
            <code className="font-mono text-xs">{code.join('\n')}</code>
          </pre>
        </div>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}` as 'h1';
      blocks.push(
        <Tag key={key++} className={HEADING_CLASS[level]}>
          {renderInline(heading[2], `h${key}`)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-3 border-border" />);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote
          key={key++}
          className="border-l-2 border-border pl-3 my-2 text-muted-foreground"
        >
          {renderInline(quoted.join(' '), `q${key}`)}
        </blockquote>,
      );
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++} className="list-disc pl-5 my-2 space-y-1">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `li${key}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++} className="list-decimal pl-5 my-2 space-y-1">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `ol${key}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s|```|>\s?|[-*]\s+|\d+\.\s+|-{3,}\s*$|\*{3,}\s*$)/.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="my-2">
        {renderInline(paragraph.join(' '), `p${key}`)}
      </p>,
    );
  }
  return blocks;
}

export default function Markdown({ source }: { source: string }) {
  return <div className="text-sm leading-relaxed">{parseBlocks(source)}</div>;
}