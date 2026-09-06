import './env';
import path from 'path';
import { appendFile, mkdir } from 'fs/promises';
import { EnturApiService } from './services/entur-skoleskyss.service';
import { QueueService, QueueEntry } from './services/queue.service';
import { revokeOrderTravelRight, RevokeOutcome } from './services/entur-revoke.service';
import { appLogger, flushLogs } from './services/logger.service';

const AUDIT_LOG_FILE = path.join(process.cwd(), 'logs', 'entur-delete.audit.log');

interface DeleteConfig {
  studentIds: string[];
  orderId?: string;
  dryRun: boolean;
  force: boolean;
}

const USAGE = `
Delete a student's Entur fare contract(s).

A fare contract is keyed on (studentId, applicationId), so each order has its own contract and each
needs its own delete.

Usage:
  npm run delete-entur -- -- --student-id <id> [options]

Options:
  --student-id <id>     Student to revoke. Repeatable.
  --student-ids <list>  Comma-separated student ids.
  --order-id <id>       Revoke only this order. Requires exactly one --student-id.
  --dry-run <bool>      Default true. Pass "false" to actually delete.
  --force               Revoke queue entries that are not marked 'sent'. Use after a queue rebuild
                        has wiped the send history. NOTE: --force cannot invent an order id — if the
                        queue has no entry for the student at all, pair it with --order-id.
  --help, -h            Show this message.

Examples:
  npm run delete-entur -- -- --student-id 91703
  npm run delete-entur -- -- --student-id 91703 --order-id 78411 --dry-run false
  npm run delete-entur -- -- --student-ids 91703,91704 --dry-run false --force
`;

const writeAudit = async (payload: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(AUDIT_LOG_FILE), { recursive: true });
  await appendFile(AUDIT_LOG_FILE, JSON.stringify(payload) + '\n', 'utf8');
};

export const parseDeleteArgs = (args: string[]): DeleteConfig | null => {
  if (args.includes('--help') || args.includes('-h')) return null;

  const config: DeleteConfig = { studentIds: [], dryRun: true, force: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--student-id' && next) {
      config.studentIds.push(next.trim());
      i++;
    } else if (arg === '--student-ids' && next) {
      config.studentIds.push(...next.split(',').map((s) => s.trim()).filter(Boolean));
      i++;
    } else if (arg === '--order-id' && next) {
      config.orderId = next.trim();
      i++;
    } else if (arg === '--dry-run' && next) {
      // Matches the sync CLI: anything but the literal "false" stays a dry run.
      config.dryRun = next !== 'false';
      i++;
    } else if (arg === '--force') {
      config.force = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  config.studentIds = [...new Set(config.studentIds)];

  // An order belongs to exactly one student, so pairing --order-id with several of them describes
  // something that cannot exist. Nothing would be wrongly deleted — the (other student, this order)
  // pair was never posted, so Entur reports it as already gone — but the run would claim to have
  // revoked more than it did. Reject the typo instead of reporting fiction.
  if (config.orderId && config.studentIds.length !== 1) {
    const got = config.studentIds.length
      ? `${config.studentIds.length}: ${config.studentIds.join(', ')}`
      : 'none';
    throw new Error(
      `--order-id requires exactly one --student-id (got ${got}). ` +
        'An order belongs to a single student, so it cannot be revoked for several.'
    );
  }

  return config;
};

/**
 * Work out which orders to revoke.
 *
 * Without --force only orders the queue records as 'sent' are touched: deleting for a student Entur
 * has never seen returns HTTP 500, which is indistinguishable from a real outage.
 */
export const selectOrdersToRevoke = (
  entries: QueueEntry[],
  options: { orderId?: string; force: boolean }
): Array<{ ordersId: string; studentId: string }> => {
  const scoped = options.orderId ? entries.filter((e) => e.ordersId === options.orderId) : entries;
  const eligible = options.force ? scoped : scoped.filter((e) => e.status === 'sent');
  return eligible.map((e) => ({ ordersId: e.ordersId, studentId: e.studentId }));
};

/**
 * Explain what is actually missing when a student has nothing revokable.
 *
 * `--force` only widens *which queue entries* count as revokable — it cannot invent an order id.
 * A delete is addressed by (studentId, applicationId), and the queue is the CLI's only source of
 * order ids, so when there are no entries the caller must name the order with --order-id whether
 * or not --force was given.
 */
export const explainNothingToRevoke = (state: {
  entryCount: number;
  force: boolean;
  hasOrderId: boolean;
}): string => {
  if (state.entryCount === 0) {
    return state.force
      ? 'The queue has no entry for this student, so there is no order id to delete against — add --order-id <id>.'
      : 'The queue has no entry for this student — add --order-id <id> --force to delete an order it has no record of.';
  }
  if (state.hasOrderId) {
    return state.force
      ? 'No queue entry matches that --order-id for this student. Check the id.'
      : 'That --order-id is not marked sent. Add --force to revoke it anyway.';
  }
  return 'No entry is marked sent. Add --force to revoke entries the queue does not consider sent.';
};

const describeOutcome = (outcome: RevokeOutcome): string => {
  switch (outcome.outcome) {
    case 'deleted': return `deleted ${outcome.fareContractId}`;
    case 'already_gone': return 'no contract in Entur (already gone)';
    case 'skipped_never_sent': return 'skipped — no record of it ever being sent';
    case 'dry_run': return 'DRY RUN — would delete';
    case 'failed': return `FAILED — ${outcome.error}`;
  }
};

async function deleteStudentFromEntur(): Promise<number> {
  let config: DeleteConfig | null;
  try {
    config = parseDeleteArgs(process.argv.slice(2));
  } catch (error) {
    appLogger.error('{ErrorMessage}', error instanceof Error ? error.message : String(error));
    console.log(USAGE);
    return 1;
  }

  if (!config) {
    console.log(USAGE);
    return 0;
  }

  if (config.studentIds.length === 0) {
    appLogger.error('No student specified. Pass --student-id or --student-ids.');
    console.log(USAGE);
    return 1;
  }

  const queueService = new QueueService(process.env.SYNC_QUEUE_FILE ?? './queue/sync-queue.json');
  queueService.loadQueue();
  const enturService = new EnturApiService();

  appLogger.info(
    '{Mode}: revoking Entur contracts for {StudentCount} student(s){OrderScope}{Forced}',
    config.dryRun ? 'DRY RUN' : 'LIVE',
    config.studentIds.length,
    config.orderId ? ` (order ${config.orderId} only)` : '',
    config.force ? ' [--force]' : ''
  );

  // 'alreadyGone' is counted apart from 'deleted' on purpose: Entur answers a delete for a contract
  // that is no longer there with a 200, so folding the two together would report a revoke that
  // never happened — on a re-run, or on an order the monitor had already revoked.
  let deleted = 0;
  let alreadyGone = 0;
  let skipped = 0;
  let failed = 0;
  let wouldDelete = 0;

  for (const studentId of config.studentIds) {
    const entries = queueService.getEntriesByStudent(studentId);
    const targets = selectOrdersToRevoke(entries, { orderId: config.orderId, force: config.force });

    if (targets.length === 0) {
      // --force with an explicit order id can still act on an order the queue has never seen.
      if (config.force && config.orderId) {
        targets.push({ ordersId: config.orderId, studentId });
      } else {
        appLogger.warn(
          'Student {StudentId}: nothing to revoke ({EntryCount} queue entry/entries). {Remedy}',
          studentId,
          entries.length,
          explainNothingToRevoke({
            entryCount: entries.length,
            force: config.force,
            hasOrderId: Boolean(config.orderId)
          })
        );
        skipped++;
        continue;
      }
    }

    for (const target of targets) {
      const outcome = await revokeOrderTravelRight(
        { enturService, queueService },
        {
          studentId: target.studentId,
          ordersId: target.ordersId,
          dryRun: config.dryRun,
          force: config.force,
          audit: writeAudit
        }
      );

      appLogger.info(
        'Student {StudentId} order {OrderId}: {Result}',
        target.studentId,
        target.ordersId,
        describeOutcome(outcome)
      );

      if (outcome.outcome === 'deleted') deleted++;
      else if (outcome.outcome === 'already_gone') alreadyGone++;
      else if (outcome.outcome === 'failed') failed++;
      else if (outcome.outcome === 'dry_run') wouldDelete++;
      else skipped++;
    }
  }

  const summary = config.dryRun
    ? [`Would revoke: ${wouldDelete}`, `skipped: ${skipped}`]
    : [
        `Revoked: ${deleted}`,
        `already gone: ${alreadyGone}`,
        `skipped: ${skipped}`,
        `failed: ${failed}`
      ];

  appLogger.info(
    'Done. {Summary}{DryRunNote}',
    summary.join(', '),
    config.dryRun ? ' (dry run — nothing was actually deleted)' : ''
  );

  return failed > 0 ? 1 : 0;
}

// Only run when invoked directly, so the exported helpers stay importable from tests.
if (require.main === module) {
  deleteStudentFromEntur()
    .then(async (code) => {
      await flushLogs();
      process.exit(code);
    })
    .catch(async (error) => {
      appLogger.error(
        'Delete command failed: {ErrorMessage}',
        error instanceof Error ? error.message : String(error)
      );
      await flushLogs();
      process.exit(1);
    });
}
