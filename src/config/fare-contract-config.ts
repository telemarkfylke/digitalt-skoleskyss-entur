export type ActivationMeansEnumeration = string;

export interface OrganisationFareContractConfig {
  authorityId: string;
  name: string;
  timeBands?: {
    startTime: number;
    endTime: number;
  };
  validableElementId: string;
  fareProductId: string;
  userProfileId: string;
  maximumNumberOfInterchanges?: number;
  calendarId: string;
  activationMeans: ActivationMeansEnumeration[];
}

export interface FareContractRule {
  schoolIds?: string[];
  classNamePatterns?: string[];
  config: Partial<OrganisationFareContractConfig>;
}

const buildDefaultConfig = (): OrganisationFareContractConfig => {
  const startTime = process.env.ENTUR_DEFAULT_TIMEBANDS_START
    ? parseInt(process.env.ENTUR_DEFAULT_TIMEBANDS_START, 10)
    : undefined;
  const endTime = process.env.ENTUR_DEFAULT_TIMEBANDS_END
    ? parseInt(process.env.ENTUR_DEFAULT_TIMEBANDS_END, 10)
    : undefined;

  return {
    authorityId: process.env.ENTUR_AUTHORITY_ID || '',
    name: 'Standard skoleskyss',
    calendarId: process.env.ENTUR_DEFAULT_CALENDAR_ID || '',
    timeBands:
      startTime !== undefined && endTime !== undefined
        ? { startTime, endTime }
        : undefined,
    validableElementId: process.env.ENTUR_VALIDABLE_ELEMENT_ID || '',
    fareProductId: process.env.ENTUR_FARE_PRODUCT_ID || '',
    userProfileId: process.env.ENTUR_USER_PROFILE_ID || '',
    activationMeans: [],
  };
};

// Per-school/class override rules — evaluated top-to-bottom, first match wins.
// Add entries here to override the default config for specific schools or classes.
// Rules use AND logic: when both schoolIds and classNamePatterns are set,
// both must match for the rule to apply.
//
// Example:
// {
//   schoolIds: ['123'],
//   config: { calendarId: 'TEL:FareDayType:SchoolDaySpecial20252026' }
// }

// If not special rules are defined for a school or class, the default config is used. 
// Remove all the rules and leave an empty array to use only the default config for all schools and classes.
export const fareContractRules: FareContractRule[] = [
  // Regel for Talenthuset: Alle dager mellom 5 og 23, uavhengig av skoleårskalender.
  { schoolIds: ['7'], config: { calendarId: undefined, timeBands: { startTime: 5, endTime: 23 } } },

  // Regel for Toppidrett: Alle dager mellom 5 og 23, Alle skoledager.
  { schoolIds: ['9'], config: { timeBands: { startTime: 5, endTime: 23 } } },

  // Regel for Skien VGS Musikk, Dans og Drama VG1 VG2 VG3: Alle dager mellom 5 og 23, Alle skoledager.
  { classNamePatterns: ['MDMDD1--1-', 'MDMDD1--4-', 'MDMDD1--6-', 
                        'MDDAN2----','MDDRA2----' ,'MDMUS2----', 
                        'MDDAN3----', 'MDDRA3----', 'MDMUS3----' ], config: { timeBands: { startTime: 5, endTime: 23 } } }
];

export const getFareContractConfig = (
  schoolId: string | number | undefined,
  className: string | undefined
): OrganisationFareContractConfig => {
  const defaultConfig = buildDefaultConfig();

  const schoolIdStr = String(schoolId ?? '');
  const classNameStr = String(className ?? '');

  for (const rule of fareContractRules) {
    const matchesSchool =
      !rule.schoolIds?.length || rule.schoolIds.includes(schoolIdStr);

    const matchesClass =
      !rule.classNamePatterns?.length ||
      rule.classNamePatterns.some((p) => classNameStr.includes(p));

    if (matchesSchool && matchesClass) {
      return { ...defaultConfig, ...rule.config };
    }
  }

  return defaultConfig;
};
