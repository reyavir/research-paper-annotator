// Service worker. Its only job: react to the toolbar button.
//
//  - On /abs/ and /html/ pages the content script is already injected, so we just tell it to toggle.
//  - On /pdf/ pages Chrome shows its built-in PDF viewer, which extensions cannot touch.
//    So we navigate the tab to our own viewer page (viewer/viewer.html), which renders the
//    same PDF with pdf.js and runs the same annotator on top of it.

const PDF_RE = /^https?:\/\/(?:export\.)?arxiv\.org\/pdf\//;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;

  if (PDF_RE.test(tab.url)) {
    const viewer = chrome.runtime.getURL('viewer/viewer.html') + '?src=' + encodeURIComponent(tab.url);
    chrome.tabs.update(tab.id, { url: viewer });
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'apa-toggle' });
  } catch {
    // Tab was open before the extension was installed/reloaded: inject on demand (needs activeTab).
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['markdown.js', 'content.js'] });
    chrome.tabs.sendMessage(tab.id, { type: 'apa-toggle' });
  }
});

// Content scripts and the viewer can't open chrome-extension:// URLs themselves, so they ask us.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'apa-open-library') chrome.tabs.create({ url: chrome.runtime.getURL('library/library.html') });
});
