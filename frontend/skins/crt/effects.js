(function initCrtEffects(documentRef) {
  function syncPageVisibility() {
    documentRef.body.classList.toggle('page-hidden', documentRef.hidden);
  }

  documentRef.addEventListener('visibilitychange', syncPageVisibility);
  syncPageVisibility();
})(document);
