import { appLogger } from './logger.service';

export const DEFAULT_REVOKE_GRACE_MINUTES = 15;

export const getRevokeGraceMs = (): number => {
  const raw = process.env.ENTUR_REVOKE_GRACE_MINUTES;
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  const minutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_REVOKE_GRACE_MINUTES;
  return minutes * 60 * 1000;
};

/**
 * Holds a delete back for a grace period after an order loses approval.
 *
 * Stage one of a revoke (re-POST with endDate = today) has already happened by the time anything is
 * scheduled here, so travel is stopped immediately either way. This only defers the destructive
 * half, so that a transient PrimaryStatus flip does not delete and recreate a pupil's contract.
 *
 * The check is self-correcting and needs no cancellation path: when the timer fires it re-reads
 * current state, so an order that was re-approved in the meantime simply is not deleted.
 *
 * State is in-memory only. A monitor restart drops pending checks, leaving the order with
 * endDate = today and no delete — which is exactly the behaviour that existed before deletion was
 * wired up, and the safe direction to fail in.
 */
export class DeferredRevokeScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly graceMs: number = getRevokeGraceMs(),
    private readonly onFire: (ordersId: string) => Promise<void> = async () => {}
  ) {}

  /**
   * Schedule a delete re-check for an order. Repeat signals for the same order do not stack —
   * the first deadline stands, so a chattering status cannot postpone the check indefinitely.
   */
  public schedule(ordersId: string | number): boolean {
    const key = String(ordersId);
    if (this.timers.has(key)) return false;

    const timer = setTimeout(async () => {
      this.timers.delete(key);
      try {
        await this.onFire(key);
      } catch (error: unknown) {
        appLogger.error(
          'Deferred revoke check failed for order {OrderId}: {ErrorMessage}',
          key,
          error instanceof Error ? error.message : String(error)
        );
      }
    }, this.graceMs);

    // Do not hold the process open purely for a pending revoke check.
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(key, timer);
    return true;
  }

  public pendingCount(): number {
    return this.timers.size;
  }

  public isPending(ordersId: string | number): boolean {
    return this.timers.has(String(ordersId));
  }

  public cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
