const test = require('node:test');
const assert = require('node:assert/strict');

const { isVerificationCodeRejectedText, isVerificationRetryStateText } = require('../shared/verification-code.js');

test('detects Chinese verification-code rejection copy', () => {
  assert.equal(isVerificationCodeRejectedText('验证码错误，请重试'), true);
  assert.equal(isVerificationCodeRejectedText('输入的代码有误'), true);
  assert.equal(isVerificationCodeRejectedText('代码不正确'), true);
});

test('detects English verification-code rejection copy', () => {
  assert.equal(isVerificationCodeRejectedText('The code you entered is incorrect'), true);
  assert.equal(isVerificationCodeRejectedText('Invalid verification code'), true);
});

test('does not treat normal verification prompts as rejection', () => {
  assert.equal(isVerificationCodeRejectedText('Your ChatGPT code is 281878'), false);
  assert.equal(isVerificationCodeRejectedText('重新发送电子邮件'), false);
});

test('detects retry-state copy on verification pages', () => {
  assert.equal(isVerificationRetryStateText('Something went wrong. Please retry.'), true);
  assert.equal(isVerificationRetryStateText('验证失败，请重试'), true);
});

test('does not treat ordinary resend prompts as retry-state failures', () => {
  assert.equal(isVerificationRetryStateText('Resend email'), false);
  assert.equal(isVerificationRetryStateText('Your ChatGPT code is 281878'), false);
});
