import { QueueEntry } from '../services/queue.service';

export type UpdateDispatchAction =
  | { action: 'send'; reason: 'no_queue_entry' | 'queue_entry_sent' }
  | { action: 'skip'; reason: 'queue_entry_pending' }
  | { action: 'requeue'; reason: 'queue_entry_failed' };

// Decides what to do with an 'updated' change event for an order that may already
// be tracked in the async sync queue (added earlier as 'new'). The queue's status
// is the source of truth for whether a direct send would race/duplicate the
// scheduled drain.
export const decideUpdateDispatchAction = (entry: QueueEntry | undefined): UpdateDispatchAction => {
  if (!entry) return { action: 'send', reason: 'no_queue_entry' };
  if (entry.status === 'pending') return { action: 'skip', reason: 'queue_entry_pending' };
  if (entry.status === 'failed') return { action: 'requeue', reason: 'queue_entry_failed' };
  return { action: 'send', reason: 'queue_entry_sent' };
};
