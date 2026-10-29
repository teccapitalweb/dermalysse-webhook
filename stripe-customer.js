function isMissingStripeCustomerError(error) {
  if (!error) return false;

  const code = String(error.code || error.raw?.code || '').toLowerCase();
  const message = String(error.message || error.raw?.message || '').toLowerCase();

  return code === 'resource_missing' && message.includes('no such customer');
}

function stripeId(value) {
  if (typeof value === 'string') return value;
  return value && typeof value.id === 'string' ? value.id : '';
}

function customerBelongsToUser(customer, firebaseUid, subscription) {
  if (!customer || customer.deleted) return false;
  const owner = String(customer.metadata?.firebaseUid || '').trim();
  const source = String(customer.metadata?.source || '').trim();
  if (owner) return owner === firebaseUid && (!source || source === 'dermalysse');

  // Compatibilidad para clientes históricos sin metadata: solo son reutilizables
  // si la suscripción guardada prueba simultáneamente customer, uid y club.
  if (!subscription) return false;
  const subscriptionOwner = String(subscription.metadata?.firebaseUid || '').trim();
  const subscriptionSource = String(subscription.metadata?.source || '').trim();
  return stripeId(subscription.customer) === customer.id
    && subscriptionOwner === firebaseUid
    && (!subscriptionSource || subscriptionSource === 'dermalysse');
}

async function ensureStripeCustomer({ stripe, userRef, firebaseUid, email, userData = {} }) {
  const storedCustomerId = String(userData.subscription?.stripeCustomerId || '').trim();

  if (storedCustomerId) {
    try {
      const customer = await stripe.customers.retrieve(storedCustomerId);
      let storedSubscription = null;
      const subscriptionId = String(userData.subscription?.stripeSubscriptionId || '').trim();
      if (!customer?.metadata?.firebaseUid && subscriptionId) {
        try { storedSubscription = await stripe.subscriptions.retrieve(subscriptionId); } catch { /* no reutilizar */ }
      }
      if (customerBelongsToUser(customer, firebaseUid, storedSubscription)) return storedCustomerId;
      console.warn('Cliente Stripe guardado no pertenece a este usuario; se reemplazará:', storedCustomerId);
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

module.exports = { customerBelongsToUser, ensureStripeCustomer, isMissingStripeCustomerError };
