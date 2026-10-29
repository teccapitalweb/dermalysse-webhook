const test = require('node:test');
const assert = require('node:assert/strict');
const {
  escHtml,
  maskEmail,
  construirEmailPagoFallido,
  enviarEmailPagoFallido,
} = require('../emails-pago');

const silencioso = { log() {}, warn() {} };

test('escHtml escapa & < > " y \'', () => {
  assert.equal(escHtml(`<script>a&b"c'd</script>`), '&lt;script&gt;a&amp;b&quot;c&#39;d&lt;/script&gt;');
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
  assert.equal(escHtml(0), '0');
});

test('maskEmail oculta el local salvo la primera letra', () => {
  assert.equal(maskEmail('carlos@clinica.mx'), 'c***@clinica.mx');
  assert.equal(maskEmail(''), '***');
  assert.equal(maskEmail('sinarroba'), '***');
  assert.equal(maskEmail('@dominio.com'), '***');
});

test('construirEmailPagoFallido escapa el nombre (Auth) y la razón (Stripe) de terceros', () => {
  const render = (title, body, btn) => `<<${title}|${btn}>>${body}`;
  const { subject, html } = construirEmailPagoFallido(
    { nombre: '<img src=x onerror=alert(1)>', razon: 'tarjeta "rechazada" <banco> & co' },
    render,
  );
  assert.match(subject, /pago/i);
  // Nada del input de terceros entra sin escapar.
  assert.ok(!html.includes('<img src=x'), 'el nombre no debe inyectarse crudo');
  assert.ok(!html.includes('<banco>'), 'la razón no debe inyectarse cruda');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;banco&gt;'));
  assert.ok(html.includes('&quot;rechazada&quot;'));
  assert.ok(html.includes('&amp; co'));
});

test('sin razón no agrega la línea de motivo', () => {
  const { html } = construirEmailPagoFallido({ nombre: 'Ana' }, (t, b) => b);
  assert.ok(!/Motivo informado/.test(html));
  assert.ok(html.includes('Hola Ana,'));
});

test('un emailer caído NO rompe el flujo (nunca lanza)', async () => {
  const emailerCaido = async () => { throw new Error('Resend 500'); };
  const res = await enviarEmailPagoFallido(emailerCaido, { to: 'a@b.com', nombre: 'Ana' }, (t, b) => b, silencioso);
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'error_envio');
});

test('el aviso llega al email correcto del miembro', async () => {
  const enviados = [];
  const fakeEmailer = async (to, subject, html, options) => { enviados.push({ to, subject, html, options }); return { sent: true, reason: 'enviada' }; };
  const res = await enviarEmailPagoFallido(
    fakeEmailer,
    { to: 'socio@clinica.mx', nombre: 'Dra. Pérez', idempotencyKey: 'invoice-in_123' },
    (t, b) => b,
    silencioso,
  );
  assert.equal(res.sent, true);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, 'socio@clinica.mx');
  assert.deepEqual(enviados[0].options, { idempotencyKey: 'invoice-in_123' });
  assert.match(enviados[0].subject, /pago/i);
});

test('sin correo no intenta enviar', async () => {
  const enviados = [];
  const fakeEmailer = async (to) => { enviados.push(to); return { sent: true }; };
  const res = await enviarEmailPagoFallido(fakeEmailer, { to: '', nombre: 'X' }, (t, b) => b, silencioso);
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'sin_correo');
  assert.equal(enviados.length, 0);
});
