// Email transaccional de "pago fallido" para el Club Dermalysse (Resend).
//
// Módulo puro y testeable (mismo patrón que stripe-subscription.js): index.js
// le inyecta el `emailTemplate` del club y el `sendEmail` reales. Aquí no se
// toca Stripe, Firebase ni la red directamente.
//
// Regla dura: un email jamás debe tumbar un cobro. `enviarEmailPagoFallido`
// nunca lanza; si el proveedor revienta, devuelve { sent:false } y registra un
// warn. Todo valor de terceros (nombre del Auth, razón del error de Stripe) se
// escapa con escHtml antes de entrar al HTML. Los logs enmascaran el correo.

// Escapa & < > " ' para interpolar texto no confiable dentro de HTML.
function escHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Enmascara un correo para logs: "carlos@clinica.mx" -> "c***@clinica.mx".
function maskEmail(email) {
  const s = String(email || '').trim();
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  return `${s[0]}***@${s.slice(at + 1)}`;
}

const DEFAULT_PORTAL_URL = 'https://club.dermalyssemx.com/';

// Construye { subject, html } del aviso de pago fallido.
// `render` = emailTemplate(title, body, buttonText, buttonUrl) del club (inyectado);
// si no se pasa, devuelve solo el cuerpo (útil en pruebas).
function construirEmailPagoFallido({ nombre, razon, portalUrl } = {}, render) {
  const saludo = nombre ? `Hola ${escHtml(nombre)},` : 'Hola,';
  const motivo = razon
    ? `<p style="margin-top:1rem;color:#9a8e7f;font-size:.85rem;">Motivo informado por el procesador de pagos: ${escHtml(razon)}</p>`
    : '';
  const body =
    `<p>${saludo}</p>` +
    '<p>No pudimos procesar el cobro de tu suscripción al <strong>Club Dermalysse</strong>. ' +
    'Tu acceso sigue activo por ahora, pero para no perderlo necesitamos que actualices tu método de pago.</p>' +
    '<p>Entra a tu portal de facturación, actualiza tu tarjeta y el cobro se reintentará automáticamente.</p>' +
    motivo;
  const subject = 'Problema con el pago de tu suscripción · Club Dermalysse';
  const url = portalUrl || DEFAULT_PORTAL_URL;
  const html = typeof render === 'function'
    ? render('Actualiza tu método de pago', body, 'Actualizar mi tarjeta', url)
    : body;
  return { subject, html };
}

// Envía el aviso de forma segura. Nunca lanza: devuelve el resultado del emailer
// o { sent:false, reason }. `emailer` = sendEmail(to, subject, html) (inyectado).
async function enviarEmailPagoFallido(emailer, { to, nombre, razon, portalUrl } = {}, render, logger = console) {
  if (!to) {
    logger.log('ℹ️ Pago fallido: sin correo del miembro; no se envía aviso');
    return { sent: false, reason: 'sin_correo' };
  }
  const { subject, html } = construirEmailPagoFallido({ nombre, razon, portalUrl }, render);
  try {
    const res = await emailer(to, subject, html);
    logger.log('📧 Aviso de pago fallido a:', maskEmail(to), (res && res.reason) || '');
    return res || { sent: false, reason: 'sin_resultado' };
  } catch (e) {
    logger.warn('⚠️ Aviso de pago fallido falló (no bloquea el webhook):', maskEmail(to), e && e.message);
    return { sent: false, reason: 'error_envio' };
  }
}

module.exports = { escHtml, maskEmail, construirEmailPagoFallido, enviarEmailPagoFallido, DEFAULT_PORTAL_URL };
