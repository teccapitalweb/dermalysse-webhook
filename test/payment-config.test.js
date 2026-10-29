'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkoutUrl, clubPricing, congressPricing } = require('../payment-config');

test('los cobros exigen precios reales y nunca inventan importes de respaldo', () => {
  assert.deepEqual(clubPricing({ precioMes: 199, precioAno: 1799 }), { precioMes: 199, precioAno: 1799 });
  assert.throws(() => clubPricing({ precioMes: 0, precioAno: 1799 }), /PAYMENT_CONFIG_INVALID/);
  assert.throws(() => congressPricing({ ficha1Precio: 970 }), /PAYMENT_CONFIG_INVALID/);
});

test('las redirecciones de Stripe permanecen en orígenes autorizados', () => {
  const fallback = 'https://club.dermalyssemx.com/?payment=canceled';
  const allowed = ['https://club.dermalyssemx.com'];
  assert.equal(checkoutUrl('https://club.dermalyssemx.com/cuenta?ok=1', fallback, allowed), 'https://club.dermalyssemx.com/cuenta?ok=1');
  assert.equal(checkoutUrl('https://sitio-malicioso.example/robo', fallback, allowed), fallback);
  assert.equal(checkoutUrl('javascript:alert(1)', fallback, allowed), fallback);
});
