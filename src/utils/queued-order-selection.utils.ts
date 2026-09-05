export type QueuedOrderSelection<T> =
  | { found: true; order: T }
  | { found: false; reason: 'student_not_found' | 'order_not_active' };

// Picks the one order a queue entry refers to out of everything returned for that student.
//
// The lookup is by studentId because that is what computes the overridden-order set
// correctly, but only the entry's own order may be sent: Entur deduplicates on studentId and
// honours the newest post, so sending a student's other orders in the same run would let an
// unrelated order silently become their contract. It also stops a sibling that fails
// validation from failing this entry.
export const selectQueuedOrder = <T extends { OrdersId: string | number }>(
  students: T[],
  ordersId: string
): QueuedOrderSelection<T> => {
  if (students.length === 0) return { found: false, reason: 'student_not_found' };

  const order = students.find((student) => String(student.OrdersId) === String(ordersId));
  if (!order) return { found: false, reason: 'order_not_active' };

  return { found: true, order };
};
