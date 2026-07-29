(function initCrtEffects(documentRef: Document): void {
  function syncPageVisibility(): void {
    documentRef.body.classList.toggle('page-hidden', documentRef.hidden);
  }

  documentRef.addEventListener('visibilitychange', syncPageVisibility);
  syncPageVisibility();
})(document);
