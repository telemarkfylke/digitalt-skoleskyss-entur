import { getExcludedOrderTags } from '../config/excluded-order-tags.config';

export interface ExcludedOrderTagFilter {
  sql: string;
  params: string[];
}

/**
 * `EXISTS (...)` predicate that is true when the order has a physical-travel-card tag.
 *
 * NOT EXISTS rather than a LEFT JOIN ... IS NULL so the predicate adds no row multiplication of its
 * own — the eligibility queries already fan out on dbo.OrderParts.
 *
 * `startParamIndex` is the first unused @paramN slot in the calling query: DatabaseService binds
 * parameters positionally (`request.input('param' + index, ...)`), so the caller must append the
 * returned `params` to the end of its own parameter array, in order.
 *
 * An empty tag list returns an empty fragment — callers decide what that means for their query.
 *
 * The `o` alias refers to dbo.Orders in the outer query; every call site aliases it that way.
 */
export const buildExcludedOrderTagPredicate = (
  startParamIndex: number,
  tags: string[] = getExcludedOrderTags()
): ExcludedOrderTagFilter => {
  const params = tags.map((tag) => String(tag).trim()).filter(Boolean);

  if (params.length === 0) {
    return { sql: '', params: [] };
  }

  const placeholders = params
    .map((_, index) => `@param${startParamIndex + index}`)
    .join(', ');

  // t.IsDeleted = 0: a soft-deleted tag row must not keep denying a pupil a digital card.
  const sql = `EXISTS (
            SELECT 1
            FROM dbo.OrderTags ot
            INNER JOIN dbo.Tags t ON t.Id = ot.TagId
            WHERE ot.OrderId = o.Id
              AND t.IsDeleted = 0
              AND t.Text IN (${placeholders})
          )`;

  return { sql, params };
};

/**
 * SELECT-list fragment exposing the tag as an `ExcludedByTag` flag, for `filterExcludedByTag` to
 * act on after the query returns.
 *
 * **This is the form the StudentService lookups use, and the reason is subtle.**
 * `filterOverriddenOrders` only treats an order as superseded while the *overriding* order is
 * present in the same result set. Excluding tagged rows in SQL removes that row — so when a tagged
 * order replaces an untagged one, the replaced order stops looking superseded and gets sent to
 * Entur, giving a digital contract to the very pupil the tag excludes. Keeping every row and
 * filtering afterwards leaves the override filter with the full picture, which is correct at any
 * override-chain depth.
 *
 * The column is emitted even with no tags configured, so callers can read it unconditionally.
 *
 * See buildExcludedOrderTagPredicate for `startParamIndex` and the SQL itself.
 */
export const buildExcludedOrderTagFlag = (
  startParamIndex: number,
  tags: string[] = getExcludedOrderTags()
): ExcludedOrderTagFilter => {
  const predicate = buildExcludedOrderTagPredicate(startParamIndex, tags);

  if (!predicate.sql) {
    return { sql: `,\n          CAST(0 AS bit) AS ExcludedByTag`, params: [] };
  }

  return {
    sql: `,
          -- Pupils with a physical school travel card are tagged in the source system and must
          -- never get an Entur fare contract. Filtered by filterExcludedByTag *after*
          -- filterOverriddenOrders — see buildExcludedOrderTagFlag for why not in the WHERE.
          CASE WHEN ${predicate.sql} THEN 1 ELSE 0 END AS ExcludedByTag`,
    params: predicate.params,
  };
};

/**
 * Builds the WHERE fragment that keeps physical-travel-card orders out of an eligibility query.
 *
 * **Used by the monitor only** — `StudentService` uses `buildExcludedOrderTagFlag` instead, for the
 * override-filter reason documented there. The monitor wants the row gone: a tagged order
 * *disappearing* from its result set is what fires the existing `removed` → revoke path, which is
 * how a pupil handed a physical card loses the contract they already had. The monitor filters
 * overrides per change-batch rather than over the full result set, so removing rows costs it
 * nothing it had.
 *
 * An empty tag list returns an empty fragment, so switching the filter off via
 * ENTUR_EXCLUDED_ORDER_TAGS degrades to the pre-tag behaviour instead of producing invalid SQL.
 *
 * See buildExcludedOrderTagPredicate for `startParamIndex` and the SQL itself.
 */
export const buildExcludedOrderTagFilter = (
  startParamIndex: number,
  tags: string[] = getExcludedOrderTags()
): ExcludedOrderTagFilter => {
  const predicate = buildExcludedOrderTagPredicate(startParamIndex, tags);

  if (!predicate.sql) {
    return predicate;
  }

  return {
    sql: `
          -- Pupils with a physical school travel card are tagged in the source system and must
          -- never get an Entur fare contract. Per order, so their untagged orders still sync.
          AND NOT ${predicate.sql}`,
    params: predicate.params,
  };
};

export interface HasExcludedByTagFlag {
  ExcludedByTag?: number | boolean | null;
}

export interface ExcludedByTagFilterResult<T> {
  filtered: T[];
  excluded: number;
}

/**
 * Drops orders flagged by `buildExcludedOrderTagFlag`.
 *
 * Must run **after** `filterOverriddenOrders`, which needs the tagged row present to recognise the
 * order it replaces as superseded. `filterStudentData` owns that ordering.
 *
 * The flag is read as truthy rather than compared to 1: `mssql` returns a bit column as a boolean
 * and a computed 1/0 as a number, and both forms reach here.
 */
export const filterExcludedByTag = <T extends HasExcludedByTagFlag>(
  records: T[]
): ExcludedByTagFilterResult<T> => {
  const filtered = records.filter((record) => !record.ExcludedByTag);

  return { filtered, excluded: records.length - filtered.length };
};
