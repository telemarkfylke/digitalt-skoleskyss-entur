import { DatabaseService } from './database.service';
import { EventEmitter } from 'events';
import { appLogger } from './logger.service';

export interface CustomQueryChange {
  operation: 'NEW_RECORDS' | 'UPDATED_RECORDS' | 'REMOVED_RECORDS' | 'DATA_CHANGED';
  newRecords: any[];
  removedRecords: any[];
  changedRecords: any[];
  totalRecords: number;
  timestamp: Date;
}

export interface CustomQueryConfig {
  name: string;
  query: string;
  interval: number; // milliseconds
  keyColumns: string[]; // columns to use for identifying unique records
  compareColumns?: string[]; // columns to compare for changes (if not provided, compares all)
  timeoutMs?: number; // query timeout in milliseconds (default: 30000)
}

export class CustomQueryMonitor extends EventEmitter {
  private db: DatabaseService;
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private lastResults: Map<string, any[]> = new Map();
  private runningChecks: Map<string, boolean> = new Map();

  constructor(databaseService: DatabaseService) {
    super();
    this.db = databaseService;
  }

  /**
   * Start monitoring a custom query for changes
   */
  startMonitoring(config: CustomQueryConfig): void {
    if (this.intervals.has(config.name)) {
      appLogger.info(`Already monitoring query: ${config.name}`);
      return;
    }

    const monitor = async () => {
      if (this.runningChecks.get(config.name)) {
        appLogger.debug(`Skipping overlapping check for ${config.name}`);
        return;
      }

      this.runningChecks.set(config.name, true);
      try {
        await this.checkQueryChanges(config);
      } catch (error: any) {
        appLogger.error(`Error monitoring query ${config.name}: {ErrorMessage}`, error instanceof Error ? error.message : String(error));
        this.emit('error', { queryName: config.name, error });
      } finally {
        this.runningChecks.set(config.name, false);
      }
    };

    // Initial check to establish baseline
    monitor();

    // Set up recurring checks
    const interval = setInterval(monitor, config.interval);
    this.intervals.set(config.name, interval);

    appLogger.info(`Started monitoring custom query: ${config.name} (${config.interval}ms)`);
  }

  /**
   * Stop monitoring a query
   */
  stopMonitoring(queryName: string): void {
    const interval = this.intervals.get(queryName);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(queryName);
      this.lastResults.delete(queryName);
      this.runningChecks.delete(queryName);
      appLogger.info(`Stopped monitoring: ${queryName}`);
    }
  }

  /**
   * Stop all monitoring
   */
  stopAll(): void {
    for (const [queryName] of this.intervals) {
      this.stopMonitoring(queryName);
    }
  }

  /**
   * Get current results for a monitored query
   */
  async getCurrentResults(config: CustomQueryConfig): Promise<any[]> {
    const timeout = config.timeoutMs || 30000; // Default 30 second timeout
    const result = await this.db.query(config.query, [], timeout);
    return result.recordset;
  }

  private async checkQueryChanges(config: CustomQueryConfig): Promise<void> {
    const currentResults = await this.getCurrentResults(config);
    const hasBaseline = this.lastResults.has(config.name);
    const previousResults = this.lastResults.get(config.name) || [];

    if (!hasBaseline) {
      // First run only - establish baseline once.
      this.lastResults.set(config.name, currentResults);
      appLogger.info(`Baseline established for ${config.name}: ${currentResults.length} records`);
      return;
    }

    // Detect changes
    const changes = this.compareResults(config, previousResults, currentResults);

    if (changes.hasChanges) {
      const changeEvent: CustomQueryChange = {
        operation: this.determineOperation(changes),
        newRecords: changes.newRecords,
        removedRecords: changes.removedRecords,
        changedRecords: changes.changedRecords,
        totalRecords: currentResults.length,
        timestamp: new Date()
      };

      this.emit('change', changeEvent);

      appLogger.info(`Changes detected in ${config.name}:`);
      appLogger.info(`New: ${changes.newRecords.length}, Removed: ${changes.removedRecords.length}, Changed: ${changes.changedRecords.length}`);
      appLogger.info(`Total records: ${currentResults.length} (was ${previousResults.length})`);
    }

    // Update stored results
    this.lastResults.set(config.name, currentResults);
  }

  private compareResults(config: CustomQueryConfig, previous: any[], current: any[]): any {
    const { keyColumns, compareColumns } = config;
    
    // Create lookup maps based on key columns
    const previousMap = new Map();
    const currentMap = new Map();

    // Build lookup keys for previous results
    for (const record of previous) {
      const key = this.buildRecordKey(record, keyColumns);
      previousMap.set(key, record);
    }

    // Build lookup keys for current results
    for (const record of current) {
      const key = this.buildRecordKey(record, keyColumns);
      currentMap.set(key, record);
    }

    // Find new records (in current but not in previous)
    const newRecords = [];
    for (const [key, record] of currentMap) {
      if (!previousMap.has(key)) {
        newRecords.push(record);
      }
    }

    // Find removed records (in previous but not in current)
    const removedRecords = [];
    for (const [key, record] of previousMap) {
      if (!currentMap.has(key)) {
        removedRecords.push(record);
      }
    }

    // Find changed records (same key but different data)
    const changedRecords = [];
    for (const [key, currentRecord] of currentMap) {
      const previousRecord = previousMap.get(key);
      if (previousRecord && this.recordsAreDifferent(previousRecord, currentRecord, compareColumns)) {
        changedRecords.push({
          key,
          previous: previousRecord,
          current: currentRecord
        });
      }
    }

    return {
      hasChanges: newRecords.length > 0 || removedRecords.length > 0 || changedRecords.length > 0,
      newRecords,
      removedRecords,
      changedRecords
    };
  }

  private buildRecordKey(record: any, keyColumns: string[]): string {
    return keyColumns.map(col => String(record[col])).join('|');
  }

  private recordsAreDifferent(record1: any, record2: any, compareColumns?: string[]): boolean {
    // If no specific columns to compare, compare all columns
    const columnsToCompare = compareColumns || Object.keys(record1);
    
    for (const column of columnsToCompare) {
      const val1 = record1[column];
      const val2 = record2[column];
      
      // Handle dates and different types
      if (val1 instanceof Date && val2 instanceof Date) {
        if (val1.getTime() !== val2.getTime()) return true;
      } else if (val1 !== val2) {
        return true;
      }
    }
    
    return false;
  }

  private determineOperation(changes: any): 'NEW_RECORDS' | 'UPDATED_RECORDS' | 'REMOVED_RECORDS' | 'DATA_CHANGED' {
    if (changes.newRecords.length > 0 && changes.removedRecords.length === 0 && changes.changedRecords.length === 0) {
      return 'NEW_RECORDS';
    } else if (changes.changedRecords.length > 0 && changes.newRecords.length === 0 && changes.removedRecords.length === 0) {
      return 'UPDATED_RECORDS';
    } else if (changes.removedRecords.length > 0 && changes.newRecords.length === 0 && changes.changedRecords.length === 0) {
      return 'REMOVED_RECORDS';
    } else {
      return 'DATA_CHANGED';
    }
  }

  /**
   * Get monitoring statistics
   */
  getMonitoringStats(): any {
    const stats: any = {};
    for (const [queryName, results] of this.lastResults) {
      stats[queryName] = {
        recordCount: results.length,
        isActive: this.intervals.has(queryName),
        sampleRecord: results.length > 0 ? results[0] : null
      };
    }
    return stats;
  }
}
