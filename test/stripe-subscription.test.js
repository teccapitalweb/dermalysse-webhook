const test = require('node:test');
const assert = require('node:assert/strict');
const { subscriptionPeriodEndSeconds, subscriptionPeriodEndIso } = require('../stripe-subscription');

test('reads the subscription period end from the legacy top-level field', () => {
  const subscription = { current_period_end: 1798761600 };
  assert.equal(subscriptionPeriodEndSeconds(subscription), 1798761600);
  assert.equal(subscriptionPeriodEndIso(subscription), '2027-01-01T00:00:00.000Z');
});

test('reads the period end from subscription items when Stripe omits the top-level field', () => {
  const subscription = {
    items: { data: [{ current_period_end: 1798761600 }] }
  };
  assert.equal(subscriptionPeriodEndSeconds(subscription), 1798761600);
});

test('does not invent an immediately expired period when Stripe omits both fields', () => {
  assert.equal(subscriptionPeriodEndSeconds({}), null);
  assert.equal(subscriptionPeriodEndIso({}), null);
});
