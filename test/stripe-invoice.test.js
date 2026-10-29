'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { subscriptionIdFromInvoice } = require('../stripe-invoice');

test('lee la suscripción desde la forma histórica de Invoice', () => {
  assert.equal(subscriptionIdFromInvoice({ subscription: 'sub_legacy' }), 'sub_legacy');
  assert.equal(subscriptionIdFromInvoice({ subscription: { id: 'sub_expandida' } }), 'sub_expandida');
});

test('lee la suscripción desde parent.subscription_details de Stripe actual', () => {
  assert.equal(subscriptionIdFromInvoice({
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_actual' } },
  }), 'sub_actual');
});

test('usa las líneas actuales y heredadas como respaldo', () => {
  assert.equal(subscriptionIdFromInvoice({ lines: { data: [{
    parent: { subscription_item_details: { subscription: 'sub_linea_actual' } },
  }] } }), 'sub_linea_actual');
  assert.equal(subscriptionIdFromInvoice({ lines: { data: [{ subscription: 'sub_linea_legacy' }] } }), 'sub_linea_legacy');
});

test('una factura ajena a suscripción no inventa un id', () => {
  assert.equal(subscriptionIdFromInvoice({ parent: { type: 'quote_details' }, lines: { data: [] } }), '');
  assert.equal(subscriptionIdFromInvoice(null), '');
});
