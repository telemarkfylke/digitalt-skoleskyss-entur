import './env';
import path from 'path';
import { appendFile, mkdir } from 'fs/promises';
import { DatabaseService } from './services/database.service';
import { CustomQueryMonitor } from './services/custom-query-monitor.service';
import { calculateSchoolYear, filterOverriddenOrders, formatSchoolYear, formatSchoolYearRange, getSchoolYearRange, mapStudentRecordToEnturRequest, dedupeByOrderId, decideUpdateDispatchAction } from './utils';
import { appLogger, flushLogs } from './services/logger.service';
import { EnturApiService } from './services/entur-skoleskyss.service';
import { QueueService } from './services/queue.service';
import { sendTeamsNotification } from './services/teams-notifier.service';

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

const summary: MonitorSummary = {
  newOrders: 0,
  updatedOrders: 0,
  removedOrders: 0,
  errors: 0
};

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

class EnturValidationError extends Error {
  constructor(public readonly validationErrors: string[]) {
    super(`Entur request validation failed: ${validationErrors.join('; ')}`);
    this.name = 'EnturValidationError';
  }
}

const ensureAuditDir = async (): Promise<void> => {
  await mkdir(AUDIT_DIR, { recursive: true });
};

const writeJsonLine = async (filePath: string, payload: unknown): Promise<void> => {
  await ensureAuditDir();
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
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

  const request = mapRecordToEnturRequest(enturService, record);
  const validation = enturService.validateSkoleskyssRequest(request);
  if (!validation.isValid) {
    throw new EnturValidationError(validation.errors);
  }

  await withRetry(async () => {
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

const SCHOOL_YEAR_ROLLOVER_CHECK_MS = 60 * 60 * 1000; // hourly

const scheduleSchoolYearRolloverWatchdog = (startupYearString: string): void => {
  let alerted = false;

  setInterval(async () => {
    const currentYearString = calculateSchoolYear().yearString;
    if (alerted || currentYearString === startupYearString) return;

    alerted = true;
    const details = [
      `Monitor started for school year ${startupYearString}, but it is now ${currentYearString}.`,
      'The query window is fixed at startup, so no orders from the new school year are being detected.',
      'Restart the monitor, then run: npm run sync-entur-queue-rebuild'
    ].join('\n');

    appLogger.error(
      'School year rolled over from {StartupYear} to {CurrentYear} — monitor is still querying the old window. Restart required.',
      startupYearString,
      currentYearString
    );

    await writeJsonLine(CRITICAL_LOG_FILE, {
      timestamp: new Date().toISOString(),
      level: 'critical',
      event: 'school_year_rollover_restart_required',
      startupSchoolYear: startupYearString,
      currentSchoolYear: currentYearString
    });

    await sendTeamsNotification('Monitor school year rollover — restart required', details);
  }, SCHOOL_YEAR_ROLLOVER_CHECK_MS);
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
    
    // Calculate current school year dynamically. Note this is resolved once, at startup —
    // the rollover watchdog below alerts if the calendar moves past it.
    const currentSchoolYear = calculateSchoolYear();
    const schoolYearRange = getSchoolYearRange(currentSchoolYear);
    appLogger.info(
      `Monitoring school year: ${formatSchoolYear(currentSchoolYear, 'full')} (orders overlapping ${formatSchoolYearRange(schoolYearRange)})`
    );
    
    // Connect to database
    await dbService.connect();
    appLogger.info('Database connected (read-only)');

    const queueService = new QueueService(process.env.SYNC_QUEUE_FILE ?? './queue/sync-queue.json');
    queueService.loadQueue();

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
              const isValidationError = error instanceof EnturValidationError;

              await writeJsonLine(CRITICAL_LOG_FILE, {
                timestamp: new Date().toISOString(),
                level: 'critical',
                event: isValidationError ? 'entur_validation_failed_skipped' : 'entur_process_failed_after_retries',
                changeType,
                studentId: record.StudentId,
                orderId: record.OrdersId,
                error: errorMessage,
                ...(isValidationError ? { validationErrors: (error as EnturValidationError).validationErrors } : {}),
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
                isValidationError ? 'Entur Request Validation Failed (Not Sent)' : 'Critical Entur Sync Failure',
                [
                  `Change type: ${changeType}`,
                  `Order ID: ${record.OrdersId}`,
                  `Student ID: ${record.StudentId}`,
                  `Student: ${record.StudentName || ''} ${record.StudentMiddleName || ''} ${record.StudentLastName || ''}`.trim(),
                  isValidationError
                    ? `Validation errors: ${(error as EnturValidationError).validationErrors.join('; ')}`
                    : `Error: ${errorMessage}`
                ].join('\n')
              );
            }
          })()
        );
      };

      // New records are added to the queue for rate-limited batch processing by the scheduler.
      const { deduped: newRecordsDeduped, duplicates: newRecordsDuplicates } = dedupeByOrderId(newFilter.filtered);
      if (newRecordsDuplicates > 0) {
        appLogger.warn('Removed {DuplicateCount} duplicate OrdersId record(s) from new-records batch before queueing', newRecordsDuplicates);
      }
      for (const record of newRecordsDeduped) {
        await writeJsonLine(AUDIT_LOG_FILE, {
          timestamp: new Date().toISOString(),
          level: 'info',
          event: 'change_detected',
          changeType: 'new',
          studentId: record.StudentId,
          orderId: record.OrdersId,
          student: {
            firstName: record.StudentName,
            middleName: record.StudentMiddleName,
            lastName: record.StudentLastName,
            schoolName: record.SchoolName,
            className: record.SchoolClassName,
            email: record.EmailAddress,
          },
        });
        const wasAdded = queueService.addEntry({
          ordersId: String(record.OrdersId),
          studentId: String(record.StudentId),
          startDate: String(record.StartDate),
        });
        if (wasAdded) summary.newOrders++;
      }
      if (newRecordsDeduped.length > 0) {
        appLogger.info('{Count} new student(s) added to queue for scheduled processing', newRecordsDeduped.length);
      }

      // Updates go directly to Entur (immediate, not rate-limited), unless the order's
      // queue entry shows it hasn't actually been sent yet — in that case the scheduled
      // drain will pick up fresh DB data, so a direct send here would race/duplicate it.
      for (const record of updatedFilter.filtered) {
        const ordersId = String(record.OrdersId);
        const decision = decideUpdateDispatchAction(queueService.getEntry(ordersId));

        if (decision.action === 'skip') {
          appLogger.info('Order {OrderId} update skipped: queue entry already pending; scheduled drain will use fresh DB data.', ordersId);
          await writeJsonLine(AUDIT_LOG_FILE, {
            timestamp: new Date().toISOString(),
            level: 'info',
            event: 'updated_skipped_queue_pending',
            orderId: ordersId,
            studentId: record.StudentId
          });
          continue;
        }

        if (decision.action === 'requeue') {
          queueService.addEntry({ ordersId, studentId: String(record.StudentId), startDate: String(record.StartDate) });
          appLogger.warn('Order {OrderId} update re-queued after prior failed send; will retry on next scheduled drain.', ordersId);
          await writeJsonLine(AUDIT_LOG_FILE, {
            timestamp: new Date().toISOString(),
            level: 'info',
            event: 'updated_requeued_after_failed',
            orderId: ordersId,
            studentId: record.StudentId
          });
          continue;
        }

        if (decision.reason === 'no_queue_entry') {
          appLogger.warn('Order {OrderId} update has no queue entry (unusual state) — sending directly to Entur.', ordersId);
          await writeJsonLine(AUDIT_LOG_FILE, {
            timestamp: new Date().toISOString(),
            level: 'warn',
            event: 'updated_sent_no_queue_entry',
            orderId: ordersId,
            studentId: record.StudentId
          });
        }

        enqueue('updated', record);
      }

      // Removals go directly to Entur (immediate, not rate-limited).
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
      name: `ActiveStudentOrders${currentSchoolYear.yearString}`,
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
        WHERE o.ToDate >= @param0
          AND o.FromDate < @param1
          AND s.Type = 1
          AND p.Discriminator LIKE 'Student'
          AND p.IsActive = 1
          AND UsesMassTransit = 1
        ORDER BY o.ToDate DESC
      `,

      params: [
        schoolYearRange.start, // School year start (August 1st), inclusive
        schoolYearRange.end, // School year end (August 1st the year after), exclusive
      ],
      interval: 5000, // Check every 5 seconds
      keyColumns: ['OrdersId'], // Use Order ID as unique identifier
      // Use updatedTime and studentUpdatedTime to detect all changes, BUT! EnTur dont need to know if a field they dont use is updated.
      // In the future if we start to use zones, we need to monitor changes in the zones fiels (currently not needed)
      compareColumns: ['OverridesOrderId', 'StartDate', 'EndDate', 'StudentName', 'StudentMiddleName', 'StudentLastName', 'PhoneNumber', 'EmailAddress', 'SchoolId', 'SchoolName', 'SchoolClassId', 'SchoolClassName', 'SchoolGradeId', 'PrimaryStatus'] // Monitor these columns for changes
    };

    // Startup reconciliation: catch any records added to the DB while the monitor was down.
    // CustomQueryMonitor silently establishes a baseline on first poll, so records that arrived
    // during downtime would otherwise never emit a NEW_RECORDS event.
    try {
      const currentRecords = await queryMonitor.getCurrentResults(studentOrdersConfig);
      const { deduped: currentRecordsDeduped, duplicates: currentRecordsDuplicates } = dedupeByOrderId(currentRecords);
      if (currentRecordsDuplicates > 0) {
        appLogger.warn('Removed {DuplicateCount} duplicate OrdersId record(s) from startup reconciliation batch', currentRecordsDuplicates);
      }
      let reconciled = 0;
      for (const record of currentRecordsDeduped) {
        const wasAdded = queueService.addEntry({
          ordersId: String(record.OrdersId),
          studentId: String(record.StudentId),
          startDate: String(record.StartDate),
        });
        if (wasAdded) reconciled++;
      }
      appLogger.info(
        'Queue reconciliation on startup: {Reconciled} new entries added ({Total} DB records checked)',
        reconciled,
        currentRecordsDeduped.length
      );
    } catch (error) {
      appLogger.warn(
        'Queue reconciliation failed — monitor will still start: {ErrorMessage}',
        error instanceof Error ? error.message : String(error)
      );
    }

    // Start monitoring
    queryMonitor.startMonitoring(studentOrdersConfig);
    
    appLogger.info('Listening for changes in Active Student Orders...');
    appLogger.info('This monitors your specific filtered dataset:');
    appLogger.info(`Orders overlapping the ${formatSchoolYear(currentSchoolYear, 'full')} school year`);
    appLogger.info(`Order date range: ${formatSchoolYearRange(schoolYearRange)}`);
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

    // The query window above is fixed for the lifetime of this process. Once the calendar
    // rolls past the school year it was built for, the monitor keeps querying the old one and
    // silently sees none of the new year's orders. Alert once so an operator can restart.
    scheduleSchoolYearRolloverWatchdog(currentSchoolYear.yearString);

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
