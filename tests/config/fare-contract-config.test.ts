import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getFareContractConfig, fareContractRules } from '../../src/config/fare-contract-config';

describe('getFareContractConfig', () => {
  before(() => {
    process.env.ENTUR_DEFAULT_CALENDAR_ID = 'DEFAULT_CALENDAR';
    process.env.ENTUR_AUTHORITY_ID = 'DEFAULT_AUTHORITY';
    process.env.ENTUR_DEFAULT_TIMEBANDS_START = '5';
    process.env.ENTUR_DEFAULT_TIMEBANDS_END = '18';
    process.env.ENTUR_VALIDABLE_ELEMENT_ID = 'DEFAULT_VALIDABLE';
    process.env.ENTUR_FARE_PRODUCT_ID = 'DEFAULT_FARE_PRODUCT';
    process.env.ENTUR_USER_PROFILE_ID = 'DEFAULT_USER_PROFILE';
  });

  after(() => {
    delete process.env.ENTUR_DEFAULT_CALENDAR_ID;
    delete process.env.ENTUR_AUTHORITY_ID;
    delete process.env.ENTUR_DEFAULT_TIMEBANDS_START;
    delete process.env.ENTUR_DEFAULT_TIMEBANDS_END;
    delete process.env.ENTUR_VALIDABLE_ELEMENT_ID;
    delete process.env.ENTUR_FARE_PRODUCT_ID;
    delete process.env.ENTUR_USER_PROFILE_ID;
  });

  afterEach(() => {
    fareContractRules.length = 0;
  });

  test('returns default config when no rules are defined', () => {
    const config = getFareContractConfig('school-1', 'class-A');
    assert.equal(config.calendarId, 'DEFAULT_CALENDAR');
    assert.equal(config.authorityId, 'DEFAULT_AUTHORITY');
    assert.deepEqual(config.timeBands, { startTime: 5, endTime: 18 });
  });

  test('reads calendarId from process.env at call time', () => {
    process.env.ENTUR_DEFAULT_CALENDAR_ID = 'UPDATED_CALENDAR';
    const config = getFareContractConfig(undefined, undefined);
    assert.equal(config.calendarId, 'UPDATED_CALENDAR');
    process.env.ENTUR_DEFAULT_CALENDAR_ID = 'DEFAULT_CALENDAR';
  });

  test('omits timeBands when env vars are not set', () => {
    delete process.env.ENTUR_DEFAULT_TIMEBANDS_START;
    delete process.env.ENTUR_DEFAULT_TIMEBANDS_END;
    const config = getFareContractConfig(undefined, undefined);
    assert.equal(config.timeBands, undefined);
    process.env.ENTUR_DEFAULT_TIMEBANDS_START = '5';
    process.env.ENTUR_DEFAULT_TIMEBANDS_END = '18';
  });

  test('returns overridden config when schoolId matches a rule', () => {
    fareContractRules.push({
      schoolIds: ['school-42'],
      config: { calendarId: 'SCHOOL_42_CALENDAR' },
    });
    const config = getFareContractConfig('school-42', 'class-A');
    assert.equal(config.calendarId, 'SCHOOL_42_CALENDAR');
  });

  test('returns default config when schoolId does not match', () => {
    fareContractRules.push({
      schoolIds: ['school-42'],
      config: { calendarId: 'SCHOOL_42_CALENDAR' },
    });
    const config = getFareContractConfig('school-99', 'class-A');
    assert.equal(config.calendarId, 'DEFAULT_CALENDAR');
  });

  test('returns overridden config when className pattern matches', () => {
    fareContractRules.push({
      classNamePatterns: ['VG3'],
      config: { calendarId: 'VG3_CALENDAR' },
    });
    const config = getFareContractConfig('school-1', '3VG3-STU');
    assert.equal(config.calendarId, 'VG3_CALENDAR');
  });

  test('AND logic: both schoolId and className must match when both specified', () => {
    fareContractRules.push({
      schoolIds: ['school-42'],
      classNamePatterns: ['VG3'],
      config: { calendarId: 'SPECIFIC_CALENDAR' },
    });

    // schoolId matches, className does not
    const configMissClass = getFareContractConfig('school-42', '1A');
    assert.equal(configMissClass.calendarId, 'DEFAULT_CALENDAR');

    // className matches, schoolId does not
    const configMissSchool = getFareContractConfig('school-99', 'VG3-STU');
    assert.equal(configMissSchool.calendarId, 'DEFAULT_CALENDAR');

    // both match
    const configBoth = getFareContractConfig('school-42', 'VG3-STU');
    assert.equal(configBoth.calendarId, 'SPECIFIC_CALENDAR');
  });

  test('first matching rule wins over later rules', () => {
    fareContractRules.push(
      { schoolIds: ['school-1'], config: { calendarId: 'FIRST_CALENDAR' } },
      { schoolIds: ['school-1'], config: { calendarId: 'SECOND_CALENDAR' } }
    );
    const config = getFareContractConfig('school-1', undefined);
    assert.equal(config.calendarId, 'FIRST_CALENDAR');
  });

  test('merged config does not mutate defaultConfig', () => {
    fareContractRules.push({
      schoolIds: ['school-1'],
      config: { calendarId: 'OVERRIDE_CALENDAR' },
    });
    const overridden = getFareContractConfig('school-1', undefined);
    const defaultConfig = getFareContractConfig('school-99', undefined);

    assert.equal(overridden.calendarId, 'OVERRIDE_CALENDAR');
    assert.equal(defaultConfig.calendarId, 'DEFAULT_CALENDAR');
  });

  test('rule with no schoolIds or classNamePatterns matches any student', () => {
    fareContractRules.push({
      config: { calendarId: 'CATCH_ALL_CALENDAR' },
    });
    const config = getFareContractConfig('any-school', 'any-class');
    assert.equal(config.calendarId, 'CATCH_ALL_CALENDAR');
  });
});
