'use strict';

function positiveMoney(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error(`PAYMENT_CONFIG_INVALID:${field}`);
    error.code = 'PAYMENT_CONFIG_INVALID';
    throw error;
  }
  return amount;
}

function clubPricing(data) {
  const value = data || {};
  return {
    precioMes: positiveMoney(value.precioMes, 'precioMes'),
    precioAno: positiveMoney(value.precioAno, 'precioAno'),
  };
}

function congressPricing(data) {
  const value = data || {};
  return {
    ficha1Nombre: String(value.ficha1Nombre || 'Especial'),
    ficha1Precio: positiveMoney(value.ficha1Precio, 'ficha1Precio'),
    ficha2Nombre: String(value.ficha2Nombre || 'General'),
    ficha2Precio: positiveMoney(value.ficha2Precio, 'ficha2Precio'),
  };
}

function checkoutUrl(value, fallback, allowedOrigins) {
  if (!value) return fallback;
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && allowedOrigins.includes(url.origin) ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

module.exports = { checkoutUrl, clubPricing, congressPricing, positiveMoney };
