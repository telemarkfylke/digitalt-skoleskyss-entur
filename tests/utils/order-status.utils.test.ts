import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { APPROVED_PRIMARY_STATUS, isOrderApproved } from '../../src/utils/order-status.utils';

describe('isOrderApproved', () => {
  test('approves PrimaryStatus 2 as a number', () => {
    assert.equal(isOrderApproved(2), true);
  });

  // SQL Server values arrive typed as number, but the record types allow string too.
  test('approves PrimaryStatus 2 as a string', () => {
    assert.equal(isOrderApproved('2'), true);
  });

  test('rejects any other numeric status', () => {
    assert.equal(isOrderApproved(0), false);
    assert.equal(isOrderApproved(1), false);
    assert.equal(isOrderApproved(3), false);
  });

  test('rejects non-numeric values', () => {
    assert.equal(isOrderApproved('abc'), false);
    assert.equal(isOrderApproved(''), false);
  });

  // A missing status must never count as approved — an order can only be queued on a positive signal.
  test('rejects undefined and null', () => {
    assert.equal(isOrderApproved(undefined), false);
    assert.equal(isOrderApproved(null), false);
  });

  test('exposes the approved status constant', () => {
    assert.equal(APPROVED_PRIMARY_STATUS, 2);
  });
});
