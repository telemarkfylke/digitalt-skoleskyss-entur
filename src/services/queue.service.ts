import fs from 'fs';
import path from 'path';
import { StudentWithDetails } from '../types/user.types';
import { appLogger } from './logger.service';

export type QueueEntryStatus = 'pending' | 'sent' | 'failed';

export interface QueueEntry {
  studentId: string;
  ordersId: string;
  startDate: string;
  addedAt: string;
  processedAt: string | null;
  status: QueueEntryStatus;
  errorMessage?: string;
  retryCount: number;
}

export interface SyncQueue {
  version: 1;
  generatedAt: string;
  lastRunAt: string | null;
  entries: QueueEntry[];
}

export interface QueueStats {
  pending: number;
  sent: number;
  failed: number;
  total: number;
}

export class QueueService {
  private queue: SyncQueue;
  private readonly filePath: string;
  private readonly maxRetries: number;

  constructor(filePath: string, maxRetries = 3) {
    this.filePath = path.resolve(filePath);
    this.maxRetries = maxRetries;
    this.queue = this.emptyQueue();
  }

  private emptyQueue(): SyncQueue {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      lastRunAt: null,
      entries: [],
    };
  }

  private toIsoDate(value: string | Date): string {
    if (value instanceof Date) return value.toISOString().split('T')[0];
    return String(value).split('T')[0];
  }

  buildQueue(students: StudentWithDetails[]): void {
    const sorted = [...students].sort((a, b) => {
      const dateA = new Date(a.StartDate).getTime();
      const dateB = new Date(b.StartDate).getTime();
      if (dateA !== dateB) return dateA - dateB;
      return Number(a.OrdersId) - Number(b.OrdersId);
    });

    const now = new Date().toISOString();
    this.queue = {
      version: 1,
      generatedAt: now,
      lastRunAt: null,
      entries: sorted.map((s) => ({
        studentId: String(s.StudentId),
        ordersId: String(s.OrdersId),
        startDate: this.toIsoDate(s.StartDate),
        addedAt: now,
        processedAt: null,
        status: 'pending',
        retryCount: 0,
      })),
    };

    appLogger.info('Queue built with {EntryCount} entries', this.queue.entries.length);
    this.saveQueue();
  }

  loadQueue(): void {
    if (!fs.existsSync(this.filePath)) {
      this.queue = this.emptyQueue();
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.queue = JSON.parse(raw) as SyncQueue;
    } catch {
      appLogger.warn('Queue file at {FilePath} is missing or corrupt — starting with empty queue', this.filePath);
      this.queue = this.emptyQueue();
    }
  }

  saveQueue(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.queue, null, 2), 'utf-8');
  }

  // Returns up to `limit` pending entries in chronological order.
  // Pass limit = 0 to return all pending entries.
  getNextBatch(limit: number): QueueEntry[] {
    const pending = this.queue.entries.filter((e) => e.status === 'pending');
    return limit === 0 ? pending : pending.slice(0, limit);
  }

  markSent(ordersId: string): void {
    const entry = this.queue.entries.find((e) => e.ordersId === ordersId);
    if (!entry) {
      appLogger.warn('markSent: ordersId {OrdersId} not found in queue', ordersId);
      return;
    }
    entry.status = 'sent';
    entry.processedAt = new Date().toISOString();
    this.queue.lastRunAt = entry.processedAt;
  }

  markFailed(ordersId: string, error: string): void {
    const entry = this.queue.entries.find((e) => e.ordersId === ordersId);
    if (!entry) {
      appLogger.warn('markFailed: ordersId {OrdersId} not found in queue', ordersId);
      return;
    }
    entry.retryCount++;
    entry.errorMessage = error;
    if (entry.retryCount >= this.maxRetries) {
      entry.status = 'failed';
      entry.processedAt = new Date().toISOString();
      appLogger.error(
        'Queue entry {OrdersId} permanently failed after {RetryCount} attempts: {Error}',
        ordersId,
        entry.retryCount,
        error
      );
    }
    this.queue.lastRunAt = new Date().toISOString();
  }

  // Adds a single entry to the existing queue without rebuilding.
  // Reloads from disk first so concurrent writes (monitor + scheduler) don't overwrite each other.
  // Returns true if the entry was added or re-queued, false if already pending/sent.
  addEntry(entry: { ordersId: string; studentId: string; startDate: string }): boolean {
    this.loadQueue();

    const existing = this.queue.entries.find((e) => e.ordersId === entry.ordersId);

    if (existing) {
      if (existing.status === 'pending' || existing.status === 'sent') return false;
      // 'failed' — re-queue for another attempt
      existing.status = 'pending';
      existing.retryCount = 0;
      delete existing.errorMessage;
      existing.addedAt = new Date().toISOString();
      this.saveQueue();
      return true;
    }

    this.queue.entries.push({
      studentId: entry.studentId,
      ordersId: entry.ordersId,
      startDate: entry.startDate,
      addedAt: new Date().toISOString(),
      processedAt: null,
      status: 'pending',
      retryCount: 0,
    });

    this.saveQueue();
    return true;
  }

  hasQueueFile(): boolean {
    return fs.existsSync(this.filePath);
  }

  hasPendingEntries(): boolean {
    return this.queue.entries.some((e) => e.status === 'pending');
  }

  getStats(): QueueStats {
    const stats: QueueStats = { pending: 0, sent: 0, failed: 0, total: this.queue.entries.length };
    for (const e of this.queue.entries) stats[e.status]++;
    return stats;
  }
}
