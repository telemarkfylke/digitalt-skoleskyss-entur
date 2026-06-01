import sql, { ConnectionPool, config } from 'mssql';
import { appLogger } from './logger.service';

export class DatabaseService {
  private pool: ConnectionPool | null = null;
  private config: config;

  constructor() {
    this.config = {
      server: process.env.DB_SERVER || 'localhost',
      port: parseInt(process.env.DB_PORT || '1433'),
      database: process.env.DB_DATABASE || '',
      user: process.env.DB_USER || '',
      password: process.env.DB_PASSWORD || '',
      options: {
        encrypt: process.env.DB_ENCRYPT === 'true', // Use encryption
        trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true' // Trust self-signed certificate
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000 // 30 sec
      },
      requestTimeout: 15000, // Default request timeout in milliseconds (15 sec)
      connectionTimeout: 15000 // Connection timeout in milliseconds (15 sec)
    };
    
    // Validate required configuration
    this.validateConfiguration();
  }

  private validateConfiguration(): void {
    const missingConfig: string[] = [];
    
    if (!this.config.server) missingConfig.push('DB_SERVER');
    if (!this.config.database) missingConfig.push('DB_DATABASE');
    if (!this.config.user) missingConfig.push('DB_USER');
    if (!this.config.password) missingConfig.push('DB_PASSWORD');
    
    if (missingConfig.length > 0) {
      const error = `Missing required database configuration: ${missingConfig.join(', ')}`;
      appLogger.error('Database configuration error: {ErrorMessage}', error);
      appLogger.error('Please check your .env file contains these variables');
      missingConfig.forEach(configName => appLogger.error('{ConfigName}=your_value_here', configName));
      throw new Error(error);
    }
  }

  private getConnectionInfo(): string {
    return `server: ${this.config.server}:${this.config.port}, database: ${this.config.database}, user: ${this.config.user}`;
  }

  async connect(): Promise<void> {
    try {
      if (this.pool) {
        appLogger.info('Database connection pool already established');
        return;
      }

      appLogger.info('Attempting to establish database connection');
      appLogger.info('Connection details: {ConnectionInfo}', this.getConnectionInfo());
      appLogger.info('Encryption: {EncryptionStatus}', this.config.options?.encrypt ? 'enabled' : 'disabled');
      appLogger.info('Trust cert: {TrustCertStatus}', this.config.options?.trustServerCertificate ? 'enabled' : 'disabled');
      
      this.pool = await sql.connect(this.config);
      
      // Verify the connection is actually working
      if (!this.pool) {
        throw new Error('Failed to create connection pool - pool is null');
      }
      
      if (!this.pool.connected) {
        throw new Error('Connection pool created but not connected');
      }
      
      appLogger.info('Database connection pool established successfully');
    } catch (error: any) {
      const connectionInfo = this.getConnectionInfo();
      appLogger.error('Failed to connect to database');
      appLogger.error('Attempted connection: {ConnectionInfo}', connectionInfo);
      appLogger.error('Error details');
      
      // Analyze common connection errors and provide specific guidance
      if (error.code) {
        appLogger.error('Error code: {ErrorCode}', error.code);
        
        switch (error.code) {
          case 'ECONNREFUSED':
            appLogger.error('Connection refused - SQL Server is not running or not accepting connections');
            appLogger.error('Check if SQL Server is running and listening on the specified port');
            break;
          case 'ENOTFOUND':
            appLogger.error('Host not found - DNS resolution failed');
            appLogger.error('Check if the server name is correct');
            break;
          case 'ETIMEDOUT':
            appLogger.error('Connection timeout');
            appLogger.error('Check firewall settings and network connectivity');
            break;
          case 'ELOGIN':
            appLogger.error('Login failed - authentication error');
            appLogger.error('Check username and password');
            break;
          default:
            appLogger.error('Unexpected error code: {ErrorCode}', error.code);
        }
      }
      
      if (error.message) {
        appLogger.error('Message: {ErrorMessage}', error.message);
      }
      
      appLogger.error('Troubleshooting checklist');
      appLogger.error('1. Ensure SQL Server is running');
      appLogger.error('2. Verify server name and port in .env file');
      appLogger.error('3. Check if database exists');
      appLogger.error('4. Verify username and password');
      appLogger.error('5. Check firewall settings');
      appLogger.error('6. Verify SQL Server allows remote connections (if accessing remotely)');
      
      // Ensure pool is null if connection failed
      this.pool = null;
      throw error;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      appLogger.info('Testing database connection');
      await this.connect();
      
      // Try a simple query to verify the connection works
      const request = this.pool!.request();
      const result = await request.query('SELECT 1 as test');
      
      if (result.recordset && result.recordset[0]?.test === 1) {
        appLogger.info('Database connection test successful');
        return true;
      } else {
        appLogger.error('Database connection test failed - unexpected query result');
        return false;
      }
    } catch (error: any) {
      appLogger.error('Database connection test failed: {ErrorMessage}', error.message);
      return false;
    } finally {
      await this.disconnect();
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.pool) {
        await this.pool.close();
        this.pool = null;
        appLogger.info('Database connection pool closed');
      } else {
        appLogger.info('Database connection pool already closed or never established');
      }
    } catch (error: any) {
      appLogger.error('Error closing database connection: {ErrorMessage}', error?.message || String(error));
      // Ensure pool is null even if close fails
      this.pool = null;
      throw error;
    }
  }

  isConnected(): boolean {
    const connected = this.pool !== null && this.pool.connected;
    // Uncomment for debugging: console.log(`Database connection status: pool=${this.pool !== null ? 'exists' : 'null'}, connected=${this.pool?.connected || false}`);
    return connected;
  }

  async query(query: string, params?: any[], timeoutMs?: number): Promise<sql.IResult<any>> {
    try {
      if (!this.pool) {
        throw new Error('Database not connected. Call connect() first.');
      }

      if (!this.pool.connected) {
        throw new Error('Database connection pool exists but is not connected. Connection may have been lost.');
      }

      const request = this.pool.request();
      
      // Set custom timeout if provided (use type assertion to handle typing issue)
      if (timeoutMs) {
        (request as any).timeout = timeoutMs;
      }
      
      // Add parameters if provided
      if (params) {
        params.forEach((param, index) => {
          request.input(`param${index}`, param);
        });
      }

      return await request.query(query);
    } catch (error: any) {
      if (error.message?.includes('timeout')) {
        appLogger.error(
          'Database query timeout ({TimeoutMs}ms): {QueryPreview}',
          timeoutMs || this.config.requestTimeout,
          query.substring(0, 100) + '...'
        );
      } else if (error.message?.includes('not connected')) {
        appLogger.error(
          'Database connection error. Pool status: {PoolStatus}, Connected: {ConnectedStatus}',
          this.pool ? 'exists' : 'null',
          this.isConnected()
        );
      }
      appLogger.error('Database query error: {ErrorMessage}', error?.message || String(error));
      throw error;
    }
  }

  getPool(): ConnectionPool {
    if (!this.pool) {
      throw new Error('Database not connected. Call connect() first.');
    }
    return this.pool;
  }
}