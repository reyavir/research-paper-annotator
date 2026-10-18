/*
 * PDF viewer + PDF adapter.
 *
 * Why this exists: Chrome's built-in PDF viewer is not a normal web page, so extensions can't read
 * its text selection or draw on it. Instead, background.js sends arxiv.org/pdf/* tabs here. We render
 * the same PDF with pdf.js (canvas + a transparent, selectable text layer) and hand the annotator
 * core (content.js) a PDF-flavoured adapter.
 *
 * Anchor shape for PDFs:  { rects: [{ page, x, y, w, h }] }
 *   Units are PDF points measured from the TOP-LEFT of the page at scale 1, so they're
 *   independent of zoom. pdf-exporter.js flips y when drawing into the real PDF.
 */
import * as pdfjsLib from '../lib/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const SCALES = [0.8, 1, 1.2, 1.4, 1.7, 2, 2.5];
let scale = 1.4;

const $ = (id) => document.getElementById(id);
const squish = (s) => s.replace(/\s+/g, ' ').trim();

const src = new URLSearchParams(location.search).get('src');
const srcUrl = src && new URL(src);
const paperId = srcUrl && /(^|\.)arxiv\.org$/.test(srcUrl.hostname) ? APA.parseArxivId(srcUrl.pathname) : null; // only arxiv PDFs

if (!paperId) {
  $('name').textContent = 'Not an arXiv PDF URL.';
  throw new Error('bad src');
}

let originalBytes; // kept pristine for pdf-lib; pdf.js gets a copy because it transfers its buffer
let pdf;
/** @type {{num:number, div:HTMLElement, overlay:HTMLElement, page:any, rendered:boolean}[]} */
const pages = [];
let apa; // annotator core handle

// ---------------------------------------------------------------- load + layout
async function load() {
  $('orig').href = src;
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  originalBytes = await res.arrayBuffer();
  pdf = await pdfjsLib.getDocument({ data: originalBytes.slice(0), isEvalSupported: false }).promise;

  const meta = await pdf.getMetadata().catch(() => null);
  const title = meta?.info?.Title?.trim();
  adapter.titleText = title || `arXiv:${paperId}`;
  $('name').textContent = `${adapter.titleText} (arXiv:${paperId})`;
  document.title = `${adapter.titleText} — annotating`;

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const div = document.createElement('div');
    div.className = 'apa-page';
    div.dataset.page = n;
    const overlay = document.createElement('div');
    overlay.className = 'apa-overlay';
    const boxes = document.createElement('div'); // text boxes live above the text layer so they can be dragged
    boxes.className = 'apa-boxes';
    div.append(overlay, boxes);
    $('pages').append(div);
    pages.push({ num: n, div, overlay, boxes, page, rendered: false });
    observer.observe(div);
  }
  layout();
}

function layout() {
  for (const p of pages) {
    const vp = p.page.getViewport({ scale });
    p.div.style.width = vp.width + 'px';
    p.div.style.height = vp.height + 'px';
    p.div.style.setProperty('--scale-factor', scale);
    p.div.style.setProperty('--total-scale-factor', scale);
    if (p.rendered) {
      p.div.querySelectorAll('canvas,.textLayer').forEach((n) => n.remove());
      p.rendered = false;
      observer.unobserve(p.div);
      observer.observe(p.div); // re-fires if it's on screen
    }
  }
  $('zoom-label').textContent = Math.round((scale / 1) * 100) + '%';
}

// Render pages lazily, a screenful or two ahead of the viewport.
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const p = pages[Number(e.target.dataset.page) - 1];
      if (!p.rendered) renderPage(p);
    }
  },
  { rootMargin: '1500px 0px' }
);

async function renderPage(p) {
  p.rendered = true;
  const viewport = p.page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';
  p.div.insertBefore(canvas, p.overlay); // canvas < overlay < text layer
  const render = p.page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });

  const textDiv = document.createElement('div');
  textDiv.className = 'textLayer';
  p.div.append(textDiv);
  // pdf.js's own viewer does this so drag-selecting across gaps doesn't jump around.
  textDiv.addEventListener('mousedown', () => textDiv.classList.add('selecting'));
  const textLayer = new pdfjsLib.TextLayer({ textContentSource: p.page.streamTextContent(), container: textDiv, viewport });
  await Promise.all([render.promise, textLayer.render()]);
}
document.addEventListener('mouseup', () => document.querySelectorAll('.textLayer.selecting').forEach((t) => t.classList.remove('selecting')));

// ---------------------------------------------------------------- zoom
function zoom(dir) {
  const i = SCALES.findIndex((s) => s >= scale - 1e-6);
  const next = SCALES[Math.min(SCALES.length - 1, Math.max(0, i + dir))];
  if (next === scale) return;
  scale = next;
  layout();
  apa?.restore(); // repaint highlight rects at the new scale
}
$('zoom-in').onclick = () => zoom(1);
$('zoom-out').onclick = () => zoom(-1);

// ---------------------------------------------------------------- PDF adapter
const pageAt = (x, y) =>
  pages.find((p) => {
    const b = p.div.getBoundingClientRect();
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  });

const adapter = {
  alwaysOn: true,
  titleText: '',
  paperId: () => paperId,
  title() {
    return this.titleText;
  },

  capture() {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    const quote = squish(sel.toString());
    if (!quote) return null;

    // Measure each selected text-layer span separately. (range.getClientRects() on its own also
    // returns container boxes, which would give us giant rectangles.)
    const rects = [];
    for (const span of document.querySelectorAll('.textLayer span')) {
      const tn = span.firstChild;
      if (!tn || tn.nodeType !== Node.TEXT_NODE || !r.intersectsNode(tn)) continue;
      const sub = document.createRange();
      sub.selectNodeContents(tn);
      if (tn === r.startContainer) sub.setStart(tn, r.startOffset);
      if (tn === r.endContainer) sub.setEnd(tn, r.endOffset);
      for (const cr of sub.getClientRects()) {
        if (cr.width < 1 || cr.height < 1) continue;
        const p = pageAt(cr.left + cr.width / 2, cr.top + cr.height / 2);
        if (!p) continue;
        const b = p.div.getBoundingClientRect();
        rects.push({ page: p.num, x: (cr.left - b.left) / scale, y: (cr.top - b.top) / scale, w: cr.width / scale, h: cr.height / scale });
      }
    }
    return rects.length ? { quote, anchor: { rects } } : null;
  },

  // Idempotent: clears this annotation's rects first, so it's safe to call again after a zoom.
  paint(ann) {
    this.unpaint(ann);
    if (ann.kind === 'textbox') return paintTextBox(ann);
    for (const r of ann.anchor.rects) {
      const p = pages[r.page - 1];
      if (!p) return false;
      const d = document.createElement('div');
      d.className = `apa-mark apa-rect apa-${ann.kind}`;
      d.dataset.apaId = ann.id;
      Object.assign(d.style, { left: r.x * scale + 'px', top: r.y * scale + 'px', width: r.w * scale + 'px', height: r.h * scale + 'px' });
      p.overlay.append(d);
    }
    return true;
  },

  unpaint(ann) {
    document.querySelectorAll(`[data-apa-id="${ann.id}"]`).forEach((n) => n.remove());
  },

  order: (a) => a.anchor.rects[0].page * 1e5 + a.anchor.rects[0].y,
  where: (a) => `p. ${a.anchor.rects[0].page}`,

  // Overlay rects ignore the mouse (so text stays selectable), so hit-test clicks by geometry.
  hit(e) {
    const p = pageAt(e.clientX, e.clientY);
    if (!p) return null;
    const b = p.div.getBoundingClientRect();
    const x = (e.clientX - b.left) / scale;
    const y = (e.clientY - b.top) / scale;
    for (const n of p.overlay.children) {
      const l = parseFloat(n.style.left) / scale, t = parseFloat(n.style.top) / scale;
      if (x >= l && x <= l + parseFloat(n.style.width) / scale && y >= t && y <= t + parseFloat(n.style.height) / scale) return n.dataset.apaId;
    }
    return null;
  },

  // ---- text boxes: press T, click on the page, type in the panel; drag the box to move it ----
  beginPlaceTextBox() {
    placing = true;
    document.body.classList.add('apa-placing');
  },
  cancelPlaceTextBox() {
    placing = false;
    document.body.classList.remove('apa-placing');
  },
  init(api) {
    core = api;
  },

  exportPdf: (anns, paperNote) => PDFExporter.exportAnnotatedPdf(originalBytes, anns, paperId, paperNote),
};

let core; // { createTextBox, moveAnn } handed to us by the annotator core
let placing = false;
let swallowNextClick = false;
const TEXTBOX_W = 180;

function paintTextBox(ann) {
  const r = ann.anchor.rects[0];
  const p = pages[r.page - 1];
  if (!p) return false;
  const d = document.createElement('div');
  d.className = 'apa-mark apa-textbox' + (ann.note ? '' : ' apa-empty');
  d.dataset.apaId = ann.id;
  d.textContent = ann.note || 'Empty text box';
  Object.assign(d.style, { left: r.x * scale + 'px', top: r.y * scale + 'px', width: r.w * scale + 'px', fontSize: 10 * scale + 'px' });
  d.addEventListener('pointerdown', (e) => dragTextBox(e, ann, d, p));
  p.boxes.append(d);
  return true;
}

function dragTextBox(e, ann, d, p) {
  if (e.button !== 0) return;
  const r0 = ann.anchor.rects[0];
  const [sx, sy] = [e.clientX, e.clientY];
  let [dx, dy] = [0, 0];
  let moved = false;
  d.setPointerCapture(e.pointerId);

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const move = (ev) => {
    [dx, dy] = [ev.clientX - sx, ev.clientY - sy];
    if (!moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag
    moved = true;
    const pw = parseFloat(p.div.style.width), ph = parseFloat(p.div.style.height);
    d.style.left = clamp(r0.x * scale + dx, 0, pw - d.offsetWidth) + 'px';
    d.style.top = clamp(r0.y * scale + dy, 0, ph - d.offsetHeight) + 'px';
  };
  const up = () => {
    d.removeEventListener('pointermove', move);
    d.removeEventListener('pointerup', up);
    if (!moved) return;
    swallowNextClick = true; // the browser still fires a click after a drag; don't treat it as "open popover"
    setTimeout(() => (swallowNextClick = false), 0);
    core.moveAnn(ann.id, { ...r0, x: parseFloat(d.style.left) / scale, y: parseFloat(d.style.top) / scale });
  };
  d.addEventListener('pointermove', move);
  d.addEventListener('pointerup', up);
}

// Capture phase, so we run before the annotator's own click handler.
document.addEventListener(
  'click',
  (e) => {
    if (swallowNextClick) {
      swallowNextClick = false;
      return e.stopImmediatePropagation(); // (stopPropagation wouldn't stop the annotator's listener on this same node)
    }
    if (!placing) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const p = pageAt(e.clientX, e.clientY);
    adapter.cancelPlaceTextBox();
    if (!p) return;
    const b = p.div.getBoundingClientRect();
    const x = Math.min((e.clientX - b.left) / scale, b.width / scale - TEXTBOX_W);
    core.createTextBox({ page: p.num, x: Math.max(0, x), y: (e.clientY - b.top) / scale, w: TEXTBOX_W, h: 0 });
  },
  true
);

// ---------------------------------------------------------------- go
load()
  .then(async () => {
    apa = await APA.start(adapter);
  })
  .catch((err) => {
    console.error('[apa] viewer failed', err);
    $('name').textContent = `Couldn’t load PDF: ${err.message}`;
  });
