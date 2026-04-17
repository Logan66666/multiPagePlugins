const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('step 3 and step 6 password logs do not include plaintext passwords', () => {
  const signupSource = readProjectFile(path.join('content', 'signup-page.js'));
  const step6Source = readProjectFile(path.join('content', 'openai-auth-step6-flow.js'));

  assert.doesNotMatch(signupSource, /Password filled:\s*\$\{payload\.password\}/);
  assert.doesNotMatch(step6Source, /Password filled:\s*\$\{password\}/);
  assert.match(signupSource, /log\(['"]Step 3: Password filled['"]\)/);
  assert.match(step6Source, /log\(['"]Step 6: Password filled['"]\)/);
});

test('background message and state logging never dumps secret-bearing payloads', () => {
  const backgroundSource = readProjectFile('background.js');

  assert.match(backgroundSource, /function redactLogMessage\(message\)/);
  assert.match(backgroundSource, /const safeMessage = redactLogMessage\(getFriendlyWarnErrorMessage\(message,\s*level\)\)/);
  assert.match(backgroundSource, /console\.log\(LOG_PREFIX,\s*'storage\.set keys:',\s*Object\.keys\(updates \|\| \{\}\)\.join\(','\)\)/);
  assert.doesNotMatch(backgroundSource, /JSON\.stringify\(updates\)/);
  assert.doesNotMatch(backgroundSource, /Received:[^`]*`,\s*message\)/);
});

test('OAuth and localhost callback logs are redacted before persistence or console output', () => {
  const backgroundSource = readProjectFile('background.js');
  const vpsSource = readProjectFile(path.join('content', 'vps-panel.js'));

  assert.match(backgroundSource, /redacted oauth url/);
  assert.match(backgroundSource, /redacted localhost callback/);
  assert.doesNotMatch(backgroundSource, /已提前捕获到 localhost 回调：\$\{tab\.url\}/);
  assert.doesNotMatch(backgroundSource, /已捕获 localhost 回调地址：\$\{url\}/);
  assert.doesNotMatch(backgroundSource, /Captured localhost redirect: \$\{details\.url\}/);

  assert.doesNotMatch(vpsSource, /已获取 OAuth URL：\$\{oauthUrl\.slice/);
  assert.doesNotMatch(vpsSource, /Got localhostUrl: \$\{localhostUrl\.slice/);
  assert.doesNotMatch(vpsSource, /Filled callback URL: \$\{localhostUrl\.slice/);
});
