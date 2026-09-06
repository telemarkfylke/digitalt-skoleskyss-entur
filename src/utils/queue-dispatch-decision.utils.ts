import { QueueEntry } from '../services/queue.service';
import { isOrderApproved } from './order-status.utils';

export type UpdateDispatchAction =
  | { action: 'send'; reason: 'queue_entry_sent' | 'queue_entry_sent_status_unknown' }
  | { action: 'send_then_revoke'; reason: 'sent_lost_approval' }
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
// An already-'sent' order is always sent again. When it has *lost* approval that send still happens
// first — the mapper's overrideEndDateWhenPrimaryStatusNot2 sets endDate to today, which revokes
// travel immediately and reversibly — and 'send_then_revoke' additionally asks the caller to
// schedule a delete re-check. Deleting outright on the first poll would be wrong for two reasons:
// PrimaryStatus 2 is the only value documented anywhere, so "not 2" may include benign states, and
// an order is typically created unapproved and decided seconds later, so a transient flip would
// destroy and recreate the pupil's contract. The grace period lets a re-approval undo it silently.
//
// PrimaryStatus must be *explicitly* not approved to trigger a revoke. isOrderApproved returns false
// for undefined/null too, so an absent status would otherwise revoke on missing data — the same trap
// the mapper guards against (see entur-request-mapper.utils.ts). An unknown status falls back to a
// plain refresh, which is what the mapper does with it anyway.
//
// Conversely an order that never reached Entur and is no longer approved is simply ignored — there
// is nothing to revoke, and nothing worth retrying.
export const decideUpdateDispatchAction = (
  entry: QueueEntry | undefined,
  primaryStatus: string | number | null | undefined
): UpdateDispatchAction => {
  const isApproved = isOrderApproved(primaryStatus);
  const isStatusKnown = primaryStatus !== undefined && primaryStatus !== null;

  if (entry?.status === 'sent') {
    if (isApproved) return { action: 'send', reason: 'queue_entry_sent' };
    if (!isStatusKnown) return { action: 'send', reason: 'queue_entry_sent_status_unknown' };
    return { action: 'send_then_revoke', reason: 'sent_lost_approval' };
  }

  if (entry?.status === 'pending') return { action: 'skip', reason: 'queue_entry_pending' };

  if (!isApproved) return { action: 'ignore', reason: 'not_approved_never_sent' };

  if (entry?.status === 'failed') return { action: 'enqueue', reason: 'queue_entry_failed' };
  if (entry?.status === 'skipped') return { action: 'enqueue', reason: 'queue_entry_skipped' };
  return { action: 'enqueue', reason: 'approved_not_queued' };
};
