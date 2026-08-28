'use strict';

function toTimestamp(value) {
  if (!value) return NaN;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  return Date.parse(value);
}

function membershipAccess(userData, nowValue) {
  const data = userData || {};
  const now = Number.isFinite(nowValue) ? nowValue : Date.now();
  const courtesyUntil = toTimestamp(data.vigenciaHasta);
  if (Number.isFinite(courtesyUntil) && courtesyUntil > now) {
    return { allowed: true, reason: 'courtesy', expiresAt: courtesyUntil };
  }

  const subscription = data.subscription || {};
  const status = String(subscription.status || 'none').toLowerCase();
  const periodEnd = toTimestamp(subscription.currentPeriodEnd);
  if (status === 'active' || status === 'trialing') {
    const allowed = !Number.isFinite(periodEnd) || periodEnd > now;
    return { allowed, reason: allowed ? status : 'expired', expiresAt: periodEnd };
  }
  if ((status === 'canceled' || subscription.cancelAtPeriodEnd === true) && Number.isFinite(periodEnd)) {
    const allowed = periodEnd > now;
    return { allowed, reason: allowed ? 'canceling' : 'expired', expiresAt: periodEnd };
  }
  return { allowed: false, reason: status === 'past_due' ? 'past_due' : 'none', expiresAt: periodEnd };
}

function hasCurrentMembership(userData, nowValue) {
  return membershipAccess(userData, nowValue).allowed;
}

module.exports = { hasCurrentMembership, membershipAccess, toTimestamp };
