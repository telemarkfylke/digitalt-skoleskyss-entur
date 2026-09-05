import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { selectQueuedOrder } from '../../src/utils/queued-order-selection.utils';

const order = (OrdersId: string | number, ToDate = '2027-06-20') => ({ OrdersId, ToDate });

describe('selectQueuedOrder', () => {
  test('returns the order matching the queue entry', () => {
    const selection = selectQueuedOrder([order('100'), order('200')], '200');
    assert.deepEqual(selection, { found: true, order: order('200') });
  });

  test('matches across string and number OrdersId', () => {
    const selection = selectQueuedOrder([order(200)], '200');
    assert.equal(selection.found, true);
  });

  test('reports student_not_found when the student returned no orders', () => {
    const selection = selectQueuedOrder([], '200');
    assert.deepEqual(selection, { found: false, reason: 'student_not_found' });
  });

  // The student exists but this particular order was filtered out — superseded by a newer
  // order, PrimaryStatus not 2, or no longer overlapping the school year.
  test('reports order_not_active when the student has orders but not this one', () => {
    const selection = selectQueuedOrder([order('100')], '200');
    assert.deepEqual(selection, { found: false, reason: 'order_not_active' });
  });

  // The whole point: a sibling order must never be picked up alongside the entry's own order.
  // Entur honours the newest post per studentId, so sending a sibling in the same run would
  // let it silently become the student's contract.
  test('never returns a sibling order when the requested one is present', () => {
    const siblings = [order('100', '2026-12-19'), order('200', '2027-06-20')];
    const selection = selectQueuedOrder(siblings, '100');
    assert.equal(selection.found, true);
    assert.equal((selection as { found: true; order: { OrdersId: string } }).order.OrdersId, '100');
  });
});
