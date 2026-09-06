import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeferredRevokeScheduler,
  DEFAULT_REVOKE_GRACE_MINUTES,
  getRevokeGraceMs,
} from '../../src/services/deferred-revoke.service';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  delete process.env.ENTUR_REVOKE_GRACE_MINUTES;
});

describe('getRevokeGraceMs', () => {
  test('defaults to 15 minutes when unset', () => {
    delete process.env.ENTUR_REVOKE_GRACE_MINUTES;
    assert.equal(getRevokeGraceMs(), DEFAULT_REVOKE_GRACE_MINUTES * 60 * 1000);
  });

  test('reads a configured value', () => {
    process.env.ENTUR_REVOKE_GRACE_MINUTES = '5';
    assert.equal(getRevokeGraceMs(), 5 * 60 * 1000);
  });

  test('allows 0 for an immediate re-check', () => {
    process.env.ENTUR_REVOKE_GRACE_MINUTES = '0';
    assert.equal(getRevokeGraceMs(), 0);
  });

  // A typo must not silently disable the grace period, which is the whole protection against
  // deleting on a transient status flip.
  test('falls back to the default on unparseable or negative values', () => {
    for (const bad of ['abc', '', '-5']) {
      process.env.ENTUR_REVOKE_GRACE_MINUTES = bad;
      assert.equal(getRevokeGraceMs(), DEFAULT_REVOKE_GRACE_MINUTES * 60 * 1000, `input: "${bad}"`);
    }
  });
});

describe('DeferredRevokeScheduler', () => {
  test('fires the callback once the grace period elapses', async () => {
    const fired: string[] = [];
    const scheduler = new DeferredRevokeScheduler(5, async (id) => {
      fired.push(id);
    });

    assert.equal(scheduler.schedule('78411'), true);
    assert.equal(scheduler.isPending('78411'), true);
    assert.deepEqual(fired, [], 'must not fire immediately');

    await tick(30);
    assert.deepEqual(fired, ['78411']);
    assert.equal(scheduler.isPending('78411'), false, 'the timer should be cleared after firing');
  });

  // A chattering PrimaryStatus must not be able to postpone the check indefinitely, so a repeat
  // signal keeps the original deadline instead of restarting it.
  test('a repeat signal for the same order does not stack or postpone', async () => {
    const fired: string[] = [];
    const scheduler = new DeferredRevokeScheduler(20, async (id) => {
      fired.push(id);
    });

    assert.equal(scheduler.schedule('78411'), true);
    await tick(10);
    assert.equal(scheduler.schedule('78411'), false, 'second schedule should be a no-op');
    assert.equal(scheduler.pendingCount(), 1);

    await tick(40);
    assert.deepEqual(fired, ['78411'], 'should fire exactly once');
  });

  test('tracks separate orders independently', async () => {
    const fired: string[] = [];
    const scheduler = new DeferredRevokeScheduler(5, async (id) => {
      fired.push(id);
    });

    scheduler.schedule('78411');
    scheduler.schedule('78412');
    assert.equal(scheduler.pendingCount(), 2);

    await tick(30);
    assert.deepEqual(fired.sort(), ['78411', '78412']);
  });

  test('cancelAll stops pending checks from firing', async () => {
    const fired: string[] = [];
    const scheduler = new DeferredRevokeScheduler(20, async (id) => {
      fired.push(id);
    });

    scheduler.schedule('78411');
    scheduler.cancelAll();
    assert.equal(scheduler.pendingCount(), 0);

    await tick(40);
    assert.deepEqual(fired, [], 'a cancelled check must not fire');
  });

  // The scheduler runs inside a long-lived monitor; one failing check must not take it down.
  test('a throwing callback is contained and clears its timer', async () => {
    const scheduler = new DeferredRevokeScheduler(5, async () => {
      throw new Error('boom');
    });

    scheduler.schedule('78411');
    await tick(30);

    assert.equal(scheduler.isPending('78411'), false);
    assert.equal(scheduler.pendingCount(), 0);
  });
});
