import { EnturApiService } from './entur-skoleskyss.service';
import { QueueService } from './queue.service';
import { appLogger } from './logger.service';
import { decideRevokeAction, decideDeferredRevoke } from '../utils/revoke-decision.utils';
import { selectQueuedOrder } from '../utils/queued-order-selection.utils';
import { SchoolYearRange } from '../utils/school-year.utils';

export interface RevokeDeps {
  enturService: EnturApiService;
  queueService: QueueService;
}

export interface RevokeInput {
  studentId: string | number;
  ordersId: string | number;
  dryRun: boolean;
  /** Manual CLI escape hatch: delete even when the queue has no 'sent' record for the order. */
  force?: boolean;
  /** Audit sink. The monitor passes writeJsonLine; the CLI passes its own. */
  audit?: (payload: Record<string, unknown>) => Promise<void>;
  /** Retry tuning, overridden by tests to keep them fast. */
  maxAttempts?: number;
  baseDelayMs?: number;
}

export type RevokeOutcome =
  | { outcome: 'deleted'; fareContractId?: string; customerAccountId?: string }
  | { outcome: 'already_gone' }
  | { outcome: 'skipped_never_sent' }
  | { outcome: 'dry_run'; wouldDelete: boolean }
  | { outcome: 'failed'; error: string; unknownStudent: boolean };

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Entur answers a delete for a student it has no customer account for with HTTP 500, not 404
// (docs/ENTUR_INTEGRATION.md). We cannot tell that apart from a genuine server fault, so it is
// reported but never escalated — the likeliest cause is a queue that has lost its 'sent' markers.
const isUnknownStudentError = (message: string): boolean => message.includes('HTTP 500');

/**
 * Delete one order's Entur fare contract.
 *
 * Contracts are keyed on the (studentId, applicationId) pair, so this removes only the contract
 * belonging to this order — the pupil's other orders keep theirs. See
 * docs/ENTUR-CONTRACT-MODEL-FINDINGS.md.
 *
 * Shared by every trigger (removed records, deferred revoke after lost approval, and the manual CLI)
 * so the behaviour cannot drift between them.
 */
export const revokeOrderTravelRight = async (
  deps: RevokeDeps,
  input: RevokeInput
): Promise<RevokeOutcome> => {
  const { enturService, queueService } = deps;
  const { studentId, ordersId, dryRun, force, audit } = input;
  const maxAttempts = input.maxAttempts ?? 3;
  const baseDelayMs = input.baseDelayMs ?? 500;

  const ordersIdString = String(ordersId);
  const context = { studentId, orderId: ordersIdString, dryRun: dryRun === true };

  const writeAudit = async (event: string, extra: Record<string, unknown> = {}): Promise<void> => {
    if (!audit) return;
    await audit({ timestamp: new Date().toISOString(), level: 'info', event, ...context, ...extra });
  };

  const decision = decideRevokeAction({ entry: queueService.getEntry(ordersIdString), force });

  if (decision.action === 'none') {
    appLogger.info(
      'Order {OrderId} not revoked: no record of it ever being sent to Entur.',
      ordersIdString
    );
    await writeAudit('entur_delete_skipped_never_sent', { reason: decision.reason });
    return { outcome: 'skipped_never_sent' };
  }

  if (dryRun) {
    appLogger.info(
      'DRY RUN: would delete skoleskyss for order {OrderId} (student {StudentId}, reason {Reason})',
      ordersIdString,
      studentId,
      decision.reason
    );
    await writeAudit('entur_delete_attempted', { reason: decision.reason, dryRunSkipped: true });
    return { outcome: 'dry_run', wouldDelete: true };
  }

  await writeAudit('entur_delete_attempted', { reason: decision.reason });

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await enturService.deleteSkoleskyss({
        studentId,
        applicationId: ordersIdString
      });

      // A 200 with no fare contract means there was nothing to remove — the contract had already
      // been deleted, or was superseded. That is a no-op, not a deletion.
      //
      // Read only fareContractId: Entur deprecates the fareContractIds array in favour of it, and
      // staging set both whenever a contract was actually removed, so the singular field is the
      // whole signal. Its absence is what "already gone" looks like.
      const removedId = response?.fareContractId;
      const nothingRemoved = !removedId;

      // Either way Entur no longer holds a contract for this order, so the queue's 'sent' marker is
      // stale. 'skipped' is the existing terminal state for "no longer eligible", and addEntry
      // resurrects it to 'pending' if the order is ever approved again.
      queueService.markSkipped(
        ordersIdString,
        nothingRemoved ? 'Entur held no contract for this order' : 'Fare contract deleted in Entur'
      );

      if (nothingRemoved) {
        appLogger.info('Order {OrderId}: Entur held no fare contract to delete.', ordersIdString);
        await writeAudit('entur_delete_noop_already_gone', {
          customerAccountId: response?.customerAccountId
        });
        return { outcome: 'already_gone' };
      }

      appLogger.info(
        'Deleted Entur fare contract {FareContractId} for order {OrderId} (student {StudentId})',
        removedId,
        ordersIdString,
        studentId
      );
      await writeAudit('entur_deleted', {
        reason: decision.reason,
        fareContractId: removedId,
        customerAccountId: response?.customerAccountId
      });
      return {
        outcome: 'deleted',
        fareContractId: removedId,
        customerAccountId: response?.customerAccountId
      };
    } catch (error: unknown) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);

      if (attempt < maxAttempts) {
        const backoffMs = baseDelayMs * Math.pow(2, attempt - 1);
        appLogger.warn(
          'Delete attempt {Attempt}/{MaxAttempts} failed for order {OrderId}; retrying in {BackoffMs}ms: {ErrorMessage}',
          attempt,
          maxAttempts,
          ordersIdString,
          backoffMs,
          message
        );
        await delay(backoffMs);
      }
    }
  }

  const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
  const unknownStudent = isUnknownStudentError(errorMessage);

  if (unknownStudent) {
    appLogger.warn(
      'Delete for order {OrderId} returned HTTP 500 — Entur most likely has no account for student {StudentId}. Not escalating.',
      ordersIdString,
      studentId
    );
  } else {
    appLogger.error(
      'Failed deleting Entur fare contract for order {OrderId}: {ErrorMessage}',
      ordersIdString,
      errorMessage
    );
  }

  await writeAudit('entur_delete_failed', {
    level: unknownStudent ? 'warn' : 'error',
    reason: decision.reason,
    error: errorMessage,
    unknownStudent
  });

  return { outcome: 'failed', error: errorMessage, unknownStudent };
};

/** Just enough of StudentService to re-check eligibility, so tests can stub it trivially. */
export interface StudentOrderLookup {
  getSingleStudent(range: SchoolYearRange, studentId: string): Promise<Array<{ OrdersId: string | number }>>;
}

export type DeferredRevokeResult =
  | { result: 'no_entry' }
  | { result: 'cancelled'; reason: 'order_eligible_again' }
  | { result: 'check_failed'; error: string }
  | { result: 'revoked'; outcome: RevokeOutcome };

/**
 * Stage two of a lost-approval revoke, run once the grace period has elapsed.
 *
 * Approval lives in the database, not the queue — a re-approved order keeps its 'sent' entry — so
 * this re-queries before deleting. That is what makes a transient PrimaryStatus flip harmless: the
 * order is eligible again by the time the timer fires, and no delete happens.
 *
 * A re-approved order needs no repair here. Stage one set endDate to today, and the re-approval is
 * itself an 'updated' change, which the monitor dispatches as a normal send that rewrites endDate
 * back to the order's real value.
 */
export const revokeAfterGracePeriod = async (
  deps: RevokeDeps & { studentService: StudentOrderLookup },
  input: {
    ordersId: string | number;
    schoolYearRange: SchoolYearRange;
    dryRun: boolean;
    audit?: (payload: Record<string, unknown>) => Promise<void>;
    maxAttempts?: number;
    baseDelayMs?: number;
  }
): Promise<DeferredRevokeResult> => {
  const ordersIdString = String(input.ordersId);
  const entry = deps.queueService.getEntry(ordersIdString);

  // Retired or re-queued while we waited — decideRevokeAction would decline anyway.
  if (!entry || entry.status !== 'sent') return { result: 'no_entry' };

  const writeAudit = async (event: string, extra: Record<string, unknown> = {}): Promise<void> => {
    if (!input.audit) return;
    await input.audit({
      timestamp: new Date().toISOString(),
      level: 'info',
      event,
      studentId: entry.studentId,
      orderId: ordersIdString,
      dryRun: input.dryRun === true,
      ...extra
    });
  };

  let selection;
  try {
    const orders = await deps.studentService.getSingleStudent(input.schoolYearRange, entry.studentId);
    selection = selectQueuedOrder(orders, ordersIdString);
  } catch (error: unknown) {
    // A failed query is not evidence that the order became ineligible. Abort and leave the contract
    // alone; the order still has endDate = today from stage one, so travel is already stopped.
    const message = error instanceof Error ? error.message : String(error);
    appLogger.error(
      'Deferred revoke check for order {OrderId} could not read the database; not deleting: {ErrorMessage}',
      ordersIdString,
      message
    );
    await writeAudit('entur_revoke_check_failed', { level: 'error', error: message });
    return { result: 'check_failed', error: message };
  }

  if (decideDeferredRevoke(selection).action === 'cancel') {
    appLogger.info(
      'Order {OrderId} is approved again; deferred delete cancelled.',
      ordersIdString
    );
    await writeAudit('entur_revoke_cancelled_reapproved');
    return { result: 'cancelled', reason: 'order_eligible_again' };
  }

  const outcome = await revokeOrderTravelRight(deps, {
    studentId: entry.studentId,
    ordersId: ordersIdString,
    dryRun: input.dryRun,
    audit: input.audit,
    maxAttempts: input.maxAttempts,
    baseDelayMs: input.baseDelayMs
  });

  return { result: 'revoked', outcome };
};
