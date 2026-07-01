import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { QueueService } from '../../src/services/queue.service';
import { StudentWithDetails } from '../../src/types/user.types';

let testDir: string;

before(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-'));
});

after(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

const queuePath = () => path.join(testDir, `queue-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

const makeStudent = (overrides: Partial<StudentWithDetails> = {}): StudentWithDetails => ({
  StudentId: 1,
  OrdersId: 100,
  StartDate: new Date('2025-08-15'),
  EndDate: new Date('2026-06-15'),
  StudentName: 'Ola',
  StudentMiddleName: '',
  StudentLastName: 'Nordmann',
  SchoolGradeId: '1',
  SchoolName: 'Telemark VGS',
  SchoolId: 'school-1',
  SchoolClassName: '1A',
  SchoolClassId: 'class-1',
  EmailAddress: 'ola@test.no',
  PhoneNumber: '90000000',
  ...overrides,
});

describe('QueueService.buildQueue', () => {
  test('creates a queue file with all entries as pending', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([makeStudent()]);
    const stats = service.getStats();
    assert.equal(stats.total, 1);
    assert.equal(stats.pending, 1);
  });

  test('sorts entries by StartDate ASC', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([
      makeStudent({ OrdersId: 1, StartDate: new Date('2025-09-01') }),
      makeStudent({ OrdersId: 2, StartDate: new Date('2025-08-01') }),
      makeStudent({ OrdersId: 3, StartDate: new Date('2025-10-01') }),
    ]);
    const batch = service.getNextBatch(0);
    assert.equal(batch[0].startDate, '2025-08-01');
    assert.equal(batch[1].startDate, '2025-09-01');
    assert.equal(batch[2].startDate, '2025-10-01');
  });

  test('breaks ties by OrdersId ASC', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([
      makeStudent({ OrdersId: 30, StartDate: new Date('2025-08-15') }),
      makeStudent({ OrdersId: 10, StartDate: new Date('2025-08-15') }),
      makeStudent({ OrdersId: 20, StartDate: new Date('2025-08-15') }),
    ]);
    const batch = service.getNextBatch(0);
    assert.equal(batch[0].ordersId, '10');
    assert.equal(batch[1].ordersId, '20');
    assert.equal(batch[2].ordersId, '30');
  });

  test('rebuilding replaces existing entries', () => {
    const p = queuePath();
    const service = new QueueService(p);
    service.buildQueue([makeStudent({ OrdersId: 1 }), makeStudent({ OrdersId: 2 })]);
    service.buildQueue([makeStudent({ OrdersId: 99 })]);
    const stats = service.getStats();
    assert.equal(stats.total, 1);
    assert.equal(service.getNextBatch(0)[0].ordersId, '99');
  });
});

describe('QueueService.getNextBatch', () => {
  test('returns first N pending entries when limit > 0', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([
      makeStudent({ OrdersId: 1 }),
      makeStudent({ OrdersId: 2 }),
      makeStudent({ OrdersId: 3 }),
      makeStudent({ OrdersId: 4 }),
    ]);
    const batch = service.getNextBatch(2);
    assert.equal(batch.length, 2);
  });

  test('returns all pending entries when limit = 0', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([
      makeStudent({ OrdersId: 1 }),
      makeStudent({ OrdersId: 2 }),
      makeStudent({ OrdersId: 3 }),
    ]);
    const batch = service.getNextBatch(0);
    assert.equal(batch.length, 3);
  });

  test('excludes already sent or failed entries', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([
      makeStudent({ OrdersId: 1 }),
      makeStudent({ OrdersId: 2 }),
      makeStudent({ OrdersId: 3 }),
    ]);
    service.markSent('1');
    service.markFailed('2', 'test error');
    service.markFailed('2', 'test error');
    service.markFailed('2', 'test error'); // reaches maxRetries=3, becomes failed
    const batch = service.getNextBatch(0);
    assert.equal(batch.length, 1);
    assert.equal(batch[0].ordersId, '3');
  });
});

describe('QueueService.markSent', () => {
  test('sets status to sent and records processedAt', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([makeStudent({ OrdersId: 1 })]);
    service.markSent('1');
    const stats = service.getStats();
    assert.equal(stats.sent, 1);
    assert.equal(stats.pending, 0);
  });

  test('does not throw for unknown ordersId', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([makeStudent({ OrdersId: 1 })]);
    assert.doesNotThrow(() => service.markSent('999'));
  });
});

describe('QueueService.markFailed', () => {
  test('keeps status as pending when below maxRetries', () => {
    const service = new QueueService(queuePath(), 3);
    service.buildQueue([makeStudent({ OrdersId: 1 })]);
    service.markFailed('1', 'first error');
    const batch = service.getNextBatch(0);
    assert.equal(batch.length, 1);
    assert.equal(batch[0].status, 'pending');
    assert.equal(batch[0].retryCount, 1);
    assert.equal(batch[0].errorMessage, 'first error');
  });

  test('sets status to failed after reaching maxRetries', () => {
    const service = new QueueService(queuePath(), 3);
    service.buildQueue([makeStudent({ OrdersId: 1 })]);
    service.markFailed('1', 'err');
    service.markFailed('1', 'err');
    service.markFailed('1', 'err');
    const stats = service.getStats();
    assert.equal(stats.failed, 1);
    assert.equal(stats.pending, 0);
  });

  test('does not throw for unknown ordersId', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([makeStudent({ OrdersId: 1 })]);
    assert.doesNotThrow(() => service.markFailed('999', 'error'));
  });
});

describe('QueueService.hasPendingEntries', () => {
  test('returns true when queue has pending entries', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([makeStudent()]);
    assert.equal(service.hasPendingEntries(), true);
  });

  test('returns false when all entries are sent', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([makeStudent({ OrdersId: 1 })]);
    service.markSent('1');
    assert.equal(service.hasPendingEntries(), false);
  });

  test('returns false on empty queue', () => {
    const service = new QueueService(queuePath());
    assert.equal(service.hasPendingEntries(), false);
  });
});

describe('QueueService.loadQueue', () => {
  test('does not throw when file does not exist', () => {
    const service = new QueueService(path.join(testDir, 'nonexistent', 'queue.json'));
    assert.doesNotThrow(() => service.loadQueue());
    assert.equal(service.hasPendingEntries(), false);
  });

  test('does not throw on corrupt JSON — resets to empty queue', () => {
    const p = queuePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ invalid json !!!', 'utf-8');
    const service = new QueueService(p);
    assert.doesNotThrow(() => service.loadQueue());
    assert.equal(service.getStats().total, 0);
  });

  test('restores queue state from file', () => {
    const p = queuePath();
    const writer = new QueueService(p);
    writer.buildQueue([makeStudent({ OrdersId: 1 }), makeStudent({ OrdersId: 2 })]);
    writer.markSent('1');
    writer.saveQueue();

    const reader = new QueueService(p);
    reader.loadQueue();
    const stats = reader.getStats();
    assert.equal(stats.total, 2);
    assert.equal(stats.sent, 1);
    assert.equal(stats.pending, 1);
  });
});

describe('QueueService.saveQueue', () => {
  test('creates the directory if it does not exist', () => {
    const p = path.join(testDir, 'nested', 'deeply', 'queue.json');
    const service = new QueueService(p);
    service.buildQueue([makeStudent()]);
    assert.ok(fs.existsSync(p));
  });
});

describe('QueueService.getStats', () => {
  test('returns correct counts for mixed statuses', () => {
    const service = new QueueService(queuePath(), 2);
    service.buildQueue([
      makeStudent({ OrdersId: 1 }),
      makeStudent({ OrdersId: 2 }),
      makeStudent({ OrdersId: 3 }),
      makeStudent({ OrdersId: 4 }),
    ]);
    service.markSent('1');
    service.markFailed('2', 'err');
    service.markFailed('2', 'err'); // retryCount=2 >= maxRetries=2 → failed
    const stats = service.getStats();
    assert.equal(stats.total, 4);
    assert.equal(stats.sent, 1);
    assert.equal(stats.failed, 1);
    assert.equal(stats.pending, 2);
  });
});

describe('QueueService.addEntry', () => {
  test('returns true and adds a new entry when ordersId is not in queue', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([]);
    const added = service.addEntry({ ordersId: '999', studentId: '42', startDate: '2025-08-15' });
    assert.equal(added, true);
    assert.equal(service.getStats().total, 1);
    assert.equal(service.getStats().pending, 1);
  });

  test('returns false when ordersId already exists as pending', () => {
    const p = queuePath();
    const service = new QueueService(p);
    service.buildQueue([makeStudent({ OrdersId: 1 })]);
    const added = service.addEntry({ ordersId: '1', studentId: '42', startDate: '2025-08-15' });
    assert.equal(added, false);
    assert.equal(service.getStats().total, 1);
  });

  test('returns false when ordersId already exists as sent', () => {
    const p = queuePath();
    const service = new QueueService(p);
    service.buildQueue([makeStudent({ OrdersId: 1 })]);
    service.markSent('1');
    service.saveQueue();
    const added = service.addEntry({ ordersId: '1', studentId: '42', startDate: '2025-08-15' });
    assert.equal(added, false);
    assert.equal(service.getStats().sent, 1);
  });

  test('returns true and resets to pending when ordersId exists as failed', () => {
    const p = queuePath();
    const service = new QueueService(p, 1);
    service.buildQueue([makeStudent({ OrdersId: 1 })]);
    service.markFailed('1', 'permanent error'); // maxRetries=1 → immediately failed
    service.saveQueue();

    const added = service.addEntry({ ordersId: '1', studentId: '42', startDate: '2025-08-15' });
    assert.equal(added, true);
    const stats = service.getStats();
    assert.equal(stats.pending, 1);
    assert.equal(stats.failed, 0);
    const entry = service.getNextBatch(1)[0];
    assert.equal(entry.retryCount, 0);
    assert.equal(entry.errorMessage, undefined);
  });

  test('saves queue to disk after adding', () => {
    const p = queuePath();
    const service = new QueueService(p);
    service.buildQueue([]);
    service.addEntry({ ordersId: '777', studentId: '1', startDate: '2025-08-15' });

    const reader = new QueueService(p);
    reader.loadQueue();
    assert.equal(reader.getStats().total, 1);
  });
});

describe('QueueService.hasQueueFile', () => {
  test('returns false when file does not exist', () => {
    const service = new QueueService(queuePath());
    assert.equal(service.hasQueueFile(), false);
  });

  test('returns true after saveQueue has been called', () => {
    const service = new QueueService(queuePath());
    service.buildQueue([makeStudent()]);
    assert.equal(service.hasQueueFile(), true);
  });
});
