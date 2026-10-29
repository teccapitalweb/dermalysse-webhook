const test = require('node:test');
const assert = require('node:assert/strict');
const { customerBelongsToUser, ensureStripeCustomer, isMissingStripeCustomerError } = require('../stripe-customer');

test('reuses a customer that exists in the current Stripe environment', async () => {
  let creates = 0;
  let writes = 0;
  const customerId = await ensureStripeCustomer({
    stripe: {
      customers: {
        retrieve: async id => ({ id, deleted: false, metadata: { firebaseUid: 'firebase-user', source: 'dermalysse' } }),
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

test('never reuses a Stripe customer owned by another Firebase account', async () => {
  let created = 0;
  const customerId = await ensureStripeCustomer({
    stripe: {
      customers: {
        retrieve: async id => ({ id, deleted: false, metadata: { firebaseUid: 'another-user', source: 'dermalysse' } }),
        create: async () => { created += 1; return { id: 'cus_owned' }; },
      },
    },
    userRef: { set: async () => {} },
    firebaseUid: 'firebase-user',
    email: 'socia@example.com',
    userData: { subscription: { stripeCustomerId: 'cus_wrong' } },
  });
  assert.equal(customerId, 'cus_owned');
  assert.equal(created, 1);
});

test('legacy customers require a matching subscription before reuse', () => {
  const customer = { id: 'cus_legacy', deleted: false, metadata: {} };
  const subscription = { customer: 'cus_legacy', metadata: { firebaseUid: 'firebase-user', source: 'dermalysse' } };
  assert.equal(customerBelongsToUser(customer, 'firebase-user', subscription), true);
  assert.equal(customerBelongsToUser(customer, 'other-user', subscription), false);
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
