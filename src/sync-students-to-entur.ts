import dotenv from 'dotenv';
import { SyncManager, SyncOptions } from './sync-manager';
import { calculateSchoolYear, formatSchoolYear } from './utils';
import { appLogger, flushLogs } from './services/logger.service';

// Load environment variables
dotenv.config();

interface SyncConfig {
  method: 'all' | 'filtered' | 'single';
  classes?: string[];
  gradeIds?: string[];
  studentId?: string;
  studentIds?: string[];
  startYear?: string;
  endYear?: string;
  dryRun?: boolean;
  batchSize?: number;
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
}

const getFirstDefinedEnv = (...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      return value;
    }
  }

  return undefined;
};

// Default configuration - can be overridden by environment variables or command line args
const getSyncConfig = (): SyncConfig => {
  // npm can expose CLI args as npm_config_* environment variables.
  // This makes commands like `npm run sync-entur -- --dry-run false` work
  // even if npm/powershell strips the original flag names from process.argv.
  const method = (getFirstDefinedEnv('SYNC_METHOD', 'npm_config_method') as 'all' | 'filtered' | 'single') || 'all';
  const classes = (getFirstDefinedEnv('SYNC_CLASSES', 'npm_config_classes') || '').split(',').map(v => v.trim()).filter(Boolean);
  const gradeIds = (getFirstDefinedEnv('SYNC_GRADE_IDS', 'npm_config_grade_ids') || '').split(',').map(v => v.trim()).filter(Boolean);
  const studentId = getFirstDefinedEnv('SYNC_STUDENT_ID', 'npm_config_student_id');
  const studentIds = (getFirstDefinedEnv('SYNC_STUDENT_IDS', 'npm_config_student_ids') || '').split(',').map(id => id.trim()).filter(Boolean);
  const dryRunValue = getFirstDefinedEnv('SYNC_DRY_RUN', 'npm_config_dry_run');
  const dryRun = dryRunValue !== 'false'; // Default to true for safety
  const batchSize = parseInt(getFirstDefinedEnv('SYNC_BATCH_SIZE', 'npm_config_batch_size') || '10', 10);
  const logLevel = (getFirstDefinedEnv('SYNC_LOG_LEVEL', 'npm_config_log_level') as 'error' | 'warn' | 'info' | 'debug') || 'debug';

  return {
    method,
    classes,
    gradeIds,
    studentId,
    studentIds,
    dryRun,
    batchSize,
    logLevel
  };
};

async function syncStudentsToEntur(config?: SyncConfig) {
  appLogger.info('Starting Student Skoleskyss Sync to Entur...');
  
  const syncConfig = {
    ...getSyncConfig(),
    ...(config || {})
  };
  
  // Get current school year for defaults
  const currentSchoolYear = calculateSchoolYear();
  const startYear = syncConfig.startYear || currentSchoolYear.graduationYear;
  const endYear = syncConfig.endYear || (currentSchoolYear.endYear + 1).toString();
  
  appLogger.info(`School year range: ${startYear} - ${endYear}`);
  appLogger.info(`Sync method: ${syncConfig.method}`);
  appLogger.info(`Dry run: ${syncConfig.dryRun ? 'Yes' : 'No'}`);
  appLogger.info(`Batch size: ${syncConfig.batchSize}`);
  
  // Create SyncManager with options
  const syncOptions: SyncOptions = {
    dryRun: syncConfig.dryRun,
    batchSize: syncConfig.batchSize,
    maxRetries: 3,
    delayBetweenBatches: 1000,
    logLevel: syncConfig.logLevel
  };
  
  const syncManager = new SyncManager(syncOptions);
  
  try {
    let result;
    
    switch (syncConfig.method) {
      case 'all':
        appLogger.info('Syncing all videregående students...');
        result = await syncManager.syncAllStudents(startYear, endYear);
        break;
        
      case 'filtered':
        if (!syncConfig.classes || !syncConfig.gradeIds || 
            syncConfig.classes.length === 0 || syncConfig.gradeIds.length === 0) {
          throw new Error('Filtered sync requires both classes and gradeIds to be specified');
        }
        appLogger.info(`Syncing students from classes: ${syncConfig.classes.join(', ')}`);
        appLogger.info(`Grade IDs: ${syncConfig.gradeIds.join(', ')}`);
        result = await syncManager.syncStudentsByClasses(
          syncConfig.classes,
          syncConfig.gradeIds,
          startYear,
          endYear
        );
        break;
        
      case 'single':
        if (syncConfig.studentIds && syncConfig.studentIds.length > 0) {
          appLogger.info(`Syncing multiple students: ${syncConfig.studentIds.join(', ')}`);
          result = await syncManager.syncMultipleStudents(
            syncConfig.studentIds,
            startYear,
            endYear
          );
          break;
        }

        if (!syncConfig.studentId) {
          throw new Error('Single student sync requires studentId or studentIds to be specified');
        }
        appLogger.info(`Syncing single student: ${syncConfig.studentId}`);
        result = await syncManager.syncSingleStudent(
          syncConfig.studentId,
          startYear,
          endYear
        );
        break;
        
      default:
        throw new Error(`Unknown sync method: ${syncConfig.method}`);
    }
  
    
    // Display sync results
    appLogger.info('═══ Sync Results ═══');
    appLogger.info(`Total students processed: ${result.totalStudents}`);
    appLogger.info(`Successful syncs: ${result.successCount}`);
    appLogger.info(`Failed syncs: ${result.failedCount}`);
    appLogger.info(`Skipped syncs: ${result.skippedCount}`);
    appLogger.info(`Duration: ${(result.duration / 1000).toFixed(2)} seconds`);
    
    if (result.errors.length > 0) {
      appLogger.info('Errors encountered:');
      result.errors.forEach((error, index) => {
        appLogger.info(`   ${index + 1}. ${error}`);
      });
    }
    
    if (syncConfig.dryRun) {
      appLogger.info('This was a DRY RUN. No actual API calls were made.');
      appLogger.info('Set dryRun to false to perform actual sync.');
    }
    
    return result;

  } catch (error: any) {
    appLogger.error(`Sync failed: ${error.message}`);
    throw error;
  }
}

// Helper function to demonstrate how to use the Entur service for creating skoleskyss requests
async function demonstrateEnturSkoleskyssIntegration() {
  appLogger.info('═══ Entur Skoleskyss Integration Guide ═══'); 
  appLogger.info('What this integration does:');
  appLogger.info('-- Creates skoleskyss (school transport) requests for students');
  appLogger.info('-- Maps your local student data to Entur\'s format');
  appLogger.info('-- Handles fare contracts with zone configurations');
  appLogger.info('-- Manages school year periods automatically');
  appLogger.info('-- Provides batch processing with error handling');
  appLogger.info('-- Supports dry-run mode for safe testing');
  appLogger.info('');
  
  appLogger.info('Configuration options:');
  appLogger.info('-- Dry run mode (default: true for safety)');
  appLogger.info('-- Batch size (default: 10 students per batch)');
  appLogger.info('-- Retry logic (default: 3 attempts)');
  appLogger.info('-- Rate limiting (default: 1s between batches)');
  appLogger.info('-- Log levels (error, warn, info, debug)');
  appLogger.info('');
  
  appLogger.info('Next actions:');
  appLogger.info('-- Run: npm run test-entur (test API connection)');
  appLogger.info('-- Test with dry run first: npm run sync-entur');
  appLogger.info('-- Configure environment variables for production');
  appLogger.info('-- Set SYNC_DRY_RUN=false when ready for real sync');
  appLogger.info('-- Monitor sync results and adjust batch sizes as needed');
}

// Helper function to demonstrate zone configuration
function demonstrateZoneConfiguration() {
  appLogger.info('═══ Zone Configuration Examples ═══');
  
  appLogger.info('Example 1: Point-to-point zones');
  appLogger.info('zones: [');
  appLogger.info('  { fromZoneId: "3001", toZoneId: "3002" }  // Home zone to school zone');
  appLogger.info(']');
  appLogger.info('');
  
  appLogger.info('Example 2: Group zone (typical for region-wide student transport)');
  appLogger.info('zones: [');
  appLogger.info(' { groupOfTariffZoneId: \'TEL:GroupOfTariffZones:1\' }');
  appLogger.info('  // Regional student transport');
  appLogger.info(']');
  appLogger.info('');
  
  appLogger.info('Example 3: Multiple zones for complex routes');
  appLogger.info('zones: [');
  appLogger.info('  { fromZoneId: "3001", toZoneId: "3002" },  // Home to transfer point');
  appLogger.info('  { fromZoneId: "3002", toZoneId: "3003" }   // Transfer point to school');
  appLogger.info(']');
  appLogger.info('');
  
  appLogger.info('❓ How to find zone IDs:');
  appLogger.info('-- Check Entur documentation for your area or with the EnTur skoleskyss team');
  appLogger.info('-- Test with EnTur skoleskyss team');
}

const isSetupOrConfigError = (errorMessage: string): boolean => {
  const setupErrorPattern = /missing|required|config|environment|env|token|auth|connection|econnrefused|not connected|login|credential/i;
  return setupErrorPattern.test(errorMessage);
};

// Parse command line arguments for sync configuration
function parseCommandLineArgs(): SyncConfig | null {
  const args = process.argv.slice(2);
  
  // Handle npm script positional arguments (when npm strips -- flags)
  // "npm run sync-entur -- --validate --method single --student-id 77793"
  // actually comes through as: ['single', '77793'] 
  if (args.length >= 1 && !args[0].startsWith('--')) {
    appLogger.debug('DEBUG: Detected positional arguments from npm script');
    const method = args[0];
    
    if (['all', 'filtered', 'single'].includes(method)) {
      const config: SyncConfig = {
        method: method as 'all' | 'filtered' | 'single'
      };
      
      // If method is single and we have a student ID
      if (method === 'single' && args.length >= 2) {
        if (args[1].includes(',')) {
          config.studentIds = args[1].split(',').map(id => id.trim()).filter(Boolean);
        } else {
          config.studentId = args[1];
        }
      }
      
      appLogger.debug('DEBUG: Parsed positional config: {ConfigJson}', JSON.stringify(config));
      return config;
    }
  }
  
  if (args.includes('--help') || args.includes('-h')) {
    appLogger.info('═══ Sync Students to Entur - Usage ═══');
    appLogger.info('');
    appLogger.info('Sync all students:');
    appLogger.info('npm run sync-entur');
    appLogger.info('npm run sync-entur -- --method all');
    appLogger.info('PowerShell safe: npm run sync-entur -- -- --method all');
    appLogger.info('');
    appLogger.info('Sync filtered students:');
    appLogger.info('npm run sync-entur -- --method filtered --classes "1A,1B,2A" --grade-ids "1,2"');
    appLogger.info('');
    appLogger.info('Sync single student:');
    appLogger.info('npm run sync-entur -- --method single --student-id "12345"');
    appLogger.info('PowerShell safe: npm run sync-entur -- -- --method single --student-id "12345"');
    appLogger.info('');
    appLogger.info('Sync multiple students (testing):');
    appLogger.info('npm run sync-entur -- --method single --student-ids "12345,67890,77793"');
    appLogger.info('');
    appLogger.info('Advanced options:');
    appLogger.info('npm run sync-entur -- --method all --dry-run false --batch-size 20 --log-level debug');
    appLogger.info('PowerShell safe: npm run sync-entur -- -- --method all --dry-run false --batch-size 20 --log-level debug');
    appLogger.info('');
    appLogger.info('Validation options:');
    appLogger.info('npm run sync-entur -- --validate  # Test all methods');
    appLogger.info('npm run sync-entur -- --validate --method single --student-id \"12345\"  # Validate specific student');
    appLogger.info('npm run sync-entur -- --validate --method single --student-ids \"12345,67890\"  # Validate specific students');
    appLogger.info('npm run sync-entur -- --validate --method filtered --classes \"1A,1B\" --grade-ids \"1,2\"  # Validate specific classes');
    appLogger.info('');
    appLogger.info('Environment variables:');
    appLogger.info('SYNC_METHOD=filtered');
    appLogger.info('SYNC_CLASSES=1A,1B,2A');
    appLogger.info('SYNC_GRADE_IDS=1,2');
    appLogger.info('SYNC_STUDENT_ID=12345');
    appLogger.info('SYNC_STUDENT_IDS=12345,67890');
    appLogger.info('SYNC_DRY_RUN=false');
    appLogger.info('SYNC_BATCH_SIZE=20');
    appLogger.info('SYNC_LOG_LEVEL=debug');
    appLogger.info('');
    return null;
  }

  const config: SyncConfig = { method: 'all' };

  appLogger.debug('DEBUG: Starting parseCommandLineArgs with args: {ArgsJson}', JSON.stringify(args));

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    appLogger.debug(`DEBUG: Processing arg[${i}]: "${arg}"`);
    
    switch (arg) {
      case '--validate':
        // Skip this flag as it's handled elsewhere -> it triggers validation mode instead of sync mode
        break;
        
      case '--method':
        const method = args[i + 1];
        appLogger.debug(`DEBUG: Found --method flag, next value: "${method}"`);
        if (['all', 'filtered', 'single'].includes(method)) {
          config.method = method as 'all' | 'filtered' | 'single';
          appLogger.debug(`DEBUG: Set config.method to: "${config.method}"`);
          
          // Special case: if method is 'single' and the next argument after that is not a flag, 
          // treat it as the student ID
          if (method === 'single' && i + 2 < args.length && !args[i + 2].startsWith('--')) {
            config.studentId = args[i + 2];
            appLogger.debug('DEBUG: Found positional student ID after single method: {StudentId}', config.studentId);
            i++; // Skip the extra positional argument
          }
        }
        i++;
        break;
        
      case '--classes':
        config.classes = args[i + 1]?.split(',') || [];
        i++;
        break;
        
      case '--grade-ids':
        config.gradeIds = args[i + 1]?.split(',') || [];
        i++;
        break;
        
      case '--student-id':
        if (config.studentIds && config.studentIds.length > 0) {
          config.studentIds.push(args[i + 1]);
        } else if (config.studentId) {
          config.studentIds = [config.studentId, args[i + 1]];
          config.studentId = undefined;
        } else {
          config.studentId = args[i + 1];
        }
        i++;
        break;

      case '--student-ids':
        config.studentIds = args[i + 1]?.split(',').map(id => id.trim()).filter(Boolean) || [];
        if (config.studentIds.length === 1 && !config.studentId) {
          config.studentId = config.studentIds[0];
        }
        i++;
        break;
        
      case '--dry-run':
        config.dryRun = args[i + 1] !== 'false';
        i++;
        break;
        
      case '--batch-size':
        const batchSize = parseInt(args[i + 1]);
        if (!isNaN(batchSize) && batchSize > 0) {
          config.batchSize = batchSize;
        }
        i++;
        break;
        
      case '--log-level':
        const logLevel = args[i + 1];
        if (['error', 'warn', 'info', 'debug'].includes(logLevel)) {
          config.logLevel = logLevel as 'error' | 'warn' | 'info' | 'debug';
        }
        i++;
        break;
        
      case '--start-year':
        config.startYear = args[i + 1];
        i++;
        break;
        
      case '--end-year':
        config.endYear = args[i + 1];
        i++;
        break;
    }
  }

  appLogger.debug('DEBUG: Final parsed config from parseCommandLineArgs: {ConfigJson}', JSON.stringify(config));

  return config;
}

// Validate all StudentService methods
async function validateAllMethods() {
  appLogger.info('═══ Validating All Student Service Methods ═══');
  
  try {
    const syncManager = new SyncManager({ dryRun: true, logLevel: 'debug' });
    const results = await syncManager.validateAllMethods();
    
    appLogger.info('Method Validation Results:');
    Object.entries(results).forEach(([method, isValid]) => {
      const status = isValid ? '✅ - YES' : '❌ - NO :(';
      appLogger.info(`${status} ${method}: ${isValid ? 'Available' : 'Failed'}`);
    });
    
    const allValid = Object.values(results).every(v => v);
    appLogger.info(`Overall Status: ${allValid ? 'All methods working' : 'Some methods failed'}`);
    
    return results;
  } catch (error: any) {
    appLogger.error('Validation failed with error: {ErrorMessage}', error.message);
    
    // Check if this is a database connection issue
    if (error.message.includes('not connected') || 
        error.message.includes('connection') || 
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('authentication') ||
        error.message.includes('login')) {
      
      appLogger.info('Database Connection Troubleshooting:');
      appLogger.info('This appears to be a database connection issue.');
      appLogger.info('');
      appLogger.info('-- Quick fixes to try:');
      appLogger.info('1. Run: npm run test-db-connection  (to get detailed diagnostics)');
      appLogger.info('2. Check your .env file has correct database settings');
      appLogger.info('3. Verify SQL Server is running');
      appLogger.info('4. Test connection with SQL Server Management Studio');
      appLogger.info('');
      appLogger.info('-- Common .env file format:');
      appLogger.info('-- DB_SERVER=localhost\\SQLEXPRESS  (or just localhost)');
      appLogger.info('-- DB_DATABASE=your_database_name');
      appLogger.info('-- DB_USER=your_username');
      appLogger.info('-- DB_PASSWORD=your_password');
      appLogger.info('-- DB_ENCRYPT=false  (for local development)');
      appLogger.info('-- DB_TRUST_SERVER_CERTIFICATE=true  (for self-signed certs)');
      
    } else {
      appLogger.info('General troubleshooting tips:');
      appLogger.info('-- Check that your database connection settings are correct in .env');
      appLogger.info('-- Verify that the SQL Server is running and accessible');
      appLogger.info('-- Ensure the database name and credentials are correct');
      appLogger.info('-- Check firewall settings if using a remote database');
      appLogger.info('-- Run: npm run test-db-connection for detailed diagnostics');
    }
    
    throw error;
  }
}

// Validate single student method
async function validateSingleStudent(studentId: string, startYear?: string, endYear?: string) {
  appLogger.info(`Validating single student sync for ID: ${studentId}`);
  appLogger.debug('DEBUG: validateSingleStudent called');
  
  try {
    appLogger.debug('DEBUG: Creating SyncManager');
    const syncManager = new SyncManager({ dryRun: true, logLevel: 'debug' });
    
    // Get current school year for defaults
    const currentSchoolYear = calculateSchoolYear();
    const start = startYear || currentSchoolYear.graduationYear;
    const end = endYear || (currentSchoolYear.endYear + 1).toString();
    
    appLogger.info(`Using school year range: ${start} - ${end}`);
    appLogger.debug('DEBUG: About to call syncManager.syncSingleStudent');
    
    // Test the single student sync
    const result = await syncManager.syncSingleStudent(studentId, start, end);
    
    appLogger.debug('DEBUG: syncSingleStudent completed');
    appLogger.debug('Validation Results:');
    appLogger.debug(`Students found: ${result.totalStudents}`);
    appLogger.debug(`Would sync: ${result.successCount}`);
    appLogger.debug(`Would fail: ${result.failedCount}`);
    appLogger.debug(`Would skip: ${result.skippedCount}`);
    
    if (result.errors.length > 0) {
      appLogger.debug('Potential issues:');
      result.errors.forEach((error, index) => {
        appLogger.debug(`   ${index + 1}. ${error}`);
      });
    }
    
    if (result.totalStudents === 0) {
      appLogger.debug('No matching student found. Check:');
      appLogger.debug(`-- Student ID exists: ${studentId}`);
      appLogger.debug(`-- Student is in school year range: ${start} - ${end}`);
      appLogger.debug(`-- Student is from videregående schools`);
      appLogger.debug(`-- Student record is active`);
    } else {
      appLogger.debug(`Single student validation successful!`);
      appLogger.debug('Ready to sync when dry-run is disabled');
    }
    
  } catch (error: any) {
    appLogger.debug(`Single student validation failed: ${error.message}`);
    throw error;
  }
}

async function validateMultipleStudents(studentIds: string[], startYear?: string, endYear?: string) {
  appLogger.info(`Validating multiple students sync`);
  appLogger.info(`Student IDs: ${studentIds.join(', ')}`);

  try {
    const syncManager = new SyncManager({ dryRun: true, logLevel: 'debug' });

    const currentSchoolYear = calculateSchoolYear();
    const start = startYear || currentSchoolYear.graduationYear;
    const end = endYear || (currentSchoolYear.endYear + 1).toString();

    appLogger.debug(`Using school year range: ${start} - ${end}`);

    const result = await syncManager.syncMultipleStudents(studentIds, start, end);

    appLogger.debug('Validation Results:');
    appLogger.debug(`Students found: ${result.totalStudents}`);
    appLogger.debug(`Would sync: ${result.successCount}`);
    appLogger.debug(`Would fail: ${result.failedCount}`);
    appLogger.debug(`Would skip: ${result.skippedCount}`);

    if (result.errors.length > 0) {
      appLogger.debug('Potential issues:');
      result.errors.forEach((error, index) => {
        appLogger.debug(`   ${index + 1}. ${error}`);
      });
    }

    appLogger.debug('Multiple student validation successful!');
    appLogger.debug('Ready to sync when dry-run is disabled');
  } catch (error: any) {
    appLogger.error(`Multiple student validation failed: ${error.message}`);
    throw error;
  }
}

// Validate filtered students method
async function validateFilteredStudents(
  classes: string[], 
  gradeIds: string[], 
  startYear?: string, 
  endYear?: string
) {
  appLogger.debug(`Validating filtered student sync`);
  appLogger.debug(`Classes: ${classes.join(', ')}`);
  appLogger.debug(`Grade IDs: ${gradeIds.join(', ')}`);
  
  try {
    const syncManager = new SyncManager({ dryRun: true, logLevel: 'info' });
    
    // Get current school year for defaults
    const currentSchoolYear = calculateSchoolYear();
    const start = startYear || currentSchoolYear.graduationYear;
    const end = endYear || (currentSchoolYear.endYear + 1).toString();
    
    appLogger.debug(`Using school year range: ${start} - ${end}`);
    
    // Test the filtered sync
    const result = await syncManager.syncStudentsByClasses(classes, gradeIds, start, end);
    
    appLogger.debug('Validation Results:');
    appLogger.debug(`Students found: ${result.totalStudents}`);
    appLogger.debug(`Would sync: ${result.successCount}`);
    appLogger.debug(`Would fail: ${result.failedCount}`);
    appLogger.debug(`Would skip: ${result.skippedCount}`);
    
    if (result.errors.length > 0) {
      appLogger.debug('Potential issues:');
      result.errors.forEach((error, index) => {
        appLogger.debug(`   ${index + 1}. ${error}`);
      });
    }
    
    if (result.totalStudents === 0) {
      appLogger.debug('No matching students found. Check:');
      appLogger.debug(`-- Classes exist: ${classes.join(', ')}`);
      appLogger.debug(`-- Grade IDs exist: ${gradeIds.join(', ')}`);
      appLogger.debug(`-- Students are in school year range: ${start} - ${end}`);
      appLogger.debug(`-- Students are from videregående schools`);
      appLogger.debug(`-- Student records are active`);
    } else {
      appLogger.debug(`Filtered student validation successful!`);
      appLogger.debug('Ready to sync when dry-run is disabled');
    }
    
  } catch (error: any) {
    appLogger.error(`Filtered student validation failed: ${error.message}`);
    throw error;
  }
}

// Run the sync
const exitWithCode = async (code: number): Promise<never> => {
  await flushLogs();
  process.exit(code);
};

if (require.main === module) {
  const args = process.argv.slice(2);
  
  appLogger.debug('DEBUG: Raw arguments: {ArgsJson}', JSON.stringify(args));
  appLogger.debug('DEBUG: Contains --validate: {HasValidate}', args.includes('--validate'));
  
  const isValidationMode = args.includes('--validate') || process.env.npm_config_validate === 'true';
  
  appLogger.debug('DEBUG: Is validation mode: {IsValidationMode}', isValidationMode);
  
  if (isValidationMode) {
    // Check if specific method validation is requested
    const config = parseCommandLineArgs();
    
    appLogger.debug('DEBUG: Parsed config: {ConfigJson}', JSON.stringify(config));
    
    if (config === null) {
      // Help was shown, exit
      exitWithCode(0);
    } else if (config.method === 'single' && config.studentId) {
      appLogger.info(`Validation mode detected. Method: ${config.method}`);
      appLogger.info(`Student ID: ${config.studentId}`);
      appLogger.debug('DEBUG: Triggering single student validation');
      // Validate single student method with specific student ID
      appLogger.info('═══ Validating Single Student Sync ═══');
      appLogger.info(`Target: Student ID ${config.studentId}`);
      
      validateSingleStudent(config.studentId, config.startYear, config.endYear)
        .then(() => {
          appLogger.info('Single student validation completed');
          return exitWithCode(0);
        })
        .catch((error) => {
          appLogger.error('Single student validation error: {ErrorMessage}', error instanceof Error ? error.message : String(error));
          return exitWithCode(1);
        });
    } else if (config.method === 'single' && config.studentIds && config.studentIds.length > 0) {
      appLogger.info(`Validation mode detected. Method: ${config.method}`);
      appLogger.info(`Student IDs: ${config.studentIds.join(', ')}`);
      appLogger.debug('DEBUG: Triggering multi-student validation');
      appLogger.info('═══ Validating Multiple Students Sync ═══');
      appLogger.info(`Target: Student IDs ${config.studentIds.join(', ')}`);

      validateMultipleStudents(config.studentIds, config.startYear, config.endYear)
        .then(() => {
          appLogger.info('Multiple student validation completed');
          return exitWithCode(0);
        })
        .catch((error) => {
          appLogger.error('Multiple student validation error: {ErrorMessage}', error instanceof Error ? error.message : String(error));
          return exitWithCode(1);
        });
    } else if (config.method === 'filtered' && config.classes && config.gradeIds) {
      appLogger.info(`Validation mode detected. Method: ${config.method}`);
      appLogger.info(`Classes: ${config.classes.join(', ')}`);
      appLogger.info(`Grade IDs: ${config.gradeIds.join(', ')}`);
      appLogger.debug('DEBUG: Triggering filtered validation');
      // Validate filtered method with specific classes
      appLogger.info('═══ Validating Filtered Student Sync ═══');
      appLogger.info(`Target: Classes ${config.classes.join(', ')}, Grades ${config.gradeIds.join(', ')}`);
      
      validateFilteredStudents(config.classes, config.gradeIds, config.startYear, config.endYear)
        .then(() => {
          appLogger.info('Filtered student validation completed');
          return exitWithCode(0);
        })
        .catch((error) => {
          appLogger.error('Filtered student validation error: {ErrorMessage}', error instanceof Error ? error.message : String(error));
          return exitWithCode(1);
        });
    } else {
      appLogger.info(`Validation mode detected. Method: ${config.method}`);
      if (config.studentId) appLogger.info(`Student ID: ${config.studentId}`);
      if (config.studentIds && config.studentIds.length > 0) appLogger.info(`Student IDs: ${config.studentIds.join(', ')}`);
      if (config.classes) appLogger.info(`Classes: ${config.classes.join(', ')}`);
      if (config.gradeIds) appLogger.info(`Grade IDs: ${config.gradeIds.join(', ')}`);
      appLogger.debug('DEBUG: Triggering validate all methods (fallback)');
      // Validate all methods (default behavior)
      appLogger.info('Specific validation not triggered. Falling back to validate all methods.');
      appLogger.info(`Reason: method='${config.method}', studentId='${config.studentId}', classes=${config.classes?.length || 0}, gradeIds=${config.gradeIds?.length || 0}`);
      
      validateAllMethods()
        .then(() => {
          appLogger.info('Validation completed');
          return exitWithCode(0);
        })
        .catch((error) => {
          appLogger.error('Validation error: {ErrorMessage}', error instanceof Error ? error.message : String(error));
          return exitWithCode(1);
        });
    }
  } else {
    const config = parseCommandLineArgs();
    
    if (config === null) {
      // Help was shown, exit
      exitWithCode(0);
    } else {
      syncStudentsToEntur(config)
      .then((result) => {
        const shouldShowGuides = !!result && (result.failedCount > 0 || result.totalStudents === 0);

        if (shouldShowGuides) {
          appLogger.info('Issues detected (failures or no matching students). Showing troubleshooting guides...');
          return demonstrateEnturSkoleskyssIntegration().then(() => demonstrateZoneConfiguration());
        }

        return undefined;
      })
      .then(() => {
        appLogger.info('Skoleskyss sync completed');
        appLogger.info('Useful commands:');
        appLogger.info('--  npm run test-entur              # Test API connection');
        appLogger.info('--  npm run sync-entur              # Run sync (dry run by default)');
        appLogger.info('--  npm run sync-entur -- --help    # Show usage help');
        appLogger.info('--  npm run sync-entur -- --validate # Test all methods');
        appLogger.info('--  npm run sync-entur -- -- --method single --dry-run false --student-ids "12345,67890" # PowerShell-safe real sync');
        return exitWithCode(0);
      })
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        appLogger.error('Unhandled error: {ErrorMessage}', errorMessage);

        if (isSetupOrConfigError(errorMessage)) {
          appLogger.info('Setup/config issue detected. Showing troubleshooting guides...');
          return demonstrateEnturSkoleskyssIntegration()
            .then(() => demonstrateZoneConfiguration())
            .then(() => exitWithCode(1));
        }

        return exitWithCode(1);
      });
    }
  }
}

