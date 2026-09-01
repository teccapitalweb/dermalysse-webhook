const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  codigoQr,
  normalizarToken,
  hashToken,
  perfilQr,
  perfilPublico
} = require('../congreso-qr');

test('genera códigos físicos QR-001 a QR-100', () => {
  assert.equal(codigoQr(1), 'QR-001');
  assert.equal(codigoQr(100), 'QR-100');
  assert.equal(codigoQr(0), null);
  assert.equal(codigoQr(101), null);
});

test('valida tokens aleatorios y solo persiste su hash', () => {
  const token = 'w8xPqjJ9bR7kM5tV2nS4cD6fH1zL3yUa';
  assert.equal(normalizarToken(token), token);
  assert.equal(normalizarToken('QR-001'), '');
  assert.match(hashToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(hashToken(token), token);
});

test('construye el perfil desde el registro y respeta privacidad', () => {
  const registro = {
    nombre: 'Ana Dermatóloga',
    correo: 'ana@example.com',
    telefono: '+525500000000',
    extra: { Empresa: 'Clínica Ana', Instagram: '@ana', 'LinkedIn/Web': 'linkedin.com/in/ana' }
  };
  const perfil = perfilQr({ mostrarCorreo: false, mostrarTelefono: true, mostrarInstagram: true }, registro);
  const publico = perfilPublico(perfil);
  assert.equal(publico.nombre, 'Ana Dermatóloga');
  assert.equal(publico.empresa, 'Clínica Ana');
  assert.equal(publico.correo, '');
  assert.equal(publico.telefono, '+525500000000');
  assert.equal(publico.instagram, '@ana');
});

test('reutiliza campos y privacidad capturados antes de vincular la tarjeta', () => {
  const perfil = perfilQr({}, {
    nombre: 'Ana',
    extra: { Cargo: 'Dermatóloga', 'Presentación': 'Especialista en piel', 'Sitio web': 'https://ana.mx' },
    preferenciasTarjeta: { mostrarSitioWeb: true, tarjetaVisible: true }
  });
  assert.equal(perfil.cargo, 'Dermatóloga');
  assert.equal(perfil.bio, 'Especialista en piel');
  assert.equal(perfil.sitioWeb, 'https://ana.mx');
  assert.equal(perfil.mostrarSitioWeb, true);
});

test('todas las rutas administrativas QR requieren usuario y administrador', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  for (const route of [
    "app.post('/congreso/admin/qr/lote', requireFirebaseUser, requireFirebaseAdmin",
    "app.get('/congreso/admin/qr', requireFirebaseUser, requireFirebaseAdmin",
    "app.post('/congreso/admin/qr/asignar', requireFirebaseUser, requireFirebaseAdmin",
    "app.put('/congreso/admin/qr/:codigo', requireFirebaseUser, requireFirebaseAdmin",
    "app.delete('/congreso/admin/qr/:codigo/vinculo', requireFirebaseUser, requireFirebaseAdmin"
  ]) assert.ok(source.includes(route), route);
  assert.ok(source.includes("app.get('/congreso/tarjeta/:token'"));
  assert.ok(source.includes("res.set('X-Robots-Tag', 'noindex, nofollow, noarchive')"));
});
