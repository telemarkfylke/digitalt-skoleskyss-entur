export interface HasOrdersId {
  OrdersId: string | number;
  OverridesOrderId?: string | number | null;
}

export interface OverriddenOrderFilterResult<T> {
  filtered: T[];
  excluded: number;
  overriddenOrderIds: Set<number>;
}

export const filterOverriddenOrders = <T extends HasOrdersId>(
  records: T[]
): OverriddenOrderFilterResult<T> => {
  const orderIds = new Set(
    records
      .map(record => Number(record.OrdersId))
      .filter(orderId => Number.isFinite(orderId))
  );

  const overriddenOrderIds = new Set(
    records
      .map(record => record.OverridesOrderId)
      .filter(overridesOrderId => overridesOrderId !== null && overridesOrderId !== undefined)
      .map(overridesOrderId => Number(overridesOrderId))
      .filter(overridesOrderId => Number.isFinite(overridesOrderId) && orderIds.has(overridesOrderId))
  );

  const filtered = records.filter(
    record => !overriddenOrderIds.has(Number(record.OrdersId))
  );

  return {
    filtered,
    excluded: records.length - filtered.length,
    overriddenOrderIds
  };
};
