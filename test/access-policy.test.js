'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { membershipAccess } = require('../access-policy');

const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const future = '2026-08-20T12:00:00.000Z';
const past = '2026-08-10T12:00:00.000Z';

test('autoriza una membresía activa', () => {
  assert.equal(membershipAccess({ subscription: { status: 'active', currentPeriodEnd: future } }, NOW).allowed, true);
});

test('autoriza una membresía en prueba', () => {
  assert.equal(membershipAccess({ subscription: { status: 'trialing', currentPeriodEnd: future } }, NOW).allowed, true);
});

test('autoriza una cortesía vigente', () => {
  assert.equal(membershipAccess({ vigenciaHasta: future }, NOW).reason, 'courtesy');
});

test('mantiene acceso tras cancelar mientras el periodo siga vigente', () => {
  assert.equal(membershipAccess({ subscription: { status: 'canceled', currentPeriodEnd: future } }, NOW).reason, 'canceling');
});

test('bloquea una membresía vencida', () => {
  assert.equal(membershipAccess({ subscription: { status: 'canceled', currentPeriodEnd: past } }, NOW).allowed, false);
});

test('bloquea a un usuario sin membresía', () => {
  assert.equal(membershipAccess({}, NOW).allowed, false);
});
