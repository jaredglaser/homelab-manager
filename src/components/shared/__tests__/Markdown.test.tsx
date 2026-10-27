import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import Markdown from '@/components/shared/Markdown';

describe('Markdown', () => {
  it('renders headings at their levels', () => {
    const { container } = render(<Markdown source={'# Title\n\n## Section\n\n### Detail'} />);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('h2')?.textContent).toBe('Section');
    expect(container.querySelector('h3')?.textContent).toBe('Detail');
  });

  it('renders unordered and ordered lists', () => {
    const { container } = render(<Markdown source={'- alpha\n- beta\n\n1. one\n2. two'} />);
    const ul = container.querySelector('ul');
    expect(ul?.querySelectorAll('li').length).toBe(2);
    expect(ul?.textContent).toContain('alpha');
    const ol = container.querySelector('ol');
    expect(ol?.querySelectorAll('li').length).toBe(2);
    expect(ol?.textContent).toContain('two');
  });

  it('renders fenced code blocks with a language label', () => {
    const { container } = render(<Markdown source={'```ts\nconst x = 1;\n```'} />);
    expect(container.querySelector('pre')?.textContent).toBe('const x = 1;');
    expect(container.textContent).toContain('ts');
  });

  it('renders http(s) links with target blank and noreferrer', () => {
    const { container } = render(<Markdown source={'[docs](https://example.com/guide)'} />);
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com/guide');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noreferrer');
    expect(anchor?.textContent).toBe('docs');
  });

  it('does not linkify non-http schemes', () => {
    const { container } = render(<Markdown source={'[x](javascript:alert(1))'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('[x](javascript:alert(1))');
  });

  it('renders HTML as escaped text with no script element', () => {
    const { container } = render(<Markdown source={'<script>alert(1)</script>'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders bold and italic', () => {
    render(<Markdown source={'**bold** and *italic*'} />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
  });

  it('does not italicize asterisks surrounded by spaces', () => {
    const { container } = render(<Markdown source={'2 * 3 * 4 = 24'} />);
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toContain('2 * 3 * 4 = 24');
  });

  it('renders blockquotes and horizontal rules', () => {
    const { container } = render(<Markdown source={'> quoted\n\n---'} />);
    expect(container.querySelector('blockquote')?.textContent).toBe('quoted');
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('renders inline code', () => {
    const { container } = render(<Markdown source={'run `bun test` now'} />);
    expect(container.querySelector('code')?.textContent).toBe('bun test');
  });
});