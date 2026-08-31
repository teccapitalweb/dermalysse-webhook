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
  assert.match(route, /name_collection/);
  assert.match(route, /phone_number_collection/);
  assert.match(route, /stripe\.customers\.create/);
  assert.match(route, /customer: customerCreadoId/);
  assert.match(route, /customer_creation: 'always'/);
  assert.doesNotMatch(route, /custom_fields:/);
});

test('crea un registro y un vínculo de asiento por cada boleto del grupo', () => {
  const completed = source.slice(
    source.indexOf("case 'checkout.session.completed'"),
    source.indexOf("case 'checkout.session.expired'")
  );

  assert.match(completed, /for \(const \[indice, asientoCompra\] of asientosParaRegistrar\.entries\(\)\)/);
  assert.match(completed, /`\$\{session\.id\}_\$\{asientoCompra\.toLowerCase\(\)\}`/);
  assert.match(completed, /cantidadBoletos/);
  assert.match(completed, /asientosGrupo/);
  assert.match(completed, /registroId: regRef\.id/);
  assert.match(completed, /datosAsistenteEstado/);
  assert.match(completed, /Registrar a mis acompañantes/);
});

test('ofrece enlaces opacos para guardar avances o completar cada asiento', () => {
  assert.match(source, /app\.get\('\/congreso\/acompanantes\/:token'/);
  assert.match(source, /app\.put\('\/congreso\/acompanantes\/:token'/);
  assert.match(source, /app\.post\('\/congreso\/acompanantes\/:token\/invitar'/);
  assert.match(source, /hashTokenGestion/);
  assert.match(source, /req\.body\?\.finalizar === true/);
});



