import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOrderOwners,
  summariseOwners,
} from '../../src/utils/order-owner-resolution.utils';

const noQueue = () => undefined;
const noDb = new Map<string, string>();

describe('resolveOrderOwners', () => {
  test('resolves from the queue', () => {
    const owners = resolveOrderOwners(['78411'], {
      queueOwner: (id) => (id === '78411' ? '91703' : undefined),
      dbOwner: noDb,
    });
    assert.deepEqual(owners, [
      { resolved: true, ordersId: '78411', studentId: '91703', source: 'queue' },
    ]);
  });

  test('falls back to the database', () => {
    const owners = resolveOrderOwners(['80409'], {
      queueOwner: noQueue,
      dbOwner: new Map([['80409', '12345']]),
    });
    assert.deepEqual(owners, [
      { resolved: true, ordersId: '80409', studentId: '12345', source: 'database' },
    ]);
  });

  // The queue records what we actually posted to Entur, which is what a delete has to match.
  test('the queue wins when both sources know the order', () => {
    const owners = resolveOrderOwners(['78411'], {
      queueOwner: () => '91703',
      dbOwner: new Map([['78411', '99999']]),
    });
    assert.equal(owners[0].resolved && owners[0].studentId, '91703');
    assert.equal(owners[0].resolved && owners[0].source, 'queue');
  });

  test('marks an order neither source knows as unresolved', () => {
    const owners = resolveOrderOwners(['99999999'], { queueOwner: noQueue, dbOwner: noDb });
    assert.deepEqual(owners, [{ resolved: false, ordersId: '99999999' }]);
  });

  test('collapses duplicate ids', () => {
    const owners = resolveOrderOwners(['78411', '78411', '78411'], {
      queueOwner: () => '91703',
      dbOwner: noDb,
    });
    assert.equal(owners.length, 1);
  });

  test('ignores blank entries', () => {
    const owners = resolveOrderOwners(['78411', '', '  '], {
      queueOwner: () => '91703',
      dbOwner: noDb,
    });
    assert.equal(owners.length, 1);
  });

  test('preserves the order the ids were given in', () => {
    const owners = resolveOrderOwners(['3', '1', '2'], {
      queueOwner: (id) => `s${id}`,
      dbOwner: noDb,
    });
    assert.deepEqual(owners.map((o) => o.ordersId), ['3', '1', '2']);
  });
});

describe('summariseOwners', () => {
  test('counts each source and lists the unresolved ids', () => {
    const owners = resolveOrderOwners(['1', '2', '3', '4'], {
      queueOwner: (id) => (id === '1' ? '100' : undefined),
      dbOwner: new Map([
        ['2', '200'],
        ['3', '300'],
      ]),
    });

    const summary = summariseOwners(owners);
    assert.equal(summary.total, 4);
    assert.equal(summary.resolved.length, 3);
    assert.equal(summary.fromQueue, 1);
    assert.equal(summary.fromDatabase, 2);
    assert.deepEqual(summary.unresolved, ['4']);
  });

  test('a fully resolved batch reports no unresolved ids', () => {
    const summary = summariseOwners(
      resolveOrderOwners(['1', '2'], { queueOwner: () => '100', dbOwner: noDb })
    );
    assert.deepEqual(summary.unresolved, []);
    assert.equal(summary.resolved.length, summary.total);
  });
});
