import { QueueEntry } from '../services/queue.service';

export type RevokeAction =
  | { action: 'delete'; reason: 'order_revoked' | 'forced' }
  | { action: 'none'; reason: 'never_sent' };

// Decides whether an order's Entur fare contract should be deleted.
//
// A fare contract is keyed on the (studentId, applicationId) pair, so a delete only ever removes the
// contract belonging to *this* order — a pupil's other orders are untouched. That is why this
// decision needs nothing beyond the order's own queue entry; see
// docs/ENTUR-CONTRACT-MODEL-FINDINGS.md for the staging evidence.
//
// The queue entry is the only record of what actually reached Entur. Without a 'sent' entry we do
// not call the API at all: deleting for a student Entur has never seen returns HTTP 500, which is
// indistinguishable from a genuine outage (docs/ENTUR_INTEGRATION.md). 'force' is the manual CLI
// escape hatch for cleaning up a contract the queue has lost track of — for example after
// buildQueue() reset every 'sent' marker at the start of a school year.
export const decideRevokeAction = (input: {
  entry: QueueEntry | undefined;
  force?: boolean;
}): RevokeAction => {
  if (input.force) return { action: 'delete', reason: 'forced' };
  if (input.entry?.status === 'sent') return { action: 'delete', reason: 'order_revoked' };
  return { action: 'none', reason: 'never_sent' };
};

export type DeferredRevokeCheck =
  | { action: 'delete'; reason: 'still_not_eligible' }
  | { action: 'cancel'; reason: 'order_eligible_again' };

// Decides whether a delete deferred after a lost approval should still go ahead.
//
// This has to read the *database*, not the queue: a re-approved order keeps its 'sent' queue entry
// (decideUpdateDispatchAction returns 'send', which never changes queue state), so the queue alone
// cannot tell a genuine rejection from a transient PrimaryStatus flip. `selection` comes from
// selectQueuedOrder over getSingleStudent, which already filters to PrimaryStatus = 2 and drops
// overridden orders — so "found" means "eligible again".
//
// The caller must abort rather than call this if the lookup threw: a failed query is not evidence
// that an order became ineligible, and treating it as such would delete a valid contract.
export const decideDeferredRevoke = (selection: { found: boolean }): DeferredRevokeCheck =>
  selection.found
    ? { action: 'cancel', reason: 'order_eligible_again' }
    : { action: 'delete', reason: 'still_not_eligible' };
