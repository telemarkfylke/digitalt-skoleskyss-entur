import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideUpdateDispatchAction } from '../../src/utils/queue-dispatch-decision.utils';
import { QueueEntry } from '../../src/services/queue.service';

const makeEntry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  studentId: '1',
  ordersId: '100',
  startDate: '2025-08-15',
  addedAt: '2025-08-01T00:00:00.000Z',
  processedAt: null,
  status: 'pending',
  retryCount: 0,
  ...overrides,
});

describe('decideUpdateDispatchAction', () => {
  test('sends directly when no queue entry exists', () => {
    const decision = decideUpdateDispatchAction(undefined);
    assert.deepEqual(decision, { action: 'send', reason: 'no_queue_entry' });
  });

  test('skips the direct send when the queue entry is still pending', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'pending' }));
    assert.deepEqual(decision, { action: 'skip', reason: 'queue_entry_pending' });
  });

  test('re-queues when the queue entry is permanently failed', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'failed' }));
    assert.deepEqual(decision, { action: 'requeue', reason: 'queue_entry_failed' });
  });

  test('sends directly when the queue entry was already sent', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'sent' }));
    assert.deepEqual(decision, { action: 'send', reason: 'queue_entry_sent' });
  });
});
