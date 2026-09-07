import './env';
import path from 'path';
import fs from 'fs';
import { appendFile, mkdir } from 'fs/promises';
import { EnturApiService } from './services/entur-skoleskyss.service';
import { QueueService, QueueEntry } from './services/queue.service';
import { StudentService } from './services/student.service';
import { DatabaseService } from './services/database.service';
import { revokeOrderTravelRight, RevokeOutcome } from './services/entur-revoke.service';
import { resolveOrderOwners, summariseOwners } from './utils/order-owner-resolution.utils';
import { appLogger, flushLogs } from './services/logger.service';

const AUDIT_LOG_FILE = path.join(process.cwd(), 'logs', 'entur-delete.audit.log');

interface DeleteConfig {
  studentIds: string[];
  orderIds: string[];
  dryRun: boolean;
  force: boolean;
}

const USAGE = `
Delete a student's Entur fare contract(s).

A fare contract is keyed on (studentId, applicationId), so each order has its own contract and each
needs its own delete.

Two ways to drive it: by student (revokes their queued orders) or by order id (looks the owner up).

Usage:
  npm run delete-entur -- -- --order-ids <ids> [options]
  npm run delete-entur -- -- --student-id <id> [options]

Options:
  --order-ids <ids>        Orders to revoke. Commas and/or spaces both work, so a list pasted from
                           SQL output is fine. Owners are resolved from the queue, then dbo.Orders.
  --order-ids-file <path>  Same, read from a file (one per line or comma-separated).
  --order-id <id>          A single order. Repeatable.
  --student-id <id>        Student to revoke. Repeatable. With --order-ids, at most one may be
                           given, and it is checked against each order's real owner.
  --student-ids <list>     Comma- and/or space-separated student ids.
  --dry-run <bool>         Default true. Pass "false" to actually delete.
  --force                  Revoke orders with no 'sent' record in the queue. Required whenever an
                           owner had to be resolved from the database.
  --help, -h               Show this message.

Nothing is deleted unless every id resolves and every check passes — the batch runs whole or not
at all. Check the "Resolved N of M order id(s)" line before arming a run.

Examples:
  npm run delete-entur -- -- --order-ids 80409, 80565, 80188
  npm run delete-entur -- -- --order-ids-file ./orders.txt --dry-run false --force
  npm run delete-entur -- -- --student-id 91703
  npm run delete-entur -- -- --student-id 91703 --order-id 78411 --dry-run false --force
`;

const writeAudit = async (payload: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(AUDIT_LOG_FILE), { recursive: true });
  await appendFile(AUDIT_LOG_FILE, JSON.stringify(payload) + '\n', 'utf8');
};

const splitIdList = (raw: string): string[] =>
  raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

export const parseDeleteArgs = (args: string[]): DeleteConfig | null => {
  if (args.includes('--help') || args.includes('-h')) return null;

  const config: DeleteConfig = { studentIds: [], orderIds: [], dryRun: true, force: false };

  // Consume every following argument up to the next flag, so a list pasted with spaces after the
  // commas survives the shell splitting it into separate argv entries. Without this, only the first
  // id would be read and the rest silently ignored — which would delete one order out of 58 and
  // report success. Greedy consumption is safe here: this CLI has no positional arguments.
  const takeValues = (startIndex: number): { values: string[]; nextIndex: number } => {
    const values: string[] = [];
    let index = startIndex;
    while (index < args.length && !args[index].startsWith('--')) {
      values.push(...splitIdList(args[index]));
      index++;
    }
    return { values, nextIndex: index - 1 };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--student-id' && next) {
      config.studentIds.push(next.trim());
      i++;
    } else if (arg === '--student-ids' && next) {
      const { values, nextIndex } = takeValues(i + 1);
      config.studentIds.push(...values);
      i = nextIndex;
    } else if (arg === '--order-id' && next) {
      config.orderIds.push(next.trim().replace(/,$/, ''));
      i++;
    } else if (arg === '--order-ids' && next) {
      const { values, nextIndex } = takeValues(i + 1);
      config.orderIds.push(...values);
      i = nextIndex;
    } else if (arg === '--order-ids-file' && next) {
      // A one-id-per-line SQL export and a comma list both work — splitIdList handles either.
      config.orderIds.push(...splitIdList(fs.readFileSync(next.trim(), 'utf8')));
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
  config.orderIds = [...new Set(config.orderIds)];

  // dbo.Orders.Id is an integer, so a non-numeric id is always a typo. This is also the backstop
  // that catches a stray token the list-splitting did not clean up, rather than passing it to SQL.
  const nonNumeric = config.orderIds.filter((id) => !/^\d+$/.test(id));
  if (nonNumeric.length > 0) {
    throw new Error(
      `Order ids must be numeric — got: ${nonNumeric.join(', ')}. ` +
        'Check for stray characters in the list.'
    );
  }

  // An order belongs to exactly one student, so pairing order ids with several students describes
  // something that cannot exist. Zero students is fine — the owner is looked up. One is fine, and
  // is verified against the resolved owner before anything is deleted.
  if (config.orderIds.length > 0 && config.studentIds.length > 1) {
    throw new Error(
      `--order-id/--order-ids cannot be combined with ${config.studentIds.length} students ` +
        `(${config.studentIds.join(', ')}). An order belongs to a single student. ` +
        'Omit --student-id to look the owners up automatically.'
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
  options: { orderIds?: string[]; force: boolean }
): Array<{ ordersId: string; studentId: string }> => {
  const wanted = options.orderIds?.length ? new Set(options.orderIds) : undefined;
  const scoped = wanted ? entries.filter((e) => wanted.has(e.ordersId)) : entries;
  const eligible = options.force ? scoped : scoped.filter((e) => e.status === 'sent');
  return eligible.map((e) => ({ ordersId: e.ordersId, studentId: e.studentId }));
};

/**
 * Explain what is actually missing when a student has nothing revokable.
 *
 * `--force` only widens *which queue entries* count as revokable — it cannot invent an order id,
 * because a delete is addressed by (studentId, applicationId). With no queue entry there is nothing
 * to derive an order id from, so the way forward is to name the orders directly with --order-ids,
 * which resolves owners from the database instead.
 */
export const explainNothingToRevoke = (state: { entryCount: number; force: boolean }): string => {
  if (state.entryCount === 0) {
    return 'The queue has no entry for this student. If you know the order id(s), use --order-ids <ids> instead — that resolves the owner from the database.';
  }
  if (!state.force) {
    return 'No entry is marked sent. Add --force to revoke entries the queue does not consider sent.';
  }
  return 'No queue entries are revokable for this student.';
};

/**
 * Turn a list of order ids into (studentId, ordersId) delete targets, or abort.
 *
 * Resolution is queue-first, then dbo.Orders. Everything is resolved and checked up front: with a
 * batch this size a half-done run is far worse than none, so any problem returns null and nothing
 * is deleted.
 */
const resolveOrderTargets = async (
  config: DeleteConfig,
  queueService: QueueService,
  studentService: StudentService
): Promise<Array<{ ordersId: string; studentId: string }> | null> => {
  const queueOwner = (ordersId: string) => queueService.getEntry(ordersId)?.studentId;

  const dbOwner = new Map<string, string>();
  const missingFromQueue = config.orderIds.filter((id) => !queueOwner(id));
  if (missingFromQueue.length > 0) {
    for (const row of await studentService.getOrderOwners(missingFromQueue)) {
      dbOwner.set(String(row.OrdersId), String(row.StudentId));
    }
  }

  const summary = summariseOwners(resolveOrderOwners(config.orderIds, { queueOwner, dbOwner }));

  // Echo the counts back before doing anything. A list pasted from SQL output is easy to truncate,
  // and this line is the cheapest way for the operator to catch that before arming the run.
  appLogger.info(
    'Resolved {ResolvedCount} of {TotalCount} order id(s) — {FromQueue} from queue, {FromDatabase} from database',
    summary.resolved.length,
    summary.total,
    summary.fromQueue,
    summary.fromDatabase
  );

  if (summary.unresolved.length > 0) {
    appLogger.error(
      'Could not resolve {Count} order id(s) to a student. Nothing was deleted. Unresolved: {Ids}',
      summary.unresolved.length,
      summary.unresolved.join(', ')
    );
    return null;
  }

  // A single --student-id acts as an assertion about ownership, so a mismatch is a typo worth
  // stopping for — otherwise a mistyped id would revoke a different pupil's contract.
  if (config.studentIds.length === 1) {
    const expected = config.studentIds[0];
    const mismatched = summary.resolved.filter((owner) => owner.studentId !== expected);
    if (mismatched.length > 0) {
      appLogger.error(
        'These order(s) do not belong to student {StudentId}. Nothing was deleted: {Details}',
        expected,
        mismatched.map((owner) => `${owner.ordersId} belongs to ${owner.studentId}`).join(', ')
      );
      return null;
    }
  }

  // Without --force the never-sent gate would decline every order that has no 'sent' queue entry —
  // which is all of them when resolution came from the database. Say so instead of running and
  // reporting a wall of skips that reads like success.
  if (!config.force) {
    const notSent = summary.resolved.filter(
      (owner) => queueService.getEntry(owner.ordersId)?.status !== 'sent'
    );
    if (notSent.length > 0) {
      appLogger.error(
        '{Count} of {Total} order(s) have no "sent" record in the queue and would all be skipped. Add --force to revoke them anyway. Nothing was deleted.',
        notSent.length,
        summary.total
      );
      return null;
    }
  }

  return summary.resolved.map((owner) => ({ ordersId: owner.ordersId, studentId: owner.studentId }));
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

  if (config.studentIds.length === 0 && config.orderIds.length === 0) {
    appLogger.error(
      'Nothing specified. Pass --student-id/--student-ids, or --order-ids/--order-ids-file.'
    );
    console.log(USAGE);
    return 1;
  }

  const queueService = new QueueService(process.env.SYNC_QUEUE_FILE ?? './queue/sync-queue.json');
  queueService.loadQueue();
  const enturService = new EnturApiService();
  const dbService = new DatabaseService();
  const studentService = new StudentService(dbService);

  appLogger.info(
    '{Mode}: revoking Entur contracts — {Scope}{Forced}',
    config.dryRun ? 'DRY RUN' : 'LIVE',
    config.orderIds.length
      ? `${config.orderIds.length} order id(s)`
      : `${config.studentIds.length} student(s)`,
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

  const targets: Array<{ ordersId: string; studentId: string }> = [];
  try {
    if (config.orderIds.length > 0) {
      const resolved = await resolveOrderTargets(config, queueService, studentService);
      if (!resolved) return 1;
      targets.push(...resolved);
    } else {
      for (const studentId of config.studentIds) {
        const entries = queueService.getEntriesByStudent(studentId);
        const found = selectOrdersToRevoke(entries, { force: config.force });
        if (found.length === 0) {
          appLogger.warn(
            'Student {StudentId}: nothing to revoke ({EntryCount} queue entry/entries). {Remedy}',
            studentId,
            entries.length,
            explainNothingToRevoke({ entryCount: entries.length, force: config.force })
          );
          skipped++;
          continue;
        }
        targets.push(...found);
      }
    }
  } finally {
    // Only the order-id path connects, and disconnect is safe either way.
    await dbService.disconnect();
  }

  // Sequential on purpose: a batch of dozens of concurrent deletes would hammer Entur, and the
  // monitor's removal path is sequential for the same reason. Individual failures do not stop the
  // run — the batch was already validated as a whole before any of it executed.
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

/**
 * Finish with the given exit code without calling process.exit().
 *
 * Forcing an exit here raced libuv tearing down its handles and aborted the process on Windows
 * ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"), reporting 0xC0000409 instead of the
 * intended code — so a script could not tell a refused run from a clean one. Setting exitCode and
 * letting the event loop drain avoids the race. The unref'd fallback only matters if something
 * (the remote log shipper, typically) keeps the loop alive: it does not hold the process open
 * itself, but it will fire if anything else does.
 */
const finishWithCode = async (code: number): Promise<void> => {
  await flushLogs();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
};

// Only run when invoked directly, so the exported helpers stay importable from tests.
if (require.main === module) {
  deleteStudentFromEntur()
    .then((code) => finishWithCode(code))
    .catch((error) => {
      appLogger.error(
        'Delete command failed: {ErrorMessage}',
        error instanceof Error ? error.message : String(error)
      );
      return finishWithCode(1);
    });
}
