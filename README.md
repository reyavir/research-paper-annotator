# Annotator for arXiv

Annotate arXiv papers the way you would on paper: highlight, underline, write notes, flag open questions, and come back to them later. Works on arXiv abstract, HTML, and PDF pages. Everything stays in your browser. You can download the annotated paper afterwards, to reference in future or share with others.

## Install

1. Download or clone this repo.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Optional: click the puzzle-piece icon in the toolbar and pin **Annotator for arXiv**.

After you change any code, click the reload arrow on the extension's card **and refresh the paper tab**. An old tab keeps running the old version.

## Use it

### On `arxiv.org/abs/…` and `arxiv.org/html/…`

1. Open a paper. A small **Annotate** tab appears on the right edge. Click it (or the toolbar icon, or press `Alt+A`) to open the panel.
2. Select some text, then press a key:

| Key | Does |
| --- | --- |
| `H` | Highlight |
| `U` | Underline |
| `N` | Note: highlight the text and type your note |
| `Q` | Question: flag something you don't understand yet, type what's unclear |
| `J` / `K` | Next / previous annotation |
| `R` | Mark the active question resolved (or open again) |
| `C` | Pick a color or change the kind of the active annotation |
| `Enter` | Edit the note on the active annotation |
| `Backspace` | Delete the active annotation |
| `Alt+A` | Show / hide the panel |
| `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z` | Undo / redo |
| `Cmd/Ctrl+Shift+E` | Copy all annotations as Markdown |

While typing a note, `Cmd/Ctrl+Enter` or `Esc` saves it.

3. **Click any highlight** to open a small popover: pick any color, switch between highlight / underline / note / question, edit the note, or delete.
4. Overlapping highlights all stay visible; the newest is on top.
5. The **Paper notes** box at the bottom of the panel is for notes about the whole paper (summary, what to read next).

### On `arxiv.org/pdf/…`

Chrome's built-in PDF viewer can't be annotated by extensions, so click the toolbar icon on a PDF tab and the paper reopens in this extension's own viewer. Everything above works there too, plus:

- `T`, then click on the page: place a **text box**. Type its text in the panel; drag the box to move it.
- `Cmd/Ctrl+Shift+D`: download an **annotated PDF** (`<arXiv-ID>-annotated.pdf`) with your highlights, underlines, text boxes, numbered note badges, and an extra last page listing your notes, questions, and paper notes.
- The `+` / `−` buttons zoom.

Annotations made on HTML pages can't be placed on PDF pages, so they export to Markdown only.

### All your papers

Click **All papers** in the panel. It lists every paper you've annotated, shows all your open questions in one place, and has search. From there you can **Export all (JSON)** as a backup and **Import** it back (it merges, never overwrites).

## Your data

- Annotations are saved automatically in `chrome.storage.local`, per paper, so they come back when you reload.
- Annotations follow the paper across versions (v1 → v2). If the text changed and a highlight can't be found, its card shows a warning instead of disappearing.
- Nothing is sent anywhere. There is no server, account, or tracking.
- Browser data is easy to lose (clearing site data, reinstalling the extension, a new profile). **Export a JSON backup now and then.**

## Troubleshooting

- **Nothing happens when I press keys.** Open the panel first (`Alt+A`). Keys are ignored while it's closed, and while you're typing in a text field.
- **I changed the code and nothing changed.** Reload the extension on `chrome://extensions`, then refresh the paper tab.
- **`Cmd/Ctrl+Shift+D` does nothing.** Chrome may reserve it for "bookmark all tabs". Use the **Annotated PDF** button in the panel, or change the shortcut in `CONFIG` at the top of `content.js`.
- **A highlight is missing after the paper changed.** See the warning on its card. The quote is still saved and shows up in Markdown exports.

## Limits

- Text boxes and PDF export need the PDF viewer.
- Highlights on equations style the whole equation.
- Tested in Chrome. Other browsers aren't supported yet.

## Project layout

```
manifest.json      extension manifest (MV3)
background.js      toolbar button; sends /pdf/ tabs to the viewer
content.js/.css    annotator: panel, shortcuts, storage, Markdown export (abs + html pages)
pdf-exporter.js    writes annotations into the PDF with pdf-lib
viewer/            pdf.js-based PDF viewer that runs the same annotator
library/           the "All papers" page
lib/               vendored pdf.js and pdf-lib
```
