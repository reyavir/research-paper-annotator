/*
 * markdown.js — turns saved annotations into a Markdown document. Plain string building, no libraries.
 * Shared by the panel (content.js), the PDF viewer, and the library page, so every export looks the same.
 *
 * A "paper" is the record we keep in storage: { id, title, paperNote, annotations: [...] }.
 * Each annotation may carry `where` (a section name or "p. 3"), saved alongside it.
 */
(() => {
  const squish = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  /** Reading order: text offset on HTML pages, page + vertical position on PDFs. */
  const positionOf = (a) => a.anchor?.start ?? (a.anchor?.rects?.[0] ? a.anchor.rects[0].page * 1e5 + a.anchor.rects[0].y : 0);

  /** One bullet for one annotation, with its reference text and note nested underneath. */
  function entry(a, bullet) {
    const where = a.where ? ` — _${a.where}_` : '';
    if (a.kind === 'textbox') return `${bullet} ${squish(a.note) || '(empty)'}${where}`;
    const lines = [`${bullet} “${squish(a.quote)}”${where}`];
    if (a.refText) lines.push(...a.refText.split('\n').map((l) => `  - Reference: ${l}`));
    if (a.note) lines.push(...a.note.split('\n').map((l) => `  - ${l}`));
    return lines.join('\n');
  }

  const section = (title, items) => (items.length ? `## ${title}\n\n${items.join('\n')}\n` : null);

  function toMarkdown(paper) {
    const all = [...paper.annotations].sort((x, y) => positionOf(x) - positionOf(y));
    const of = (kind, pred = () => true) => all.filter((a) => a.kind === kind && pred(a));
    const open = (a) => !a.resolved;

    const parts = [
      `# ${squish(paper.title) || 'arXiv:' + paper.id}`,
      '',
      `arXiv: [${paper.id}](https://arxiv.org/abs/${paper.id})`,
      `Exported ${new Date().toISOString().slice(0, 10)} · ${all.length} annotation${all.length === 1 ? '' : 's'}`,
      '',
      paper.paperNote?.trim() ? `## Paper notes\n\n${paper.paperNote.trim()}\n` : null,
      section('Open questions', of('question', open).map((a) => entry(a, '- [ ]'))),
      section('References to check', of('reference').map((a) => entry(a, a.resolved ? '- [x]' : '- [ ]'))),
      section('Notes', of('note').map((a) => entry(a, '-'))),
      section('Highlights', of('highlight').map((a) => entry(a, '-'))),
      section('Underlines', of('underline').map((a) => entry(a, '-'))),
      section('Text boxes', of('textbox').map((a) => entry(a, '-'))),
      section('Resolved questions', of('question', (a) => a.resolved).map((a) => entry(a, '- [x]'))),
      all.length || paper.paperNote?.trim() ? null : '_No annotations yet._\n',
    ];
    return parts.filter((s) => s !== null).join('\n');
  }

  /** Several papers in one file, most recently updated first. */
  function toMarkdownAll(papers) {
    return [...papers].sort((a, b) => (b.updated || 0) - (a.updated || 0)).map(toMarkdown).join('\n---\n\n');
  }

  const filenameFor = (id) => `${id.replace('/', '_')}-annotations.md`;

  function download(text, filename) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  window.APA_MD = { toMarkdown, toMarkdownAll, filenameFor, download };
})();
