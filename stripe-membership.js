'use strict';

const { membershipAccess } = require('./access-policy');
const { subscriptionPeriodEndIso } = require('./stripe-subscription');

function id(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return '';
}

function planFromSubscription(sub) {
  const interval = sub?.items?.data?.[0]?.price?.recurring?.interval;
  if (interval === 'year') return 'anual';
  if (interval === 'month') return 'mensual';
  return null;
}

function isStaleSubscriptionEvent(stored, eventSubId, incomingStatus) {
  const currentId = String(stored?.stripeSubscriptionId || '').trim();
  const eventId = id(eventSubId);
  if (currentId && eventId && currentId !== eventId) return true;
  const currentStatus = String(stored?.status || '').toLowerCase();
  const nextStatus = String(incomingStatus || '').toLowerCase();
  return currentStatus === 'active' && ['incomplete', 'incomplete_expired'].includes(nextStatus);
}

function subscriptionBelongsToUser(sub, firebaseUid) {
  return Boolean(sub)
    && String(sub.metadata?.firebaseUid || '').trim() === firebaseUid
    && (!sub.metadata?.source || sub.metadata.source === 'dermalysse');
}

function subscriptionPatch(sub, options = {}) {
  const now = options.now || new Date().toISOString();
  const status = String(options.status || sub?.status || 'none').toLowerCase();
  const patch = {
    status,
    stripeSubscriptionId: id(sub),
    currentPeriodEnd: subscriptionPeriodEndIso(sub),
    cancelAtPeriodEnd: options.cancelAtPeriodEnd ?? sub?.cancel_at_period_end === true,
    updatedAt: now,
  };
  const plan = options.plan || planFromSubscription(sub);
  const customerId = id(options.customerId) || id(sub?.customer);
  if (plan) patch.plan = plan;
  if (customerId) patch.stripeCustomerId = customerId;
  if (Number.isFinite(options.amountPaid)) patch.amountPaid = options.amountPaid;
  if (options.subscribedAt) patch.subscribedAt = options.subscribedAt;
  if (options.canceledAt) patch.canceledAt = options.canceledAt;
  return patch;
}

function memberPatch(userData, mergedSubscription, nowValue = Date.now()) {
  const acceso = membershipAccess({ ...userData, subscription: mergedSubscription }, nowValue);
  // members.status describe si la cuenta pertenece al padrón activo, no si paga VIP.
  // Al terminar una membresía solo vuelve a Free; no se desactiva a la persona.
  if (!acceso.allowed) return { plan: 'Free' };
  if (acceso.reason === 'courtesy') return { plan: 'Cortesía', status: 'active' };
  const plan = String(mergedSubscription?.plan || '').toLowerCase();
  return { plan: plan === 'anual' ? 'Anual' : 'Mensual', status: 'active' };
}

/**
 * Persiste users + members en una sola transacción. Los eventos normales jamás reemplazan
 * la suscripción actual por otra; únicamente checkout.session.completed puede hacerlo.
 */
async function persistStripeMembership(db, uid, sub, options = {}) {
  const eventSubId = id(sub);
  if (!uid || !eventSubId) throw new Error('INVALID_STRIPE_MEMBERSHIP');
  const now = options.now || new Date().toISOString();
  const userRef = db.collection('users').doc(uid);
  const memberRef = db.collection('members').doc(uid);
  let result = null;

  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const userData = userSnap.exists ? userSnap.data() : {};
    const stored = userData.subscription || {};
    const incomingStatus = options.status || sub.status;
    if (!options.allowReplace && isStaleSubscriptionEvent(stored, eventSubId, incomingStatus)) {
      result = { applied: false, stale: true, subscription: stored };
      return;
    }
    const patch = subscriptionPatch(sub, { ...options, now });
    const merged = { ...stored, ...patch };
    const member = memberPatch(userData, merged, Date.parse(now));
    tx.set(userRef, { subscription: patch }, { merge: true });
    tx.set(memberRef, member, { merge: true });
    result = { applied: true, stale: false, subscription: merged, member };
  });
  return result;
}

module.exports = {
  id,
  isStaleSubscriptionEvent,
  memberPatch,
  persistStripeMembership,
  planFromSubscription,
  subscriptionBelongsToUser,
  subscriptionPatch,
};
