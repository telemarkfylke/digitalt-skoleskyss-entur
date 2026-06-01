import { DatabaseService } from './services/database.service';
import { StudentService } from './services/student.service';
import { EnturApiService, PostSkoleskyssRequest } from './services/entur-skoleskyss.service';
import { appLogger } from './services/logger.service';
import { StudentWithDetails } from './types/user.types';
import { calculateSchoolYear, mapStudentRecordToEnturRequest } from './utils';

/**
 * SyncManager is responsible for orchestrating the synchronization of student data with the Entur API.
 * It provides methods to sync all students, filter by classes, sync individual students, and handle batch processing.
 * The class also includes a method to validate the functionality of all StudentService methods before attempting synchronization.
 */

export interface SyncOptions {
  dryRun?: boolean;
  batchSize?: number;
  maxRetries?: number;
  delayBetweenBatches?: number;
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
}

export interface SyncResult {
  totalStudents: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  errors: string[];
  duration: number;
}

export class SyncManager {
  private db: DatabaseService;
  private studentService: StudentService;
  private enturService: EnturApiService;
  private options: Required<SyncOptions>;

  constructor(options: SyncOptions = {}) {
    this.db = new DatabaseService();
    this.studentService = new StudentService(this.db);
    this.enturService = new EnturApiService();
    
    this.options = {
      dryRun: options.dryRun ?? true,
      batchSize: options.batchSize ?? 10,
      maxRetries: options.maxRetries ?? 3,
      delayBetweenBatches: options.delayBetweenBatches ?? 1000,
      logLevel: options.logLevel ?? 'debug'
    };
    
    // Verify that the student service is using the same database instance
    appLogger.info('SyncManager database service instances created');
  }

  private log(level: string, message: string) {
    const levels = ['error', 'warn', 'info', 'debug'];
    const currentLevel = levels.indexOf(this.options.logLevel);
    const messageLevel = levels.indexOf(level);

    if (messageLevel <= currentLevel) {
      switch (level) {
        case 'error':
          appLogger.error(message);
          break;
        case 'warn':
          appLogger.warn(message);
          break;
        case 'debug':
          appLogger.debug(message);
          break;
        default:
          appLogger.info(message);
      }
    }
  }

  async syncAllStudents(startYear?: string, endYear?: string): Promise<SyncResult> {
    const currentSchoolYear = calculateSchoolYear();
    const start = startYear || currentSchoolYear.graduationYear;
    const end = endYear || (currentSchoolYear.endYear + 1).toString();

    this.log('info', `Syncing all videregående students for ${start}-${end}`);
    
    const students = await this.studentService.getVideregaaendeStudents(start, end);
    return this.processBatch(students, 'all-students');
  }

  async syncStudentsByClasses(
    classes: string[], 
    gradeIds: string[], 
    startYear?: string, 
    endYear?: string
  ): Promise<SyncResult> {
    const currentSchoolYear = calculateSchoolYear();
    const start = startYear || currentSchoolYear.graduationYear;
    const end = endYear || (currentSchoolYear.endYear + 1).toString();

    this.log('info', `Syncing students from classes: ${classes.join(', ')}`);
    
    const students = await this.studentService.getVideregaaendeStudentsFromClasses(
      start, end, classes, gradeIds
    );
    return this.processBatch(students, 'filtered-students');
  }

  async syncSingleStudent(
    studentId: string, 
    startYear?: string, 
    endYear?: string
  ): Promise<SyncResult> {
    const currentSchoolYear = calculateSchoolYear();
    const start = startYear || currentSchoolYear.graduationYear;
    const end = endYear || (currentSchoolYear.endYear + 1).toString();

    this.log('info', `Syncing single student: ${studentId}`);
    this.log('debug', 'SyncManager.syncSingleStudent called');
    this.log('debug', 'About to call studentService.getSingleStudent');
    
    const students = await this.studentService.getSingleStudent(start, end, studentId);
    
    this.log('debug', 'studentService.getSingleStudent completed');
    this.log('debug', `Found ${students.length} students`);
    
    return this.processBatch(students, 'single-student');
  }

  async syncMultipleStudents(
    studentIds: string[],
    startYear?: string,
    endYear?: string
  ): Promise<SyncResult> {
    const normalizedStudentIds = [...new Set(studentIds.map(id => id.trim()).filter(Boolean))];

    if (normalizedStudentIds.length === 0) {
      throw new Error('syncMultipleStudents requires at least one student ID');
    }

    this.log('info', `Syncing ${normalizedStudentIds.length} students with single-student flow`);

    const startTime = Date.now();
    const aggregateResult: SyncResult = {
      totalStudents: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      errors: [],
      duration: 0
    };

    for (const studentId of normalizedStudentIds) {
      try {
        const singleResult = await this.syncSingleStudent(studentId, startYear, endYear);
        aggregateResult.totalStudents += singleResult.totalStudents;
        aggregateResult.successCount += singleResult.successCount;
        aggregateResult.failedCount += singleResult.failedCount;
        aggregateResult.skippedCount += singleResult.skippedCount;
        aggregateResult.errors.push(
          ...singleResult.errors.map(error => `[Student ${studentId}] ${error}`)
        );
      } catch (error: any) {
        aggregateResult.failedCount += 1;
        aggregateResult.errors.push(`[Student ${studentId}] ${error.message}`);
      }
    }

    aggregateResult.duration = Date.now() - startTime;
    return aggregateResult;
  }

  async syncWithFallback(
    primaryMethod: () => Promise<StudentWithDetails[]>,
    fallbackMethod: () => Promise<StudentWithDetails[]>,
    methodName: string
  ): Promise<SyncResult> {
    try {
      this.log('info', `Attempting primary method: ${methodName}`);
      const students = await primaryMethod();
      return this.processBatch(students, methodName);
    } catch (error: any) {
      this.log('warn', `Primary method failed: ${error.message}`);
      this.log('info', 'Attempting fallback method...');
      
      const students = await fallbackMethod();
      return this.processBatch(students, `${methodName}-fallback`);
    }
  }

  private async processBatch(
    students: StudentWithDetails[], 
    operation: string
  ): Promise<SyncResult> {
    const startTime = Date.now();
    const result: SyncResult = {
      totalStudents: students.length,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      errors: [],
      duration: 0
    };

    this.log('info', `Processing ${students.length} students for ${operation}`);

    try {
      await this.db.connect();
      
      // Test Entur connection
      const enturConnected = await this.enturService.testConnection();
      if (!enturConnected) {
        throw new Error('Failed to connect to Entur API');
      }

      // Process in batches
      for (let i = 0; i < students.length; i += this.options.batchSize) {
        const batch = students.slice(i, i + this.options.batchSize);
        this.log('info', `Processing batch ${Math.floor(i / this.options.batchSize) + 1}/${Math.ceil(students.length / this.options.batchSize)}`);

        const batchResult = await this.processSingleBatch(batch);
        result.successCount += batchResult.successCount || 0;
        result.failedCount += batchResult.failedCount || 0;
        result.skippedCount += batchResult.skippedCount || 0;
        result.errors.push(...(batchResult.errors || []));

        // Delay between batches to avoid overwhelming the API
        if (i + this.options.batchSize < students.length) {
          await this.delay(this.options.delayBetweenBatches);
        }
      }

    } finally {
      await this.db.disconnect();
      result.duration = Date.now() - startTime;
    }

    this.log('info', `Sync completed: ${result.successCount} success, ${result.failedCount} failed, ${result.skippedCount} skipped`);
    return result;
  }

  private async processSingleBatch(students: StudentWithDetails[]): Promise<{
    successCount: number;
    failedCount: number;
    skippedCount: number;
    errors: string[];
  }> {
    const result = { successCount: 0, failedCount: 0, skippedCount: 0, errors: [] as string[] };

    // Convert students to Entur requests
    const requests: PostSkoleskyssRequest[] = students.map(student => {
      this.log('debug', `Processing student with ID: ${student.StudentId}`);
      try {
        const studentRef = `${student.StudentId}`;
        appLogger.debug('Mapping student {StudentId} order {OrderId} to Entur request', studentRef, String(student.OrdersId));

        return mapStudentRecordToEnturRequest(this.enturService, {
          OrdersId: student.OrdersId,
          StudentId: student.StudentId,
          PrimaryStatus: (student as any).PrimaryStatus,
          StartDate: student.StartDate,
          EndDate: student.EndDate,
          StudentName: student.StudentName,
          StudentMiddleName: student.StudentMiddleName,
          StudentLastName: student.StudentLastName,
          PhoneNumber: student.PhoneNumber,
          EmailAddress: student.EmailAddress,
          SchoolId: student.SchoolId,
          SchoolName: student.SchoolName || 'Unknown School',
          SchoolClassId: student.SchoolClassId,
          SchoolClassName: student.SchoolClassName || undefined
        });
      } catch (error: any) {
        result.errors.push(`Failed to create request for student ${student.StudentId}: ${error.message}`);
        result.failedCount++;
        return null;
      }
    }).filter((request): request is PostSkoleskyssRequest => request !== null);

    // Validate requests
    const validRequests = requests.filter(request => {
      const validation = this.enturService.validateSkoleskyssRequest(request);
      if (!validation.isValid) {
        result.errors.push(`Validation failed for student ${request.studentId}: ${validation.errors.join(', ')}`);
        result.failedCount++;
        return false;
      }
      return true;
    });

    if (this.options.dryRun) {
      this.log('info', `DRY RUN: Would sync ${validRequests.length} valid requests`);
      result.successCount = validRequests.length;
      return result;
    }

    // Actually sync to Entur
    if (validRequests.length > 0) {
      try {
        const syncResult = await this.enturService.createManySkoleskyssSequentially(validRequests);
        result.successCount += syncResult.success;
        result.failedCount += syncResult.failed;
        
        // Add specific error details
        syncResult.results.filter(r => !r.success).forEach(r => {
          result.errors.push(`Student ${r.request.studentId}: ${r.error}`);
        });
      } catch (error: any) {
        result.errors.push(`Batch sync failed: ${error.message}`);
        result.failedCount += validRequests.length;
      }
    }

    return result;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async validateAllMethods(): Promise<{ [method: string]: boolean }> {
    const results: { [method: string]: boolean } = {};
    const currentSchoolYear = calculateSchoolYear();

    try {
      this.log('info', 'Connecting to database for validation...');
      await this.db.connect();
      this.log('info', `Database connected successfully. Connected: ${this.db.isConnected()}`);

      // Test StudentService database access first
      this.log('info', 'Testing StudentService database access...');
      const studentDbTest = await this.studentService.testDatabaseAccess();
      if (!studentDbTest) {
        throw new Error('StudentService cannot access database properly');
      }
      this.log('info', 'StudentService database access: ✅ Success');

      // Test all methods
      this.log('info', 'Testing getVideregaaendeStudents method...');
      try {
        await this.studentService.getVideregaaendeStudents(
          currentSchoolYear.graduationYear, 
          (currentSchoolYear.endYear + 1).toString()
        );
        results.getVideregaaendeStudents = true;
        this.log('info', 'getVideregaaendeStudents: ✅ Success');
      } catch (error: any) {
        this.log('error', `getVideregaaendeStudents failed: ${error.message}`);
        results.getVideregaaendeStudents = false;
      }

      this.log('info', 'Testing getVideregaaendeStudentsFromClasses method...');
      try {
        await this.studentService.getVideregaaendeStudentsFromClasses(
          currentSchoolYear.graduationYear,
          (currentSchoolYear.endYear + 1).toString(),
          ['TEST'],
          ['1']
        );
        results.getVideregaaendeStudentsFromClasses = true;
        this.log('info', 'getVideregaaendeStudentsFromClasses: ✅ Success');
      } catch (error: any) {
        // This might fail due to no data or empty arrays validation, which is OK for validation
        if (error.message.includes('cannot be empty')) {
          results.getVideregaaendeStudentsFromClasses = true;
          this.log('info', 'getVideregaaendeStudentsFromClasses: ✅ Success (validation error expected)');
        } else {
          this.log('error', `getVideregaaendeStudentsFromClasses failed: ${error.message}`);
          results.getVideregaaendeStudentsFromClasses = false;
        }
      }

      this.log('info', 'Testing getSingleStudent method...');
      try {
        await this.studentService.getSingleStudent(
          currentSchoolYear.graduationYear,
          (currentSchoolYear.endYear + 1).toString(),
          '12345'
        );
        results.getSingleStudent = true;
        this.log('info', 'getSingleStudent: ✅ Success');
      } catch (error: any) {
        this.log('error', `getSingleStudent failed: ${error.message}`);
        results.getSingleStudent = false;
      }

    } catch (error: any) {
      this.log('error', `Database connection or validation failed: ${error.message}`);
      // Mark all methods as failed if we can't even connect
      results.getVideregaaendeStudents = false;
      results.getVideregaaendeStudentsFromClasses = false;
      results.getSingleStudent = false;
    } finally {
      try {
        this.log('info', 'Disconnecting from database...');
        await this.db.disconnect();
        this.log('info', 'Database disconnected successfully');
      } catch (error: any) {
        this.log('error', `Error during database disconnect: ${error.message}`);
      }
    }

    return results;
  }
}