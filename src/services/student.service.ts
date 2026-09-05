import { DatabaseService } from './database.service';
import { StudentWithDetails } from '../types/user.types';
import { appLogger } from './logger.service';
import { filterOverriddenOrders, dedupeByOrderId, SchoolYearRange, formatSchoolYearRange, isOrderApproved } from '../utils';


export class StudentService {
  private db: DatabaseService;

  constructor(databaseService?: DatabaseService) {
    this.db = databaseService || new DatabaseService();
    appLogger.info('StudentService initialized with {InstanceType} DatabaseService instance', databaseService ? 'shared' : 'new');
  }

  private async ensureConnected(): Promise<void> {
    appLogger.debug('StudentService checking database connection');
    if (!this.db.isConnected()) {
      appLogger.info('StudentService database not connected, establishing connection');
      await this.db.connect();
      appLogger.info('StudentService database connection established');
    } else {
      appLogger.debug('StudentService database already connected');
    }
  }

  /**
   * Filter students to include only active ones (PrimaryStatus = 2) and exclude those with overridden orders.
   */
  private filterStudentData(students: any[], methodName: string): StudentWithDetails[] {
    const activeStudents = students.filter((student: any) => isOrderApproved(student.PrimaryStatus));
    const studentsWithoutOverriddenOrders = filterOverriddenOrders(activeStudents).filtered;
    const { deduped: dedupedStudents, duplicates } = dedupeByOrderId(studentsWithoutOverriddenOrders);

    appLogger.info(
      '{MethodName}: Found {TotalCount} students, {ActiveCount} are active (PrimaryStatus = 2), removed {RemovedCount} overridden orders',
      methodName,
      students.length,
      activeStudents.length,
      activeStudents.length - studentsWithoutOverriddenOrders.length
    );

    if (duplicates > 0) {
      appLogger.warn(
        '{MethodName}: removed {DuplicateCount} duplicate OrdersId record(s) (likely a 3rd-party data issue)',
        methodName,
        duplicates
      );
    }

    return dedupedStudents as StudentWithDetails[];
  }

  async testDatabaseAccess(): Promise<boolean> {
    try {
      await this.ensureConnected();
      const result = await this.db.query('SELECT 1 as test');
      return result.recordset && result.recordset[0]?.test === 1;
    } catch (error: any) {
      appLogger.error('StudentService database test failed: {ErrorMessage}', error.message);
      return false;
    }
  }

  // Get students from videregående schools whose order overlaps the given school year
  async getVideregaaendeStudents(range: SchoolYearRange): Promise<StudentWithDetails[]> {
    try {
      await this.ensureConnected();
      appLogger.debug('getVideregaaendeStudents school year range: {Range}', formatSchoolYearRange(range));
      const optimizedQuery = `
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
        -- Ascending: Entur honours the newest post per studentId, so the last order sent wins.
        -- For a student with more than one order this makes the longest-running contract win,
        -- which fails in the less harmful direction than cutting transport short.
        ORDER BY o.ToDate ASC
      `;

      const result = await this.db.query(optimizedQuery, [
        range.start, // School year start (August 1st), inclusive
        range.end, // School year end (August 1st the year after), exclusive
      ]);

      return this.filterStudentData(result.recordset, 'getVideregaaendeStudents');
    } catch (error) {
      appLogger.error('Error fetching videregaaende students: {ErrorMessage}', (error as any)?.message || String(error));
      throw error;
    }
  }

  // Get students from videregående schools whose order overlaps the given school year, filtered by class and grade
  async getVideregaaendeStudentsFromClasses(range: SchoolYearRange, Classes: string[], GradeId: string[]): Promise<StudentWithDetails[]> {
    appLogger.debug('getVideregaaendeStudentsFromClasses inputs: Range={Range}, Classes={Classes}, GradeId={GradeId}', formatSchoolYearRange(range), Classes.join(','), GradeId.join(','));
    // Classes and GradeId cannot be empty arrays. 
    if (Classes.length === 0) {
      throw new Error('Classes array cannot be empty');
    }
    if (GradeId.length === 0) {
      throw new Error('GradeId array cannot be empty');
    }
    try {
      await this.ensureConnected();
      const optimizedQuery = `
        SELECT 
          o.Id as OrdersId,
          OverridesOrderId,
          o.StudentId,
          o.FromDate as StartDate,
          o.ToDate as EndDate,
          o.CreatedTime as OrderCreated,
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
          AND sc.Name IN (${Classes.map((_, index) => `@param${index + 2}`).join(', ')})
          AND sc.GradeId IN (${GradeId.map((_, index) => `@param${index + 2 + Classes.length}`).join(', ')})
          AND UsesMassTransit = 1
        -- Ascending: Entur honours the newest post per studentId, so the last order sent wins.
        -- For a student with more than one order this makes the longest-running contract win,
        -- which fails in the less harmful direction than cutting transport short.
        ORDER BY o.ToDate ASC
      `;

      const result = await this.db.query(optimizedQuery, [
        range.start, // School year start (August 1st), inclusive
        range.end, // School year end (August 1st the year after), exclusive
        ...Classes, // Add class names as parameters
        ...GradeId, // Add grade IDs as parameters
      ]);

      return this.filterStudentData(result.recordset, 'getVideregaaendeStudentsFromClasses');
    } catch (error) {
      appLogger.error('Error fetching videregaaende students from classes: {ErrorMessage}', (error as any)?.message || String(error));
      throw error;
    }
  }

  // Get a single student by ID from videregående schools whose order overlaps the given school year
  async getSingleStudent(range: SchoolYearRange, StudentId: String): Promise<StudentWithDetails[]> {
    try {
      await this.ensureConnected();
      appLogger.debug('getSingleStudent school year range: {Range}', formatSchoolYearRange(range));
      const optimizedQuery = `
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
          AND p.Id = @param2
          AND UsesMassTransit = 1
        -- Ascending: Entur honours the newest post per studentId, so the last order sent wins.
        -- For a student with more than one order this makes the longest-running contract win,
        -- which fails in the less harmful direction than cutting transport short.
        ORDER BY o.ToDate ASC
      `;

      const result = await this.db.query(optimizedQuery, [
        range.start, // School year start (August 1st), inclusive
        range.end, // School year end (August 1st the year after), exclusive
        StudentId // Student ID as parameter
      ]);

      return this.filterStudentData(result.recordset, 'getSingleStudent');
    } catch (error) {
      appLogger.error('Error fetching single videregaaende student: {ErrorMessage}', (error as any)?.message || String(error));
      throw error;
    }
  }
}