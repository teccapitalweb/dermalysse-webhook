function isMissingStripeCustomerError(error) {
  if (!error) return false;

  const code = String(error.code || error.raw?.code || '').toLowerCase();
  const message = String(error.message || error.raw?.message || '').toLowerCase();

  return code === 'resource_missing' && message.includes('no such customer');
}

async function ensureStripeCustomer({ stripe, userRef, firebaseUid, email, userData = {} }) {
  const storedCustomerId = String(userData.subscription?.stripeCustomerId || '').trim();

  if (storedCustomerId) {
    try {
      const customer = await stripe.customers.retrieve(storedCustomerId);
      if (customer && !customer.deleted) return storedCustomerId;
    } catch (error) {
      if (!isMissingStripeCustomerError(error)) throw error;
      console.warn('Cliente Stripe guardado no pertenece al entorno actual; se reemplazará:', storedCustomerId);
    }
  }

  const customer = await stripe.customers.create({
    email: email || userData.email || '',
    metadata: { firebaseUid, source: 'dermalysse' }
  });

  await userRef.set({
    subscription: {
      stripeCustomerId: customer.id,
      updatedAt: new Date().toISOString()
    }
  }, { merge: true });

  return customer.id;
}

module.exports = { ensureStripeCustomer, isMissingStripeCustomerError };
