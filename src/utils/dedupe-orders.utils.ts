export interface DedupeResult<T> {
  deduped: T[];
  duplicates: number;
}

// Keeps the first record per key, in original order.
export const dedupeBy = <T>(records: T[], keyFn: (record: T) => string): DedupeResult<T> => {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const record of records) {
    const key = keyFn(record);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(record);
  }
  return { deduped, duplicates: records.length - deduped.length };
};

export const dedupeByOrderId = <T extends { OrdersId: string | number }>(records: T[]): DedupeResult<T> =>
  dedupeBy(records, (record) => String(record.OrdersId));
