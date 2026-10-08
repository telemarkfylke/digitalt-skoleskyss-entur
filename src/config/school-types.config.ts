// dbo.Schools.Type values whose pupils receive an Entur fare contract: 
// 0 = VO
// 1 = VGS.
//
// Shared by every eligibility query (StudentService and the order monitor) so they cannot drift
// apart — a type synced by the batch job but missing from the monitor would never have its changes
// or removals picked up.
export const INCLUDED_SCHOOL_TYPES: readonly number[] = [0, 1];

// Inlined as literals rather than bound parameters: the list is static, and keeping it out of the
// parameter list leaves every query's @paramN numbering untouched.
export const SCHOOL_TYPE_FILTER_SQL = `s.Type IN (${INCLUDED_SCHOOL_TYPES.map(Number).join(', ')})`;
