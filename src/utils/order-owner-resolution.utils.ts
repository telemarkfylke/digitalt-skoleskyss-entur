export type OrderOwner =
  | { resolved: true; ordersId: string; studentId: string; source: 'queue' | 'database' }
  | { resolved: false; ordersId: string };

// Maps order ids back to the student that owns them, so a delete can be driven by order id alone.
//
// A fare contract is addressed by the (studentId, applicationId) pair, so an order id on its own is
// not enough to delete anything — the owner has to come from somewhere. Two sources, in order:
//
//   1. The sync queue, which records both ids for everything we sent.
//   2. dbo.Orders, for orders the queue has no entry for — after a queue rebuild, or for an order
//      that has dropped out of the monitor's eligible set entirely.
//
// The queue wins when both have an answer: it reflects what we actually posted to Entur, which is
// what a delete has to match.
//
// Kept pure — the caller supplies both lookups — so precedence and the unresolved case are testable
// without a database or a queue file.
export const resolveOrderOwners = (
  ordersIds: string[],
  sources: {
    queueOwner: (ordersId: string) => string | undefined;
    dbOwner: Map<string, string>;
  }
): OrderOwner[] => {
  const seen = new Set<string>();

  return ordersIds.reduce<OrderOwner[]>((owners, rawId) => {
    const ordersId = String(rawId).trim();
    if (!ordersId || seen.has(ordersId)) return owners;
    seen.add(ordersId);

    const fromQueue = sources.queueOwner(ordersId);
    if (fromQueue) {
      owners.push({ resolved: true, ordersId, studentId: String(fromQueue), source: 'queue' });
      return owners;
    }

    const fromDb = sources.dbOwner.get(ordersId);
    if (fromDb) {
      owners.push({ resolved: true, ordersId, studentId: String(fromDb), source: 'database' });
      return owners;
    }

    owners.push({ resolved: false, ordersId });
    return owners;
  }, []);
};

export const summariseOwners = (owners: OrderOwner[]) => {
  const resolved = owners.filter((o): o is Extract<OrderOwner, { resolved: true }> => o.resolved);
  return {
    total: owners.length,
    resolved,
    unresolved: owners.filter((o) => !o.resolved).map((o) => o.ordersId),
    fromQueue: resolved.filter((o) => o.source === 'queue').length,
    fromDatabase: resolved.filter((o) => o.source === 'database').length
  };
};
