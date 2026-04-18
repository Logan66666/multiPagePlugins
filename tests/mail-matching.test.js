const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getStepMailMatchProfile,
  hasSignupVerificationMailDetail,
  isExpectedVerificationMailDetail,
  matchesSubjectPatterns,
} = require('../shared/mail-matching.js');

test('step 4 mail profile accepts the Chinese registration title', () => {
  const profile = getStepMailMatchProfile(4);

  assert.equal(matchesSubjectPatterns('你的 ChatGPT 代码为 040535', profile), true);
});

test('step 4 mail profile also accepts the Chinese OpenAI title', () => {
  const profile = getStepMailMatchProfile(4);

  assert.equal(matchesSubjectPatterns('你的 OpenAI 代码为 040535', profile), true);
});

test('step 4 mail profile also accepts the English verification title', () => {
  const profile = getStepMailMatchProfile(4);

  assert.equal(matchesSubjectPatterns('Your ChatGPT code is 281878', profile), true);
});

test('step 4 mail profile also accepts the English OpenAI verification title', () => {
  const profile = getStepMailMatchProfile(4);

  assert.equal(matchesSubjectPatterns('Your OpenAI code is 281878', profile), true);
});

test('step 7 mail profile accepts both English and Chinese OpenAI verification titles', () => {
  const profile = getStepMailMatchProfile(7);

  assert.equal(matchesSubjectPatterns('Your ChatGPT code is 281878', profile), true);
  assert.equal(matchesSubjectPatterns('Your OpenAI code is 281878', profile), true);
  assert.equal(matchesSubjectPatterns('你的 ChatGPT 代码为 040535', profile), true);
  assert.equal(matchesSubjectPatterns('你的 OpenAI 代码为 040535', profile), true);
});

test('step 9 reuses the later verification title profile for both English and Chinese verification titles', () => {
  const profile = getStepMailMatchProfile(9);

  assert.equal(matchesSubjectPatterns('Your ChatGPT code is 774992', profile), true);
  assert.equal(matchesSubjectPatterns('Your OpenAI code is 774992', profile), true);
  assert.equal(matchesSubjectPatterns('你的 ChatGPT 代码为 490239', profile), true);
  assert.equal(matchesSubjectPatterns('你的 OpenAI 代码为 490239', profile), true);
});

test('step 7 detail matching rejects explicit signup intent but does not reject incomplete detail text', () => {
  assert.equal(
    isExpectedVerificationMailDetail(7, '你的 OpenAI 代码为 223344。请输入此验证码以继续登录。'),
    true
  );
  assert.equal(
    isExpectedVerificationMailDetail(7, 'Your OpenAI code is 223344. Use this code to continue login.'),
    true
  );
  assert.equal(
    isExpectedVerificationMailDetail(7, '你的 OpenAI 代码为 223344。请输入此验证码以继续创建 ChatGPT 帐户。'),
    false
  );
  assert.equal(
    isExpectedVerificationMailDetail(7, 'Your OpenAI code is 223344. Use this code to continue creating your account.'),
    false
  );
  assert.equal(
    isExpectedVerificationMailDetail(7, 'Your OpenAI code is 223344.'),
    true
  );
  assert.equal(
    hasSignupVerificationMailDetail(7, 'Your OpenAI code is 223344. Use this code to continue creating your account.'),
    true
  );
});

test('step 7 detail matching accepts hyphenated log-in wording from OpenAI mail bodies', () => {
  assert.equal(
    isExpectedVerificationMailDetail(7, 'ChatGPT Log-in Code. We noticed a suspicious log-in on your account. If that was you, enter this code: 549235.'),
    true
  );
});

test('step 7 detail matching accepts unicode-hyphen log-in wording from OpenAI mail bodies', () => {
  assert.equal(
    isExpectedVerificationMailDetail(7, 'ChatGPT Log‑in Code. We noticed a suspicious log‑in on your account. If that was you, enter this code: 549235.'),
    true
  );
});
