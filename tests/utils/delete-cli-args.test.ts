import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDeleteArgs,
  selectOrdersToRevoke,
  explainNothingToRevoke,
} from '../../src/delete-student-from-entur';
import { QueueEntry } from '../../src/services/queue.service';

// The module is guarded by `require.main === module`, so importing it does not run the CLI.

const makeEntry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  studentId: '91703',
  ordersId: '78411',
  startDate: '2026-08-15',
  addedAt: '2026-08-01T00:00:00.000Z',
  processedAt: null,
  status: 'sent',
  retryCount: 0,
  ...overrides,
});

describe('parseDeleteArgs — --order-id requires exactly one student', () => {
  test('accepts one student with an order id', () => {
    const config = parseDeleteArgs(['--student-id', '91703', '--order-id', '78411']);
    assert.equal(config?.orderId, '78411');
    assert.deepEqual(config?.studentIds, ['91703']);
  });

  // Deduplication happens before the check, so naming the same student twice is still one student.
  test('duplicate ids for the same student collapse to one and are accepted', () => {
    const config = parseDeleteArgs([
      '--student-id', '91703',
      '--student-id', '91703',
      '--order-id', '78411',
    ]);
    assert.deepEqual(config?.studentIds, ['91703']);
  });

  // An order belongs to exactly one student, so this describes something that cannot exist. Nothing
  // would be wrongly deleted — the bogus pair was never posted, so Entur reports it already gone —
  // but the run would claim to have revoked more than it did.
  test('rejects --order-id with several students, naming them', () => {
    assert.throws(
      () => parseDeleteArgs(['--student-ids', '91703,91704', '--order-id', '78411']),
      (error: Error) => {
        assert.match(error.message, /exactly one --student-id/);
        assert.match(error.message, /91703, 91704/);
        return true;
      }
    );
  });

  test('rejects repeated --student-id with an order id', () => {
    assert.throws(
      () => parseDeleteArgs(['--student-id', '91703', '--student-id', '91704', '--order-id', '78411']),
      /exactly one --student-id/
    );
  });

  test('rejects --order-id with no student at all', () => {
    assert.throws(() => parseDeleteArgs(['--order-id', '78411']), /got none/);
  });

  // --force is about the never-sent gate, not about which student owns an order.
  test('--force does not bypass the rule', () => {
    assert.throws(
      () => parseDeleteArgs(['--student-ids', '1,2', '--order-id', '78411', '--force']),
      /exactly one --student-id/
    );
  });

  test('several students are fine without an order id', () => {
    const config = parseDeleteArgs(['--student-ids', '91703,91704']);
    assert.deepEqual(config?.studentIds, ['91703', '91704']);
    assert.equal(config?.orderId, undefined);
  });
});

describe('parseDeleteArgs — existing behaviour must not regress', () => {
  test('defaults to a dry run', () => {
    assert.equal(parseDeleteArgs(['--student-id', '1'])?.dryRun, true);
  });

  test('only the literal "false" arms a real delete', () => {
    assert.equal(parseDeleteArgs(['--student-id', '1', '--dry-run', 'false'])?.dryRun, false);
    for (const truthy of ['0', 'no', 'FALSE', 'true']) {
      assert.equal(
        parseDeleteArgs(['--student-id', '1', '--dry-run', truthy])?.dryRun,
        true,
        `"${truthy}" must stay a dry run`
      );
    }
  });

  test('--help returns null', () => {
    assert.equal(parseDeleteArgs(['--help']), null);
    assert.equal(parseDeleteArgs(['-h']), null);
  });

  test('an unknown flag throws rather than being ignored', () => {
    assert.throws(() => parseDeleteArgs(['--student-id', '1', '--delete-everything']), /Unknown flag/);
  });

  test('--force is off by default', () => {
    assert.equal(parseDeleteArgs(['--student-id', '1'])?.force, false);
    assert.equal(parseDeleteArgs(['--student-id', '1', '--force'])?.force, true);
  });
});

describe('selectOrdersToRevoke', () => {
  const entries = [
    makeEntry({ ordersId: '78411', status: 'sent' }),
    makeEntry({ ordersId: '78412', status: 'pending' }),
    makeEntry({ ordersId: '78413', status: 'skipped' }),
  ];

  test('takes only sent entries by default', () => {
    const targets = selectOrdersToRevoke(entries, { force: false });
    assert.deepEqual(targets, [{ ordersId: '78411', studentId: '91703' }]);
  });

  test('force widens it to every entry', () => {
    const targets = selectOrdersToRevoke(entries, { force: true });
    assert.deepEqual(targets.map((t) => t.ordersId), ['78411', '78412', '78413']);
  });

  test('an order id narrows it to that order', () => {
    const targets = selectOrdersToRevoke(entries, { orderId: '78412', force: true });
    assert.deepEqual(targets, [{ ordersId: '78412', studentId: '91703' }]);
  });

  test('an order id that is not sent yields nothing without force', () => {
    assert.deepEqual(selectOrdersToRevoke(entries, { orderId: '78412', force: false }), []);
  });

  test('an unknown order id yields nothing', () => {
    assert.deepEqual(selectOrdersToRevoke(entries, { orderId: '99999', force: true }), []);
  });
});

describe('explainNothingToRevoke', () => {
  // The regression: the old message said "Use --force to delete anyway" even when --force had just
  // been passed, which sent the operator round in circles. --force widens which entries count as
  // revokable; it cannot supply an order id, and a delete is addressed by (studentId, applicationId).
  test('tells a --force user to add --order-id when the queue is empty', () => {
    const message = explainNothingToRevoke({ entryCount: 0, force: true, hasOrderId: false });
    assert.match(message, /--order-id/);
    assert.doesNotMatch(message, /add --force|Add --force/i, 'must not ask for --force again');
  });

  test('asks for both flags when the queue is empty and force was not given', () => {
    const message = explainNothingToRevoke({ entryCount: 0, force: false, hasOrderId: false });
    assert.match(message, /--order-id/);
    assert.match(message, /--force/);
  });

  test('asks for --force when entries exist but none are sent', () => {
    const message = explainNothingToRevoke({ entryCount: 3, force: false, hasOrderId: false });
    assert.match(message, /--force/);
    assert.doesNotMatch(message, /--order-id/);
  });

  test('points at the order id when a forced lookup matched nothing', () => {
    const message = explainNothingToRevoke({ entryCount: 3, force: true, hasOrderId: true });
    assert.match(message, /Check the id/);
  });

  test('offers --force when the named order exists but is not sent', () => {
    const message = explainNothingToRevoke({ entryCount: 3, force: false, hasOrderId: true });
    assert.match(message, /--force/);
  });
});
