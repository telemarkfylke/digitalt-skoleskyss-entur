import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ALTERNATE_LOCATIONS_FLAG_SQL, hasAlternateLocations } from '../../src/utils/alternate-locations.utils';

describe('ALTERNATE_LOCATIONS_FLAG_SQL', () => {
  test('is a SELECT-list fragment on the outer dbo.Orders alias', () => {
    assert.match(ALTERNATE_LOCATIONS_FLAG_SQL, /^,/);
    assert.match(ALTERNATE_LOCATIONS_FLAG_SQL, /ISJSON\(o\.OrderBundle\) = 1/);
    assert.match(ALTERNATE_LOCATIONS_FLAG_SQL, /END AS HasAlternateLocations$/);
  });

  test('only counts objects in AlternateLocations.Locations', () => {
    assert.match(ALTERNATE_LOCATIONS_FLAG_SQL, /OPENJSON\(o\.OrderBundle, '\$\.AlternateLocations\.Locations'\)/);
    assert.match(ALTERNATE_LOCATIONS_FLAG_SQL, /\[type\] = 5/);
  });

  test('binds no parameters', () => {
    assert.doesNotMatch(ALTERNATE_LOCATIONS_FLAG_SQL, /@param/);
  });
});

describe('hasAlternateLocations', () => {
  test('reads 1/true as extended and 0/false/null/undefined as normal', () => {
    assert.equal(hasAlternateLocations({ HasAlternateLocations: 1 }), true);
    assert.equal(hasAlternateLocations({ HasAlternateLocations: true }), true);
    assert.equal(hasAlternateLocations({ HasAlternateLocations: 0 }), false);
    assert.equal(hasAlternateLocations({ HasAlternateLocations: false }), false);
    assert.equal(hasAlternateLocations({ HasAlternateLocations: null }), false);
    assert.equal(hasAlternateLocations({}), false);
  });
});
