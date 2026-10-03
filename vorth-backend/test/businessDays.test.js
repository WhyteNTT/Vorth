'use strict';

/**
 * Business-day arithmetic for the DMCA counter-notice window.
 *
 * The date maths is checked against dates worked out by hand rather than by
 * re-implementing the implementation. Every case below names the expected day.
 */

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.DATABASE_SSL = 'false';
process.env.JWT_SECRET ||= 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const {
  addBusinessDays, businessDaysBetween, counterNoticeDeadline, isWeekend, startOfDay,
} = require('../src/services/businessDays');

test('a weekday plus one business day is the next weekday', () => {
  // Mon 2026-03-02 -> Tue 2026-03-03
  assert.equal(addBusinessDays('2026-03-02', 1).toISOString().slice(0, 10), '2026-03-03');
  // Fri 2026-03-06 -> Mon 2026-03-09 (skips the weekend)
  assert.equal(addBusinessDays('2026-03-06', 1).toISOString().slice(0, 10), '2026-03-09');
});

test('the weekend is skipped in both directions', () => {
  // Starting on a Saturday behaves like starting on the Friday before it.
  const fromSat = addBusinessDays('2026-03-07', 1).toISOString().slice(0, 10);
  const fromFri = addBusinessDays('2026-03-06', 1).toISOString().slice(0, 10);
  assert.equal(fromSat, fromFri);
  assert.equal(fromSat, '2026-03-09');
});

test('ten business days from a Friday crosses two weekends', () => {
  // Fri 2026-03-06 + 10 business days = Fri 2026-03-20
  assert.equal(addBusinessDays('2026-03-06', 10).toISOString().slice(0, 10), '2026-03-20');
});

test('ten business days from a Monday is the Monday two weeks later', () => {
  // Mon 2026-03-02 + 10 business days = Mon 2026-03-16
  assert.equal(addBusinessDays('2026-03-02', 10).toISOString().slice(0, 10), '2026-03-16');
});

test('fourteen business days is the outer statutory bound', () => {
  // Mon 2 Mar + 14 business days = Fri 20 Mar: two full weeks, then one more day.
  assert.equal(addBusinessDays('2026-03-02', 14).toISOString().slice(0, 10), '2026-03-20');
});

test('zero business days returns the starting day, not the next one', () => {
  // Day zero is not a day the complainant can act on, so it must not shift.
  assert.equal(addBusinessDays('2026-03-02', 0).toISOString().slice(0, 10), '2026-03-02');
  assert.equal(addBusinessDays('2026-03-07', 0).toISOString().slice(0, 10), '2026-03-07');
});

test('a supplied holiday is not counted', () => {
  // Without the holiday, Fri 2026-03-06 + 1 = Mon 2026-03-09.
  // Declaring Mon 2026-03-09 a holiday pushes it to Tue 2026-03-10.
  assert.equal(
    addBusinessDays('2026-03-06', 1, ['2026-03-09']).toISOString().slice(0, 10),
    '2026-03-10',
  );
  // A holiday inside a longer run shifts the whole result by one.
  assert.equal(
    addBusinessDays('2026-03-02', 10, ['2026-03-04']).toISOString().slice(0, 10),
    '2026-03-17',
  );
});

test('a holiday on a weekend changes nothing', () => {
  assert.equal(
    addBusinessDays('2026-03-06', 1, ['2026-03-07', '2026-03-08']).toISOString().slice(0, 10),
    '2026-03-09',
  );
});

test('the time of day never affects the result', () => {
  // A job running at 23:59 and one at 00:01 must agree, or the deadline moves.
  const early = addBusinessDays('2026-03-06T00:00:01Z', 10).toISOString();
  const late = addBusinessDays('2026-03-06T23:59:59Z', 10).toISOString();
  assert.equal(early.slice(0, 10), late.slice(0, 10));
  assert.equal(early.slice(0, 10), '2026-03-20');
});

test('days between never goes negative', () => {
  assert.equal(businessDaysBetween('2026-03-10', '2026-03-02'), 0);
  assert.equal(businessDaysBetween('2026-03-02', '2026-03-02'), 0);
});

test('days between counts weekdays only', () => {
  // Mon to the following Mon is 5 business days.
  assert.equal(businessDaysBetween('2026-03-02', '2026-03-09'), 5);
  // A clock skewed into the past reads as zero, never negative.
  assert.ok(businessDaysBetween('2026-03-09T00:00:00Z', new Date()) >= 0);
});

test('the deadline helper defaults to the earliest statutory bound', () => {
  assert.equal(
    counterNoticeDeadline('2026-03-06').toISOString().slice(0, 10),
    '2026-03-20',
  );
  assert.equal(
    counterNoticeDeadline('2026-03-06', { businessDays: 14 }).toISOString().slice(0, 10),
    '2026-03-26',
  );
});

test('weekend detection is in UTC', () => {
  assert.equal(isWeekend(new Date('2026-03-07T12:00:00Z')), true);
  assert.equal(isWeekend(new Date('2026-03-08T12:00:00Z')), true);
  assert.equal(isWeekend(new Date('2026-03-09T12:00:00Z')), false);
});

test('start of day normalises to midnight UTC', () => {
  assert.equal(startOfDay('2026-03-06T23:59:59Z').toISOString(), '2026-03-06T00:00:00.000Z');
  assert.equal(startOfDay('2026-03-06T00:00:00Z').toISOString(), '2026-03-06T00:00:00.000Z');
});

test('nonsense input is refused rather than silently coerced', () => {
  assert.throws(() => addBusinessDays('2026-03-02', -1), /non-negative integer/);
  assert.throws(() => addBusinessDays('2026-03-02', 1.5), /non-negative integer/);
  assert.throws(() => addBusinessDays('2026-03-02', NaN), /non-negative integer/);
});

test('the statutory window spans a long weekend correctly', () => {
  // Fri 20 Nov 2026 + 10 business days is Fri 4 Dec: it crosses Thanksgiving
  // (Thu 26 Nov) and the weekend that follows it.
  assert.equal(
    addBusinessDays('2026-11-20', 10).toISOString().slice(0, 10),
    '2026-12-04',
  );
  // Skipping Thanksgiving pushes the deadline to Mon 7 Dec: exactly one
  // business day later, which is the property that matters.
  const withHoliday = addBusinessDays('2026-11-20', 10, ['2026-11-26']).toISOString().slice(0, 10);
  assert.equal(withHoliday, '2026-12-07');
  assert.equal(
    businessDaysBetween('2026-12-04', withHoliday),
    1,
    'skipping one holiday must move the deadline by exactly one business day',
  );
});