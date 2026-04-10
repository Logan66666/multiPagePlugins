const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutoRunStatusPayload,
  shouldContinueAutoRunAfterError,
  summarizeAutoRunResult,
} = require('../shared/auto-run.js');

test('auto run continues to next round after a normal run failure', () => {
  assert.equal(
    shouldContinueAutoRunAfterError(new Error('Step 4 failed')),
    true
  );
  assert.equal(
    shouldContinueAutoRunAfterError(new Error('Step 5 failed: Auth fatal error page detected after profile submit.')),
    true
  );
  assert.equal(
    shouldContinueAutoRunAfterError(new Error('Step 5 failed: unsupported_email domain blocked and added to blacklist.')),
    true
  );
});

test('auto run stops on stop and manual-handoff sentinel errors', () => {
  assert.equal(
    shouldContinueAutoRunAfterError(new Error('Flow stopped by user.')),
    false
  );
  assert.equal(
    shouldContinueAutoRunAfterError(new Error('Auto run handed off to manual continuation.')),
    false
  );
});

test('auto run summary reports mixed success and failure correctly', () => {
  assert.deepEqual(
    summarizeAutoRunResult({
      totalRuns: 5,
      successfulRuns: 3,
      failedRuns: 2,
      lastAttemptedRun: 5,
      stopRequested: false,
      handedOffToManual: false,
    }),
    {
      phase: 'complete',
      message: '=== Auto run finished: 3 succeeded, 2 failed, 5 total ===',
      toastMessage: '自动运行完成：成功 3 次，失败 2 次',
    }
  );
});

test('auto run stop summary keeps success and failure statistics', () => {
  assert.deepEqual(
    summarizeAutoRunResult({
      totalRuns: 5,
      successfulRuns: 2,
      failedRuns: 1,
      lastAttemptedRun: 4,
      stopRequested: true,
      handedOffToManual: false,
    }),
    {
      phase: 'stopped',
      message: '=== Stopped after 3/5 runs (2 succeeded, 1 failed) ===',
      toastMessage: '自动运行已停止：成功 2 次，失败 1 次',
    }
  );
});

test('infinite auto run stop summary reports completed rounds before stop', () => {
  assert.deepEqual(
    summarizeAutoRunResult({
      totalRuns: Number.POSITIVE_INFINITY,
      successfulRuns: 4,
      failedRuns: 2,
      lastAttemptedRun: 7,
      stopRequested: true,
      handedOffToManual: false,
      infiniteMode: true,
    }),
    {
      phase: 'stopped',
      message: '=== Infinite auto run stopped after 6 runs (4 succeeded, 2 failed) ===',
      toastMessage: '无限自动运行已停止：成功 4 次，失败 2 次',
    }
  );
});

test('buildAutoRunStatusPayload always includes sanitized success and failure counters', () => {
  assert.deepEqual(
    buildAutoRunStatusPayload({
      phase: 'running',
      currentRun: 2,
      totalRuns: 5,
      infiniteMode: false,
      successfulRuns: '3',
      failedRuns: -1,
    }),
    {
      phase: 'running',
      currentRun: 2,
      totalRuns: 5,
      infiniteMode: false,
      successfulRuns: 3,
      failedRuns: 0,
      summaryMessage: '',
      summaryToast: '',
      waitUntilTimestamp: null,
      waitReason: '',
    }
  );
});

test('buildAutoRunStatusPayload keeps wait metadata for timed auto-run pauses', () => {
  assert.deepEqual(
    buildAutoRunStatusPayload({
      phase: 'waiting_rotation',
      currentRun: 8,
      totalRuns: Number.POSITIVE_INFINITY,
      infiniteMode: true,
      successfulRuns: 6,
      failedRuns: 1,
      waitUntilTimestamp: 1710000000000,
      waitReason: '33mail limit window',
    }),
    {
      phase: 'waiting_rotation',
      currentRun: 8,
      totalRuns: Number.POSITIVE_INFINITY,
      infiniteMode: true,
      successfulRuns: 6,
      failedRuns: 1,
      summaryMessage: '',
      summaryToast: '',
      waitUntilTimestamp: 1710000000000,
      waitReason: '33mail limit window',
    }
  );
});
