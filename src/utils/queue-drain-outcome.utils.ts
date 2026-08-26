export interface DrainBatchResult {
  successCount: number;
  failedCount: number;
  errors: string[];
}

export type DrainOutcome =
  | { action: 'mark_sent' }
  | { action: 'mark_failed'; error: string }
  | { action: 'none'; reason: 'dry_run' };

// Decides how a queue entry's status should be updated after its batch was processed.
// A dry run never touches queue state: processSingleBatch reports every valid request as a
// success without calling Entur, so marking the entry 'sent' would retire a student who was
// never actually sent (and addEntry refuses to re-queue a 'sent' order).
export const decideDrainOutcome = (batchResult: DrainBatchResult, dryRun: boolean): DrainOutcome => {
  if (dryRun) return { action: 'none', reason: 'dry_run' };

  if (batchResult.failedCount === 0 && batchResult.successCount > 0) {
    return { action: 'mark_sent' };
  }

  return {
    action: 'mark_failed',
    error: batchResult.errors[0] ?? 'processSingleBatch reported failure'
  };
};
