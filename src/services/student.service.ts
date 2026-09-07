import { DatabaseService } from './database.service';
import { StudentWithDetails } from '../types/user.types';
import { appLogger } from './logger.service';
import { filterOverriddenOrders, dedupeByOrderId, SchoolYearRange, formatSchoolYearRange, isOrderApproved, buildExcludedOrderTagFlag, buildExcludedOrderTagPredicate, filterExcludedByTag } from '../utils';
import { getExcludedOrderTags } from '../config/excluded-order-tags.config';


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
   * Applies the three eligibility rules to a raw recordset, then de-duplicates.
   *
   * **The order matters and is not interchangeable:**
   *
   *   isOrderApproved -> filterOverriddenOrders -> filterExcludedByTag -> dedupeByOrderId
   *
   * `filterOverriddenOrders` recognises an order as superseded only while the order that *overrides*
   * it is still in the set. Dropping physical-travel-card orders any earlier — here or in the
   * query's WHERE clause — would take the overriding row away with them, so an order replaced by a
   * tagged one would stop looking superseded and be sent to Entur. Filtering the tag last keeps the
   * override filter working on the full set, which is correct at any override-chain depth.
   */
  private filterStudentData(students: any[], methodName: string): StudentWithDetails[] {
    const activeStudents = students.filter((student: any) => isOrderApproved(student.PrimaryStatus));
    const studentsWithoutOverriddenOrders = filterOverriddenOrders(activeStudents).filtered;
    const { filtered: eligibleStudents, excluded: excludedByTag } = filterExcludedByTag(studentsWithoutOverriddenOrders);
    const { deduped: dedupedStudents, duplicates } = dedupeByOrderId(eligibleStudents);

    appLogger.info(
      '{MethodName}: Found {TotalCount} students, {ActiveCount} are active (PrimaryStatus = 2), removed {RemovedCount} overridden orders, removed {ExcludedByTagCount} with a physical travel card tag',
      methodName,
      students.length,
      activeStudents.length,
      activeStudents.length - studentsWithoutOverriddenOrders.length,
      excludedByTag
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

  /**
   * Look up which student owns each of the given order ids.
   *
   * Deliberately unfiltered — no school-year window, no PrimaryStatus, no IsActive, no joins, and
   * NOT routed through filterStudentData (which keeps only PrimaryStatus = 2). The orders that most
   * need revoking are exactly the ones that have dropped out of the eligible set, so any filter here
   * would hide them. That is also why getSingleStudent cannot serve this.
   *
   * Used only by the delete CLI, to resolve an order id to the (studentId, applicationId) pair a
   * fare contract is addressed by.
   *
   * Exempt from the physical-travel-card tag filter for the same reason: a tagged order is exactly
   * one whose contract needs deleting, so excluding it here would break that cleanup.
   */
  async getOrderOwners(ordersIds: Array<string | number>): Promise<Array<{ OrdersId: number; StudentId: number }>> {
    const ids = [...new Set(ordersIds.map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return [];

    await this.ensureConnected();

    // SQL Server caps a request at 2100 parameters; chunk well inside that rather than fail at scale.
    const CHUNK_SIZE = 500;
    const owners: Array<{ OrdersId: number; StudentId: number }> = [];

    for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
      const chunk = ids.slice(start, start + CHUNK_SIZE);
      const placeholders = chunk.map((_, index) => `@param${index}`).join(', ');
      const result = await this.db.query(
        `SELECT o.Id as OrdersId, o.StudentId FROM dbo.Orders o WHERE o.Id IN (${placeholders})`,
        chunk
      );
      owners.push(...(result.recordset || []));
    }

    appLogger.info(
      'getOrderOwners: resolved {FoundCount} of {RequestedCount} order id(s) from dbo.Orders',
      owners.length,
      ids.length
    );

    return owners;
  }

  /**
   * Whether this pupil has any physical-travel-card order in the given school year.
   *
   * Only used to explain an order's *absence* from an eligibility query, so that a routine
   * retirement is not reported as the unexpected "student not found". Asked per student rather than
   * per order because the tag disqualifies two different orders: the tagged one itself, and the
   * untagged order it replaces — which `filterOverriddenOrders` drops without ever being tagged.
   *
   * Scoped to the school year for the same reason the eligibility queries are: a tag on a long-past
   * order says nothing about this year's travel.
   */
  async hasExcludedTagOrder(studentId: string | number, range: SchoolYearRange): Promise<boolean> {
    // No tags configured means nothing is ever excluded, so the answer cannot be yes.
    const tags = getExcludedOrderTags();
    if (tags.length === 0) return false;

    await this.ensureConnected();

    const predicate = buildExcludedOrderTagPredicate(3, tags);
    const result = await this.db.query(
      `SELECT TOP 1 o.Id as OrdersId
       FROM dbo.Orders o
       WHERE o.ToDate >= @param0
         AND o.FromDate < @param1
         AND o.StudentId = @param2
         AND ${predicate.sql}`,
      [range.start, range.end, studentId, ...predicate.params]
    );

    return (result.recordset || []).length > 0;
  }

  // Get students from videregående schools whose order overlaps the given school year
  async getVideregaaendeStudents(range: SchoolYearRange): Promise<StudentWithDetails[]> {
    try {
      await this.ensureConnected();
      appLogger.debug('getVideregaaendeStudents school year range: {Range}', formatSchoolYearRange(range));
      // @param0 and @param1 are the school year bounds, so the tag parameters start at 2.
      const excludedTagFlag = buildExcludedOrderTagFlag(2);
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
          sc.GradeId as SchoolGradeId${excludedTagFlag.sql}
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
        ...excludedTagFlag.params, // Physical travel card tags — excluded orders
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
      // @param0/@param1 are the school year bounds, then one slot per class and per grade id.
      const excludedTagFlag = buildExcludedOrderTagFlag(2 + Classes.length + GradeId.length);
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
          sc.GradeId as SchoolGradeId${excludedTagFlag.sql}
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
        ...excludedTagFlag.params, // Physical travel card tags — excluded orders
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
      // @param0/@param1 are the school year bounds and @param2 the student id, so tags start at 3.
      const excludedTagFlag = buildExcludedOrderTagFlag(3);
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
          sc.GradeId as SchoolGradeId${excludedTagFlag.sql}
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
        StudentId, // Student ID as parameter
        ...excludedTagFlag.params, // Physical travel card tags — excluded orders
      ]);

      return this.filterStudentData(result.recordset, 'getSingleStudent');
    } catch (error) {
      appLogger.error('Error fetching single videregaaende student: {ErrorMessage}', (error as any)?.message || String(error));
      throw error;
    }
  }
}
