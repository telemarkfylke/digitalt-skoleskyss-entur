import { EnturApiService, PostSkoleskyssRequest } from '../services/entur-skoleskyss.service';
import { appLogger } from '../services/logger.service';
import { formatPhoneNumberForEntur } from './entur-phonenumer.utils';
import { getFareContractConfig } from '../config/fare-contract-config';

export interface EnturMappableStudentRecord {
  OrdersId: string | number;
  StudentId: string | number;
  PrimaryStatus?: string | number;
  StartDate: string | Date;
  EndDate: string | Date;
  StudentName?: string;
  StudentMiddleName?: string;
  StudentLastName?: string;
  PhoneNumber?: string | null;
  EmailAddress?: string;
  SchoolId?: string | number;
  SchoolName?: string;
  SchoolClassId?: string | number;
  SchoolClassName?: string;
}

export interface EnturRequestMappingOptions {
  overrideEndDateWhenPrimaryStatusNot2?: boolean;
}

const toIsoDate = (value: string | Date): string => {
  if (value instanceof Date) {
    return value.toISOString().split('T')[0];
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  return new Date(value).toISOString().split('T')[0];
};

export const mapStudentRecordToEnturRequest = (
  enturService: EnturApiService,
  record: EnturMappableStudentRecord,
  options: EnturRequestMappingOptions = {}
): PostSkoleskyssRequest => {
  const primaryStatusValue = record.PrimaryStatus;
  const primaryStatusNumber = Number(primaryStatusValue);
  const shouldOverrideEndDate =
    options.overrideEndDateWhenPrimaryStatusNot2 === true &&
    primaryStatusValue !== undefined &&
    primaryStatusValue !== null &&
    primaryStatusNumber !== 2;

  const todayIsoDate = new Date().toISOString().split('T')[0];
  const effectiveEndDate = shouldOverrideEndDate ? todayIsoDate : toIsoDate(record.EndDate);

  if (shouldOverrideEndDate) {
    appLogger.info(
      'PrimaryStatus is {PrimaryStatus} for order {OrderId}. Overriding endDate to today ({TodayIsoDate}).',
      primaryStatusNumber,
      record.OrdersId,
      todayIsoDate
    );
  }

  const fareConfig = getFareContractConfig(record.SchoolId, record.SchoolClassName);

  return enturService.createSkoleskyssRequest({
    studentId: String(record.StudentId),
    applicationId: String(record.OrdersId),
    firstName: record.StudentName,
    surname: `${record.StudentMiddleName || ''} ${record.StudentLastName || ''}`.trim() || undefined,
    schoolId: record.SchoolId,
    schoolName: record.SchoolName,
    classId: record.SchoolClassId,
    className: record.SchoolClassName,
    email: record.EmailAddress || undefined,
    phoneNumber: formatPhoneNumberForEntur(record.PhoneNumber || null),
    phoneCountryCode: '+47',
    startDate: toIsoDate(record.StartDate),
    endDate: effectiveEndDate,
    zones: [{ groupOfTariffZoneId: 'TEL:GroupOfTariffZones:1' }],
    calendarId: fareConfig.calendarId || undefined,
    timeBands: fareConfig.timeBands
  });
};
