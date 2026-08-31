const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('permite los métodos usados por la taquilla en el preflight CORS', () => {
  const match = source.match(/Access-Control-Allow-Methods',\s*'([^']+)'/);
  assert.ok(match, 'debe declarar Access-Control-Allow-Methods');
  const methods = new Set(match[1].split(',').map((value) => value.trim()));
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.ok(methods.has(method), `falta permitir ${method}`);
  }
});

test('protege todas las rutas de taquilla con usuario y administrador Firebase', () => {
  const contracts = [
    "app.get('/congreso/admin/registros', requireFirebaseUser, requireFirebaseAdmin",
    "app.get('/congreso/admin/asientos', requireFirebaseUser, requireFirebaseAdmin",
    "app.post('/congreso/admin/registros', requireFirebaseUser, requireFirebaseAdmin",
    "app.put('/congreso/admin/registros/:id', requireFirebaseUser, requireFirebaseAdmin",
    "app.delete('/congreso/admin/registros/:id', requireFirebaseUser, requireFirebaseAdmin",
    "app.delete('/congreso/admin/registros/:id/permanente', requireFirebaseUser, requireFirebaseAdmin",
    "app.patch('/congreso/admin/asientos/:id', requireFirebaseUser, requireFirebaseAdmin"
  ];
  for (const contract of contracts) assert.ok(source.includes(contract), `ruta sin protección: ${contract}`);
});

test('la eliminación permanente exige cancelación y ausencia de asignaciones', () => {
  const start = source.indexOf("app.delete('/congreso/admin/registros/:id/permanente'");
  const end = source.indexOf("app.patch('/congreso/admin/asientos/:id'", start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /estadoRegistro !== 'cancelado'/);
  assert.match(route, /congresoAsientos/);
  assert.match(route, /congresoQrCards/);
  assert.match(route, /congresoDeletedRegistrations/);
  assert.match(route, /batch\.delete\(registroRef\)/);
  assert.match(source, /Registro eliminado definitivamente; webhook ignorado/);
});

test('las altas y cambios de asiento se ejecutan dentro de transacciones', () => {
  const start = source.indexOf("app.post('/congreso/admin/registros'");
  const update = source.indexOf("app.put('/congreso/admin/registros/:id'");
  const cancel = source.indexOf("app.delete('/congreso/admin/registros/:id'");
  assert.ok(start >= 0 && update > start && cancel > update);
  assert.match(source.slice(start, update), /db\.runTransaction/);
  assert.match(source.slice(update, cancel), /db\.runTransaction/);
});

test('la taquilla registra de uno a diez lugares como una compra atómica', () => {
  const start = source.indexOf("app.post('/congreso/admin/registros'");
  const update = source.indexOf("app.put('/congreso/admin/registros/:id'", start);
  assert.ok(start >= 0 && update > start);
  const route = source.slice(start, update);

  assert.match(route, /normalizarAsientosCongreso\(req\.body\?\.asientos, req\.body\?\.asiento\)/);
  assert.match(route, /asientos\.length > 10/);
  assert.match(route, /Promise\.all\(asientoRefs\.map\(\(ref\) => tx\.get\(ref\)\)\)/);
  assert.match(route, /cantidadBoletos: asientos\.length/);
  assert.match(route, /asientosGrupo: asientos/);
  assert.match(route, /compraGrupoId/);
  assert.match(route, /registrosCreados/);
});

test('los reintentos de Stripe respetan ediciones y cancelaciones administrativas', () => {
  assert.match(source, /registro = \{ \.\.\.registro, \.\.\.datosAnteriores \}/);
  assert.match(source, /datosAnteriores\.estadoRegistro === 'cancelado'/);
});

test('el sembrado del mapa repara asientos faltantes sin sobrescribir ventas', () => {
  assert.match(source, /const faltantes = todosLosAsientos\(\)\.filter/);
  assert.match(source, /for \(const a of faltantes\)/);
  assert.doesNotMatch(source, /if \(snap\.empty\)/);
});
