import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXCLUDED_ORDER_TAGS,
  getExcludedOrderTags,
} from '../../src/config/excluded-order-tags.config';

describe('getExcludedOrderTags', () => {
  afterEach(() => {
    delete process.env.ENTUR_EXCLUDED_ORDER_TAGS;
  });

  test('defaults to the physical travel card tag', () => {
    assert.deepEqual(getExcludedOrderTags(), ['VGS Fysisk skolereisekort']);
  });

  test('returns a copy, so a caller cannot mutate the default list', () => {
    const tags = getExcludedOrderTags();
    tags.push('Injisert tagg');

    assert.deepEqual(EXCLUDED_ORDER_TAGS, ['VGS Fysisk skolereisekort']);
  });

  test('reads the env override at call time', () => {
    process.env.ENTUR_EXCLUDED_ORDER_TAGS = 'Annen tagg';
    assert.deepEqual(getExcludedOrderTags(), ['Annen tagg']);
  });

  test('splits a comma-separated override and trims each entry', () => {
    process.env.ENTUR_EXCLUDED_ORDER_TAGS = ' Tagg A , Tagg B ,Tagg C';
    assert.deepEqual(getExcludedOrderTags(), ['Tagg A', 'Tagg B', 'Tagg C']);
  });

  test('drops empty entries from a sloppy override', () => {
    process.env.ENTUR_EXCLUDED_ORDER_TAGS = 'Tagg A,,  ,Tagg B,';
    assert.deepEqual(getExcludedOrderTags(), ['Tagg A', 'Tagg B']);
  });

  // The documented escape hatch: an empty override switches the filter off entirely.
  test('an empty override excludes nothing', () => {
    process.env.ENTUR_EXCLUDED_ORDER_TAGS = '';
    assert.deepEqual(getExcludedOrderTags(), []);
  });

  test('a whitespace-only override excludes nothing', () => {
    process.env.ENTUR_EXCLUDED_ORDER_TAGS = '  ,  ';
    assert.deepEqual(getExcludedOrderTags(), []);
  });

  // Callers guard on an empty result to mean "exclude nothing", so the default path has to be
  // normalised too — a blank entry left in the constant must not survive as a phantom tag.
  test('normalises the default list, not just the override', () => {
    EXCLUDED_ORDER_TAGS.push('   ');
    try {
      assert.deepEqual(getExcludedOrderTags(), ['VGS Fysisk skolereisekort']);
    } finally {
      EXCLUDED_ORDER_TAGS.pop();
    }
  });
});
