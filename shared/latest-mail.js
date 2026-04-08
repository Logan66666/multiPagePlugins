(function(root, factory) {
  const exports = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }

  root.LatestMail = exports;
})(typeof globalThis !== 'undefined' ? globalThis : self, function() {
  function findLatestMatchingItem(items, predicate) {
    for (const item of items || []) {
      if (predicate(item)) {
        return item;
      }
    }
    return null;
  }

  return {
    findLatestMatchingItem,
  };
});
