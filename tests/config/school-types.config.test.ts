import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHOOL_TYPE_FILTER_SQL,
  TYPE_0_INCLUDED_GRADE_IDS,
  buildSchoolTypeFilterSql,
} from '../../src/config/school-types.config';

describe('buildSchoolTypeFilterSql', () => {
  test('includes all VGS and only the VO grades of Type 0 by default', () => {
    assert.deepEqual(TYPE_0_INCLUDED_GRADE_IDS, ['1118', '1120']);
    assert.equal(
      SCHOOL_TYPE_FILTER_SQL,
      "(s.Type = 1 OR (s.Type = 0 AND sc.GradeId IN ('1118', '1120')))"
    );
  });

  test('falls back to VGS only when no Type 0 grades are listed', () => {
    assert.equal(buildSchoolTypeFilterSql([]), '(s.Type = 1)');
  });

  test('rejects a non-numeric grade id rather than inlining it', () => {
    assert.throws(() => buildSchoolTypeFilterSql(['1118', "1'; DROP TABLE x --"]), /Invalid Type 0 GradeId/);
  });
});
