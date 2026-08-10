import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EnturApiService } from '../../src/services/entur-skoleskyss.service';
import { mapStudentRecordToEnturRequest, EnturMappableStudentRecord } from '../../src/utils/entur-request-mapper.utils';
import { fareContractRules } from '../../src/config/fare-contract-config';

let service: EnturApiService;

before(() => {
  process.env.ENTUR_AUDIENCE = 'https://entur.io';
  process.env.ENTUR_CLIENT_ID = 'test-client-id';
  process.env.ENTUR_CLIENT_SECRET = 'test-secret';
  process.env.ENTUR_TOKEN_URL = 'https://entur.io/oauth/token';
  process.env.ENTUR_API_URL = 'https://entur.io/skoleskyss';
  process.env.ENTUR_DEFAULT_CALENDAR_ID = 'TEL:FareDayType:SchoolDayDefaultSchool20252026';
  process.env.ENTUR_DEFAULT_TIMEBANDS_START = '5';
  process.env.ENTUR_DEFAULT_TIMEBANDS_END = '18';
  service = new EnturApiService();
});

after(() => {
  delete process.env.ENTUR_DEFAULT_CALENDAR_ID;
  delete process.env.ENTUR_DEFAULT_TIMEBANDS_START;
  delete process.env.ENTUR_DEFAULT_TIMEBANDS_END;
});

afterEach(() => {
  fareContractRules.length = 0;
});

const baseRecord = (): EnturMappableStudentRecord => ({
  OrdersId: '1001',
  StudentId: '42',
  StartDate: '2025-08-15',
  EndDate: '2026-06-15',
  StudentName: 'Ola',
  StudentMiddleName: '',
  StudentLastName: 'Nordmann',
  EmailAddress: 'ola@test.no',
  PhoneNumber: '90000000',
  SchoolId: 'school-1',
  SchoolName: 'Telemark videregående',
  SchoolClassId: 'class-1',
  SchoolClassName: '1A',
});

describe('mapStudentRecordToEnturRequest', () => {
  test('maps studentId and applicationId correctly', () => {
    const req = mapStudentRecordToEnturRequest(service, baseRecord());
    assert.equal(req.studentId, '42');
    assert.equal(req.applicationId, '1001');
  });

  test('maps startDate and endDate as YYYY-MM-DD strings', () => {
    const req = mapStudentRecordToEnturRequest(service, baseRecord());
    assert.equal(req.validity.startDate, '2025-08-15');
    assert.equal(req.validity.endDate, '2026-06-15');
  });

  test('formats Date objects to YYYY-MM-DD', () => {
    const record = { ...baseRecord(), StartDate: new Date('2025-08-15T00:00:00Z'), EndDate: new Date('2026-06-15T00:00:00Z') };
    const req = mapStudentRecordToEnturRequest(service, record);
    assert.equal(req.validity.startDate, '2025-08-15');
    assert.equal(req.validity.endDate, '2026-06-15');
  });

  test('includes validity.calendar.id from default fare config', () => {
    const req = mapStudentRecordToEnturRequest(service, baseRecord());
    assert.equal(req.validity.calendar?.id, 'TEL:FareDayType:SchoolDayDefaultSchool20252026');
  });

  test('includes validity.travelWindow from default fare config', () => {
    const req = mapStudentRecordToEnturRequest(service, baseRecord());
    assert.deepEqual(req.validity.travelWindow, { fromHour: 5, toHour: 18 });
  });

  test('uses overridden calendarId when a fare rule matches', () => {
    fareContractRules.push({
      schoolIds: ['school-1'],
      config: { calendarId: 'OVERRIDE_CALENDAR' },
    });
    const req = mapStudentRecordToEnturRequest(service, baseRecord());
    assert.equal(req.validity.calendar?.id, 'OVERRIDE_CALENDAR');
  });

  test('validity.calendar is undefined when env var is not set', () => {
    delete process.env.ENTUR_DEFAULT_CALENDAR_ID;
    const req = mapStudentRecordToEnturRequest(service, baseRecord());
    assert.equal(req.validity.calendar, undefined);
    process.env.ENTUR_DEFAULT_CALENDAR_ID = 'TEL:FareDayType:SchoolDayDefaultSchool20252026';
  });

  test('handles missing optional fields without throwing', () => {
    const record: EnturMappableStudentRecord = {
      OrdersId: '1001',
      StudentId: '42',
      StartDate: '2025-08-15',
      EndDate: '2026-06-15',
    };
    assert.doesNotThrow(() => mapStudentRecordToEnturRequest(service, record));
  });

  test('overrides endDate to today when PrimaryStatus is not 2', () => {
    const today = new Date().toISOString().split('T')[0];
    const record = { ...baseRecord(), PrimaryStatus: 1 };
    const req = mapStudentRecordToEnturRequest(service, record, {
      overrideEndDateWhenPrimaryStatusNot2: true,
    });
    assert.equal(req.validity.endDate, today);
  });

  test('does not override endDate when PrimaryStatus is 2', () => {
    const record = { ...baseRecord(), PrimaryStatus: 2 };
    const req = mapStudentRecordToEnturRequest(service, record, {
      overrideEndDateWhenPrimaryStatusNot2: true,
    });
    assert.equal(req.validity.endDate, '2026-06-15');
  });

  // Documents why the caller must validate the mapped request before sending it to
  // Entur (see EnturApiService.validateSkoleskyssRequest): overriding endDate to
  // today does not account for a StartDate that hasn't happened yet, so it can
  // produce an invalid endDate < startDate pair. This is intentionally not fixed
  // here — the mapper's job is just to apply the override; validation catches it.
  test('overriding endDate to today can produce endDate before startDate when StartDate is in the future', () => {
    const today = new Date().toISOString().split('T')[0];
    const record = { ...baseRecord(), StartDate: '2999-01-01', PrimaryStatus: 1 };
    const req = mapStudentRecordToEnturRequest(service, record, {
      overrideEndDateWhenPrimaryStatusNot2: true,
    });
    assert.equal(req.validity.startDate, '2999-01-01');
    assert.equal(req.validity.endDate, today);
    assert.ok(new Date(req.validity.endDate) < new Date(req.validity.startDate));
  });
});
