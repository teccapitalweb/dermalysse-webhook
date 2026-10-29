'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isStaleSubscriptionEvent,
  memberPatch,
  persistStripeMembership,
  planFromSubscription,
  subscriptionBelongsToUser,
  subscriptionPatch,
} = require('../stripe-membership');

const future = Math.floor(Date.parse('2027-01-01T00:00:00.000Z') / 1000);
const past = Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000);
const sub = (overrides = {}) => ({
  id: 'sub_actual', status: 'active', customer: 'cus_actual', cancel_at_period_end: false,
  items: { data: [{ current_period_end: future, price: { recurring: { interval: 'month' } } }] },
  ...overrides,
});

test('eventos de otra suscripción nunca sustituyen la suscripción actual', () => {
  assert.equal(isStaleSubscriptionEvent({ status: 'active', stripeSubscriptionId: 'sub_actual' }, 'sub_vieja', 'active'), true);
  assert.equal(isStaleSubscriptionEvent({ status: 'past_due', stripeSubscriptionId: 'sub_actual' }, 'sub_vieja', 'active'), true);
  assert.equal(isStaleSubscriptionEvent({ status: 'active', stripeSubscriptionId: 'sub_actual' }, 'sub_actual', 'active'), false);
});

test('un incomplete tardío no degrada una membresía activa', () => {
  assert.equal(isStaleSubscriptionEvent({ status: 'active', stripeSubscriptionId: 'sub_actual' }, 'sub_actual', 'incomplete_expired'), true);
});

test('cancelación y portal solo operan la suscripción de la cuenta autenticada', () => {
  assert.equal(subscriptionBelongsToUser({ metadata: { firebaseUid: 'uid-1', source: 'dermalysse' } }, 'uid-1'), true);
  assert.equal(subscriptionBelongsToUser({ metadata: { firebaseUid: 'uid-2', source: 'dermalysse' } }, 'uid-1'), false);
  assert.equal(subscriptionBelongsToUser({ metadata: { firebaseUid: 'uid-1', source: 'otro-club' } }, 'uid-1'), false);
});

test('construye estado autoritativo mensual/anual con el periodo por item', () => {
  assert.equal(planFromSubscription(sub()), 'mensual');
  const patch = subscriptionPatch(sub(), { now: '2026-10-29T00:00:00.000Z', amountPaid: 199 });
  assert.deepEqual(patch, {
    status: 'active', stripeSubscriptionId: 'sub_actual', stripeCustomerId: 'cus_actual',
    currentPeriodEnd: '2027-01-01T00:00:00.000Z', cancelAtPeriodEnd: false,
    plan: 'mensual', amountPaid: 199, updatedAt: '2026-10-29T00:00:00.000Z',
  });
});

test('members refleja el plan real sin desactivar la cuenta cuando vence VIP', () => {
  const paid = memberPatch({}, { status: 'active', plan: 'mensual', currentPeriodEnd: '2027-01-01T00:00:00.000Z' }, Date.parse('2026-10-29T00:00:00.000Z'));
  const expired = memberPatch({}, { status: 'active', plan: 'mensual', currentPeriodEnd: new Date(past * 1000).toISOString() }, Date.parse('2026-10-29T00:00:00.000Z'));
  const courtesy = memberPatch({ vigenciaHasta: '2027-01-01T00:00:00.000Z' }, { status: 'canceled', plan: 'mensual' }, Date.parse('2026-10-29T00:00:00.000Z'));
  assert.deepEqual(paid, { plan: 'Mensual', status: 'active' });
  assert.deepEqual(expired, { plan: 'Free' });
  assert.deepEqual(courtesy, { plan: 'Cortesía', status: 'active' });
});

function fakeDb(userData) {
  const writes = [];
  return {
    writes,
    collection(name) { return { doc(uid) { return { path: `${name}/${uid}` }; } }; },
    async runTransaction(fn) {
      await fn({
        async get(ref) { return { exists: ref.path.startsWith('users/'), data: () => userData }; },
        set(ref, data, options) { writes.push({ path: ref.path, data, options }); },
      });
    },
  };
}

test('persistencia transaccional ignora un evento de una suscripción anterior', async () => {
  const db = fakeDb({ subscription: { status: 'active', stripeSubscriptionId: 'sub_actual' } });
  const result = await persistStripeMembership(db, 'uid-1', sub({ id: 'sub_vieja' }), { status: 'active' });
  assert.equal(result.stale, true);
  assert.equal(db.writes.length, 0);
});

test('checkout autorizado actualiza users y members juntos', async () => {
  const db = fakeDb({ subscription: { status: 'canceled', stripeSubscriptionId: 'sub_vieja' } });
  const result = await persistStripeMembership(db, 'uid-1', sub(), {
    allowReplace: true, status: 'active', now: '2026-10-29T00:00:00.000Z',
  });
  assert.equal(result.applied, true);
  assert.deepEqual(db.writes.map((w) => w.path), ['users/uid-1', 'members/uid-1']);
  assert.equal(db.writes[0].data.subscription.stripeSubscriptionId, 'sub_actual');
  assert.deepEqual(db.writes[1].data, { plan: 'Mensual', status: 'active' });
});
