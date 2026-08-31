function normalizarAsientosCongreso(valor, respaldo) {
  let candidatos = valor;
  if (typeof valor === 'string') {
    try {
      const parsed = JSON.parse(valor);
      candidatos = Array.isArray(parsed) ? parsed : valor.split(',');
    } catch {
      candidatos = valor.split(',');
    }
  }
  if (!Array.isArray(candidatos)) candidatos = respaldo ? [respaldo] : [];
  if (candidatos.length === 0 && respaldo) candidatos = [respaldo];

  return [...new Set(candidatos
    .filter((asiento) => typeof asiento === 'string')
    .map((asiento) => asiento.trim().toUpperCase())
    .filter(Boolean))];
}

/*
  Cancela una reserva temporal sin abrir la puerta a dobles ventas: primero
  expira la Checkout Session en Stripe y solo después libera todos los lugares
  cuyo hold todavía pertenece a esa misma sesión. Es idempotente y nunca toca
  una sesión pagada ni un asiento vendido.
*/
async function cancelarReservaCongreso({ stripe, db, sessionId }) {
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    throw new Error('INVALID_CHECKOUT_SESSION');
  }

  let session = await stripe.checkout.sessions.retrieve(sessionId);
  const asientos = normalizarAsientosCongreso(session.metadata?.asientos, session.metadata?.asiento);
  if (session.metadata?.source !== 'congreso' || asientos.length === 0) {
    throw new Error('NOT_CONGRESS_SESSION');
  }

  if (session.payment_status === 'paid' || session.status === 'complete') {
    return { liberado: false, motivo: 'pagado', asientos, asiento: asientos[0] };
  }

  if (session.status === 'open') {
    try {
      session = await stripe.checkout.sessions.expire(session.id);
    } catch (error) {
      // El pago pudo completarse justo entre retrieve() y expire(). Volver a
      // consultar evita liberar un asiento que ya se cobró.
      session = await stripe.checkout.sessions.retrieve(session.id);
      if (session.payment_status === 'paid' || session.status === 'complete') {
        return { liberado: false, motivo: 'pagado', asientos, asiento: asientos[0] };
      }
      if (session.status !== 'expired') throw error;
    }
  }

  if (session.status !== 'expired') {
    return { liberado: false, motivo: session.status || 'no_cancelable', asientos, asiento: asientos[0] };
  }

  const refs = asientos.map((asiento) => db.collection('congresoAsientos').doc(asiento));
  const liberados = [];
  await db.runTransaction(async (tx) => {
    const docs = await Promise.all(refs.map((ref) => tx.get(ref)));
    docs.forEach((doc, index) => {
      if (!doc.exists) return;
      const data = doc.data();
      if (data.estado !== 'hold' || data.sessionId !== session.id) return;
      tx.update(refs[index], {
        estado: 'libre',
        holdUntil: null,
        sessionId: null,
        actualizadoEn: new Date().toISOString()
      });
      liberados.push(asientos[index]);
    });
  });

  return {
    liberado: liberados.length > 0,
    motivo: liberados.length > 0 ? 'cancelado' : 'ya_liberado',
    asientos,
    asiento: asientos[0],
    liberados
  };
}

module.exports = { cancelarReservaCongreso, normalizarAsientosCongreso };
