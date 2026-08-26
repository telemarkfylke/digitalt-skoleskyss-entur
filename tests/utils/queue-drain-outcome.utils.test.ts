import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDrainOutcome, DrainBatchResult } from '../../src/utils/queue-drain-outcome.utils';

const makeBatchResult = (overrides: Partial<DrainBatchResult> = {}): DrainBatchResult => ({
  successCount: 1,
  failedCount: 0,
  errors: [],
  ...overrides,
});

describe('decideDrainOutcome', () => {
  test('marks the entry sent after a successful live send', () => {
    const outcome = decideDrainOutcome(makeBatchResult(), false);
    assert.deepEqual(outcome, { action: 'mark_sent' });
  });

  test('marks the entry failed with the first error on a live failure', () => {
    const outcome = decideDrainOutcome(
      makeBatchResult({ successCount: 0, failedCount: 1, errors: ['bad phone', 'other'] }),
      false
    );
    assert.deepEqual(outcome, { action: 'mark_failed', error: 'bad phone' });
  });

  test('falls back to a generic message when a live failure reported no errors', () => {
    const outcome = decideDrainOutcome(makeBatchResult({ successCount: 0, failedCount: 1 }), false);
    assert.deepEqual(outcome, { action: 'mark_failed', error: 'processSingleBatch reported failure' });
  });

  test('treats a partially failed batch as a failure', () => {
    const outcome = decideDrainOutcome(
      makeBatchResult({ successCount: 1, failedCount: 1, errors: ['sibling failed'] }),
      false
    );
    assert.deepEqual(outcome, { action: 'mark_failed', error: 'sibling failed' });
  });

  // A dry run reports every valid request as a success without calling Entur. Marking those
  // entries 'sent' retired students who were never actually sent, and addEntry refuses to
  // re-queue a 'sent' order — so they could never be recovered.
  test('never touches queue state on a dry run, even when the batch looks successful', () => {
    const outcome = decideDrainOutcome(makeBatchResult(), true);
    assert.deepEqual(outcome, { action: 'none', reason: 'dry_run' });
  });

  test('never touches queue state on a dry run that reported failures', () => {
    const outcome = decideDrainOutcome(
      makeBatchResult({ successCount: 0, failedCount: 1, errors: ['validation failed'] }),
      true
    );
    assert.deepEqual(outcome, { action: 'none', reason: 'dry_run' });
  });
});
