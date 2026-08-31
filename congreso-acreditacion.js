const crypto = require('crypto');

function texto(value, max = 240) {
  return String(value || '').trim().slice(0, max);
}

function crearTokenGestion() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashTokenGestion(value) {
  return crypto.createHash('sha256').update(texto(value, 500)).digest('hex');
}

function fechaExpiracionGestion(dias = 180, ahora = Date.now()) {
  const vigencia = Math.min(365, Math.max(1, Number(dias) || 180));
  return new Date(ahora + vigencia * 86400000).toISOString();
}

function limpiarAsistente(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    registroId: texto(source.registroId, 180),
    asiento: texto(source.asiento, 8).toUpperCase(),
    nombre: texto(source.nombre, 160),
    correo: texto(source.correo, 180).toLowerCase(),
    telefono: texto(source.telefono, 60),
    empresa: texto(source.empresa, 180),
    linkedinWeb: texto(source.linkedinWeb, 240),
    instagram: texto(source.instagram, 120),
    consentimientoPublicacion: source.consentimientoPublicacion === true
  };
}

function estadoDatosAsistente(value) {
  const asistente = limpiarAsistente(value);
  return asistente.nombre && asistente.correo && asistente.telefono ? 'completo' : 'pendiente';
}

function datosExtraAsistente(value, notas = '') {
  const asistente = limpiarAsistente(value);
  return {
    Empresa: asistente.empresa,
    'LinkedIn/Web': asistente.linkedinWeb,
    Instagram: asistente.instagram,
    Notas: texto(notas, 600)
  };
}

function enlaceGestion(baseUrl, token) {
  const base = texto(baseUrl, 500).replace(/\/+$/, '');
  if (!base || !token) return '';
  return `${base}/congreso/acompanantes?token=${encodeURIComponent(token)}`;
}

function etiquetaPendiente(asiento) {
  const lugar = texto(asiento, 8).toUpperCase();
  return lugar ? `Acompañante pendiente · ${lugar}` : 'Acompañante pendiente';
}

module.exports = {
  crearTokenGestion,
  hashTokenGestion,
  fechaExpiracionGestion,
  limpiarAsistente,
  estadoDatosAsistente,
  datosExtraAsistente,
  enlaceGestion,
  etiquetaPendiente
};
