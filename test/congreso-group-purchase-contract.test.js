const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('aparta el grupo completo en una transacción antes de abrir Stripe', () => {
  const start = source.indexOf("app.post('/create-checkout-session-congreso'");
  const end = source.indexOf("app.post('/congreso/cancelar-reserva'", start);
  const route = source.slice(start, end);

  assert.match(route, /asientos\.length > 10/);
  assert.match(route, /db\.runTransaction/);
  assert.match(route, /Promise\.all\(asientoRefs\.map\(\(ref\) => tx\.get\(ref\)\)\)/);
  assert.match(route, /quantity: asientos\.length/);
  assert.match(route, /asientos: JSON\.stringify\(asientos\)/);
});

test('crea un registro y un vínculo de asiento por cada boleto del grupo', () => {
  const completed = source.slice(
    source.indexOf("case 'checkout.session.completed'"),
    source.indexOf("case 'checkout.session.expired'")
  );

  assert.match(completed, /for \(const asientoCompra of asientosParaRegistrar\)/);
  assert.match(completed, /`\$\{session\.id\}_\$\{asientoCompra\.toLowerCase\(\)\}`/);
  assert.match(completed, /cantidadBoletos/);
  assert.match(completed, /asientosGrupo/);
  assert.match(completed, /registroId: regRef\.id/);
});



