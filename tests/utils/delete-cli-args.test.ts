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

// A 58-id list pasted with spaces after the commas, exactly as it arrives from a SQL client. The
// shell splits it into 58 separate argv entries — the failure this feature exists to prevent.
const PASTED_58 = (
  '80409, 80565, 80188, 79619, 78924, 79635, 79469, 78974, 81253, 81248, 81113, 81050, 79575, ' +
  '78909, 81792, 80122, 80247, 79596, 79452, 79319, 79250, 78941, 81437, 81099, 80658, 80279, ' +
  '79121, 80033, 79398, 78989, 81430, 80349, 77257, 81045, 81136, 80048, 79835, 79737, 79641, ' +
  '79584, 79385, 79323, 79284, 79042, 81611, 80329, 80207, 79927, 79841, 79526, 79420, 79140, ' +
  '79116, 80546, 81808, 81006, 80264, 78907'
).split(' ').filter(Boolean);

describe('parseDeleteArgs — order id lists', () => {
  // THE regression. A parser that reads only the argument after the flag would keep one id and
  // silently drop 57, then delete one order live and report success.
  test('keeps every id from a 58-id list pasted with spaces', () => {
    const config = parseDeleteArgs(['--order-ids', ...PASTED_58]);
    assert.equal(config?.orderIds.length, 58);
    assert.equal(config?.orderIds[0], '80409');
    assert.equal(config?.orderIds[57], '78907');
    assert.ok(config?.orderIds.every((id) => /^\d+$/.test(id)), 'no stray commas should survive');
  });

  test('accepts a compact comma list', () => {
    const config = parseDeleteArgs(['--order-ids', '80409,80565,80188']);
    assert.deepEqual(config?.orderIds, ['80409', '80565', '80188']);
  });

  test('accepts space-separated ids with no commas', () => {
    const config = parseDeleteArgs(['--order-ids', '80409', '80565', '80188']);
    assert.deepEqual(config?.orderIds, ['80409', '80565', '80188']);
  });

  // Greedy value consumption must stop at the next flag, or --dry-run would be swallowed as an id
  // and the run would silently stay a dry run (or worse, go live).
  test('stops consuming values at the next flag', () => {
    const config = parseDeleteArgs(['--order-ids', '1,', '2', '--dry-run', 'false', '--force']);
    assert.deepEqual(config?.orderIds, ['1', '2']);
    assert.equal(config?.dryRun, false);
    assert.equal(config?.force, true);
  });

  test('--order-id is repeatable and merges with --order-ids', () => {
    const config = parseDeleteArgs(['--order-id', '1', '--order-id', '2', '--order-ids', '3,4']);
    assert.deepEqual(config?.orderIds, ['1', '2', '3', '4']);
  });

  test('duplicate order ids collapse', () => {
    const config = parseDeleteArgs(['--order-ids', '1,1,2,2']);
    assert.deepEqual(config?.orderIds, ['1', '2']);
  });

  // dbo.Orders.Id is an integer, so a non-numeric id is a typo — and this is the backstop for a
  // stray token the list splitting did not clean up.
  test('rejects a non-numeric order id, naming it', () => {
    assert.throws(() => parseDeleteArgs(['--order-ids', '80409,abc']), /must be numeric/);
    assert.throws(() => parseDeleteArgs(['--order-ids', '80409,abc']), /abc/);
  });

  test('--student-ids is equally tolerant of spaces', () => {
    const config = parseDeleteArgs(['--student-ids', '91703,', '91704', '91705']);
    assert.deepEqual(config?.studentIds, ['91703', '91704', '91705']);
  });
});

describe('parseDeleteArgs — order ids and students together', () => {
  test('order ids alone are allowed — owners get looked up', () => {
    const config = parseDeleteArgs(['--order-ids', '78411,78412']);
    assert.deepEqual(config?.orderIds, ['78411', '78412']);
    assert.deepEqual(config?.studentIds, []);
  });

  test('one student with order ids is allowed', () => {
    const config = parseDeleteArgs(['--student-id', '91703', '--order-id', '78411']);
    assert.deepEqual(config?.orderIds, ['78411']);
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

  // An order belongs to exactly one student, so this describes something that cannot exist.
  test('rejects order ids with several students, naming them', () => {
    assert.throws(
      () => parseDeleteArgs(['--student-ids', '91703,91704', '--order-id', '78411']),
      (error: Error) => {
        assert.match(error.message, /belongs to a single student/);
        assert.match(error.message, /91703, 91704/);
        return true;
      }
    );
  });

  test('rejects repeated --student-id with an order id', () => {
    assert.throws(
      () => parseDeleteArgs(['--student-id', '91703', '--student-id', '91704', '--order-id', '78411']),
      /belongs to a single student/
    );
  });

  // --force is about the never-sent gate, not about which student owns an order.
  test('--force does not bypass the rule', () => {
    assert.throws(
      () => parseDeleteArgs(['--student-ids', '1,2', '--order-id', '78411', '--force']),
      /belongs to a single student/
    );
  });

  test('several students are fine without an order id', () => {
    const config = parseDeleteArgs(['--student-ids', '91703,91704']);
    assert.deepEqual(config?.studentIds, ['91703', '91704']);
    assert.deepEqual(config?.orderIds, []);
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

  test('order ids narrow it to those orders', () => {
    const targets = selectOrdersToRevoke(entries, { orderIds: ['78412'], force: true });
    assert.deepEqual(targets, [{ ordersId: '78412', studentId: '91703' }]);
  });

  test('several order ids select several entries', () => {
    const targets = selectOrdersToRevoke(entries, { orderIds: ['78412', '78413'], force: true });
    assert.deepEqual(targets.map((t) => t.ordersId), ['78412', '78413']);
  });

  test('an order id that is not sent yields nothing without force', () => {
    assert.deepEqual(selectOrdersToRevoke(entries, { orderIds: ['78412'], force: false }), []);
  });

  test('an unknown order id yields nothing', () => {
    assert.deepEqual(selectOrdersToRevoke(entries, { orderIds: ['99999'], force: true }), []);
  });

  // An empty list must mean "no filter", not "match nothing" — student mode passes no order ids.
  test('an empty order id list does not filter anything out', () => {
    const targets = selectOrdersToRevoke(entries, { orderIds: [], force: true });
    assert.equal(targets.length, 3);
  });
});

describe('explainNothingToRevoke', () => {
  // The regression: the old message said "Use --force to delete anyway" even when --force had just
  // been passed, which sent the operator round in circles. --force widens which entries count as
  // revokable; it cannot supply an order id, and a delete is addressed by (studentId, applicationId).
  test('points an empty queue at --order-ids, and does not ask for --force again', () => {
    const message = explainNothingToRevoke({ entryCount: 0, force: true });
    assert.match(message, /--order-ids/);
    assert.doesNotMatch(message, /add --force/i, 'must not ask for --force again');
  });

  test('points an empty queue at --order-ids regardless of --force', () => {
    assert.match(explainNothingToRevoke({ entryCount: 0, force: false }), /--order-ids/);
  });

  test('asks for --force when entries exist but none are sent', () => {
    const message = explainNothingToRevoke({ entryCount: 3, force: false });
    assert.match(message, /--force/);
    assert.doesNotMatch(message, /--order-ids/);
  });

  test('says nothing is revokable when force is already on and entries exist', () => {
    const message = explainNothingToRevoke({ entryCount: 3, force: true });
    assert.doesNotMatch(message, /add --force/i);
  });
});
