import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSchoolYear,
  formatSchoolYearRange,
  getSchoolYearByStartYear,
  getSchoolYearRange,
  resolveSchoolYear
} from '../../src/utils/school-year.utils';

const isoDate = (date: Date): string => date.toISOString().split('T')[0];

describe('calculateSchoolYear', () => {
  test('July belongs to the school year that started the previous August', () => {
    const schoolYear = calculateSchoolYear(new Date('2026-07-31T12:00:00Z'));
    assert.equal(schoolYear.yearString, '2025-2026');
  });

  test('August starts the new school year', () => {
    const schoolYear = calculateSchoolYear(new Date('2026-08-01T12:00:00Z'));
    assert.equal(schoolYear.yearString, '2026-2027');
  });
});

describe('getSchoolYearRange', () => {
  test('spans August 1st to August 1st the following year', () => {
    const range = getSchoolYearRange(getSchoolYearByStartYear(2026));
    assert.equal(isoDate(range.start), '2026-08-01');
    assert.equal(isoDate(range.end), '2027-08-01');
  });

  // The bug this replaced used a January-to-January window, which silently excluded every
  // order ending in the autumn term.
  test('includes orders ending in the autumn term', () => {
    const range = getSchoolYearRange(getSchoolYearByStartYear(2026));
    const autumnEnd = new Date('2026-12-19T00:00:00Z');
    assert.ok(autumnEnd >= range.start && autumnEnd < range.end);
  });

  test('excludes orders belonging to the next school year', () => {
    const range = getSchoolYearRange(getSchoolYearByStartYear(2026));
    const nextYearOrderEnd = new Date('2027-12-18T00:00:00Z');
    assert.ok(nextYearOrderEnd >= range.end);
  });
});

describe('resolveSchoolYear', () => {
  test('resolves an explicit start year', () => {
    assert.equal(resolveSchoolYear('2026').yearString, '2026-2027');
    assert.equal(resolveSchoolYear(2026).yearString, '2026-2027');
  });

  test('falls back to the current school year when omitted or blank', () => {
    const current = calculateSchoolYear().yearString;
    assert.equal(resolveSchoolYear().yearString, current);
    assert.equal(resolveSchoolYear('').yearString, current);
  });

  test('rejects a non-numeric start year rather than silently defaulting', () => {
    assert.throws(() => resolveSchoolYear('not-a-year'), /Invalid school year start/);
  });
});

describe('formatSchoolYearRange', () => {
  test('shows the last included day, not the exclusive upper bound', () => {
    const range = getSchoolYearRange(getSchoolYearByStartYear(2026));
    assert.equal(formatSchoolYearRange(range), '2026-08-01 -> 2027-07-31');
  });
});
