// Runs inside the selected page. Keep selection capture and guarded deletion in
// one evaluation; never read the execution host's unrelated system clipboard.
export function clipboardExpression(expectedFingerprint?: string): string {
  return `(() => {
    let doc = document;
    let target = doc.activeElement;
    while (target) {
      if (target.shadowRoot?.activeElement) { target = target.shadowRoot.activeElement; continue; }
      if (target.tagName === 'IFRAME') {
        if (!target.contentDocument) throw new Error('Clipboard selection in a cross-origin frame is unavailable.');
        doc = target.contentDocument; target = doc.activeElement; continue;
      }
      break;
    }
    if (target?.type === 'password') throw new Error('Password fields cannot be copied.');
    const nodePath = node => {
      const parts = [];
      while (node) {
        const parent = node.parentNode;
        parts.push(parent ? Array.prototype.indexOf.call(parent.childNodes, node) : 0);
        node = parent || node.host;
      }
      return parts.join('/');
    };
    let text = '', identity;
    if ((target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') && typeof target.selectionStart === 'number') {
      text = target.value.slice(target.selectionStart, target.selectionEnd);
      identity = [doc.URL, nodePath(target), target.value, target.selectionStart, target.selectionEnd];
    } else {
      const selection = doc.getSelection();
      text = selection?.toString() || '';
      identity = [doc.URL, nodePath(selection?.anchorNode), selection?.anchorOffset, nodePath(selection?.focusNode), selection?.focusOffset, text];
    }
    if (text.length > 1000000) throw new Error('Clipboard selection is too large.');
    const fingerprint = JSON.stringify(identity);
    const expected = ${JSON.stringify(expectedFingerprint ?? null)};
    if (expected !== null) {
      if (fingerprint !== expected || !text) throw new Error('Selection changed before cut; no text was deleted.');
      if (!doc.execCommand('delete')) throw new Error('This selection cannot be cut.');
      return { ok: true };
    }
    return { text, fingerprint };
  })()`;
}
