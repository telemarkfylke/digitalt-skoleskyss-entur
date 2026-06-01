import { DatabaseService } from '../services/database.service';
import { EventEmitter } from 'events';
import { appLogger } from './logger.service';

export interface ReadOnlyChangeConfig {
  table: string;
  interval: number; // milliseconds
  keyColumn?: string; // default: 'Id'
  timestampColumn?: string; // e.g., 'UpdatedAt', 'ModifiedDate'
  createdColumn?: string; // e.g., 'CreatedAt', 'CreatedDate'
}

export interface ReadOnlyChange {
  table: string;
  operation: 'INSERT' | 'UPDATE' | 'UNKNOWN_CHANGE';
  records: any[];
  timestamp: Date;
}

export class ReadOnlyChangeDetector extends EventEmitter {
  private db: DatabaseService;
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private lastCheckpoints: Map<string, any> = new Map();

  constructor(databaseService: DatabaseService) {
    super();
    this.db = databaseService;
  }

  /**
   * Start monitoring a table for changes (read-only approach)
   */
  startMonitoring(config: ReadOnlyChangeConfig): void {
    if (this.intervals.has(config.table)) {
      appLogger.info(`Already monitoring table: ${config.table}`);
      return;
    }

    const monitor = async () => {
      try {
        await this.checkTableChanges(config);
      } catch (error) {
        appLogger.error(`Error monitoring ${config.table}: {ErrorMessage}`, error instanceof Error ? error.message : String(error));
        this.emit('error', { table: config.table, error });
      }
    };

    // Initial check to establish baseline
    monitor();

    // Set up recurring checks
    const interval = setInterval(monitor, config.interval);
    this.intervals.set(config.table, interval);

    appLogger.info(`Started read-only monitoring: ${config.table} (${config.interval}ms)`);
  }

  /**
   * Stop monitoring a table
   */
  stopMonitoring(table: string): void {
    const interval = this.intervals.get(table);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(table);
      this.lastCheckpoints.delete(table);
      appLogger.warn(`Stopped monitoring: ${table}`);
    }
  }

  /**
   * Stop all monitoring
   */
  stopAll(): void {
    for (const [table] of this.intervals) {
      this.stopMonitoring(table);
    }
  }

  private async checkTableChanges(config: ReadOnlyChangeConfig): Promise<void> {
    const { table, keyColumn = 'Id', timestampColumn, createdColumn } = config;
    
    // Strategy 1: Use timestamp columns if available
    if (timestampColumn || createdColumn) {
      await this.checkTimestampBasedChanges(config);
      return;
    }

    // Strategy 2: Use max ID and row count comparison
    await this.checkIdBasedChanges(config);
  }

  private async checkTimestampBasedChanges(config: ReadOnlyChangeConfig): Promise<void> {
    const { table, timestampColumn, createdColumn } = config;
    
    const lastCheck = this.lastCheckpoints.get(table);
    const currentTime = new Date();
    
    // Check for new records (using CreatedAt/CreatedDate)
    if (createdColumn) {
      await this.checkNewRecords(table, createdColumn, lastCheck?.lastCreated);
    }

    // Check for updated records (using UpdatedAt/ModifiedDate)  
    if (timestampColumn) {
      await this.checkUpdatedRecords(table, timestampColumn, lastCheck?.lastUpdated);
    }

    // Update checkpoint
    this.lastCheckpoints.set(table, {
      lastCreated: currentTime,
      lastUpdated: currentTime,
      lastCheck: currentTime
    });
  }

  private async checkNewRecords(table: string, createdColumn: string, since?: Date): Promise<void> {
    const sinceClause = since 
      ? `WHERE ${createdColumn} > @param0`
      : `WHERE ${createdColumn} >= DATEADD(MINUTE, -5, GETUTCDATE())`;
    
    const query = `
      SELECT * FROM ${table} 
      ${sinceClause}
      ORDER BY ${createdColumn} DESC
    `;

    const params = since ? [since] : [];
    const result = await this.db.query(query, params);

    if (result.recordset.length > 0) {
      this.emit('change', {
        table,
        operation: 'INSERT',
        records: result.recordset,
        timestamp: new Date()
      } as ReadOnlyChange);

      appLogger.info(`Found ${result.recordset.length} new records in ${table}`);
    }
  }

  private async checkUpdatedRecords(table: string, timestampColumn: string, since?: Date): Promise<void> {
    const sinceClause = since 
      ? `WHERE ${timestampColumn} > @param0`
      : `WHERE ${timestampColumn} >= DATEADD(MINUTE, -5, GETUTCDATE())`;
    
    const query = `
      SELECT * FROM ${table} 
      ${sinceClause}
      ORDER BY ${timestampColumn} DESC
    `;

    const params = since ? [since] : [];
    const result = await this.db.query(query, params);

    if (result.recordset.length > 0) {
      this.emit('change', {
        table,
        operation: 'UPDATE',
        records: result.recordset,
        timestamp: new Date()
      } as ReadOnlyChange);

      appLogger.info(`Found ${result.recordset.length} updated records in ${table}`);
    }
  }

  private async checkIdBasedChanges(config: ReadOnlyChangeConfig): Promise<void> {
    const { table, keyColumn = 'Id' } = config;
    
    // Get current table statistics
    const query = `
      SELECT 
        COUNT(*) as RecordCount,
        MAX(${keyColumn}) as MaxId,
        MIN(${keyColumn}) as MinId
      FROM ${table}
    `;

    const result = await this.db.query(query);
    const current = result.recordset[0];
    
    const lastCheck = this.lastCheckpoints.get(table);
    
    if (!lastCheck) {
      // First run - establish baseline
      this.lastCheckpoints.set(table, current);
      appLogger.info(`Baseline established for ${table}: ${current.RecordCount} records`);
      return;
    }

    // Detect changes
    const hasNewRecords = current.MaxId > lastCheck.MaxId;
    const hasChanges = current.RecordCount !== lastCheck.RecordCount;

    if (hasNewRecords) {
      // Get the new records
      const newRecordsQuery = `
        SELECT * FROM ${table} 
        WHERE ${keyColumn} > @param0 
        ORDER BY ${keyColumn}
      `;
      
      const newRecords = await this.db.query(newRecordsQuery, [lastCheck.MaxId]);
      
      this.emit('change', {
        table,
        operation: 'INSERT',
        records: newRecords.recordset,
        timestamp: new Date()
      } as ReadOnlyChange);

      appLogger.info(`Found ${newRecords.recordset.length} new records in ${table}`);
    }

    if (hasChanges && !hasNewRecords) {
      // Something changed but no new records (possibly updates or deletes)
      this.emit('change', {
        table,
        operation: 'UNKNOWN_CHANGE',
        records: [],
        timestamp: new Date()
      } as ReadOnlyChange);

      appLogger.info(`Detected changes in ${table} (count: ${lastCheck.RecordCount} → ${current.RecordCount})`);
    }

    // Update checkpoint
    this.lastCheckpoints.set(table, current);
  }

  /**
   * Get recent records manually
   */
  async getRecentRecords(
    table: string, 
    timestampColumn: string, 
    sinceMinutes: number = 10
  ): Promise<any[]> {
    const query = `
      SELECT * FROM ${table}
      WHERE ${timestampColumn} >= DATEADD(MINUTE, -@param0, GETUTCDATE())
      ORDER BY ${timestampColumn} DESC
    `;

    const result = await this.db.query(query, [sinceMinutes]);
    return result.recordset;
  }

  /**
   * Get table info to help configure monitoring
   */
  async getTableInfo(table: string): Promise<any> {
    const query = `
      SELECT 
        COLUMN_NAME,
        DATA_TYPE,
        IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = @param0
      AND DATA_TYPE IN ('datetime', 'datetime2', 'timestamp', 'int', 'bigint')
      ORDER BY ORDINAL_POSITION
    `;

    const result = await this.db.query(query, [table]);
    return {
      table,
      potentialColumns: result.recordset,
      suggestion: this.suggestMonitoringStrategy(result.recordset)
    };
  }

  private suggestMonitoringStrategy(columns: any[]): any {
    const timestampCols = columns.filter(c => 
      c.DATA_TYPE.includes('datetime') || c.DATA_TYPE === 'timestamp'
    );
    
    const idCols = columns.filter(c => 
      c.COLUMN_NAME.toLowerCase() === 'id' || 
      (c.DATA_TYPE === 'int' || c.DATA_TYPE === 'bigint')
    );

    return {
      recommended: timestampCols.length > 0 ? 'timestamp-based' : 'id-based',
      createdColumn: timestampCols.find(c => c.COLUMN_NAME.toLowerCase().includes('created'))?.COLUMN_NAME,
      updatedColumn: timestampCols.find(c => c.COLUMN_NAME.toLowerCase().includes('updated') || 
                                             c.COLUMN_NAME.toLowerCase().includes('modified'))?.COLUMN_NAME,
      keyColumn: idCols.find(c => c.COLUMN_NAME.toLowerCase() === 'id')?.COLUMN_NAME || idCols[0]?.COLUMN_NAME
    };
  }
}
