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

// The decision takes the raw PrimaryStatus, not a boolean, because it has to tell
// "explicitly rejected" apart from "we don't know" — only the former may revoke.
const APPROVED = 2;
const NOT_APPROVED = 1;

describe('decideUpdateDispatchAction — already sent to Entur', () => {
  test('sends directly when the queue entry was already sent and the order is still approved', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'sent' }), APPROVED);
    assert.deepEqual(decision, { action: 'send', reason: 'queue_entry_sent' });
  });

  // Load-bearing: stage one of a revoke. The send still happens so the mapper can override endDate
  // to today, which stops travel immediately and reversibly; only the delete waits out the grace
  // period, so a transient status flip cannot destroy and recreate the pupil's contract.
  test('sends and schedules a revoke when a sent order loses approval', () => {
    const decision = decideUpdateDispatchAction(makeEntry({ status: 'sent' }), NOT_APPROVED);
    assert.deepEqual(decision, { action: 'send_then_revoke', reason: 'sent_lost_approval' });
  });

  test('treats a string status the same as a numeric one', () => {
    assert.deepEqual(decideUpdateDispatchAction(makeEntry({ status: 'sent' }), '2'), {
      action: 'send',
      reason: 'queue_entry_sent',
    });
    assert.deepEqual(decideUpdateDispatchAction(makeEntry({ status: 'sent' }), '1'), {
      action: 'send_then_revoke',
      reason: 'sent_lost_approval',
    });
  });

  // isOrderApproved returns false for undefined/null too, so without this guard a record arriving
  // without PrimaryStatus would delete the pupil's contract on missing data. It must degrade to a
  // plain refresh instead — which is also what the mapper does with an absent status.
  test('does not revoke when PrimaryStatus is absent — only an explicit non-approval revokes', () => {
    for (const absent of [undefined, null]) {
      const decision = decideUpdateDispatchAction(makeEntry({ status: 'sent' }), absent);
      assert.deepEqual(decision, { action: 'send', reason: 'queue_entry_sent_status_unknown' });
    }
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

  // An absent status is not approval, so a never-sent order is still ignored here — the
  // status-unknown fallback only applies once something has actually reached Entur.
  test('ignores an order with no queue entry and no PrimaryStatus', () => {
    const decision = decideUpdateDispatchAction(undefined, undefined);
    assert.deepEqual(decision, { action: 'ignore', reason: 'not_approved_never_sent' });
  });
});
