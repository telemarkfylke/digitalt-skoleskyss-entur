import dotenv from 'dotenv';
import { DatabaseService } from './services/database.service';
import { appLogger, flushLogs } from './services/logger.service';

// Load environment variables
dotenv.config();

async function testDatabaseConnection() {
  appLogger.debug('Database Connection Test Tool');
  appLogger.debug('='.repeat(50));
  
  // Check environment variables
  appLogger.debug('Environment Variables Check:');
  const envVars = ['DB_SERVER', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD', 'DB_PORT', 'DB_ENCRYPT', 'DB_TRUST_SERVER_CERTIFICATE'];
  
  envVars.forEach(varName => {
    const value = process.env[varName];
    if (varName === 'DB_PASSWORD') {
      appLogger.debug(`   ${varName}: ${value ? '***HIDDEN***' : 'NOT SET'}`);
    } else {
      appLogger.debug(`   ${varName}: ${value || 'NOT SET'}`);
    }
  });
  
  // Test database service
  appLogger.debug('Testing Database Service:');
  const dbService = new DatabaseService();
  
  try {
    const success = await dbService.testConnection();
    
    if (success) {
      appLogger.debug('Database connection test completed successfully!');
      appLogger.debug('You can proceed with running sync operations.');
    } else {
      appLogger.debug('Database connection test failed!');
      appLogger.debug('Please review the error messages above and fix the configuration.');
    }
    
  } catch (error: any) {
    appLogger.debug('Database connection test crashed with error:');
    appLogger.debug(`${error.message}`);
    
    appLogger.debug('Additional Help:');
    appLogger.debug('-- Make sure you have copied .env.example to .env');
    appLogger.debug('-- Verify that SQL Server is installed and running');
    appLogger.debug('-- Check that the database exists');
    appLogger.debug('-- Ensure SQL Server is configured to allow connections');
    appLogger.debug('-- Try connecting with SQL Server Management Studio using the same credentials');
  }
  
  appLogger.debug('\n' + '='.repeat(50));
}

// For Windows SQL Server Express common issues
function showWindowsSQLServerHelp() {
  appLogger.debug('Windows SQL Server Express Common Issues:');
  appLogger.debug(' 1. SQL Server Browser service not running');
  appLogger.debug(' 2. Named Pipes and TCP/IP not enabled');
  appLogger.debug(' 3. Windows Firewall blocking connections');
  appLogger.debug(' 4. SQL Server Express default instance name (usually .\\SQLEXPRESS)');
  appLogger.debug(' 5. SQL Server authentication mode (Windows vs SQL Server auth)');
  appLogger.debug('Quick fixes:');
  appLogger.debug(' 1. Start SQL Server Configuration Manager');
  appLogger.debug(' 2. Enable TCP/IP in Network Configuration');
  appLogger.debug(' 3. Start SQL Server Browser service');
  appLogger.debug(' 4. Check SQL Server service is running');
}

const exitWithCode = async (code: number): Promise<never> => {
  await flushLogs();
  process.exit(code);
};

// Run the test
if (require.main === module) {
  testDatabaseConnection()
    .then(() => {
      if (process.platform === 'win32') {
        showWindowsSQLServerHelp();
      }
      return exitWithCode(0);
    })
    .catch((error) => {
      appLogger.error('Unexpected error: {ErrorMessage}', error instanceof Error ? error.message : String(error));
      return exitWithCode(1);
    });
}
