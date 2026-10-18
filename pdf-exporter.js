/*
 * pdf-exporter.js — writes annotations into the original PDF bytes with pdf-lib.
 *
 * Needs the global `PDFLib` (lib/pdf-lib.min.js, loaded before this file) and exposes
 * `PDFExporter.exportAnnotatedPdf(pdfBytes, annotations, arxivId)`.
 *
 * What gets drawn:
 *   - highlight / note   -> translucent rectangles over the selected text (yellow unless the user picked a color)
 *   - question           -> translucent orange rectangles (or the picked color)
 *   - underline          -> a line under each text rectangle (red unless the user picked a color)
 *   - text box           -> a filled, bordered box with the text, at the position you dragged it to
 *   - paper notes        -> printed at the top of the appended Annotations page
 *   Overlapping annotations are drawn oldest first, so the newest ends up on top.
 *   - note / question    -> a numbered badge in the right margin, plus the note text on an
 *                           "Annotations" page appended to the end of the PDF
 *
 * Annotation rects are stored top-left-origin in PDF points (see viewer.js); PDF pages are
 * bottom-left-origin, so y is flipped here.
 */
(() => {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;

  const COLORS = {
    highlight: { color: rgb(1, 0.89, 0.2), opacity: 0.4 },
    note: { color: rgb(1, 0.89, 0.2), opacity: 0.4 },
    question: { color: rgb(1, 0.58, 0.24), opacity: 0.4 },
  };
  const UNDERLINE = rgb(0.84, 0.2, 0.42);
  const BADGE = rgb(0.15, 0.39, 0.92);

  /** "#ff9ec7" -> pdf-lib rgb(), or null if the annotation has no custom color. */
  const hexToRgb = (hex) => (/^#[0-9a-f]{6}$/i.test(hex || '') ? rgb(...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)) : null);

  // Standard PDF fonts only cover Latin-1; anything else would throw, so replace it.
  const TYPOGRAPHIC = { '—': '-', '–': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '•': '*', '−': '-' };
  const latin1 = (s) =>
    s
      .replace(/[—–‘’“”…•−]/g, (c) => TYPOGRAPHIC[c])
      .replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF]/g, '?');

  /** Greedy word-wrap using real glyph widths. */
  function wrap(text, font, size, maxWidth) {
    const lines = [];
    for (const para of latin1(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  async function exportAnnotatedPdf(pdfBytes, annotations, arxivId, paperNote = '') {
    const doc = await PDFDocument.load(pdfBytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const pages = doc.getPages();

    // Annotations arrive sorted in reading order; numbers follow that order.
    const callouts = []; // {n, ann}
    for (const ann of annotations) {
      const rects = ann.anchor?.rects;
      if (!rects?.length) continue;

      // Free-floating text box: a filled, bordered box with the wrapped text inside it.
      if (ann.kind === 'textbox') {
        const r = rects[0];
        const page = pages[r.page - 1];
        if (!page) continue;
        const size = 9, lead = 11, pad = 4;
        const lines = wrap(ann.note || '', font, size, r.w - 2 * pad);
        const h = lines.length * lead + 2 * pad;
        const top = page.getHeight() - r.y;
        page.drawRectangle({ x: r.x, y: top - h, width: r.w, height: h, color: hexToRgb(ann.color) || rgb(1, 0.95, 0.66), opacity: 0.95, borderColor: rgb(0.3, 0.3, 0.3), borderWidth: 0.6 });
        lines.forEach((l, i) => page.drawText(l, { x: r.x + pad, y: top - pad - size - i * lead + 1.5, size, font, color: rgb(0.1, 0.1, 0.1) }));
        continue;
      }

      for (const r of rects) {
        const page = pages[r.page - 1];
        if (!page) continue;
        const y = page.getHeight() - r.y - r.h;
        if (ann.kind === 'underline') {
          page.drawLine({ start: { x: r.x, y: y + 1 }, end: { x: r.x + r.w, y: y + 1 }, thickness: 1.2, color: hexToRgb(ann.color) || UNDERLINE });
        } else {
          const { color, opacity } = COLORS[ann.kind] || COLORS.highlight;
          page.drawRectangle({ x: r.x, y, width: r.w, height: r.h, color: hexToRgb(ann.color) || color, opacity });
        }
      }

      if (ann.kind === 'note' || ann.kind === 'question') {
        const n = callouts.length + 1;
        callouts.push({ n, ann });
        // Badge in the right margin, level with the first line of the selection.
        const first = rects[0];
        const page = pages[first.page - 1];
        if (page) {
          const cx = page.getWidth() - 14;
          const cy = page.getHeight() - first.y - first.h / 2;
          page.drawCircle({ x: cx, y: cy, size: 7, color: ann.kind === 'question' ? rgb(0.93, 0.48, 0.1) : BADGE });
          const label = String(n);
          const w = bold.widthOfTextAtSize(label, 7);
          page.drawText(label, { x: cx - w / 2, y: cy - 2.5, size: 7, font: bold, color: rgb(1, 1, 1) });
        }
      }
    }

    // Appended page(s) with the text of every numbered note / question.
    if (callouts.length || paperNote.trim()) {
      const [W, H] = [pages[0].getWidth(), pages[0].getHeight()];
      const margin = 54, size = 10, lead = 13;
      let page = doc.addPage([W, H]);
      let y = H - margin;
      const ensure = (needed) => {
        if (y - needed < margin) {
          page = doc.addPage([W, H]);
          y = H - margin;
        }
      };

      page.drawText(latin1(`Annotations — arXiv:${arxivId}`), { x: margin, y, size: 14, font: bold });
      y -= 28;

      if (paperNote.trim()) {
        page.drawText('Paper notes', { x: margin, y, size: 11, font: bold, color: BADGE });
        y -= lead + 2;
        for (const l of wrap(paperNote.trim(), font, size, W - 2 * margin)) {
          ensure(lead);
          page.drawText(l, { x: margin, y, size, font });
          y -= lead;
        }
        y -= 14;
      }

      for (const { n, ann } of callouts) {
        const where = ann.anchor.rects[0].page;
        const head = `${n}. ${ann.kind === 'question' ? (ann.resolved ? 'Question (resolved)' : 'Open question') : 'Note'}  ·  p. ${where}`;
        const quote = wrap(`"${ann.quote.length > 220 ? ann.quote.slice(0, 219) + '…' : ann.quote}"`, font, size - 1, W - 2 * margin - 12);
        const body = ann.note ? wrap(ann.note, font, size, W - 2 * margin - 12) : [];
        ensure((1 + quote.length + body.length) * lead + 10);

        page.drawText(head, { x: margin, y, size, font: bold, color: BADGE });
        y -= lead;
        for (const l of quote) (page.drawText(l, { x: margin + 12, y, size: size - 1, font, color: rgb(0.4, 0.4, 0.4) }), (y -= lead));
        for (const l of body) (page.drawText(l, { x: margin + 12, y, size, font }), (y -= lead));
        y -= 10;
      }
    }

    const bytes = await doc.save();
    download(bytes, `${arxivId.replace('/', '_')}-annotated.pdf`);
  }

  function download(bytes, filename) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  window.PDFExporter = { exportAnnotatedPdf };
})();
