import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeBy, dedupeByOrderId } from '../../src/utils/dedupe-orders.utils';

describe('dedupeBy', () => {
  test('keeps the first record per key and reports duplicate count', () => {
    const result = dedupeBy([{ id: 'a' }, { id: 'b' }, { id: 'a' }], (r) => r.id);
    assert.equal(result.deduped.length, 2);
    assert.deepEqual(result.deduped.map((r) => r.id), ['a', 'b']);
    assert.equal(result.duplicates, 1);
  });

  test('returns duplicates: 0 when there are no duplicates', () => {
    const result = dedupeBy([{ id: 'a' }, { id: 'b' }], (r) => r.id);
    assert.equal(result.duplicates, 0);
    assert.equal(result.deduped.length, 2);
  });
});

describe('dedupeByOrderId', () => {
  test('dedupes records by OrdersId, keeping the first occurrence', () => {
    const records = [
      { OrdersId: 1, StudentId: 'a' },
      { OrdersId: 1, StudentId: 'b' },
      { OrdersId: 2, StudentId: 'c' },
    ];
    const result = dedupeByOrderId(records);
    assert.equal(result.duplicates, 1);
    assert.deepEqual(result.deduped, [
      { OrdersId: 1, StudentId: 'a' },
      { OrdersId: 2, StudentId: 'c' },
    ]);
  });

  test('treats string and number OrdersId as the same key', () => {
    const records = [{ OrdersId: 1 }, { OrdersId: '1' }];
    const result = dedupeByOrderId(records);
    assert.equal(result.deduped.length, 1);
    assert.equal(result.duplicates, 1);
  });
});
