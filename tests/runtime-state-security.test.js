const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('background keeps full state trusted-only and exposes a sanitized runtime state for content scripts', () => {
  const backgroundSource = readProjectFile('background.js');

  for (const key of ['password', 'customPassword', 'oauthUrl', 'localhostUrl', 'accounts', 'tmailorAccessToken']) {
    assert.match(
      backgroundSource,
      new RegExp(`SENSITIVE_STATE_KEYS[\\s\\S]*['"]${key}['"]`),
      `expected ${key} to be classified as sensitive`,
    );
  }

  assert.doesNotMatch(backgroundSource, /initializeSessionStorageAccess\(\)/);
  assert.doesNotMatch(backgroundSource, /TRUSTED_AND_UNTRUSTED_CONTEXTS/);

  assert.match(backgroundSource, /function sanitizeRuntimeState\(state\s*=\s*\{\}\)/);
  assert.match(backgroundSource, /case 'GET_STATE': \{[\s\S]*isTrustedSidePanelRequest\(message,\s*sender\)[\s\S]*Unauthorized state access/i);
  assert.match(backgroundSource, /function isTrustedSidePanelRequest\(message,\s*sender\)[\s\S]*message\?\.source === 'sidepanel'[\s\S]*!sender\?\.tab/i);
  assert.match(backgroundSource, /case 'GET_RUNTIME_STATE': \{[\s\S]*sanitizeRuntimeState\(/i);
});

test('content scripts request only sanitized runtime state', () => {
  const signupSource = readProjectFile(path.join('content', 'signup-page.js'));
  const vpsSource = readProjectFile(path.join('content', 'vps-panel.js'));
  const sidepanelSource = readProjectFile(path.join('sidepanel', 'sidepanel.js'));

  assert.doesNotMatch(signupSource, /type:\s*'GET_STATE'/);
  assert.doesNotMatch(vpsSource, /type:\s*'GET_STATE'/);
  assert.match(signupSource, /type:\s*'GET_RUNTIME_STATE'/);
  assert.match(vpsSource, /type:\s*'GET_RUNTIME_STATE'/);
  assert.match(sidepanelSource, /type:\s*'GET_STATE',\s*source:\s*'sidepanel'/);
});

test('manifest narrows static host access and enables runtime VPS origin grants', () => {
  const manifest = JSON.parse(readProjectFile('manifest.json'));
  const backgroundSource = readProjectFile('background.js');

  assert.ok(manifest.permissions.includes('permissions'));
  assert.ok(Array.isArray(manifest.host_permissions));
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
  assert.ok(manifest.host_permissions.includes('https://auth.openai.com/*'));
  assert.ok(manifest.host_permissions.includes('https://tmailor.com/*'));
  assert.ok(Array.isArray(manifest.optional_host_permissions));
  assert.ok(manifest.optional_host_permissions.includes('http://*/*'));
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'));

  assert.match(backgroundSource, /function getOriginPermissionPatternFromUrl\(url\)/);
  assert.match(backgroundSource, /async function ensureVpsOriginPermission\(vpsUrl\)/);
  assert.match(backgroundSource, /chrome\.permissions\.contains\(\{\s*origins:\s*\[originPattern\]\s*\}\)/);
  assert.match(backgroundSource, /chrome\.permissions\.request\(\{\s*origins:\s*\[originPattern\]\s*\}\)/);
  assert.match(backgroundSource, /async function executeStep1\(state\)[\s\S]*await ensureVpsOriginPermission\(state\.vpsUrl\)/);
  assert.match(backgroundSource, /async function fetchFreshOauthUrlFromVps\(state[\s\S]*await ensureVpsOriginPermission\(state\.vpsUrl\)/);
  assert.match(backgroundSource, /async function executeStep9\(state\)[\s\S]*await ensureVpsOriginPermission\(effectiveState\.vpsUrl\)/);
});
