import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExcludedOrderTagFilter,
  buildExcludedOrderTagFlag,
  buildExcludedOrderTagPredicate,
  filterExcludedByTag,
} from '../../src/utils/excluded-order-tags.utils';

const TAG = 'VGS Fysisk skolereisekort';

describe('buildExcludedOrderTagPredicate', () => {
  test('correlates on the outer dbo.Orders alias and ignores soft-deleted tags', () => {
    const { sql } = buildExcludedOrderTagPredicate(0, [TAG]);

    assert.match(sql, /^EXISTS \(/);
    assert.match(sql, /FROM dbo\.OrderTags ot/);
    assert.match(sql, /INNER JOIN dbo\.Tags t ON t\.Id = ot\.TagId/);
    assert.match(sql, /ot\.OrderId = o\.Id/);
    assert.match(sql, /t\.IsDeleted = 0/);
  });

  test('places its parameters at the given offset', () => {
    const { sql, params } = buildExcludedOrderTagPredicate(3, [TAG]);

    assert.match(sql, /t\.Text IN \(@param3\)/);
    assert.deepEqual(params, [TAG]);
  });

  test('emits one placeholder per tag, in order', () => {
    const tags = [TAG, 'Annen tagg', 'Tredje tagg'];
    const { sql, params } = buildExcludedOrderTagPredicate(5, tags);

    assert.match(sql, /t\.Text IN \(@param5, @param6, @param7\)/);
    assert.deepEqual(params, tags);
  });

  test('trims tags and drops blank entries', () => {
    const { sql, params } = buildExcludedOrderTagPredicate(2, ['  ' + TAG + ' ', '', '   ']);

    assert.deepEqual(params, [TAG]);
    assert.match(sql, /t\.Text IN \(@param2\)/);
  });

  test('returns an empty fragment for an empty tag list', () => {
    assert.deepEqual(buildExcludedOrderTagPredicate(2, []), { sql: '', params: [] });
  });

  test('returns an empty fragment when every tag is blank', () => {
    assert.deepEqual(buildExcludedOrderTagPredicate(2, ['', '   ']), { sql: '', params: [] });
  });
});

describe('buildExcludedOrderTagFilter', () => {
  test('negates the predicate as an AND-able WHERE fragment', () => {
    const { sql, params } = buildExcludedOrderTagFilter(2, [TAG]);

    assert.match(sql, /AND NOT EXISTS \(/);
    assert.match(sql, /t\.Text IN \(@param2\)/);
    assert.deepEqual(params, [TAG]);
  });

  test('parameter count matches the number of placeholders it emits', () => {
    const { sql, params } = buildExcludedOrderTagFilter(4, [TAG, 'Annen tagg']);
    const placeholders = sql.match(/@param\d+/g) || [];

    assert.equal(placeholders.length, params.length);
    assert.deepEqual(placeholders, ['@param4', '@param5']);
  });

  // An empty override must degrade to the pre-tag behaviour, not to invalid SQL.
  test('returns an empty fragment for an empty tag list', () => {
    assert.deepEqual(buildExcludedOrderTagFilter(2, []), { sql: '', params: [] });
  });
});

describe('buildExcludedOrderTagFlag', () => {
  test('emits the predicate as a SELECT-list column, not a WHERE clause', () => {
    const { sql, params } = buildExcludedOrderTagFlag(2, [TAG]);

    assert.match(sql, /^,/);
    assert.match(sql, /CASE WHEN EXISTS \(/);
    assert.match(sql, /END AS ExcludedByTag/);
    assert.doesNotMatch(sql, /AND NOT/);
    assert.match(sql, /t\.Text IN \(@param2\)/);
    assert.deepEqual(params, [TAG]);
  });

  // Callers read the column unconditionally, so it has to exist even with the filter switched off.
  test('still emits the column, as a constant, for an empty tag list', () => {
    const { sql, params } = buildExcludedOrderTagFlag(2, []);

    assert.match(sql, /CAST\(0 AS bit\) AS ExcludedByTag/);
    assert.doesNotMatch(sql, /OrderTags/);
    assert.deepEqual(params, []);
  });

  test('parameter count matches the number of placeholders it emits', () => {
    const { sql, params } = buildExcludedOrderTagFlag(4, [TAG, 'Annen tagg']);
    const placeholders = sql.match(/@param\d+/g) || [];

    assert.equal(placeholders.length, params.length);
    assert.deepEqual(placeholders, ['@param4', '@param5']);
  });
});

describe('filterExcludedByTag', () => {
  // mssql hands back a bit column as a boolean and a computed 1/0 as a number, so both reach here.
  test('drops truthy flags in either representation', () => {
    const records = [
      { OrdersId: 1, ExcludedByTag: 1 },
      { OrdersId: 2, ExcludedByTag: true },
    ];

    assert.deepEqual(filterExcludedByTag(records), { filtered: [], excluded: 2 });
  });

  test('keeps every falsy or absent flag', () => {
    const records = [
      { OrdersId: 1, ExcludedByTag: 0 },
      { OrdersId: 2, ExcludedByTag: false },
      { OrdersId: 3, ExcludedByTag: null },
      { OrdersId: 4 },
    ];

    const result = filterExcludedByTag(records);
    assert.deepEqual(result.filtered.map((r) => r.OrdersId), [1, 2, 3, 4]);
    assert.equal(result.excluded, 0);
  });

  test('reports how many it removed', () => {
    const result = filterExcludedByTag([
      { OrdersId: 1, ExcludedByTag: 0 },
      { OrdersId: 2, ExcludedByTag: 1 },
      { OrdersId: 3, ExcludedByTag: 0 },
    ]);

    assert.deepEqual(result.filtered.map((r) => r.OrdersId), [1, 3]);
    assert.equal(result.excluded, 1);
  });

  test('handles an empty list', () => {
    assert.deepEqual(filterExcludedByTag([]), { filtered: [], excluded: 0 });
  });
});
