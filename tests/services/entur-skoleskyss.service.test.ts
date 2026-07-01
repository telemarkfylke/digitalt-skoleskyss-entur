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

  test('invalid phone number format fails', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      studentDetails: { phone: { number: 'abc-not-a-number' } },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.some((e) => e.includes('phone')));
  });

  test('calendarId and timeBands are optional — valid request without them', () => {
    const req = validRequest();
    // Ensure neither field is present
    assert.equal(req.calendarId, undefined);
    assert.equal(req.timeBands, undefined);
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, true);
  });

  test('valid request with calendarId and timeBands passes', () => {
    const req: PostSkoleskyssRequest = {
      ...validRequest(),
      calendarId: 'TEL:FareDayType:SchoolDayDefaultSchool20252026',
      timeBands: { startTime: 5, endTime: 18 },
    };
    const result = service.validateSkoleskyssRequest(req);
    assert.equal(result.isValid, true);
  });
});
