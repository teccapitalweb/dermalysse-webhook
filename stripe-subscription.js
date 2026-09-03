function subscriptionPeriodEndSeconds(subscription) {
  const candidates = [
    subscription?.current_period_end,
    ...(Array.isArray(subscription?.items?.data)
      ? subscription.items.data.map(item => item?.current_period_end)
      : [])
  ]
    .map(Number)
    .filter(value => Number.isFinite(value) && value > 0);

  return candidates.length ? Math.max(...candidates) : null;
}

function subscriptionPeriodEndIso(subscription) {
  const seconds = subscriptionPeriodEndSeconds(subscription);
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

module.exports = { subscriptionPeriodEndSeconds, subscriptionPeriodEndIso };
