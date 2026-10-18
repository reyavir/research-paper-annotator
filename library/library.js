/*
 * Library page: everything you've annotated, in one place.
 * Reads chrome.storage.local directly; every paper lives under the key "paper:<arxivId>".
 */
const PREFIX = 'paper:';
const $ = (id) => document.getElementById(id);
const squish = (s) => s.replace(/\s+/g, ' ').trim();
const KIND_LABEL = { highlight: 'Highlight', underline: 'Underline', note: 'Note', question: 'Question', textbox: 'Text box', reference: 'To check' };

/** @type {Record<string, {id:string,title:string,updated:number,annotations:any[]}>} */
let papers = {};

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
}

async function load() {
  const all = await chrome.storage.local.get(null);
  papers = Object.fromEntries(Object.entries(all).filter(([k, v]) => k.startsWith(PREFIX) && v?.annotations));
  render();
}

const matches = (needle, p, a) => !needle || [p.title, p.id, a?.quote, a?.note, a ? null : p.paperNote].some((t) => t?.toLowerCase().includes(needle));
const absUrl = (id) => `https://arxiv.org/abs/${id}`;

function annRow(p, a) {
  return el(
    'div',
    { class: `ann k-${a.kind}${a.resolved ? ' resolved' : ''}`, style: a.color ? `border-left-color:${a.color}` : false },
    el('div', { class: 'meta' }, KIND_LABEL[a.kind], a.resolved ? ' · resolved' : ''),
    a.quote ? el('blockquote', {}, a.quote) : null,
    a.refText ? el('div', { class: 'reftext' }, a.refText) : null,
    a.note ? el('div', { class: 'note' }, a.note) : null
  );
}

function render() {
  const needle = $('q').value.trim().toLowerCase();
  const list = Object.values(papers).sort((a, b) => b.updated - a.updated);

  // Open questions across all papers
  const qs = list.flatMap((p) => p.annotations.filter((a) => a.kind === 'question' && !a.resolved && matches(needle, p, a)).map((a) => [p, a]));
  $('qcount').textContent = `(${qs.length})`;
  $('questions').replaceChildren(
    ...(qs.length ? qs.map(([p, a]) => el('div', {}, el('a', { class: 'paper-link', href: absUrl(p.id), target: '_blank' }, squish(p.title || p.id)), annRow(p, a))) : [el('p', { class: 'empty' }, 'No open questions.')])
  );

  // References to check across all papers
  const rs = list.flatMap((p) => p.annotations.filter((a) => a.kind === 'reference' && !a.resolved && matches(needle, p, a)).map((a) => [p, a]));
  $('rcount').textContent = `(${rs.length})`;
  $('refs').replaceChildren(
    ...(rs.length ? rs.map(([p, a]) => el('div', {}, el('a', { class: 'paper-link', href: absUrl(p.id), target: '_blank' }, squish(p.title || p.id)), annRow(p, a))) : [el('p', { class: 'empty' }, 'Nothing to check.')])
  );

  // Papers
  const shown = list.filter((p) => matches(needle, p, null) || p.annotations.some((a) => matches(needle, p, a)));
  $('pcount').textContent = `(${shown.length})`;
  $('papers').replaceChildren(
    ...(shown.length
      ? shown.map((p) => {
          const open = p.annotations.filter((a) => a.kind === 'question' && !a.resolved).length;
          const items = p.annotations.filter((a) => matches(needle, p, a));
          return el(
            'details',
            { open: !!needle },
            el(
              'summary',
              {},
              el('span', { class: 'title' }, squish(p.title || p.id)),
              el('span', { class: 'sub' }, `arXiv:${p.id} · ${p.annotations.length} annotations${open ? ` · ${open} open` : ''} · ${new Date(p.updated).toLocaleDateString()}`)
            ),
            el('div', { class: 'actions' }, el('a', { href: absUrl(p.id), target: '_blank' }, 'Open paper ↗'), el('button', { onclick: () => copyText(APA_MD.toMarkdown(p), 'Copied Markdown') }, 'Copy Markdown'), el('button', { onclick: () => APA_MD.download(APA_MD.toMarkdown(p), APA_MD.filenameFor(p.id)) }, 'Download .md'), el('button', { class: 'danger', onclick: () => removePaper(p) }, 'Delete all annotations')),
            p.paperNote ? el('div', { class: 'ann k-note' }, el('div', { class: 'meta' }, 'Paper notes'), el('div', { class: 'note' }, p.paperNote)) : null,
            items.sort((a, b) => a.created - b.created).map((a) => annRow(p, a))
          );
        })
      : [el('p', { class: 'empty' }, 'Nothing yet. Open an arXiv paper and select some text.')])
  );
}

async function removePaper(p) {
  if (!confirm(`Delete all ${p.annotations.length} annotations on “${p.title || p.id}”? This can’t be undone.`)) return;
  await chrome.storage.local.remove(PREFIX + p.id);
  delete papers[p.id];
  render();
}

// ---------------------------------------------------------------- Markdown
async function copyText(text, msg) {
  await navigator.clipboard.writeText(text);
  const b = $('export-md'), old = b.textContent;
  b.textContent = msg;
  setTimeout(() => (b.textContent = old), 1500);
}
$('export-md').onclick = () => {
  const all = Object.values(papers);
  if (all.length) APA_MD.download(APA_MD.toMarkdownAll(all), `arxiv-annotations-${new Date().toISOString().slice(0, 10)}.md`);
};

// ---------------------------------------------------------------- backup / restore
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ format: 'arxiv-paper-annotator', version: 1, exported: Date.now(), papers }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `arxiv-annotations-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
};

$('import').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'arxiv-paper-annotator' || !data.papers) throw new Error('Not an export from this extension');
    // Merge: keep what's already here, add annotations whose id we don't have yet.
    const writes = {};
    let added = 0;
    for (const [key, incoming] of Object.entries(data.papers)) {
      if (!key.startsWith(PREFIX) || !Array.isArray(incoming?.annotations)) continue;
      const have = papers[incoming.id] || { ...incoming, annotations: [] };
      const ids = new Set(have.annotations.map((a) => a.id));
      const fresh = incoming.annotations.filter((a) => !ids.has(a.id));
      added += fresh.length;
      writes[key] = { ...have, annotations: [...have.annotations, ...fresh], updated: Math.max(have.updated || 0, incoming.updated || 0) };
    }
    await chrome.storage.local.set(writes);
    alert(`Imported ${added} new annotations.`);
    load();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
};

$('q').addEventListener('input', render);
load();
