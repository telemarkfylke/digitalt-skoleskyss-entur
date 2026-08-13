import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { EnturApiService, PostSkoleskyssRequest } from '../../src/services/entur-skoleskyss.service';

let service: EnturApiService;

before(() => {
  process.env.ENTUR_AUDIENCE = 'https://entur.io';
  process.env.ENTUR_CLIENT_ID = 'test-client-id';
  process.env.ENTUR_CLIENT_SECRET = 'test-secret';
  process.env.ENTUR_TOKEN_URL = 'https://entur.io/oauth/token';
  process.env.ENTUR_API_URL = 'https://entur.io/skoleskyss';
  service = new EnturApiService();
});

const validRequest = (): PostSkoleskyssRequest => ({
  studentId: '42',
  applicationId: '1001',
  validity: {
    startDate: '2025-08-15',
    endDate: '2026-06-15',
    zones: [{ groupOfTariffZoneId: 'TEL:GroupOfTariffZones:1' }],
  },
  studentDetails: { phone: { number: '90000000', countryCode: '+47' } },
});

describe('validateSkoleskyssRequest', () => {
  test('valid request passes', () => {
    const result = service.validateSkoleskyssRequest(validRequest());
    assert.equal(result.isValid, true);
    assert.equal(result.errors.length, 0);
  });

  test('missing studentId fails', () => {
    const req = { ...validRequest(), studentId: '' };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('studentId')));
  });

  test('missing applicationId fails', () => {
    const req = { ...validRequest(), applicationId: '' };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('applicationId')));
  });

  test('startDate not in YYYY-MM-DD format fails', () => {
    const req = { ...validRequest(), validity: { ...validRequest().validity, startDate: '15-08-2025' } };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('startDate')));
  });

  test('endDate not in YYYY-MM-DD format fails', () => {
    const req = { ...validRequest(), validity: { ...validRequest().validity, endDate: '2026/06/15' } };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('endDate')));
  });

  test('endDate before startDate fails', () => {
    const req = {
      ...validRequest(),
      validity: { ...validRequest().validity, startDate: '2026-06-15', endDate: '2025-08-15' },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('endDate')));
  });

  test('empty zones array fails', () => {
    const req = { ...validRequest(), validity: { ...validRequest().validity, zones: [] } };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('zones')));
  });

  test('invalid email format fails', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { email: 'not-an-email' },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('email')));
  });

  test('non-digit phone number fails', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { phone: { number: 'abc-not-a-number' } },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('phone')));
  });

  test('phone number with spaces or a + prefix fails (must be digits only)', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { phone: { number: '+47 90000000' } },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('phone.number')));
  });

  test('phone number not starting with 4 or 9 fails when countryCode is +47', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { phone: { number: '12345678', countryCode: '+47' } },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('phone.number')));
  });

  test('phone number not starting with 4 or 9 fails when countryCode is omitted', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { phone: { number: '12345678' } },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('phone.number')));
  });

  test('phone number with wrong length fails when countryCode is +47', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { phone: { number: '900000000', countryCode: '+47' } },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('phone.number')));
  });

  test('8-digit phone number starting with 4 or 9 passes with +47 countryCode', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { phone: { number: '90000000', countryCode: '+47' } },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, true);
  });

  test('8-digit phone number starting with 4 or 9 passes when countryCode is omitted', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { phone: { number: '40000000' } },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, true);
  });

  test('non-Norwegian countryCode skips the 8-digit/4-or-9 rule', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { phone: { number: '1234567', countryCode: '+46' } },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, true);
  });

  test('countryCode without + prefix passes (+ is optional)', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { phone: { number: '90000000', countryCode: '47' } },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, true);
  });

  test('countryCode with more than 3 digits fails', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { phone: { number: '900000', countryCode: '4777' } },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('countryCode')));
  });

  test('missing phone number fails', () => {
    const req = { ...validRequest(), studentDetails: undefined };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('studentDetails.phone.number is required')));
    assert.ok(result.errors.some((e) => e.includes('42')));
  });

  test('studentDetails present but phone absent fails', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { email: 'ola@test.no' },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('studentDetails.phone.number is required')));
  });

  test('phone present with empty number string fails', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { phone: { number: '' } },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('studentDetails.phone.number is required')));
  });

  test('validity.calendar and validity.travelWindow are optional — valid request without them', () => {
    const req = validRequest();
    // Ensure neither field is present
    assert.equal(req.validity.calendar, undefined);
    assert.equal(req.validity.travelWindow, undefined);
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, true);
  });

  test('valid request with validity.calendar.id and validity.travelWindow passes', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      validity: {
        ...validRequest().validity,
        calendar: { id: 'TEL:FareDayType:SchoolDayDefaultSchool20252026' },
        travelWindow: { fromHour: 5, toHour: 18 },
      },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, true);
  });
});
