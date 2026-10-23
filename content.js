/*
 * Annotator for arXiv — content.js
 *
 * One file, two halves:
 *
 *   1. The ANNOTATOR CORE (state, storage, margin panel, keyboard, Markdown export).
 *      It knows nothing about *where* text lives. It talks to an "adapter".
 *
 *   2. The DOM ADAPTER, used on arxiv.org/abs/* and arxiv.org/html/* pages. It anchors
 *      annotations to text offsets and paints them as <mark> elements.
 *
 * The PDF viewer (viewer/viewer.js) loads this same file and passes its own adapter that
 * anchors annotations to page + rectangle instead. Same UI, same shortcuts, same storage.
 *
 * Adapter contract (all sync unless noted):
 *   paperId()      -> "2301.12345" | "hep-th/9901001" | null
 *   title()        -> string
 *   capture()      -> { quote, anchor } | null     read the current text selection
 *   paint(ann)     -> boolean                       draw it; false = couldn't locate (orphan)
 *   unpaint(ann)
 *   order(ann)     -> number                        position in document (for sort / J / K)
 *   where(ann)     -> string                        "p. 3" / section name, used in Markdown + cards
 *   hit(event)     -> id | null                     optional click hit-testing
 *   exportPdf(anns)-> Promise                       optional (PDF viewer only)
 */
(() => {
  if (window.APA) return; // guard against double injection

  // ---------------------------------------------------------------- config
  const CONFIG = {
    // Single-key shortcuts, active when the panel is open and you're not typing in a field.
    keys: {
      highlight: 'h',
      underline: 'u',
      note: 'n',
      question: 'q',
      next: 'j',
      prev: 'k',
      resolve: 'r', // toggle "resolved" on the active annotation
      color: 'c', // open the color / kind popover for the active annotation
      erase: 'e', // remove highlighting from the selected text
      textbox: 't', // PDF viewer only: then click on the page to place a text box
      reference: 'l', // save the selected citation / term under "References to check"
      edit: 'Enter', // edit note on the active annotation
      remove: ['Backspace', 'Delete'],
    },
    // Ctrl/Cmd + Shift + <code>
    exportMarkdownCode: 'KeyE',
    exportPdfCode: 'KeyD',
    storagePrefix: 'paper:',
    quoteContext: 32, // chars of prefix/suffix stored for re-anchoring
  };

  const KIND_LABEL = { highlight: 'Highlight', underline: 'Underline', note: 'Note', question: 'Question', textbox: 'Text box', reference: 'To check' };
  const TEXT_KINDS = ['highlight', 'underline', 'note', 'question']; // kinds you can switch between (a text box isn't tied to text)
  const PALETTE = ['#ffe234', '#8be28b', '#7ec8ff', '#ff9ec7', '#ffa95c', '#c4a5ff'];
  const UNDO_LIMIT = 50;

  // ---------------------------------------------------------------- tiny helpers
  const uid = () => Math.random().toString(36).slice(2, 10);
  const squish = (s) => s.replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  /** "[13]", "[3, 7]", "Vaswani et al., 2017" -> true. Plain pattern matching, nothing fancier. */
  const looksLikeCitation = (q) =>
    /\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/.test(q) || (q.length < 80 && /[A-Z][A-Za-z'’-]+.*\b(?:19|20)\d{2}[a-z]?\b/.test(q));

  /** Where to look a reference up. Only opened if the user clicks the link. */
  const scholarUrl = (a) => 'https://scholar.google.com/scholar?q=' + encodeURIComponent((a.refText || a.quote).split('\n')[0].replace(/^\[\d+\]\s*/, '').slice(0, 200));

  /**
   * "/abs/2301.12345v2" | "/pdf/2301.12345v2.pdf" | "/html/hep-th/9901001" -> "2301.12345" | "hep-th/9901001".
   * The version is dropped so annotations follow you from v1 to v2.
   */
  function parseArxivId(pathname) {
    const m = pathname.match(/^\/(?:abs|html|pdf)\/((?:[a-z-]+(?:\.[A-Za-z]{2})?\/\d{7})|(?:\d{4}\.\d{4,5}))/i);
    return m ? m[1] : null;
  }

  /** Build DOM without innerHTML (arXiv pages may enforce Trusted Types; also avoids injection). */
  function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) node.append(kid);
    return node;
  }

  // ====================================================================================
  //  DOM ADAPTER  (abs + html pages)
  // ====================================================================================
  /**
   * Anchor = { start, end, prefix, suffix } as character offsets into the concatenation of
   * every text node under <body>. Marks only wrap text nodes, so offsets survive painting.
   * The panel lives outside <body>, so it never pollutes the offsets.
   * If the page text shifts (e.g. a new paper version), we fall back to searching for the quote,
   * using prefix/suffix to pick the right occurrence.
   */
  const domAdapter = (() => {
    const root = document.body;

    function walk() {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let pos = 0;
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        nodes.push({ node: n, start: pos });
        pos += n.data.length;
      }
      return { nodes, text: nodes.map((x) => x.node.data).join('') };
    }

    const paperId = () => parseArxivId(location.pathname);

    function title() {
      const t =
        document.querySelector('h1.title')?.textContent.replace(/^Title:/, '') ||
        document.querySelector('h1.ltx_title_document')?.textContent ||
        document.title;
      return squish(t);
    }

    /**
     * arXiv's HTML turns every in-text citation into a link to its bibliography entry (href="#bib.bib13").
     * If the selection is, or contains, such a link, return the full reference text(s) so the user
     * doesn't have to scroll down to read what "[13]" is.
     */
    function citedReferences(r) {
      const links = new Set(r.cloneContents().querySelectorAll('a[href*="#bib"]'));
      const anc = r.commonAncestorContainer;
      const own = (anc.nodeType === 1 ? anc : anc.parentElement)?.closest('a[href*="#bib"]');
      if (own) links.add(own);
      const out = [];
      for (const a of links) {
        const id = decodeURIComponent((a.getAttribute('href') || '').split('#')[1] || '');
        const target = id && document.getElementById(id);
        if (target) out.push(squish(target.textContent));
      }
      return [...new Set(out)].join('\n').slice(0, 800);
    }

    function capture() {
      const sel = getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      const r = sel.getRangeAt(0);
      if (!root.contains(r.commonAncestorContainer)) return null;

      const pre = document.createRange();
      pre.selectNodeContents(root);
      pre.setEnd(r.startContainer, r.startOffset);

      let quote = r.toString();
      let start = pre.toString().length;
      start += quote.length - quote.trimStart().length; // trim selection whitespace
      quote = quote.trim();
      if (!quote) return null;

      const end = start + quote.length;
      const { text } = walk();
      const c = CONFIG.quoteContext;
      const refText = citedReferences(r);
      return {
        quote,
        extra: refText ? { refText } : undefined,
        anchor: { start, end, prefix: text.slice(Math.max(0, start - c), start), suffix: text.slice(end, end + c) },
      };
    }

    /** Find where `ann` lives now: exact offsets if the text still matches, else search for the quote. */
    function locate(text, ann) {
      const { start, end, prefix } = ann.anchor;
      if (text.slice(start, end) === ann.quote) return [start, end];

      let best = null;
      let bestScore = -Infinity;
      for (let i = text.indexOf(ann.quote); i !== -1; i = text.indexOf(ann.quote, i + 1)) {
        const before = text.slice(Math.max(0, i - prefix.length), i);
        const score = (before === prefix ? 1e9 : 0) - Math.abs(i - start);
        if (score > bestScore) [best, bestScore] = [i, score];
      }
      return best == null ? null : [best, best + ann.quote.length];
    }

    function paint(ann) {
      const { nodes, text } = walk();
      const range = locate(text, ann);
      if (!range) return false;
      const [start, end] = range;

      for (const { node, start: ns } of nodes) {
        const len = node.data.length;
        if (ns + len <= start || ns >= end) continue;
        const s = Math.max(start, ns) - ns;
        const t = Math.min(end, ns + len) - ns;
        if (!node.data.slice(s, t).trim()) continue;
        const parent = node.parentElement;
        if (!parent || parent.closest('script,style,noscript,textarea')) continue;

        // <mark> isn't valid inside MathML, so style the whole <math> element instead.
        const math = parent.closest('math');
        if (math) {
          math.classList.add('apa-mark', 'apa-' + ann.kind);
          math.dataset.apaId = ann.id;
          continue;
        }

        let target = node;
        if (t < node.data.length) node.splitText(t);
        if (s > 0) target = node.splitText(s);
        const mark = el('mark', { class: `apa-mark apa-${ann.kind}`, dataset: { apaId: ann.id } });
        target.parentNode.insertBefore(mark, target);
        mark.appendChild(target);
      }
      return true;
    }

    function unpaint(ann) {
      for (const m of document.querySelectorAll(`[data-apa-id="${ann.id}"]`)) {
        if (m.tagName === 'MARK') {
          const p = m.parentNode;
          while (m.firstChild) p.insertBefore(m.firstChild, m);
          p.removeChild(m);
          p.normalize();
        } else {
          m.classList.remove('apa-mark', 'apa-' + ann.kind, 'apa-resolved', 'apa-active');
          delete m.dataset.apaId;
        }
      }
    }

    function where(ann) {
      const node = document.querySelector(`[data-apa-id="${ann.id}"]`);
      if (!node) return '';
      if (node.closest('.abstract')) return 'Abstract';
      const heading = node.closest('section')?.querySelector('h1,h2,h3,h4,h5,h6');
      return heading ? clip(squish(heading.textContent), 60) : '';
    }

    /** What the user selected, for erasing: just its [start, end) range of page text. */
    function captureRegion() {
      const c = capture();
      return c && { start: c.anchor.start, end: c.anchor.end };
    }

    /** What's left of `ann` once `region` is removed: null if untouched, otherwise 0, 1 or 2 pieces. */
    function subtract(ann, region) {
      const { text } = walk();
      const loc = locate(text, ann);
      if (!loc) return null;
      const [start, end] = loc;
      if (end <= region.start || start >= region.end) return null;

      const piece = (a, b) => {
        while (a < b && /\s/.test(text[a])) a++;
        while (b > a && /\s/.test(text[b - 1])) b--;
        if (a >= b) return null;
        const c = CONFIG.quoteContext;
        return { quote: text.slice(a, b), anchor: { start: a, end: b, prefix: text.slice(Math.max(0, a - c), a), suffix: text.slice(b, b + c) } };
      };
      return [start < region.start && piece(start, region.start), end > region.end && piece(region.end, end)].filter(Boolean);
    }

    return { paperId, title, capture, captureRegion, subtract, paint, unpaint, order: (a) => a.anchor.start, where, hit: null };
  })();

  // ====================================================================================
  //  ANNOTATOR CORE
  // ====================================================================================
  async function start(adapter) {
    const id = adapter.paperId();
    if (!id) return;
    const storageKey = CONFIG.storagePrefix + id;

    /** @type {Array<{id:string,kind:string,quote:string,note:string,resolved:boolean,created:number,anchor:any,orphan?:boolean}>} */
    let anns = [];
    let activeId = null;
    let lastActiveId = null; // where J / K carry on from after the selection is cleared
    let editingId = null;
    let filter = 'all'; // all | question | note
    let enabled = adapter.alwaysOn || false;
    let undoStack = []; // JSON snapshots of `anns`
    let redoStack = [];
    let popover = null;
    let paperNote = ''; // free-form notes about the whole paper

    // ------------------------------------------------------------ persistence
    let saveTimer;
    function save() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        // `where` (section / page) is stored too, so the library page can export Markdown without the paper open.
        const clean = anns.map(({ orphan, ...rest }) => ({ ...rest, where: adapter.where(rest) || rest.where }));
        chrome.storage.local.set({
          [storageKey]: { id, title: adapter.title(), url: location.href, updated: Date.now(), paperNote, annotations: clean },
        });
      }, 250);
    }

    const stored = (await chrome.storage.local.get(storageKey))[storageKey];
    anns = stored?.annotations || [];
    paperNote = stored?.paperNote || '';
    // Show the panel automatically if this paper already has annotations.
    if (anns.length || paperNote) enabled = true;

    // ------------------------------------------------------------ panel
    const list = el('div', { class: 'apa-list' });
    const count = el('span', { class: 'apa-count' });
    const toast = el('div', { class: 'apa-toast' });
    const filters = ['all', 'question', 'note'].map((f) =>
      el('button', { class: 'apa-chipbtn', dataset: { f }, onclick: () => ((filter = f), renderPanel()) }, f === 'all' ? 'All' : f === 'question' ? 'Questions' : 'Notes')
    );

    const paperNoteBox = el(
      'details',
      { class: 'apa-paper', open: !!paperNote },
      el('summary', {}, 'Paper notes'),
      el('textarea', {
        class: 'apa-textarea',
        rows: 5,
        placeholder: 'Summary, what to read next, overall thoughts…',
        oninput: (e) => ((paperNote = e.target.value), save()),
        onkeydown: (e) => e.stopPropagation(),
      }, paperNote)
    );

    const refSummary = el('summary', {}, 'References to check');
    const refList = el('div', { class: 'apa-reflist' });
    const refBox = el('details', { class: 'apa-refs', hidden: true }, refSummary, refList);

    const host = el(
      'aside',
      { class: 'apa-host', 'aria-label': 'Paper annotations' },
      el('header', { class: 'apa-head' }, el('strong', {}, 'Annotations ', count), el('button', { class: 'apa-x', title: 'Close panel', onclick: () => setEnabled(false) }, '×')),
      el('div', { class: 'apa-filters' }, filters),
      list,
      refBox,
      paperNoteBox,
      el(
        'footer',
        { class: 'apa-foot' },
        el('div', { class: 'apa-hints' }, hint('H', 'highlight'), hint('U', 'underline'), hint('N', 'note'), hint('Q', 'question'), hint('L', 'to check'), hint('E', 'erase'), hint('J/K', 'next/prev'), hint('R', 'resolve'), hint('C', 'color'), adapter.beginPlaceTextBox ? hint('T', 'text box') : null, hint('⌫', 'delete')),
        el(
          'div',
          { class: 'apa-btns' },
          el('button', { onclick: exportMarkdown, title: 'Ctrl/Cmd+Shift+E' }, 'Copy Markdown'),
          el('button', { onclick: downloadMarkdown, title: 'Save as a .md file' }, 'Download .md'),
          adapter.beginPlaceTextBox ? el('button', { onclick: () => adapter.beginPlaceTextBox() }, 'Text box') : null,
          adapter.exportPdf ? el('button', { onclick: exportPdf, title: 'Ctrl/Cmd+Shift+D' }, 'Annotated PDF') : null,
          el('button', { onclick: () => chrome.runtime.sendMessage({ type: 'apa-open-library' }), title: 'Open questions and notes across all papers' }, 'All papers')
        )
      ),
      toast
    );
    function hint(k, label) {
      return el('span', {}, el('kbd', {}, k), ' ' + label);
    }
    document.documentElement.appendChild(host);

    // Button bar that appears next to a text selection: the mouse route to everything the keys do.
    const selBtn = (label, kind) => el('button', { class: kind === 'reference' ? 'apa-sel-ref' : '', onclick: () => create(kind) }, label);
    const selbar = el(
      'div',
      { class: 'apa-selbar', hidden: true, onmousedown: (e) => e.preventDefault() }, // preventDefault keeps the selection alive
      selBtn('Highlight', 'highlight'),
      selBtn('Underline', 'underline'),
      selBtn('Note', 'note'),
      selBtn('Question', 'question'),
      selBtn('+ To check', 'reference'),
      el('button', { title: 'Remove highlighting from the selected text (E)', onclick: eraseSelection }, 'Erase')
    );
    document.documentElement.appendChild(selbar);

    function updateSelbar() {
      const sel = getSelection();
      const anchorEl = sel?.anchorNode?.parentElement;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !anchorEl || anchorEl.closest('.apa-host,.apa-pop,.apa-selbar,input,textarea')) return void (selbar.hidden = true);
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (!r.width && !r.height) return void (selbar.hidden = true);
      selbar.hidden = false;
      const [w, h] = [selbar.offsetWidth, selbar.offsetHeight];
      selbar.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
      selbar.style.top = (r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8) + 'px';
    }
    document.addEventListener('mouseup', () => setTimeout(updateSelbar, 0));
    document.addEventListener('selectionchange', () => getSelection()?.isCollapsed && (selbar.hidden = true));
    window.addEventListener('wheel', () => (selbar.hidden = true), { passive: true });

    // Small tab on the right edge, shown while the panel is closed, so it's always possible to get back in.
    const reopenTab = el('button', { class: 'apa-tab', title: 'Open annotations (Alt+A)', onclick: () => setEnabled(true) });
    document.documentElement.appendChild(reopenTab);

    function showToast(msg) {
      toast.textContent = msg;
      toast.classList.add('apa-show');
      clearTimeout(showToast.t);
      showToast.t = setTimeout(() => toast.classList.remove('apa-show'), 2200);
      if (!enabled) {
        // The panel is hidden, so its toast can't be seen. Show the message on the edge tab instead.
        reopenTab.textContent = msg;
        clearTimeout(showToast.tabT);
        showToast.tabT = setTimeout(() => (reopenTab.textContent = tabLabel()), 2200);
      }
    }

    const tabLabel = () => (anns.length ? `Annotations (${anns.length})` : 'Annotate');

    function setEnabled(on) {
      enabled = on;
      document.documentElement.classList.toggle('apa-open', on);
      host.hidden = !on;
      reopenTab.hidden = on;
      updateSelbar(); // the selection bar stays available while the panel is closed
    }

    // ------------------------------------------------------------ rendering
    const sorted = () => [...anns].sort((a, b) => adapter.order(a) - adapter.order(b));
    const matchesFilter = (a) => filter === 'all' || (filter === 'question' ? a.kind === 'question' : a.kind === 'note');
    /** The main list. References to check live in their own section below it. */
    const visible = () => sorted().filter((a) => a.kind !== 'reference' && matchesFilter(a));
    /** What J / K walk through. */
    const navItems = () => sorted().filter(matchesFilter);
    const byId = (i) => anns.find((a) => a.id === i);

    function renderPanel() {
      count.textContent = `(${anns.length})`;
      reopenTab.textContent = tabLabel();
      for (const b of filters) b.classList.toggle('apa-on', b.dataset.f === filter);
      list.replaceChildren(...visible().map(card));
      const refs = sorted().filter((a) => a.kind === 'reference');
      refBox.hidden = !refs.length;
      refSummary.textContent = `References to check (${refs.filter((a) => !a.resolved).length} left of ${refs.length})`;
      refList.replaceChildren(...refs.map(refCard));
      if (!anns.length) list.append(el('p', { class: 'apa-empty' }, 'Select text, then press H to highlight, N to add a note, Q to flag a question.'));
      syncMarkState();
      if (editingId) host.querySelector('.apa-list textarea, .apa-reflist textarea')?.focus(); // immediately, so the first keystroke isn't lost
    }

    /** One row in the "References to check" section. */
    function refCard(a) {
      return el(
        'article',
        { class: `apa-ref${a.resolved ? ' apa-resolved' : ''}${a.id === activeId ? ' apa-active' : ''}`, dataset: { id: a.id }, onclick: () => setActive(a.id, true) },
        el(
          'div',
          { class: 'apa-ref-top' },
          el('input', { type: 'checkbox', checked: a.resolved, title: 'Mark as checked (R)', onclick: (e) => (e.stopPropagation(), toggleResolved(a.id)) }),
          el('span', { class: 'apa-ref-text' }, clip(a.quote, 120)),
          el('span', { class: 'apa-chip' }, a.refType === 'citation' ? 'Citation' : 'Term'),
          el('span', { class: 'apa-where' }, adapter.where(a)),
          el('button', { title: 'Delete (Backspace)', onclick: (e) => (e.stopPropagation(), remove(a.id)) }, '🗑')
        ),
        a.refText ? el('div', { class: 'apa-reftext' }, clip(a.refText, 320)) : null,
        a.orphan ? el('div', { class: 'apa-orphan' }, '⚠ Couldn’t find this text on the page') : null,
        el('a', { class: 'apa-lookup', href: scholarUrl(a), target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, 'Look up on Google Scholar ↗'),
        noteBlock(a)
      );
    }

    /** The editable note under a card: textarea while editing, text otherwise, placeholder if empty. */
    function noteBlock(a) {
      return (
        editingId === a.id
          ? el('textarea', {
              class: 'apa-textarea',
              rows: 3,
              placeholder: a.kind === 'question' ? 'What are you unsure about?' : 'Note…',
              onkeydown: (e) => {
                e.stopPropagation();
                if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) e.target.blur();
              },
              onblur: (e) => {
                if (editingId !== a.id) return; // re-entrant blur while the textarea is being removed
                const text = e.target.value.trim();
                if (text !== a.note) (checkpoint(), (a.note = text));
                if (a.kind === 'textbox') adapter.paint(a); // the box on the page shows its text
                editingId = null;
                save();
                renderPanel();
              },
            }, a.note)
          : a.note
          ? el('div', { class: 'apa-note', onclick: (e) => (e.stopPropagation(), startEdit(a.id)) }, a.note)
          : a.kind === 'note' || a.kind === 'question' || a.kind === 'textbox' || a.kind === 'reference'
          ? el('div', { class: 'apa-note apa-placeholder', onclick: (e) => (e.stopPropagation(), startEdit(a.id)) }, a.kind === 'textbox' ? 'Add text…' : 'Add a note…')
          : null
      );
    }

    function card(a) {
      const wh = adapter.where(a);
      const noteArea = noteBlock(a);

      return el(
        'article',
        {
          class: `apa-card apa-k-${a.kind}${a.resolved ? ' apa-resolved' : ''}${a.id === activeId ? ' apa-active' : ''}`,
          style: a.color ? `border-left-color:${a.color}` : false,
          dataset: { id: a.id },
          onclick: () => setActive(a.id, true),
        },
        el(
          'div',
          { class: 'apa-card-top' },
          el('span', { class: 'apa-chip' }, a.kind === 'question' && a.resolved ? 'Resolved' : KIND_LABEL[a.kind]),
          el('span', { class: 'apa-where' }, wh),
          a.kind === 'question' ? el('button', { title: 'Toggle resolved (R)', onclick: (e) => (e.stopPropagation(), toggleResolved(a.id)) }, a.resolved ? '↺' : '✓') : null,
          el('button', { title: 'Delete (Backspace)', onclick: (e) => (e.stopPropagation(), remove(a.id)) }, '🗑')
        ),
        a.quote ? el('blockquote', { class: 'apa-quote' }, clip(a.quote, 160)) : null,
        a.orphan ? el('div', { class: 'apa-orphan' }, '⚠ Couldn’t find this text on the page (paper version changed?)') : null,
        noteArea
      );
    }

    /**
     * Kind / color / active / resolved styling on the painted marks (works for both <mark> and PDF rects).
     * Adapters only decide *where* marks go; how they look is all driven from here.
     */
    function syncMarkState() {
      for (const n of document.querySelectorAll('[data-apa-id]')) {
        const a = byId(n.dataset.apaId);
        if (!a) continue;
        for (const k of Object.keys(KIND_LABEL)) n.classList.toggle('apa-' + k, a.kind === k);
        n.classList.toggle('apa-active', a.id === activeId);
        n.classList.toggle('apa-resolved', a.resolved);
        if (a.color) n.style.setProperty('--apa-c', a.color);
        else n.style.removeProperty('--apa-c');
      }
    }

    // ------------------------------------------------------------ undo / redo
    const snapshot = () => JSON.stringify(anns.map(({ orphan, ...rest }) => rest));

    /** Call right BEFORE any change to `anns`. */
    function checkpoint() {
      undoStack.push(snapshot());
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack = [];
    }

    /** Oldest first, so when highlights overlap the newest ends up on top (innermost mark / last rect). */
    function repaintAll() {
      for (const a of [...anns].sort((x, y) => x.created - y.created)) a.orphan = !adapter.paint(a);
    }

    function loadSnapshot(snap) {
      closePopover();
      anns.forEach((a) => adapter.unpaint(a));
      anns = JSON.parse(snap);
      repaintAll();
      if (!byId(activeId)) activeId = null;
      editingId = null;
      save();
      renderPanel();
    }

    function undo() {
      if (!undoStack.length) return showToast('Nothing to undo');
      redoStack.push(snapshot());
      loadSnapshot(undoStack.pop());
    }

    function redo() {
      if (!redoStack.length) return showToast('Nothing to redo');
      undoStack.push(snapshot());
      loadSnapshot(redoStack.pop());
    }

    // ------------------------------------------------------------ popover (click a highlight)
    function closePopover() {
      popover?.remove();
      popover = null;
    }

    let popPos = { x: 0, y: 0 };
    const reopenPopover = () => popover && openPopover(activeId, popPos.x, popPos.y);

    function openPopover(annId, x, y) {
      closePopover();
      const a = byId(annId);
      if (!a) return;
      popPos = { x, y };

      const swatch = (c) => el('button', { class: `apa-swatch${a.color === c ? ' apa-on' : ''}`, style: `background:${c}`, title: c, onclick: () => setColor(a.id, c) });
      const custom = el('input', { type: 'color', class: 'apa-custom', title: 'Custom color', value: a.color || PALETTE[0], oninput: (e) => setColor(a.id, e.target.value, true) });
      const kindBtn = (k) => el('button', { class: a.kind === k ? 'apa-on' : '', onclick: () => setKind(a.id, k) }, KIND_LABEL[k]);

      popover = el(
        'div',
        { class: 'apa-pop', onmousedown: (e) => e.stopPropagation() },
        el('div', { class: 'apa-pop-row' }, PALETTE.map(swatch), custom, a.color ? el('button', { class: 'apa-pop-reset', title: 'Default color', onclick: () => setColor(a.id, null) }, '↺') : null),
        a.kind === 'textbox' || a.kind === 'reference' ? null : el('div', { class: 'apa-pop-row apa-pop-kinds' }, TEXT_KINDS.map(kindBtn)),
        el(
          'div',
          { class: 'apa-pop-row' },
          el('button', { onclick: () => (closePopover(), startEdit(a.id)) }, 'Edit note'),
          el('button', { class: 'apa-danger', onclick: () => (closePopover(), remove(a.id)) }, 'Delete')
        )
      );
      document.documentElement.append(popover);

      const w = popover.offsetWidth, h = popover.offsetHeight;
      popover.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
      popover.style.top = Math.max(8, Math.min(y + 12, innerHeight - h - 8)) + 'px';
    }

    // Only one undo step per color drag: the native color input fires `input` continuously.
    let lastColorEdit = 0;
    function setColor(i, color, continuous = false) {
      const a = byId(i);
      if (!a) return;
      if (!continuous || Date.now() - lastColorEdit > 1500) checkpoint();
      lastColorEdit = continuous ? Date.now() : 0;
      a.color = color || undefined;
      save();
      renderPanel();
      if (!continuous) reopenPopover(); // refresh the selected swatch (not mid-drag: it would close the native picker)
    }

    function setKind(i, kind) {
      const a = byId(i);
      if (!a || a.kind === kind) return;
      checkpoint();
      a.kind = kind;
      if (kind !== 'question') a.resolved = false;
      save();
      renderPanel();
      reopenPopover();
    }

    function openPopoverNearActive() {
      const target = document.querySelector(`[data-apa-id="${activeId}"]`);
      if (!target) return;
      const r = target.getBoundingClientRect();
      openPopover(activeId, r.left, r.bottom);
    }

    // ------------------------------------------------------------ actions
    function create(kind) {
      const cap = adapter.capture();
      if (!cap) return showToast('Select some text first');
      if ((kind === 'note' || kind === 'question') && !enabled) setEnabled(true); // they need the panel's text box
      checkpoint();
      const a = { id: uid(), kind, quote: cap.quote, note: '', resolved: false, created: Date.now(), anchor: cap.anchor };
      if (kind === 'reference') {
        Object.assign(a, cap.extra);
        a.refType = a.refText || looksLikeCitation(a.quote) ? 'citation' : 'term';
        refBox.open = true;
      }
      anns.push(a);
      adapter.paint(a);
      getSelection()?.removeAllRanges();
      activeId = a.id;
      if (kind === 'note' || kind === 'question') editingId = a.id;
      save();
      renderPanel();
      host.querySelector('.apa-card.apa-active, .apa-ref.apa-active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (kind === 'reference') showToast('Added to References to check');
      else if (!enabled) showToast(`${KIND_LABEL[kind]} added`); // panel is closed: the tab on the edge shows this
    }

    /**
     * Un-highlight part of an annotation: select the part you want gone and press E.
     * Annotations the selection cuts into are trimmed, or split in two if it falls in the middle.
     * (A piece split off keeps the kind, color and reference text, but not the note.)
     */
    function eraseSelection() {
      const region = adapter.captureRegion?.();
      if (!region) return showToast('Select the text you want to un-highlight');
      const touched = [];
      for (const a of anns) {
        if (a.kind === 'textbox') continue;
        const pieces = adapter.subtract(a, region);
        if (pieces) touched.push([a, pieces]);
      }
      if (!touched.length) return showToast('Nothing highlighted there');

      checkpoint();
      closePopover();
      for (const [a, pieces] of touched) {
        adapter.unpaint(a);
        if (!pieces.length) {
          anns = anns.filter((x) => x !== a);
          if (activeId === a.id) activeId = null;
          continue;
        }
        const [first, ...rest] = pieces;
        Object.assign(a, { quote: first.quote, anchor: first.anchor });
        adapter.paint(a);
        for (const piece of rest) {
          const copy = { ...a, id: uid(), note: '', quote: piece.quote, anchor: piece.anchor };
          anns.push(copy);
          adapter.paint(copy);
        }
      }
      getSelection()?.removeAllRanges();
      save();
      renderPanel();
      showToast(`Erased (Cmd/Ctrl+Z to undo)`);
    }

    /** PDF viewer only: the adapter calls this once the user has clicked where the box goes. */
    function createTextBox(rect) {
      checkpoint();
      const a = { id: uid(), kind: 'textbox', quote: '', note: '', resolved: false, created: Date.now(), anchor: { rects: [rect] } };
      anns.push(a);
      adapter.paint(a);
      activeId = a.id;
      save();
      renderPanel();
      if (adapter.editInPlace) adapter.editInPlace(a.id); // type straight into the box on the page
      else {
        editingId = a.id;
        renderPanel();
      }
    }

    /** The adapter calls this when the user finishes typing in a box on the page. */
    function updateNote(i, text) {
      const a = byId(i);
      if (!a) return;
      text = text.trim();
      if (a.kind === 'textbox' && !text) return remove(i); // an empty box isn't worth keeping
      if (text !== a.note) {
        checkpoint();
        a.note = text;
        save();
      }
      if (a.kind === 'textbox') adapter.paint(a);
      renderPanel();
    }

    /** Called by the adapter after the user drags a box. */
    function moveAnn(i, rect) {
      const a = byId(i);
      if (!a) return;
      checkpoint();
      a.anchor = { rects: [rect] };
      save();
    }

    function startEdit(i) {
      if (byId(i)?.kind === 'textbox' && adapter.editInPlace) {
        setActive(i, true);
        return adapter.editInPlace(i);
      }
      editingId = i;
      setActive(i, false);
      renderPanel();
    }

    function remove(i) {
      const a = byId(i);
      if (!a) return;
      checkpoint();
      adapter.unpaint(a);
      anns = anns.filter((x) => x.id !== i);
      if (activeId === i) activeId = null;
      save();
      renderPanel();
    }

    function toggleResolved(i) {
      const a = byId(i);
      if (!a) return;
      checkpoint();
      a.resolved = !a.resolved;
      save();
      renderPanel();
    }

    /** Nothing selected: drop the outline from the last annotation touched. */
    function clearActive() {
      if (!activeId) return;
      activeId = null;
      host.querySelectorAll('.apa-card, .apa-ref').forEach((c) => c.classList.remove('apa-active'));
      syncMarkState();
    }

    function setActive(i, scroll) {
      activeId = lastActiveId = i;
      host.querySelectorAll('.apa-card, .apa-ref').forEach((c) => c.classList.toggle('apa-active', c.dataset.id === i));
      syncMarkState();
      if (!scroll) return;
      const target = document.querySelector(`[data-apa-id="${i}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('apa-flash');
        setTimeout(() => target.classList.remove('apa-flash'), 900);
      }
      host.querySelector(`.apa-card[data-id="${i}"], .apa-ref[data-id="${i}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function step(dir) {
      const v = navItems();
      if (!v.length) return;
      const from = activeId ?? lastActiveId;
      const idx = v.findIndex((a) => a.id === from);
      const next = idx === -1 ? (dir > 0 ? 0 : v.length - 1) : Math.min(v.length - 1, Math.max(0, idx + dir));
      setActive(v[next].id, true);
    }

    // ------------------------------------------------------------ export
    function toMarkdown() {
      return APA_MD.toMarkdown({ id, title: adapter.title(), paperNote, annotations: anns.map((a) => ({ ...a, where: adapter.where(a) })) });
    }

    function downloadMarkdown() {
      APA_MD.download(toMarkdown(), APA_MD.filenameFor(id));
      showToast('Saved Markdown file');
    }

    async function exportMarkdown() {
      const md = toMarkdown();
      try {
        await navigator.clipboard.writeText(md);
      } catch {
        const ta = el('textarea', { style: 'position:fixed;opacity:0' }, md);
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      showToast(`Copied Markdown (${anns.length} annotations)`);
    }

    async function exportPdf() {
      if (!adapter.exportPdf) return showToast('Annotated PDF is available in the PDF view — click the toolbar icon on the arxiv.org/pdf/ page.');
      showToast('Building PDF…');
      try {
        await adapter.exportPdf(sorted(), paperNote);
        showToast('Saved annotated PDF');
      } catch (err) {
        console.error('[apa] PDF export failed', err);
        showToast('PDF export failed — see console');
      }
    }

    // ------------------------------------------------------------ keyboard
    const isTyping = (t) => !!t?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');

    window.addEventListener(
      'keydown',
      (e) => {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.shiftKey && e.code === CONFIG.exportMarkdownCode) return e.preventDefault(), exportMarkdown();
        if (mod && e.shiftKey && e.code === CONFIG.exportPdfCode) return e.preventDefault(), exportPdf();

        if (isTyping(e.target)) return; // leave native undo etc. alone inside text fields

        if (e.altKey && !mod && e.code === 'KeyA') return e.preventDefault(), setEnabled(!enabled);

        if (enabled && mod && !e.altKey && e.code === 'KeyZ') return e.preventDefault(), e.shiftKey ? redo() : undo();
        if (enabled && mod && !e.altKey && e.code === 'KeyY') return e.preventDefault(), redo();
        if (e.key === 'Escape') (closePopover(), clearActive());

        if (mod || e.altKey) return;
        const K = CONFIG.keys;
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        const handled = (fn) => (e.preventDefault(), fn());

        // With the panel closed, marking still works (highlight, underline, erase, to-check, question, note).
        // Notes and questions open the panel, since you need its text box to type. Everything else needs it open.
        const works_closed = [K.highlight, K.underline, K.note, K.question, K.reference, K.erase].includes(key);
        if (!enabled && !works_closed) return;

        if (key === K.highlight) handled(() => create('highlight'));
        else if (key === K.underline) handled(() => create('underline'));
        else if (key === K.note)
          handled(() => {
            if (activeId && getSelection()?.isCollapsed) {
              setEnabled(true); // editing a note needs the panel
              startEdit(activeId);
            } else create('note');
          });
        else if (key === K.question) handled(() => create('question'));
        else if (key === K.reference) handled(() => create('reference'));
        else if (key === K.erase) handled(eraseSelection);
        else if (key === K.next) handled(() => step(1));
        else if (key === K.prev) handled(() => step(-1));
        else if (key === K.resolve && activeId) handled(() => toggleResolved(activeId));
        else if (key === K.edit && activeId) handled(() => startEdit(activeId));
        else if (key === K.color && activeId) handled(openPopoverNearActive);
        else if (key === K.textbox && adapter.beginPlaceTextBox) handled(adapter.beginPlaceTextBox);
        else if (K.remove.includes(key) && activeId) handled(() => remove(activeId));
      },
      true
    );

    // Click a highlight in the page -> focus its card and open the popover.
    // Where highlights overlap, the click lands on the newest one (innermost mark / topmost rect).
    document.addEventListener('click', (e) => {
      if (e.target.closest?.('.apa-pop, [contenteditable]:not([contenteditable="false"])')) return; // popover itself / typing in a text box
      closePopover();
      if (!getSelection()?.isCollapsed || e.target.closest?.('.apa-host')) return;
      const hit = e.target.closest?.('.apa-mark')?.dataset.apaId || adapter.hit?.(e);
      if (!hit || !byId(hit)) return clearActive(); // clicked plain page text: stop showing the last annotation as selected
      setActive(hit, false);
      host.querySelector(`.apa-card[data-id="${hit}"], .apa-ref[data-id="${hit}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      openPopover(hit, e.clientX, e.clientY);
    }, true); // capture: run before any handler the page itself registers
    // Close when the user scrolls the page. Wheel/touch rather than 'scroll': the browser also fires 'scroll'
    // for layout shifts and our own scrollIntoView calls, which would close the popover the moment it opens.
    for (const ev of ['wheel', 'touchmove']) window.addEventListener(ev, (e) => !e.target.closest?.('.apa-host, .apa-pop') && closePopover(), { passive: true });

    // Toolbar button (sent by background.js).
    chrome.runtime?.onMessage?.addListener((msg) => {
      if (msg?.type === 'apa-toggle') setEnabled(!enabled);
    });

    // ------------------------------------------------------------ boot
    const api = {
      /** Called by adapters that render lazily (PDF) once their DOM is ready. */
      restore() {
        repaintAll();
        renderPanel();
      },
    };
    adapter.init?.({ createTextBox, moveAnn, updateNote, closePopover });
    setEnabled(enabled);
    api.restore();
    return api;
  }

  window.APA = { start, domAdapter, parseArxivId, CONFIG };

  // Content-script mode: start immediately. The PDF viewer (extension page) starts us itself.
  if (location.protocol !== 'chrome-extension:') start(domAdapter);
})();
