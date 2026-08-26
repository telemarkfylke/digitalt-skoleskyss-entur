/**
 * School Year Utility Functions for Norwegian School System
*/
export interface SchoolYear {
  startYear: number;
  endYear: number;
  yearString: string;
  graduationYear: string;
}

/**
 * The calendar span a school year actually covers: August 1st to August 1st the following year.
 * `start` is inclusive, `end` is exclusive — an order belongs to the school year when it
 * overlaps [start, end).
 */
export interface SchoolYearRange {
  start: Date;
  end: Date;
}

/**
 * Helper function to calculate school year based on Norwegian school system
 * School year runs from August to June (e.g., August 2025 - June 2026 = "2025-2026")
 */
export function calculateSchoolYear(date: Date = new Date()): SchoolYear {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // JavaScript months are 0-based
  
  // If it's January through July, we're in the second half of the school year
  // If it's August through December, we're in the first half of the school year
  const startYear = month >= 8 ? year : year - 1;
  const endYear = startYear + 1;
  
  return {
    startYear,
    endYear,
    yearString: `${startYear}-${endYear}`,
    graduationYear: endYear.toString()
  };
}

/**
 * Helper function to get school year for a specific graduation year
*/
export function getSchoolYearByGraduationYear(graduationYear: number): SchoolYear {
  const startYear = graduationYear - 1;
  const endYear = graduationYear;
  
  return {
    startYear,
    endYear,
    yearString: `${startYear}-${endYear}`,
    graduationYear: endYear.toString()
  };
}

/**
 * Helper function to get the school year that starts in a given calendar year
 * (e.g. 2026 -> the 2026-2027 school year)
*/
export function getSchoolYearByStartYear(startYear: number): SchoolYear {
  return getSchoolYearByGraduationYear(startYear + 1);
}

/**
 * Resolve the school year to operate on. Pass the calendar year the school year *starts* in
 * (e.g. '2026' for 2026-2027); omit it to use the school year we are currently in.
*/
export function resolveSchoolYear(startYear?: string | number): SchoolYear {
  if (startYear === undefined || startYear === '') {
    return calculateSchoolYear();
  }

  const parsed = Number(startYear);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid school year start '${startYear}'. Expected the calendar year the school year starts in, e.g. 2026.`);
  }

  return getSchoolYearByStartYear(parsed);
}

/**
 * Calendar bounds of a school year, used to select the orders belonging to it.
 * Dates are built in UTC to match how the mssql driver sends them.
 */
export function getSchoolYearRange(schoolYear: SchoolYear): SchoolYearRange {
  return {
    start: new Date(Date.UTC(schoolYear.startYear, 7, 1)), // August 1st, inclusive
    end: new Date(Date.UTC(schoolYear.endYear, 7, 1))      // August 1st the year after, exclusive
  };
}

/**
 * Human-readable form of a school year range for logs, showing the last included day
 * rather than the exclusive upper bound (e.g. "2026-08-01 -> 2027-07-31").
 */
export function formatSchoolYearRange(range: SchoolYearRange): string {
  const lastIncludedDay = new Date(range.end.getTime() - 24 * 60 * 60 * 1000);
  return `${range.start.toISOString().split('T')[0]} -> ${lastIncludedDay.toISOString().split('T')[0]}`;
}

/**
 * Helper function to get multiple school years (useful for multi-year programs)
*/
export function getSchoolYearsForProgram(startGraduationYear: number, programYears: number = 3): string[] {
  const years: string[] = [];
  for (let i = 0; i < programYears; i++) {
    const graduationYear = startGraduationYear + i;
    years.push(graduationYear.toString());
  }
  return years;
}

/**
 * Helper function to check if a date falls within a specific school year
 */
export function isDateInSchoolYear(date: Date, graduationYear: number): boolean {
  const schoolYear = getSchoolYearByGraduationYear(graduationYear);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  
  // Check if date falls within the school year period
  if (year === schoolYear.startYear) {
    return month >= 8; // August onwards
  } else if (year === schoolYear.endYear) {
    return month <= 7; // Up to July
  }
  
  return false;
}

/**
 * Helper function to get the current academic semester
 */
export function getCurrentSemester(date: Date = new Date()): 'autumn' | 'spring' {
  const month = date.getMonth() + 1;
  
  // Autumn semester: August - December
  // Spring semester: January - June
  return month >= 8 || month <= 12 ? 'autumn' : 'spring';
}

/**
 * Helper function to format school year for display
 */
export function formatSchoolYear(schoolYear: SchoolYear, format: 'full' | 'short' | 'graduation' = 'full'): string {
  switch (format) {
    case 'short':
      return `${schoolYear.startYear.toString().slice(-2)}-${schoolYear.endYear.toString().slice(-2)}`;
    case 'graduation':
      return schoolYear.graduationYear;
    case 'full':
    default:
      return schoolYear.yearString;
  }
}