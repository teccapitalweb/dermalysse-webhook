const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureStripeCustomer, isMissingStripeCustomerError } = require('../stripe-customer');

test('reuses a customer that exists in the current Stripe environment', async () => {
  let creates = 0;
  let writes = 0;
  const customerId = await ensureStripeCustomer({
    stripe: {
      customers: {
        retrieve: async id => ({ id, deleted: false }),
        create: async () => { creates += 1; return { id: 'cus_new' }; }
      }
    },
    userRef: { set: async () => { writes += 1; } },
    firebaseUid: 'firebase-user',
    email: 'socia@example.com',
    userData: { subscription: { stripeCustomerId: 'cus_live' } }
  });

  assert.equal(customerId, 'cus_live');
  assert.equal(creates, 0);
  assert.equal(writes, 0);
});

test('replaces and persists a customer left behind in Stripe test mode', async () => {
  let savedData;
  const customerId = await ensureStripeCustomer({
    stripe: {
      customers: {
        retrieve: async () => {
          const error = new Error("No such customer: 'cus_test'");
          error.code = 'resource_missing';
          throw error;
        },
        create: async params => {
          assert.deepEqual(params.metadata, { firebaseUid: 'firebase-user', source: 'dermalysse' });
          return { id: 'cus_live_new' };
        }
      }
    },
    userRef: { set: async (data, options) => { savedData = { data, options }; } },
    firebaseUid: 'firebase-user',
    email: 'socia@example.com',
    userData: { subscription: { stripeCustomerId: 'cus_test' } }
  });

  assert.equal(customerId, 'cus_live_new');
  assert.equal(savedData.data.subscription.stripeCustomerId, 'cus_live_new');
  assert.deepEqual(savedData.options, { merge: true });
});

test('does not hide unrelated Stripe failures', () => {
  const error = new Error('Stripe is temporarily unavailable');
  error.code = 'api_error';
  assert.equal(isMissingStripeCustomerError(error), false);
});
