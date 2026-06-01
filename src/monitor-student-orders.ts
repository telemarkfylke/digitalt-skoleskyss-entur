import dotenv from 'dotenv';
import path from 'path';
import { appendFile, mkdir } from 'fs/promises';
import { DatabaseService } from './services/database.service';
import { CustomQueryMonitor } from './services/custom-query-monitor.service';
import { calculateSchoolYear, filterOverriddenOrders, formatSchoolYear, mapStudentRecordToEnturRequest } from './utils';
import { appLogger, flushLogs } from './services/logger.service';
import { EnturApiService } from './services/entur-skoleskyss.service';

dotenv.config();

type ChangeType = 'new' | 'updated' | 'removed';

interface OrderRecord {
  OrdersId: string | number;
  OverridesOrderId?: string | number | null;
  StudentId: string | number;
  PrimaryStatus?: string | number;
  StartDate: string;
  EndDate: string;
  StudentName?: string;
  StudentMiddleName?: string;
  StudentLastName?: string;
  PhoneNumber?: string;
  EmailAddress?: string;
  SchoolId?: string | number;
  SchoolName?: string;
  SchoolClassId?: string | number;
  SchoolClassName?: string;
}

interface MonitorSummary {
  newOrders: number;
  updatedOrders: number;
  removedOrders: number;
  errors: number;
}

const AUDIT_DIR = path.join(process.cwd(), 'logs');
const AUDIT_LOG_FILE = path.join(AUDIT_DIR, 'student-order-monitor.audit.log');
const ERROR_LOG_FILE = path.join(AUDIT_DIR, 'student-order-monitor.error.log');
const CRITICAL_LOG_FILE = path.join(AUDIT_DIR, 'student-order-monitor.critical.log');
const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || '';

const summary: MonitorSummary = {
  newOrders: 0,
  updatedOrders: 0,
  removedOrders: 0,
  errors: 0
};

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const ensureAuditDir = async (): Promise<void> => {
  await mkdir(AUDIT_DIR, { recursive: true });
};

const writeJsonLine = async (filePath: string, payload: unknown): Promise<void> => {
  await ensureAuditDir();
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
};

const sendTeamsNotification = async (title: string, details: string): Promise<void> => {
  if (!TEAMS_WEBHOOK_URL) {
    appLogger.warn('TEAMS_WEBHOOK_URL not configured. Skipping Teams notification.');
    return;
  }

  try {
    const response = await fetch(TEAMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `**${title}**\n\n${details}`
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Teams webhook failed (${response.status}): ${body}`);
    }
  } catch (error) {
    appLogger.error('Failed sending Teams notification: {ErrorMessage}', error instanceof Error ? error.message : String(error));
  }
};

const withRetry = async <T>(
  operation: () => Promise<T>,
  context: { changeType: ChangeType; studentId: string | number; orderId: string | number },
  maxAttempts = 3,
  baseDelayMs = 500
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const errorMessage = error instanceof Error ? error.message : String(error);

      await writeJsonLine(ERROR_LOG_FILE, {
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'entur_process_failed_attempt',
        attempt,
        maxAttempts,
        changeType: context.changeType,
        studentId: context.studentId,
        orderId: context.orderId,
        error: errorMessage
      });

      if (attempt < maxAttempts) {
        const backoffMs = baseDelayMs * Math.pow(2, attempt - 1);
        appLogger.warn(
          'Retrying Entur request for order {OrderId}, attempt {Attempt}/{MaxAttempts} in {BackoffMs}ms. Error: {ErrorMessage}',
          context.orderId,
          attempt + 1,
          maxAttempts,
          backoffMs,
          errorMessage
        );
        await delay(backoffMs);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const mapRecordToEnturRequest = (enturService: EnturApiService, record: OrderRecord) => {
  return mapStudentRecordToEnturRequest(enturService, record, {
    overrideEndDateWhenPrimaryStatusNot2: true
  });
};

const processEnturChange = async (
  enturService: EnturApiService,
  changeType: ChangeType,
  record: OrderRecord
): Promise<void> => {
  const context = {
    changeType,
    studentId: record.StudentId,
    orderId: record.OrdersId
  };

  await writeJsonLine(AUDIT_LOG_FILE, {
    timestamp: new Date().toISOString(),
    level: 'info',
    event: 'change_detected',
    ...context,
    student: {
      firstName: record.StudentName,
      middleName: record.StudentMiddleName,
      lastName: record.StudentLastName,
      schoolName: record.SchoolName,
      className: record.SchoolClassName,
      email: record.EmailAddress
    }
  });

  if (changeType === 'removed') {
    // Cancel/delete endpoint is not implemented yet. Keep an audit trail and mark as processed.
    appLogger.warn('Removed order {OrderId} detected. Entur cancel endpoint is not implemented; audit logged only.', record.OrdersId);
    return;
  }

  await withRetry(async () => {
    const request = mapRecordToEnturRequest(enturService, record);
    await enturService.createSkoleskyss(request);
  }, context);
};

const getMsUntilNextDailySummary = (): number => {
  const now = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next.getTime() - now.getTime();
};

const sendDailySummaryToTeams = async (): Promise<void> => {
  const details = [
    `New orders: ${summary.newOrders}`,
    `Updated orders: ${summary.updatedOrders}`,
    `Removed orders: ${summary.removedOrders}`,
    `Errors: ${summary.errors}`
  ].join('\n');

  await sendTeamsNotification('Daily Student Order Monitor Summary', details);

  summary.newOrders = 0;
  summary.updatedOrders = 0;
  summary.removedOrders = 0;
  summary.errors = 0;
};

const scheduleDailySummary = (): void => {
  const timeoutMs = getMsUntilNextDailySummary();
  setTimeout(async () => {
    await sendDailySummaryToTeams();
    scheduleDailySummary();
  }, timeoutMs);
};

const exitWithCode = async (code: number): Promise<never> => {
  await flushLogs();
  process.exit(code);
};

async function monitorActiveStudentOrders() {
  const dbService = new DatabaseService();
  const queryMonitor = new CustomQueryMonitor(dbService);
  const enturService = new EnturApiService();

  try {
    appLogger.info('Starting Active Student Orders Monitoring...');
    
    // Calculate current school year dynamically
    const currentSchoolYear = calculateSchoolYear();
    appLogger.info(`Monitoring school year: ${formatSchoolYear(currentSchoolYear, 'full')} (graduation: ${currentSchoolYear.graduationYear})`);
    
    // Connect to database
    await dbService.connect();
    appLogger.info('Database connected (read-only)');

    // Set up event handlers
    queryMonitor.on('change', async (change) => {
      try {
      appLogger.info('STUDENT ORDERS CHANGE DETECTED!');
      appLogger.info(`Operation: ${change.operation}`);
      appLogger.info(`Total Records: ${change.totalRecords}`);
      appLogger.info(`Time: ${change.timestamp.toISOString()}`);
      appLogger.info('---');

      // Handle different types of changes
      switch (change.operation) {
        case 'NEW_RECORDS':
          appLogger.info(`${change.newRecords.length} new student orders found:`);
          change.newRecords.forEach((record: any, index: number) => {
            if (index < 3) { // Show first 3 new records
              appLogger.info(`Order ID: ${record.OrdersId}, Student: ${record.StudentName} ${record.StudentMiddleName || ''} ${record.StudentLastName || ''}`);
              appLogger.info(`School: ${record.SchoolName}, OrderUpdated: ${record.OrderUpdated}`);
            }
          });
          if (change.newRecords.length > 3) {
            appLogger.info(`   ...(${change.newRecords.length - 3} more new orders)`);
          }
          break;

        case 'UPDATED_RECORDS':
          appLogger.info(`${change.changedRecords.length} student orders updated:`);
          change.changedRecords.forEach((change: any, index: number) => {
            if (index < 2) { // Show first 2 changes
              appLogger.info(`Order ID: ${change.current.OrdersId}, Student: ${change.current.StudentName} ${change.current.StudentMiddleName || ''} ${change.current.StudentLastName || ''}`);
              appLogger.info(`Previous OrderUpdated: ${change.previous.OrderUpdated}`);
              appLogger.info(`New OrderUpdated: ${change.current.OrderUpdated}`);
              appLogger.info(`Previous PersonUpdated: ${change.previous.PersonUpdated}`);
              appLogger.info(`New PersonUpdated: ${change.current.PersonUpdated}`);
            }
          });
          if (change.changedRecords.length > 2) {
            appLogger.info(`...(${change.changedRecords.length - 2} more updated orders)`);
          }
          break;

        case 'REMOVED_RECORDS':
          appLogger.info(`${change.removedRecords.length} student orders no longer match criteria`);
          break;

        case 'DATA_CHANGED':
          appLogger.info(`Mixed changes detected:`);
          appLogger.info(`New: ${change.newRecords.length}, Updated: ${change.changedRecords.length}, Removed: ${change.removedRecords.length}`);
          break;
      }

      appLogger.info('Processing change event...');
      const tasks: Array<Promise<void>> = [];

      const newFilter = filterOverriddenOrders<OrderRecord>(change.newRecords as OrderRecord[]);
      const updatedFilter = filterOverriddenOrders<OrderRecord>(change.changedRecords.map((recordChange: any) => recordChange.current as OrderRecord));
      const removedFilter = filterOverriddenOrders<OrderRecord>(change.removedRecords as OrderRecord[]);

      const excludedOverriddenCount = newFilter.excluded + updatedFilter.excluded + removedFilter.excluded;
      if (excludedOverriddenCount > 0) {
        appLogger.info('Excluded {ExcludedCount} overridden order(s) from processing in this change event.', excludedOverriddenCount);
      }

      const enqueue = (changeType: ChangeType, record: OrderRecord) => {
        tasks.push(
          (async () => {
            try {
              await processEnturChange(enturService, changeType, record);
              if (changeType === 'new') summary.newOrders++;
              if (changeType === 'updated') summary.updatedOrders++;
              if (changeType === 'removed') summary.removedOrders++;
            } catch (error) {
              summary.errors++;
              const errorMessage = error instanceof Error ? error.message : String(error);

              await writeJsonLine(CRITICAL_LOG_FILE, {
                timestamp: new Date().toISOString(),
                level: 'critical',
                event: 'entur_process_failed_after_retries',
                changeType,
                studentId: record.StudentId,
                orderId: record.OrdersId,
                error: errorMessage,
                student: {
                  firstName: record.StudentName,
                  middleName: record.StudentMiddleName,
                  lastName: record.StudentLastName,
                  schoolName: record.SchoolName,
                  className: record.SchoolClassName,
                  email: record.EmailAddress
                }
              });

              await sendTeamsNotification(
                'Critical Entur Sync Failure',
                [
                  `Change type: ${changeType}`,
                  `Order ID: ${record.OrdersId}`,
                  `Student ID: ${record.StudentId}`,
                  `Student: ${record.StudentName || ''} ${record.StudentMiddleName || ''} ${record.StudentLastName || ''}`.trim(),
                  `Error: ${errorMessage}`
                ].join('\n')
              );
            }
          })()
        );
      };

      newFilter.filtered.forEach((record) => enqueue('new', record));
      updatedFilter.filtered.forEach((record) => enqueue('updated', record));
      removedFilter.filtered.forEach((record) => enqueue('removed', record));

      await Promise.all(tasks);
      appLogger.info('Finished processing change event: {TaskCount} item(s)', tasks.length);
      } catch (error) {
        appLogger.error('Unhandled monitor change handler error: {ErrorMessage}', error instanceof Error ? error.message : String(error));
      }

    });

    queryMonitor.on('error', (error) => {
      appLogger.error('Query monitoring error: {ErrorMessage}', error instanceof Error ? error.message : String(error));
    });

    const studentOrdersConfig = {
      name: `ActiveStudentOrders${currentSchoolYear.graduationYear}`,
      query: `
       SELECT 
          o.Id as OrdersId,
          OverridesOrderId,
          o.StudentId,
          o.FromDate as StartDate,
          o.ToDate as EndDate,
          o.CreatedTime,
          o.UpdatedTime as OrderUpdated,
          o.PrimaryStatus,
	        o.SecondaryStatus,
          p.FirstName as StudentName,
          p.MiddleName as StudentMiddleName,
          p.LastName as StudentLastName,
          p.PhoneNumber,
          p.EmailAddress,
          p.UpdatedTime as PersonUpdated,
          s.id as SchoolId,
          s.Name as SchoolName,
          sc.Id as SchoolClassId,
          sc.Name as SchoolClassName,
          sc.GradeId as SchoolGradeId
        FROM dbo.Orders o
        INNER JOIN dbo.People p ON p.Id = o.StudentId
        INNER JOIN dbo.Schools s ON s.Id = o.SchoolId
        INNER JOIN dbo.SchoolClasses sc ON sc.Id = o.SchoolClassId
        INNER JOIN dbo.OrderParts op ON o.Id = op.OrderId
        WHERE o.ToDate >= '2026-01-01'
          AND o.ToDate < '2027-01-01'
          AND s.Type = 1
          AND p.Discriminator LIKE 'Student'
          AND p.IsActive = 1
          AND UsesMassTransit = 1
        ORDER BY o.ToDate DESC
      `,
      interval: 5000, // Check every 5 seconds
      keyColumns: ['OrdersId'], // Use Order ID as unique identifier
      // Use updatedTime and studentUpdatedTime to detect all changes, BUT! EnTur dont need to know if a field they dont use is updated. 
      // In the future if we start to use zones, we need to monitor changes in the zones fiels (currently not needed)
      compareColumns: ['OverridesOrderId', 'StartDate', 'EndDate', 'StudentName', 'StudentMiddleName', 'StudentLastName', 'PhoneNumber', 'EmailAddress', 'SchoolId', 'SchoolName', 'SchoolClassId', 'SchoolClassName', 'SchoolGradeId', 'PrimaryStatus'] // Monitor these columns for changes
    };

    // Start monitoring
    queryMonitor.startMonitoring(studentOrdersConfig);
    
    appLogger.info('Listening for changes in Active Student Orders...');
    appLogger.info('This monitors your specific filtered dataset:');
    appLogger.info(`Orders from ${formatSchoolYear(currentSchoolYear, 'full')} school year`);
    appLogger.info(`Graduation year: ${currentSchoolYear.graduationYear}`);
    appLogger.info('Type 1 schools only (videregående)');
    appLogger.info('Active students only');
    appLogger.info('Ordered by UpdatedTime');
    appLogger.info('Changes will be detected when:');
    appLogger.info('New orders match your criteria');
    appLogger.info('Existing orders are updated');
    appLogger.info('Orders no longer match criteria (e.g., student becomes inactive)');
    appLogger.info('Related data changes (school type, student status, etc.)');
    appLogger.info('Press Ctrl+C to stop monitoring...');

    // Send one summary notification every day at midnight.
    scheduleDailySummary();

    // Optional: Show current statistics every 30 seconds
    setInterval(async () => {
      try {
        const stats = queryMonitor.getMonitoringStats();
        appLogger.info(`Current monitoring status:`);
        for (const [queryName, stat] of Object.entries(stats)) {
          appLogger.info(`${queryName}: ${(stat as any).recordCount} records, Active: ${(stat as any).isActive}`);
        }
      } catch (error) {
        appLogger.error('Could not get stats: {ErrorMessage}', error instanceof Error ? error.message : String(error));
      }
    }, 30000);

  } catch (error) {
    appLogger.error('Failed to start monitoring: {ErrorMessage}', error instanceof Error ? error.message : String(error));
    return exitWithCode(1);
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    appLogger.info('Shutting down monitoring...');
    queryMonitor.stopAll();
    await dbService.disconnect();
    appLogger.info('Monitoring stopped');
    return exitWithCode(0);
  });

  process.on('SIGTERM', async () => {
    appLogger.info('Received SIGTERM...');
    queryMonitor.stopAll();
    await dbService.disconnect();
    return exitWithCode(0);
  });
}

monitorActiveStudentOrders();
