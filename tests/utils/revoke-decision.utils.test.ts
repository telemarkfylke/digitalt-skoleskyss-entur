import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRevokeAction, decideDeferredRevoke } from '../../src/utils/revoke-decision.utils';
import { QueueEntry } from '../../src/services/queue.service';

const makeEntry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  studentId: '91703',
  ordersId: '78411',
  startDate: '2026-08-15',
  addedAt: '2026-08-01T00:00:00.000Z',
  processedAt: null,
  status: 'pending',
  retryCount: 0,
  ...overrides,
});

describe('decideRevokeAction', () => {
  test('deletes when the queue records the order as sent', () => {
    const decision = decideRevokeAction({ entry: makeEntry({ status: 'sent' }) });
    assert.deepEqual(decision, { action: 'delete', reason: 'order_revoked' });
  });

  // The never-sent gate keeps us off the HTTP 500 Entur returns for a student it has no account
  // for — a response indistinguishable from a genuine outage.
  test('does nothing when the order has no queue entry at all', () => {
    const decision = decideRevokeAction({ entry: undefined });
    assert.deepEqual(decision, { action: 'none', reason: 'never_sent' });
  });

  test('does nothing for any non-sent queue status', () => {
    for (const status of ['pending', 'failed', 'skipped'] as const) {
      const decision = decideRevokeAction({ entry: makeEntry({ status }) });
      assert.deepEqual(
        decision,
        { action: 'none', reason: 'never_sent' },
        `status ${status} should not revoke`
      );
    }
  });
});

describe('decideRevokeAction — force', () => {
  // buildQueue() resets every 'sent' marker at the start of a school year, so a contract can exist
  // in Entur that the queue has no memory of. --force is the manual way to clean that up.
  test('force deletes even with no queue entry', () => {
    const decision = decideRevokeAction({ entry: undefined, force: true });
    assert.deepEqual(decision, { action: 'delete', reason: 'forced' });
  });

  test('force deletes regardless of queue status', () => {
    for (const status of ['pending', 'failed', 'skipped', 'sent'] as const) {
      const decision = decideRevokeAction({ entry: makeEntry({ status }), force: true });
      assert.deepEqual(decision, { action: 'delete', reason: 'forced' });
    }
  });

  test('force:false behaves exactly like an absent force', () => {
    assert.deepEqual(decideRevokeAction({ entry: undefined, force: false }), {
      action: 'none',
      reason: 'never_sent',
    });
  });
});

describe('decideDeferredRevoke', () => {
  // The whole point of the grace period: the order was rejected, then approved again before the
  // timer fired, so the delete must not happen. The queue cannot tell us this — a re-approved order
  // keeps its 'sent' entry — which is why the check re-queries the database.
  test('cancels the delete when the order is eligible again', () => {
    const check = decideDeferredRevoke({ found: true });
    assert.deepEqual(check, { action: 'cancel', reason: 'order_eligible_again' });
  });

  test('deletes when the order is still not eligible', () => {
    const check = decideDeferredRevoke({ found: false });
    assert.deepEqual(check, { action: 'delete', reason: 'still_not_eligible' });
  });
});
