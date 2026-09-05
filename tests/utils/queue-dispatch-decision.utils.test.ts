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

const APPROVED = true;
const NOT_APPROVED = false;

describe('decideUpdateDispatchAction — already sent to Entur', () => {
  test('sends directly when the queue entry was already sent and the order is still approved', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'sent' }), APPROVED);
    assert.deepEqual(decision, { action: 'send', reason: 'queue_entry_sent' });
  });

  // Load-bearing: this is the only revoke mechanism. A sent order that loses approval must still
  // be sent so the mapper can override endDate to today — Entur has no cancel endpoint.
  test('still sends when the queue entry was sent but the order is no longer approved (revoke path)', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'sent' }), NOT_APPROVED);
    assert.deepEqual(decision, { action: 'send', reason: 'queue_entry_sent' });
  });
});

describe('decideUpdateDispatchAction — still pending in the queue', () => {
  test('skips the direct send when the queue entry is still pending and approved', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'pending' }), APPROVED);
    assert.deepEqual(decision, { action: 'skip', reason: 'queue_entry_pending' });
  });

  // The drain re-reads the DB and will retire the entry itself; a direct send would race it.
  test('skips when the queue entry is pending even if the order is no longer approved', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'pending' }), NOT_APPROVED);
    assert.deepEqual(decision, { action: 'skip', reason: 'queue_entry_pending' });
  });
});

describe('decideUpdateDispatchAction — approval enqueues', () => {
  test('enqueues an approved order that has no queue entry yet', () => {
    const decision = decideUpdateDispatchAction(undefined, APPROVED);
    assert.deepEqual(decision, { action: 'enqueue', reason: 'approved_not_queued' });
  });

  test('re-queues an approved order whose entry is permanently failed', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'failed' }), APPROVED);
    assert.deepEqual(decision, { action: 'enqueue', reason: 'queue_entry_failed' });
  });

  test('re-queues an approved order whose entry was retired as skipped', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'skipped' }), APPROVED);
    assert.deepEqual(decision, { action: 'enqueue', reason: 'queue_entry_skipped' });
  });
});

describe('decideUpdateDispatchAction — never sent and not approved', () => {
  // Nothing ever reached Entur, so there is nothing to revoke and nothing worth retrying.
  test('ignores an unapproved order that has no queue entry', () => {
    const decision = decideUpdateDispatchAction(undefined, NOT_APPROVED);
    assert.deepEqual(decision, { action: 'ignore', reason: 'not_approved_never_sent' });
  });

  test('ignores an unapproved order whose entry is permanently failed', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'failed' }), NOT_APPROVED);
    assert.deepEqual(decision, { action: 'ignore', reason: 'not_approved_never_sent' });
  });

  test('ignores an unapproved order whose entry was retired as skipped', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'skipped' }), NOT_APPROVED);
    assert.deepEqual(decision, { action: 'ignore', reason: 'not_approved_never_sent' });
  });
});
