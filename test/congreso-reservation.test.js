const test = require('node:test');
const assert = require('node:assert/strict');
const { cancelarReservaCongreso } = require('../congreso-reservation');

function crearDb(asiento) {
  const actualizaciones = [];
  const ref = { id: 'A1' };
  return {
    actualizaciones,
    db: {
      collection: () => ({ doc: () => ref }),
      runTransaction: async (fn) => fn({
        get: async () => ({ exists: true, data: () => asiento }),
        update: (_ref, data) => actualizaciones.push(data)
      })
    }
  };
}

function sesion(overrides = {}) {
  return {
    id: 'cs_live_demo',
    status: 'open',
    payment_status: 'unpaid',
    metadata: { source: 'congreso', asiento: 'A1' },
    ...overrides
  };
}

test('expira Stripe antes de liberar el hold correspondiente', async () => {
  const inicial = sesion();
  const expirada = sesion({ status: 'expired' });
  const stripe = { checkout: { sessions: {
    retrieve: async () => inicial,
    expire: async () => expirada
  } } };
  const { db, actualizaciones } = crearDb({ estado: 'hold', sessionId: inicial.id });

  const resultado = await cancelarReservaCongreso({ stripe, db, sessionId: inicial.id });

  assert.equal(resultado.liberado, true);
  assert.equal(resultado.motivo, 'cancelado');
  assert.equal(actualizaciones.length, 1);
  assert.equal(actualizaciones[0].estado, 'libre');
  assert.equal(actualizaciones[0].sessionId, null);
});

test('nunca libera una sesión pagada', async () => {
  const pagada = sesion({ status: 'complete', payment_status: 'paid' });
  let expirada = false;
  const stripe = { checkout: { sessions: {
    retrieve: async () => pagada,
    expire: async () => { expirada = true; }
  } } };
  const { db, actualizaciones } = crearDb({ estado: 'hold', sessionId: pagada.id });

  const resultado = await cancelarReservaCongreso({ stripe, db, sessionId: pagada.id });

  assert.equal(resultado.motivo, 'pagado');
  assert.equal(expirada, false);
  assert.equal(actualizaciones.length, 0);
});

test('no pisa un hold que pertenece a otra sesión', async () => {
  const inicial = sesion();
  const stripe = { checkout: { sessions: {
    retrieve: async () => inicial,
    expire: async () => sesion({ status: 'expired' })
  } } };
  const { db, actualizaciones } = crearDb({ estado: 'hold', sessionId: 'cs_live_otro' });

  const resultado = await cancelarReservaCongreso({ stripe, db, sessionId: inicial.id });

  assert.equal(resultado.liberado, false);
  assert.equal(resultado.motivo, 'ya_liberado');
  assert.equal(actualizaciones.length, 0);
});

test('protege la venta si el pago termina durante la cancelación', async () => {
  const abierta = sesion();
  const pagada = sesion({ status: 'complete', payment_status: 'paid' });
  let consultas = 0;
  const stripe = { checkout: { sessions: {
    retrieve: async () => (++consultas === 1 ? abierta : pagada),
    expire: async () => { throw new Error('session no longer expireable'); }
  } } };
  const { db, actualizaciones } = crearDb({ estado: 'hold', sessionId: abierta.id });

  const resultado = await cancelarReservaCongreso({ stripe, db, sessionId: abierta.id });

  assert.equal(resultado.motivo, 'pagado');
  assert.equal(actualizaciones.length, 0);
});
