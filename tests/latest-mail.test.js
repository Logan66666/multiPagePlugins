const test = require('node:test');
const assert = require('node:assert/strict');

const { findLatestMatchingItem } = require('../shared/latest-mail.js');

test('findLatestMatchingItem returns the first matching item from a newest-first list', () => {
  const items = [
    { id: 'latest', matched: true },
    { id: 'older', matched: true },
    { id: 'oldest', matched: true },
  ];

  const result = findLatestMatchingItem(items, (item) => item.matched);

  assert.deepEqual(result, { id: 'latest', matched: true });
});

test('findLatestMatchingItem skips non-matching items but never scans past the first match', () => {
  const items = [
    { id: 'unrelated', matched: false },
    { id: 'latest-match', matched: true },
    { id: 'older-match', matched: true },
  ];

  const result = findLatestMatchingItem(items, (item) => item.matched);

  assert.deepEqual(result, { id: 'latest-match', matched: true });
});

test('findLatestMatchingItem returns null when nothing matches', () => {
  const items = [
    { id: 'a', matched: false },
    { id: 'b', matched: false },
  ];

  const result = findLatestMatchingItem(items, (item) => item.matched);

  assert.equal(result, null);
});
