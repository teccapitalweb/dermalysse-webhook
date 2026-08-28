const crypto = require('crypto');

const QR_TOTAL = 100;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,96}$/;

function codigoQr(numero) {
  const value = Number(numero);
  if (!Number.isInteger(value) || value < 1 || value > QR_TOTAL) return null;
  return `QR-${String(value).padStart(3, '0')}`;
}

function normalizarToken(token) {
  const value = String(token || '').trim();
  return TOKEN_PATTERN.test(value) ? value : '';
}

function hashToken(token) {
  const value = normalizarToken(token);
  if (!value) return '';
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function texto(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function booleano(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function perfilQr(body = {}, registro = {}) {
  const extra = registro.extra && typeof registro.extra === 'object' ? registro.extra : {};
  return {
    nombre: texto(body.nombre || registro.nombre, 160),
    cargo: texto(body.cargo || extra.Cargo, 120),
    empresa: texto(body.empresa || extra.Empresa, 180),
    bio: texto(body.bio, 500),
    correo: texto(body.correo || registro.correo, 180).toLowerCase(),
    telefono: texto(body.telefono || registro.telefono, 60),
    sitioWeb: texto(body.sitioWeb || extra['Sitio web'], 300),
    linkedin: texto(body.linkedin || extra['LinkedIn/Web'], 300),
    instagram: texto(body.instagram || extra.Instagram, 120),
    mostrarCorreo: booleano(body.mostrarCorreo, Boolean(body.correo || registro.correo)),
    mostrarTelefono: booleano(body.mostrarTelefono, Boolean(body.telefono || registro.telefono)),
    mostrarSitioWeb: booleano(body.mostrarSitioWeb, Boolean(body.sitioWeb || extra['Sitio web'])),
    mostrarLinkedin: booleano(body.mostrarLinkedin, Boolean(body.linkedin || extra['LinkedIn/Web'])),
    mostrarInstagram: booleano(body.mostrarInstagram, Boolean(body.instagram || extra.Instagram))
  };
}

function perfilPublico(perfil = {}) {
  return {
    nombre: texto(perfil.nombre, 160),
    cargo: texto(perfil.cargo, 120),
    empresa: texto(perfil.empresa, 180),
    bio: texto(perfil.bio, 500),
    correo: perfil.mostrarCorreo ? texto(perfil.correo, 180) : '',
    telefono: perfil.mostrarTelefono ? texto(perfil.telefono, 60) : '',
    sitioWeb: perfil.mostrarSitioWeb ? texto(perfil.sitioWeb, 300) : '',
    linkedin: perfil.mostrarLinkedin ? texto(perfil.linkedin, 300) : '',
    instagram: perfil.mostrarInstagram ? texto(perfil.instagram, 120) : ''
  };
}

module.exports = {
  QR_TOTAL,
  TOKEN_PATTERN,
  codigoQr,
  normalizarToken,
  hashToken,
  perfilQr,
  perfilPublico
};
