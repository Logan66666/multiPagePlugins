const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReclaimableTabRegistry,
  normalizeOrigin,
  normalizeComparableUrl,
} = require('../shared/tab-reclaim.js');

test('buildReclaimableTabRegistry recognizes restored tabs for known sources', () => {
  const registry = buildReclaimableTabRegistry(
    [
      { id: 11, url: 'https://auth.openai.com/create-account/password', lastAccessed: 20 },
      { id: 12, url: 'https://wx.mail.qq.com/', lastAccessed: 30 },
      { id: 13, url: 'https://duckduckgo.com/email/settings/autofill', lastAccessed: 40 },
      { id: 14, url: 'https://tmailor.com/', lastAccessed: 50 },
      { id: 15, url: 'https://panel.example.com/#/oauth', lastAccessed: 60 },
      { id: 16, url: 'https://example.com/unrelated', lastAccessed: 70 },
    ],
    {
      vpsUrl: 'https://panel.example.com/#/oauth',
      inbucketHost: '',
      inbucketMailbox: '',
    }
  );

  assert.deepEqual(registry, {
    'signup-page': { tabId: 11, ready: false },
    'qq-mail': { tabId: 12, ready: false },
    'duck-mail': { tabId: 13, ready: false },
    'tmailor-mail': { tabId: 14, ready: false },
    'vps-panel': { tabId: 15, ready: false },
  });
});

test('buildReclaimableTabRegistry matches only the configured inbucket mailbox', () => {
  const registry = buildReclaimableTabRegistry(
    [
      { id: 21, url: 'https://mail.test/m/box-2/', lastAccessed: 10 },
      { id: 22, url: 'https://mail.test/m/box-1/', lastAccessed: 20 },
      { id: 23, url: 'https://mail.test/m/box-1/message/abc', lastAccessed: 30 },
    ],
    {
      vpsUrl: '',
      inbucketHost: 'mail.test',
      inbucketMailbox: 'box-1',
    }
  );

  assert.deepEqual(registry, {
    'inbucket-mail': { tabId: 23, ready: false },
  });
});

test('buildReclaimableTabRegistry prefers the most recently active tab for a source', () => {
  const registry = buildReclaimableTabRegistry(
    [
      { id: 31, url: 'https://auth.openai.com/create-account', lastAccessed: 10 },
      { id: 32, url: 'https://accounts.openai.com/about-you', lastAccessed: 80 },
    ],
    {
      vpsUrl: '',
      inbucketHost: '',
      inbucketMailbox: '',
    }
  );

  assert.deepEqual(registry, {
    'signup-page': { tabId: 32, ready: false },
  });
});

test('normalizeOrigin and normalizeComparableUrl tolerate missing protocols and hashes', () => {
  assert.equal(normalizeOrigin('panel.example.com'), 'https://panel.example.com');
  assert.equal(
    normalizeComparableUrl('panel.example.com/#/oauth'),
    'https://panel.example.com/'
  );
  assert.equal(
    normalizeComparableUrl('https://panel.example.com/path?q=1#hash'),
    'https://panel.example.com/path?q=1'
  );
});
