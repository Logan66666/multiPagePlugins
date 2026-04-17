const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('DATA_UPDATED broadcasts pass through a sensitive-field sanitizer', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(backgroundSource, /function sanitizeDataUpdatePayload\(payload\s*=\s*\{\}\)/);
  assert.match(backgroundSource, /function broadcastDataUpdate\(payload\)[\s\S]*sanitizeDataUpdatePayload\(payload\)/);
  assert.match(backgroundSource, /if \(!Object\.keys\(safePayload\)\.length\) \{[\s\S]*return;[\s\S]*\}/);

  for (const key of ['password', 'oauthUrl', 'localhostUrl', 'tmailorAccessToken']) {
    assert.doesNotMatch(
      backgroundSource,
      new RegExp(`broadcastDataUpdate\\(\\{\\s*${key}\\b`),
      `DATA_UPDATED must not broadcast ${key}`,
    );
  }
});

test('side panel does not expect secrets from DATA_UPDATED payloads', () => {
  const sidepanelSource = readProjectFile(path.join('sidepanel', 'sidepanel.js'));
  const dataUpdatedCase = sidepanelSource.match(/case 'DATA_UPDATED': \{([\s\S]*?)\n\s*break;\n\s*\}/)?.[1] || '';

  assert.notEqual(dataUpdatedCase, '', 'expected DATA_UPDATED handler');
  assert.doesNotMatch(dataUpdatedCase, /message\.payload\.password/);
  assert.doesNotMatch(dataUpdatedCase, /message\.payload\.oauthUrl/);
  assert.doesNotMatch(dataUpdatedCase, /message\.payload\.localhostUrl/);
});
