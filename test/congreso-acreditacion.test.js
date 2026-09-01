const test = require('node:test');
const assert = require('node:assert/strict');
const {
  crearTokenGestion,
  hashTokenGestion,
  fechaExpiracionGestion,
  limpiarAsistente,
  estadoDatosAsistente,
  enlaceGestion,
  etiquetaPendiente
} = require('../congreso-acreditacion');

test('genera tokens opacos y guarda únicamente un hash estable', () => {
  const token = crearTokenGestion();
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(hashTokenGestion(token), hashTokenGestion(token));
  assert.notEqual(hashTokenGestion(token), token);
});

test('normaliza los datos editables sin aceptar campos arbitrarios', () => {
  assert.deepEqual(limpiarAsistente({
    registroId: ' reg-1 ', asiento: ' f9 ', nombre: ' Ana ', correo: ' ANA@EXAMPLE.COM ',
    telefono: ' 555 ', empresa: ' Clínica ', linkedinWeb: ' https://example.com ',
    instagram: ' @ana ', consentimientoPublicacion: true, admin: true
  }), {
    registroId: 'reg-1', asiento: 'F9', nombre: 'Ana', correo: 'ana@example.com',
    telefono: '555', cargo: '', empresa: 'Clínica', bio: '', sitioWeb: '',
    linkedinWeb: 'https://example.com', instagram: '@ana', mostrarCorreo: false,
    mostrarTelefono: false, mostrarSitioWeb: false, mostrarLinkedin: false,
    mostrarInstagram: false, tarjetaVisible: false, consentimientoPublicacion: true
  });
});

test('considera completos únicamente nombre, correo y teléfono', () => {
  assert.equal(estadoDatosAsistente({ nombre: 'Ana', correo: 'a@example.com', telefono: '55' }), 'completo');
  assert.equal(estadoDatosAsistente({ nombre: 'Ana', correo: 'a@example.com' }), 'pendiente');
});

test('construye un enlace de gestión sin guardar el token en la ruta', () => {
  assert.equal(
    enlaceGestion('https://congreso.dermalyssemx.com/', 'abc+123'),
    'https://congreso.dermalyssemx.com/congreso/acompanantes?token=abc%2B123'
  );
});

test('los lugares pendientes conservan una etiqueta identificable', () => {
  assert.equal(etiquetaPendiente('f10'), 'Acompañante pendiente · F10');
});

test('la vigencia del enlace es configurable y limitada', () => {
  assert.equal(fechaExpiracionGestion(2, 0), new Date(2 * 86400000).toISOString());
  assert.equal(fechaExpiracionGestion(999, 0), new Date(365 * 86400000).toISOString());
});
