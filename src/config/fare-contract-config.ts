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

// TODO: Implement rules for specific schools and classes. For now, the array is empty, meaning all schools and classes will use the default config.
export const fareContractRules: FareContractRule[] = [];

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
