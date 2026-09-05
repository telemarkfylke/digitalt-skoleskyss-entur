import { QueueEntry } from '../services/queue.service';

export type UpdateDispatchAction =
  | { action: 'send'; reason: 'queue_entry_sent' }
  | { action: 'skip'; reason: 'queue_entry_pending' }
  | { action: 'enqueue'; reason: 'approved_not_queued' | 'queue_entry_failed' | 'queue_entry_skipped' }
  | { action: 'ignore'; reason: 'not_approved_never_sent' };

// Decides what to do with an 'updated' change event for an order that may already be tracked
// in the async sync queue. Two things drive the decision:
//   - the queue status, which is the source of truth for whether the order has actually reached
//     Entur and whether a direct send would race/duplicate the scheduled drain, and
//   - whether the order is currently approved (PrimaryStatus 2), since only approved orders
//     should ever occupy a queue slot.
//
// An already-'sent' order is always sent again, approved or not: for a non-approved order the
// mapper's overrideEndDateWhenPrimaryStatusNot2 sets endDate to today, which is the revoke
// mechanism used here. Entur does have a delete endpoint (EnturApiService.deleteSkoleskyss), but
// it is not used for this: it removes the recipient from the travel right immediately, whereas
// endDate=today leaves the ticket valid for the rest of the day, so a mid-day rejection does not
// strand a pupil who travelled in that morning. Conversely an order that never reached Entur and
// is no longer approved is simply ignored — there is nothing to revoke, and nothing worth retrying.
export const decideUpdateDispatchAction = (
  entry: QueueEntry | undefined,
  isApproved: boolean
): UpdateDispatchAction => {
  if (entry?.status === 'sent') return { action: 'send', reason: 'queue_entry_sent' };
  if (entry?.status === 'pending') return { action: 'skip', reason: 'queue_entry_pending' };

  if (!isApproved) return { action: 'ignore', reason: 'not_approved_never_sent' };

  if (entry?.status === 'failed') return { action: 'enqueue', reason: 'queue_entry_failed' };
  if (entry?.status === 'skipped') return { action: 'enqueue', reason: 'queue_entry_skipped' };
  return { action: 'enqueue', reason: 'approved_not_queued' };
};
