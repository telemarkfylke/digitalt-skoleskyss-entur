import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  revokeOrderTravelRight,
  revokeAfterGracePeriod,
  StudentOrderLookup,
} from '../../src/services/entur-revoke.service';
import { getSchoolYearRange, calculateSchoolYear } from '../../src/utils/school-year.utils';
import { EnturApiService } from '../../src/services/entur-skoleskyss.service';
import { QueueService } from '../../src/services/queue.service';

let tempDir: string;
let counter = 0;

before(() => {
  process.env.ENTUR_AUDIENCE = 'https://entur.io';
  process.env.ENTUR_CLIENT_ID = 'test-client-id';
  process.env.ENTUR_CLIENT_SECRET = 'test-secret';
  process.env.ENTUR_TOKEN_URL = 'https://entur.io/oauth/token';
  process.env.ENTUR_API_URL = 'https://entur.io';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revoke-test-'));
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const queuePath = () => path.join(tempDir, `queue-${counter++}.json`);

// A queue with one entry for order 78411 / student 91703, in the given status.
const makeQueue = (status: 'pending' | 'sent' | 'failed' | 'skipped'): QueueService => {
  const service = new QueueService(queuePath());
  service.loadQueue();
  service.addEntry({ ordersId: '78411', studentId: '91703', startDate: '2026-08-15' });
  if (status === 'sent') service.markSent('78411');
  if (status === 'skipped') service.markSkipped('78411', 'test');
  if (status === 'failed') {
    for (let i = 0; i < 3; i++) service.markFailed('78411', 'test');
  }
  return service;
};

// Records every deleteSkoleskyss call and returns a canned response, via the same private-field
// injection the entur-skoleskyss tests use.
const stubEntur = (response: any, opts: { throws?: Error } = {}) => {
  const service = new EnturApiService();
  const calls: any[] = [];
  (service as any).authClient = {
    apiRequest: async (endpoint: string, options: any) => {
      calls.push({ endpoint, options });
      if (opts.throws) throw opts.throws;
      return response;
    },
  };
  return { service, calls };
};

const audits: Array<Record<string, unknown>> = [];
const audit = async (payload: Record<string, unknown>) => {
  audits.push(payload);
};
const auditEvents = () => audits.map((a) => a.event);

beforeEach(() => {
  audits.length = 0;
});

describe('revokeOrderTravelRight — the never-sent gate', () => {
  test('makes no API call when the queue has no sent record', async () => {
    const queue = makeQueue('pending');
    const { service, calls } = stubEntur({ customerAccountId: 'ACC:1' });

    const outcome = await revokeOrderTravelRight(
      { enturService: service, queueService: queue },
      { studentId: '91703', ordersId: '78411', dryRun: false, audit }
    );

    assert.deepEqual(outcome, { outcome: 'skipped_never_sent' });
    assert.equal(calls.length, 0, 'no request should reach Entur');
    assert.deepEqual(auditEvents(), ['entur_delete_skipped_never_sent']);
  });

  test('force overrides the gate', async () => {
    const queue = makeQueue('pending');
    const { service, calls } = stubEntur({ customerAccountId: 'ACC:1', fareContractId: 'FC:1' });

    const outcome = await revokeOrderTravelRight(
      { enturService: service, queueService: queue },
      { studentId: '91703', ordersId: '78411', dryRun: false, force: true, audit }
    );

    assert.equal(outcome.outcome, 'deleted');
    assert.equal(calls.length, 1);
  });
});

describe('revokeOrderTravelRight — dry run', () => {
  test('logs the intent but never calls Entur', async () => {
    const queue = makeQueue('sent');
    const { service, calls } = stubEntur({ customerAccountId: 'ACC:1', fareContractId: 'FC:1' });

    const outcome = await revokeOrderTravelRight(
      { enturService: service, queueService: queue },
      { studentId: '91703', ordersId: '78411', dryRun: true, audit }
    );

    assert.deepEqual(outcome, { outcome: 'dry_run', wouldDelete: true });
    assert.equal(calls.length, 0, 'dry run must not reach Entur');
    // The queue must be left alone too, or a dry run would silently change state.
    assert.equal(queue.getEntry('78411')?.status, 'sent');
  });
});

describe('revokeOrderTravelRight — deleting', () => {
  test('sends the order id as applicationId, on the collection path', async () => {
    const queue = makeQueue('sent');
    const { service, calls } = stubEntur({ customerAccountId: 'ACC:1', fareContractId: 'FC:1' });

    await revokeOrderTravelRight(
      { enturService: service, queueService: queue },
      { studentId: '91703', ordersId: '78411', dryRun: false, audit }
    );

    assert.equal(calls[0].endpoint, '/skoleskyss');
    assert.equal(calls[0].options.method, 'DELETE');
    // Contracts are keyed on (studentId, applicationId) — the order's own id must be the
    // applicationId, or the delete would target a different contract.
    assert.deepEqual(calls[0].options.body, { studentId: '91703', applicationId: '78411' });
  });

  test('reports the removed fare contract and retires the queue entry', async () => {
    const queue = makeQueue('sent');
    const { service } = stubEntur({
      customerAccountId: 'ACC:1',
      fareContractId: 'FC:1',
      fareContractIds: ['FC:1'],
    });

    const outcome = await revokeOrderTravelRight(
      { enturService: service, queueService: queue },
      { studentId: '91703', ordersId: '78411', dryRun: false, audit }
    );

    assert.deepEqual(outcome, {
      outcome: 'deleted',
      fareContractId: 'FC:1',
      customerAccountId: 'ACC:1',
    });
    // 'skipped' is terminal but re-queueable, so a later re-approval comes back cleanly.
    assert.equal(queue.getEntry('78411')?.status, 'skipped');
    assert.deepEqual(auditEvents(), ['entur_delete_attempted', 'entur_deleted']);
  });

  // Verified against staging: deleting an already-deleted contract is a 200 with an empty
  // fareContractIds, not an error. That is a no-op, and must not be reported as a deletion.
  test('an empty fareContractIds is recorded as already_gone, not as a delete', async () => {
    const queue = makeQueue('sent');
    const { service } = stubEntur({ customerAccountId: 'ACC:1', fareContractIds: [] });

    const outcome = await revokeOrderTravelRight(
      { enturService: service, queueService: queue },
      { studentId: '91703', ordersId: '78411', dryRun: false, audit }
    );

    assert.deepEqual(outcome, { outcome: 'already_gone' });
    assert.equal(queue.getEntry('78411')?.status, 'skipped');
    assert.deepEqual(auditEvents(), ['entur_delete_attempted', 'entur_delete_noop_already_gone']);
  });
});

describe('revokeOrderTravelRight — failures', () => {
  test('retries, then reports failure and leaves the queue entry sent', async () => {
    const queue = makeQueue('sent');
    const { service, calls } = stubEntur(null, { throws: new Error('HTTP 503: Service Unavailable') });

    const outcome = await revokeOrderTravelRight(
      { enturService: service, queueService: queue },
      { studentId: '91703', ordersId: '78411', dryRun: false, audit, maxAttempts: 3, baseDelayMs: 1 }
    );

    assert.equal(outcome.outcome, 'failed');
    assert.equal(calls.length, 3, 'should exhaust its retries');
    // The contract may still exist, so the entry must not be retired on a failure.
    assert.equal(queue.getEntry('78411')?.status, 'sent');
    if (outcome.outcome === 'failed') assert.equal(outcome.unknownStudent, false);
  });

  // Entur answers a delete for an unknown student with 500, not 404. It is flagged so callers can
  // keep it out of the critical alerting path — the likeliest cause is a queue that lost its
  // 'sent' markers, not an outage.
  test('flags an HTTP 500 as a probably-unknown student', async () => {
    const queue = makeQueue('sent');
    const { service } = stubEntur(null, {
      throws: new Error('HTTP 500: Internal Server Error - {"error":"Internal"}'),
    });

    const outcome = await revokeOrderTravelRight(
      { enturService: service, queueService: queue },
      { studentId: '91703', ordersId: '78411', dryRun: false, audit, maxAttempts: 1, baseDelayMs: 1 }
    );

    assert.equal(outcome.outcome, 'failed');
    if (outcome.outcome === 'failed') assert.equal(outcome.unknownStudent, true);
    assert.deepEqual(auditEvents(), ['entur_delete_attempted', 'entur_delete_failed']);
  });

  test('succeeds on a retry after a transient failure', async () => {
    const queue = makeQueue('sent');
    const service = new EnturApiService();
    let attempts = 0;
    (service as any).authClient = {
      apiRequest: async () => {
        attempts++;
        if (attempts === 1) throw new Error('HTTP 503: Service Unavailable');
        return { customerAccountId: 'ACC:1', fareContractId: 'FC:1' };
      },
    };

    const outcome = await revokeOrderTravelRight(
      { enturService: service, queueService: queue },
      { studentId: '91703', ordersId: '78411', dryRun: false, audit, maxAttempts: 3, baseDelayMs: 1 }
    );

    assert.equal(outcome.outcome, 'deleted');
    assert.equal(attempts, 2);
  });
});

const RANGE = getSchoolYearRange(calculateSchoolYear());

// Stands in for StudentService.getSingleStudent, which returns only orders that are still eligible
// (PrimaryStatus = 2, not overridden). An empty array therefore means "no longer approved".
const stubLookup = (orders: Array<{ OrdersId: string }>, throws?: Error): StudentOrderLookup => ({
  getSingleStudent: async () => {
    if (throws) throw throws;
    return orders;
  },
});

describe('revokeAfterGracePeriod — the transient-flip guard', () => {
  // The regression this whole grace period exists for. A re-approved order keeps its 'sent' queue
  // entry, so checking the queue alone would delete a valid contract. Only a fresh DB read can
  // tell the difference.
  test('does not delete when the order is approved again by the time the timer fires', async () => {
    const queue = makeQueue('sent');
    const { service, calls } = stubEntur({ customerAccountId: 'ACC:1', fareContractId: 'FC:1' });

    const result = await revokeAfterGracePeriod(
      { enturService: service, queueService: queue, studentService: stubLookup([{ OrdersId: '78411' }]) },
      { ordersId: '78411', schoolYearRange: RANGE, dryRun: false, audit }
    );

    assert.deepEqual(result, { result: 'cancelled', reason: 'order_eligible_again' });
    assert.equal(calls.length, 0, 'a re-approved order must not be deleted');
    assert.equal(queue.getEntry('78411')?.status, 'sent', 'queue state must be left alone');
    assert.deepEqual(auditEvents(), ['entur_revoke_cancelled_reapproved']);
  });

  test('deletes when the order is still not eligible', async () => {
    const queue = makeQueue('sent');
    const { service, calls } = stubEntur({ customerAccountId: 'ACC:1', fareContractId: 'FC:1' });

    const result = await revokeAfterGracePeriod(
      { enturService: service, queueService: queue, studentService: stubLookup([]) },
      { ordersId: '78411', schoolYearRange: RANGE, dryRun: false, audit }
    );

    assert.equal(result.result, 'revoked');
    assert.equal(calls.length, 1);
    assert.equal(queue.getEntry('78411')?.status, 'skipped');
  });

  // A sibling order surviving does not save this one: contracts are per-order, so an order that is
  // itself gone from the eligible set must still be revoked.
  test('deletes when only a sibling order remains eligible', async () => {
    const queue = makeQueue('sent');
    const { service, calls } = stubEntur({ customerAccountId: 'ACC:1', fareContractId: 'FC:1' });

    const result = await revokeAfterGracePeriod(
      { enturService: service, queueService: queue, studentService: stubLookup([{ OrdersId: '78412' }]) },
      { ordersId: '78411', schoolYearRange: RANGE, dryRun: false, audit }
    );

    assert.equal(result.result, 'revoked');
    assert.equal(calls.length, 1);
  });

  // A database outage must never be read as "no longer eligible" — that would delete valid cards
  // for every pending check at once.
  test('a failed lookup aborts without deleting', async () => {
    const queue = makeQueue('sent');
    const { service, calls } = stubEntur({ customerAccountId: 'ACC:1', fareContractId: 'FC:1' });

    const result = await revokeAfterGracePeriod(
      {
        enturService: service,
        queueService: queue,
        studentService: stubLookup([], new Error('ECONNRESET')),
      },
      { ordersId: '78411', schoolYearRange: RANGE, dryRun: false, audit }
    );

    assert.deepEqual(result, { result: 'check_failed', error: 'ECONNRESET' });
    assert.equal(calls.length, 0, 'a DB failure must not delete anything');
    assert.equal(queue.getEntry('78411')?.status, 'sent');
    assert.deepEqual(auditEvents(), ['entur_revoke_check_failed']);
  });

  test('does nothing when the entry is no longer sent', async () => {
    const queue = makeQueue('skipped');
    const { service, calls } = stubEntur({ customerAccountId: 'ACC:1' });
    let lookedUp = false;

    const result = await revokeAfterGracePeriod(
      {
        enturService: service,
        queueService: queue,
        studentService: {
          getSingleStudent: async () => {
            lookedUp = true;
            return [];
          },
        },
      },
      { ordersId: '78411', schoolYearRange: RANGE, dryRun: false, audit }
    );

    assert.deepEqual(result, { result: 'no_entry' });
    assert.equal(calls.length, 0);
    assert.equal(lookedUp, false, 'should not even query the DB');
  });

  test('respects dry run', async () => {
    const queue = makeQueue('sent');
    const { service, calls } = stubEntur({ customerAccountId: 'ACC:1', fareContractId: 'FC:1' });

    const result = await revokeAfterGracePeriod(
      { enturService: service, queueService: queue, studentService: stubLookup([]) },
      { ordersId: '78411', schoolYearRange: RANGE, dryRun: true, audit }
    );

    assert.equal(result.result, 'revoked');
    if (result.result === 'revoked') assert.equal(result.outcome.outcome, 'dry_run');
    assert.equal(calls.length, 0);
    assert.equal(queue.getEntry('78411')?.status, 'sent');
  });
});
