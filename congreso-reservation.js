/*
  Cancela una reserva temporal sin abrir la puerta a dobles ventas: primero
  expira la Checkout Session en Stripe y solo después libera el asiento si el
  hold todavía pertenece a esa misma sesión. Es idempotente y nunca toca una
  sesión pagada ni un asiento vendido.
*/
async function cancelarReservaCongreso({ stripe, db, sessionId }) {
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    throw new Error('INVALID_CHECKOUT_SESSION');
  }

  let session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.metadata?.source !== 'congreso' || !session.metadata?.asiento) {
    throw new Error('NOT_CONGRESS_SESSION');
  }

  if (session.payment_status === 'paid' || session.status === 'complete') {
    return { liberado: false, motivo: 'pagado', asiento: session.metadata.asiento };
  }

  if (session.status === 'open') {
    try {
      session = await stripe.checkout.sessions.expire(session.id);
    } catch (error) {
      // El pago pudo completarse justo entre retrieve() y expire(). Volver a
      // consultar evita liberar un asiento que ya se cobró.
      session = await stripe.checkout.sessions.retrieve(session.id);
      if (session.payment_status === 'paid' || session.status === 'complete') {
        return { liberado: false, motivo: 'pagado', asiento: session.metadata.asiento };
      }
      if (session.status !== 'expired') throw error;
    }
  }

  if (session.status !== 'expired') {
    return { liberado: false, motivo: session.status || 'no_cancelable', asiento: session.metadata.asiento };
  }

  const asiento = session.metadata.asiento;
  const ref = db.collection('congresoAsientos').doc(asiento);
  let liberado = false;
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return;
    const data = doc.data();
    if (data.estado === 'hold' && data.sessionId === session.id) {
      tx.update(ref, {
        estado: 'libre',
        holdUntil: null,
        sessionId: null,
        actualizadoEn: new Date().toISOString()
      });
      liberado = true;
    }
  });

  return { liberado, motivo: liberado ? 'cancelado' : 'ya_liberado', asiento };
}

module.exports = { cancelarReservaCongreso };
