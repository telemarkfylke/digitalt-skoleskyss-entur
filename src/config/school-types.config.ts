// Which pupils receive an Entur fare contract, by dbo.Schools.Type:
// 1 = VGS — every pupil is included.
// 0 = VO, grunnskole and more — only classes whose dbo.SchoolClasses.GradeId is listed below.
//
// Type 0 is narrowed per class rather than per school, so grunnskole classes at a school that also
// runs VO stay out.
//
// Shared by every eligibility query (StudentService and the order monitor) so they cannot drift
// apart — pupils synced by the batch job but missing from the monitor would never have their
// changes or removals picked up.
export const VGS_SCHOOL_TYPE = 1;

// Type 0 GradeIds to include. 1118 and 1120 are the VO grades.
//
// To bring grunnskole in later, add its GradeIds here. Before doing so, check that the excluded
// order tags and fare contract config fit those pupils, and expect the monitor's startup
// reconciliation to post every newly eligible order at once on its next restart.
export const TYPE_0_INCLUDED_GRADE_IDS: readonly string[] = ['1118', '1120'];

// Inlined as literals rather than bound parameters: the list is static, and keeping it out of the
// parameter list leaves every query's @paramN numbering untouched. Ids are validated as digits and
// quoted, which compares correctly whether sc.GradeId is an int or a varchar column.
//
// Wrapped in parentheses because callers AND it into a WHERE clause — the OR must not leak.
export const buildSchoolTypeFilterSql = (type0GradeIds: readonly string[]): string => {
  const ids = type0GradeIds.map((id) => String(id).trim());
  const invalid = ids.filter((id) => !/^\d+$/.test(id));
  if (invalid.length > 0) {
    throw new Error(`Invalid Type 0 GradeId(s): ${invalid.join(', ')}`);
  }

  // No Type 0 grades means VGS only — never an empty IN (), which is invalid SQL.
  if (ids.length === 0) return `(s.Type = ${VGS_SCHOOL_TYPE})`;

  const gradeList = ids.map((id) => `'${id}'`).join(', ');
  return `(s.Type = ${VGS_SCHOOL_TYPE} OR (s.Type = 0 AND sc.GradeId IN (${gradeList})))`;
};

export const SCHOOL_TYPE_FILTER_SQL = buildSchoolTypeFilterSql(TYPE_0_INCLUDED_GRADE_IDS);
