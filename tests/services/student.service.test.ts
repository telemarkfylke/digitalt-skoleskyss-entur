import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { StudentService } from '../../src/services/student.service';
import { calculateSchoolYear, getSchoolYearRange } from '../../src/utils';

const range = getSchoolYearRange(calculateSchoolYear());

interface CapturedQuery {
  sql: string;
  params: any[];
}

// Stands in for DatabaseService: records what was asked and returns `recordset`, so these tests
// exercise query construction and post-query filtering without a database.
const makeService = (
  recordset: any[] = []
): { service: StudentService; queries: CapturedQuery[] } => {
  const queries: CapturedQuery[] = [];
  const db: any = {
    isConnected: () => true,
    connect: async () => {},
    query: async (sql: string, params?: any[]) => {
      queries.push({ sql, params: params || [] });
      return { recordset };
    },
  };
  return { service: new StudentService(db), queries };
};

// Every @paramN in the SQL must have a value bound at index N, and vice versa. The tag parameters
// are appended *after* whatever each query already binds, and DatabaseService binds them
// positionally, so an off-by-one here would silently bind a tag string as a date.
const assertParametersAligned = (captured: CapturedQuery): void => {
  const used = [...new Set(captured.sql.match(/@param(\d+)/g) || [])]
    .map((placeholder) => Number(placeholder.slice('@param'.length)))
    .sort((a, b) => a - b);
  const bound = captured.params.map((_, index) => index);

  assert.deepEqual(used, bound, `placeholders ${used.join(',')} vs bound indexes ${bound.join(',')}`);
};

// An eligible row, with the fields the filters read. PrimaryStatus 2 = approved.
const order = (
  OrdersId: number,
  overrides: { OverridesOrderId?: number | null; ExcludedByTag?: number } = {}
) => ({
  OrdersId,
  StudentId: 81722,
  PrimaryStatus: 2,
  OverridesOrderId: null,
  ExcludedByTag: 0,
  ...overrides,
});

describe('StudentService query construction', () => {
  beforeEach(() => {
    delete process.env.ENTUR_EXCLUDED_ORDER_TAGS;
  });

  afterEach(() => {
    delete process.env.ENTUR_EXCLUDED_ORDER_TAGS;
  });

  // The tag must NOT be a WHERE clause on these paths: removing the tagged row would take the
  // overriding order away from filterOverriddenOrders. See the regression suite below.
  test('selects the tag as a flag rather than filtering it in SQL', async () => {
    const { service, queries } = makeService();
    await service.getVideregaaendeStudents(range);

    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /END AS ExcludedByTag/);
    assert.doesNotMatch(queries[0].sql, /AND NOT EXISTS/);
    assertParametersAligned(queries[0]);
  });

  // The riskiest offset: two dates, then one slot per class, then one per grade id, then tags.
  test('getVideregaaendeStudentsFromClasses binds tags after the class and grade parameters', async () => {
    const { service, queries } = makeService();
    await service.getVideregaaendeStudentsFromClasses(range, ['1A', '1B'], ['1', '2', '3']);

    assertParametersAligned(queries[0]);
    assert.deepEqual(queries[0].params, [
      range.start,
      range.end,
      '1A',
      '1B',
      '1',
      '2',
      '3',
      'VGS Fysisk skolereisekort',
    ]);
  });

  test('getSingleStudent binds tags after the student id', async () => {
    const { service, queries } = makeService();
    await service.getSingleStudent(range, '81722');

    assertParametersAligned(queries[0]);
    assert.deepEqual(queries[0].params, [range.start, range.end, '81722', 'VGS Fysisk skolereisekort']);
  });

  test('multiple configured tags stay aligned with their placeholders', async () => {
    process.env.ENTUR_EXCLUDED_ORDER_TAGS = 'Tagg A,Tagg B';
    const { service, queries } = makeService();
    await service.getSingleStudent(range, '81722');

    assertParametersAligned(queries[0]);
    assert.deepEqual(queries[0].params.slice(-2), ['Tagg A', 'Tagg B']);
  });

  // The escape hatch still has to leave a readable column behind.
  test('an empty tag override selects a constant flag and binds no tag params', async () => {
    process.env.ENTUR_EXCLUDED_ORDER_TAGS = '';
    const { service, queries } = makeService();
    await service.getVideregaaendeStudents(range);

    assert.match(queries[0].sql, /CAST\(0 AS bit\) AS ExcludedByTag/);
    assert.doesNotMatch(queries[0].sql, /OrderTags/);
    assert.deepEqual(queries[0].params, [range.start, range.end]);
    assertParametersAligned(queries[0]);
  });

  // Deliberately unfiltered: the delete CLI resolves orders that have *dropped out* of the eligible
  // set, and a tagged order is exactly one whose contract needs deleting.
  test('getOrderOwners is exempt from the tag filter', async () => {
    const { service, queries } = makeService();
    await service.getOrderOwners([101, 102]);

    assert.doesNotMatch(queries[0].sql, /OrderTags/);
    assert.doesNotMatch(queries[0].sql, /ExcludedByTag/);
    assert.deepEqual(queries[0].params, ['101', '102']);
    assertParametersAligned(queries[0]);
  });
});

// Regression suite for the bug that motivated the flag: excluding tagged orders in SQL removed the
// overriding row, so filterOverriddenOrders stopped seeing the replaced order as superseded and it
// was sent to Entur — a digital contract for the very pupil the tag excludes.
describe('StudentService tag exclusion vs. overridden orders', () => {
  const lookups: Array<[string, (s: StudentService) => Promise<unknown[]>]> = [
    ['getVideregaaendeStudents', (s) => s.getVideregaaendeStudents(range)],
    ['getVideregaaendeStudentsFromClasses', (s) => s.getVideregaaendeStudentsFromClasses(range, ['1A'], ['1'])],
    ['getSingleStudent', (s) => s.getSingleStudent(range, '81722')],
  ];

  for (const [name, call] of lookups) {
    test(`${name}: an order replaced by a tagged order is not returned`, async () => {
      const { service } = makeService([
        order(1),
        order(2, { OverridesOrderId: 1, ExcludedByTag: 1 }),
      ]);

      assert.deepEqual(await call(service), []);
    });
  }

  test('a three-deep chain ending in a tagged order returns nothing', async () => {
    const { service } = makeService([
      order(1),
      order(2, { OverridesOrderId: 1 }),
      order(3, { OverridesOrderId: 2, ExcludedByTag: 1 }),
    ]);

    assert.deepEqual(await service.getSingleStudent(range, '81722'), []);
  });

  // Per-order, not per-student: the tag disqualifies its own order, not everything the pupil has.
  test("a pupil's independent untagged order still comes through", async () => {
    const { service } = makeService([order(1), order(2, { ExcludedByTag: 1 })]);

    const students = await service.getSingleStudent(range, '81722');
    assert.deepEqual(students.map((s) => s.OrdersId), [1]);
  });

  test('an untagged order superseded by an untagged order is dropped, as before', async () => {
    const { service } = makeService([order(1), order(2, { OverridesOrderId: 1 })]);

    const students = await service.getSingleStudent(range, '81722');
    assert.deepEqual(students.map((s) => s.OrdersId), [2]);
  });

  test('an unapproved tagged replacement leaves the original alone, as before', async () => {
    const { service } = makeService([
      order(1),
      order(2, { OverridesOrderId: 1, ExcludedByTag: 1 }),
    ].map((o, index) => (index === 1 ? { ...o, PrimaryStatus: 1 } : o)));

    const students = await service.getSingleStudent(range, '81722');
    assert.deepEqual(students.map((s) => s.OrdersId), [1]);
  });
});

describe('StudentService.hasExcludedTagOrder', () => {
  afterEach(() => {
    delete process.env.ENTUR_EXCLUDED_ORDER_TAGS;
  });

  test('asks whether the pupil has a tagged order inside the school year', async () => {
    const { service, queries } = makeService();
    await service.hasExcludedTagOrder('81722', range);

    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /o\.StudentId = @param2/);
    // Positive predicate — no NOT — since this asks whether a tagged order *exists*.
    assert.match(queries[0].sql, /AND EXISTS/);
    assert.deepEqual(queries[0].params, [range.start, range.end, '81722', 'VGS Fysisk skolereisekort']);
    assertParametersAligned(queries[0]);
  });

  test('is true when the query finds one', async () => {
    const { service } = makeService([{ OrdersId: 101 }]);
    assert.equal(await service.hasExcludedTagOrder('81722', range), true);
  });

  test('is false when the query finds none', async () => {
    const { service } = makeService([]);
    assert.equal(await service.hasExcludedTagOrder('81722', range), false);
  });

  // Nothing is excluded, so the answer cannot be yes — and asking would be wasted work.
  test('skips the database when no tags are configured', async () => {
    process.env.ENTUR_EXCLUDED_ORDER_TAGS = '';
    const { service, queries } = makeService([{ OrdersId: 101 }]);

    assert.equal(await service.hasExcludedTagOrder('81722', range), false);
    assert.equal(queries.length, 0);
  });
});
