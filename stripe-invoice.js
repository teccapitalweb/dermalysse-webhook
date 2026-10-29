'use strict';

function id(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return '';
}

/**
 * Stripe movió `invoice.subscription` a `invoice.parent.subscription_details.subscription`
 * en versiones recientes de la API. Conservamos ambas formas y dos respaldos de línea para
 * procesar renovaciones y fallos sin depender de una única versión del objeto Invoice.
 */
function subscriptionIdFromInvoice(invoice) {
  const legacy = id(invoice?.subscription);
  if (legacy) return legacy;

  const parent = id(invoice?.parent?.subscription_details?.subscription);
  if (parent) return parent;

  for (const line of invoice?.lines?.data || []) {
    const fromSubscriptionItem = id(line?.parent?.subscription_item_details?.subscription);
    if (fromSubscriptionItem) return fromSubscriptionItem;
    const fromInvoiceItem = id(line?.parent?.invoice_item_details?.subscription);
    if (fromInvoiceItem) return fromInvoiceItem;
    const legacyLine = id(line?.subscription);
    if (legacyLine) return legacyLine;
  }
  return '';
}

module.exports = { subscriptionIdFromInvoice };
