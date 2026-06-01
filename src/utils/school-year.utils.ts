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