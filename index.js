const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const bundledCourseCatalog = require('./data/dermalysse-courses.json');
const { hasCurrentMembership, membershipAccess } = require('./access-policy');
const { advancePlaybackState, courseReleaseAccess, isLessonSequenceUnlocked } = require('./course-policy');
const { cancelarReservaCongreso } = require('./congreso-reservation');

// ═══ FIREBASE ADMIN ═══
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ═══ BUNNY STREAM ═══
// BUNNY_STREAM_TOKEN_KEY es la "Token authentication key" de Security.
// No es la Stream API Key utilizada para administrar o subir videos.
const BUNNY_STREAM_LIBRARY_ID = String(process.env.BUNNY_STREAM_LIBRARY_ID || '').trim();
const BUNNY_STREAM_TOKEN_KEY = getBunnyTokenKey();
const BUNNY_TOKEN_TTL_SECONDS = Math.min(600, Math.max(60, Number(process.env.BUNNY_TOKEN_TTL_SECONDS || process.env.BUNNY_STREAM_TOKEN_TTL_SECONDS) || 300));

function getBunnyTokenKey() {
  return [
    process.env.BUNNY_STREAM_TOKEN_KEY,
    process.env.BUNNY_STREAM_TOKEN_SECURITY_KEY,
    process.env.BUNNY_STREAM_TOKEN_AUTH_KEY,
    process.env.BUNNY_STREAM_API_KEY
  ].map(value => String(value || '').trim()).find(value => value && !/^PEGA_AQUI/i.test(value)) || '';
}

// ═══ EMAIL (Resend API — Dermalysse / BIO SKIN Congress) ═══
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const RESEND_FROM_EMAIL = String(process.env.RESEND_FROM_EMAIL || '').trim();
const RESEND_REPLY_TO = String(process.env.RESEND_REPLY_TO || ADMIN_EMAIL || '').trim();
const EMAIL_NOTIFICATIONS_CONFIGURED = Boolean(RESEND_API_KEY && RESEND_FROM_EMAIL);

async function sendEmail(to, subject, html, options = {}) {
  if (!to) return { sent: false, reason: 'sin_correo' };
  if (!EMAIL_NOTIFICATIONS_CONFIGURED) {
    console.warn('Email omitido: integración no configurada en el entorno');
    return { sent: false, reason: 'no_configurada' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const headers = {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    };
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    const payload = {
      from: RESEND_FROM_EMAIL,
      to: [to],
      subject,
      html
    };
    if (RESEND_REPLY_TO) payload.reply_to = RESEND_REPLY_TO;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      console.log('📧 Email enviado a:', to, data.id || '');
      return { sent: true, reason: 'enviada', providerId: data.id || null };
    } else {
      const text = await res.text();
      console.error('Email error:', text);
      return { sent: false, reason: 'error_proveedor' };
    }
  } catch(e) {
    console.error('Email error:', e.message);
    return { sent: false, reason: 'error_red' };
  } finally {
    clearTimeout(timeout);
  }
}

function congresoEmailTemplate(title, body) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;margin:0 auto;background:#f5fbfa;border:1px solid #d7eeea;">
    <div style="background:#062d2b;padding:30px 36px;text-align:center;border-bottom:4px solid #21d4bd;">
      <p style="color:#69ead8;letter-spacing:3px;font-size:11px;font-weight:700;margin:0 0 8px;">BIO SKIN</p>
      <h1 style="color:#ffffff;margin:0;font-size:25px;">Congress 2026</h1>
    </div>
    <div style="padding:34px 38px;">
      <h2 style="color:#062d2b;margin:0 0 18px;font-size:24px;">${title}</h2>
      <div style="color:#365653;font-size:15px;line-height:1.75;">${body}</div>
      <div style="text-align:center;margin-top:30px;">
        <a href="https://congreso.dermalyssemx.com/#pases" style="background:#087f78;color:#ffffff;padding:13px 25px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Ver información del congreso</a>
      </div>
    </div>
    <div style="padding:18px 32px;text-align:center;background:#e9f7f4;color:#61817d;font-size:12px;">
      Dermalysse · BIO SKIN Congress 2026
    </div>
  </div>`;
}

function emailTemplate(title, body, buttonText, buttonUrl) {
  return `
  <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#faf7f2;padding:0;">
    <div style="background:#2e5f7a;padding:2rem;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:1.5rem;">Club Dermalysse</h1>
    </div>
    <div style="padding:2rem 2.5rem;">
      <h2 style="color:#3d2e1e;margin:0 0 1rem;">${title}</h2>
      <div style="color:#6b5e50;font-size:.95rem;line-height:1.7;">${body}</div>
      ${buttonText ? '<div style="text-align:center;margin:2rem 0;"><a href="' + buttonUrl + '" style="background:#2e5f7a;color:#fff;padding:.85rem 2rem;border-radius:10px;text-decoration:none;font-weight:700;font-size:1rem;display:inline-block;">' + buttonText + '</a></div>' : ''}
    </div>
    <div style="background:#f0ebe3;padding:1.25rem 2.5rem;text-align:center;font-size:.8rem;color:#9a8e7f;">
      Club Dermalysse · Dermatología y Estética Profesional<br>
      Este correo fue enviado automáticamente. No responder a este mensaje.
    </div>
  </div>`;
}

// ═══ GUARDA: ignorar eventos de suscripciones viejas/abandonadas ═══
async function _isStaleSubEvent(uid, eventSubId, incomingStatus) {
  try {
    const snap = await db.collection('users').doc(uid).get();
    const stored = snap.exists ? (snap.data().subscription || {}) : {};
    if (stored.status !== 'active') return false;
    if (eventSubId && stored.stripeSubscriptionId && eventSubId !== stored.stripeSubscriptionId) {
      console.log('⏭️  Evento ignorado (sub distinta a la activa):', eventSubId, 'vs', stored.stripeSubscriptionId);
      return true;
    }
    if (incomingStatus === 'incomplete' || incomingStatus === 'incomplete_expired') {
      console.log('⏭️  Evento ignorado (downgrade incomplete sobre activa):', uid);
      return true;
    }
    return false;
  } catch (e) {
    console.error('Stale-check error:', e);
    return false;
  }
}

// ═══ DEFENSA CONTAMINACIÓN CRUZADA (cuenta Stripe compartida entre ~16 clubes) ═══
// Capa 1: metadata.source === 'dermalysse'.
// Capa 2 (fallback si no hay source, ej. suscripciones creadas antes de este parche):
// el producto de Dermalysse siempre se llama "Club Dermalysse · Plan ...", ya que
// este webhook usa price_data dinámico (no Price IDs fijos) al crear el checkout.
// Fail-open: si no se puede verificar por un error de red/API, se deja pasar el
// evento para no bloquear pagos reales por un problema temporal de Stripe.
async function _perteneceAEsteClub(metadataSource, sub) {
  if (metadataSource) return metadataSource === 'dermalysse';
  if (!sub) return true;
  try {
    const productRef = sub.items?.data?.[0]?.price?.product;
    if (!productRef) return true;
    const product = typeof productRef === 'string'
      ? await stripe.products.retrieve(productRef)
      : productRef;
    return !!(product?.name && product.name.toLowerCase().includes('dermalysse'));
  } catch (e) {
    console.error('⚠️  Chequeo de producto falló, dejando pasar (fail-open):', e.message);
    return true;
  }
}

// ═══ LEER PRECIOS DINÁMICOS DESDE FIRESTORE ═══
// Este es el CAMBIO PRINCIPAL: en vez de usar Price IDs fijos,
// leemos los precios de config/club cada vez que se crea un checkout.
async function leerPreciosConfig() {
  try {
    const snap = await db.collection('config').doc('club').get();
    const c = snap.exists ? snap.data() : {};
    const precioMes = Number(c.precioMes) > 0 ? Number(c.precioMes) : 200;
    const precioAno = Number(c.precioAno) > 0 ? Number(c.precioAno) : 1799;
    console.log('📊 Precios cargados desde Firestore:', { precioMes, precioAno });
    return { precioMes, precioAno };
  } catch (e) {
    console.error('Error leyendo precios config:', e);
    return { precioMes: 200, precioAno: 1799 };
  }
}

// ═══ LEER FICHAS DEL CONGRESO DESDE FIRESTORE ═══
async function leerFichasCongreso() {
  try {
    const snap = await db.collection('config').doc('congreso').get();
    const c = snap.exists ? snap.data() : {};
    return {
      ficha1Nombre: c.ficha1Nombre || 'Preferente',
      ficha1Precio: Number(c.ficha1Precio) > 0 ? Number(c.ficha1Precio) : 1000,
      ficha2Nombre: c.ficha2Nombre || 'General',
      ficha2Precio: Number(c.ficha2Precio) > 0 ? Number(c.ficha2Precio) : 500
    };
  } catch (e) {
    console.error('Error leyendo fichas congreso:', e);
    return { ficha1Nombre: 'Preferente', ficha1Precio: 1000, ficha2Nombre: 'General', ficha2Precio: 500 };
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAPA DE ASIENTOS DEL CONGRESO
// Fila P  → 8 asientos de PONENTES (nacen 'reservado', nunca se venden)
// Filas A–D → 40 asientos zona PREFERENTE (ficha1)
// Filas E–J → 60 asientos zona GENERAL (ficha2)
// Cambiar el layout aquí lo cambia en todo el sistema (el frontend y el
// admin pintan lo que devuelve GET /congreso/asientos, no un mapa propio).
// ═══════════════════════════════════════════════════════════════════
const SEATMAP = [
  { fila: 'P', asientos: 8,  zona: 'ponente' },
  { fila: 'A', asientos: 10, zona: 'preferente' },
  { fila: 'B', asientos: 10, zona: 'preferente' },
  { fila: 'C', asientos: 10, zona: 'preferente' },
  { fila: 'D', asientos: 10, zona: 'preferente' },
  { fila: 'E', asientos: 10, zona: 'general' },
  { fila: 'F', asientos: 10, zona: 'general' },
  { fila: 'G', asientos: 10, zona: 'general' },
  { fila: 'H', asientos: 10, zona: 'general' },
  { fila: 'I', asientos: 10, zona: 'general' },
  { fila: 'J', asientos: 10, zona: 'general' }
];
const ZONA_POR_FICHA = { ficha1: 'preferente', ficha2: 'general' };
const HOLD_MINUTOS = 35; // > 30 min de expires_at de Stripe, con margen

function todosLosAsientos() {
  const out = [];
  for (const f of SEATMAP) {
    for (let n = 1; n <= f.asientos; n++) {
      out.push({ id: f.fila + n, fila: f.fila, numero: n, zona: f.zona });
    }
  }
  return out;
}

// Crea o repara los docs faltantes sin sobrescribir ventas existentes.
let _asientosSeeded = false;
async function asegurarAsientos() {
  if (_asientosSeeded) return;
  const col = db.collection('congresoAsientos');
  const snap = await col.get();
  const existentes = new Set(snap.docs.map((doc) => doc.id));
  const faltantes = todosLosAsientos().filter((asiento) => !existentes.has(asiento.id));
  if (faltantes.length) {
    const batch = db.batch();
    for (const a of faltantes) {
      batch.set(col.doc(a.id), {
        fila: a.fila,
        numero: a.numero,
        zona: a.zona,
        estado: a.zona === 'ponente' ? 'reservado' : 'libre',
        holdUntil: null,
        sessionId: null,
        nombre: a.zona === 'ponente' ? 'Ponente' : null,
        actualizadoEn: new Date().toISOString()
      });
    }
    await batch.commit();
    console.log('🪑 Asientos faltantes creados:', faltantes.length);
  }
  _asientosSeeded = true;
}

// Estado efectivo: un hold vencido cuenta como libre (sin escribir nada).
function estadoEfectivo(data) {
  if (data.estado === 'hold' && data.holdUntil && new Date(data.holdUntil) < new Date()) {
    return 'libre';
  }
  return data.estado;
}

const app = express();

// ═══ CORS ═══
const allowedOrigins = new Set([
  'https://club.dermalyssemx.com',
  'https://congreso.dermalyssemx.com',
  'https://teccapitalweb.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3010',
  'http://127.0.0.1:3010'
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// ═══ WEBHOOK (necesita raw body — debe ir ANTES de json parser) ═══
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  console.log('📩 Stripe event:', event.type);

  // ═══ IGNORAR EVENTOS DE TEST-MODE (no deben tocar Firestore de producción) ═══
  if (!event.livemode) {
    console.log('⏭️  Evento de test-mode ignorado:', event.type);
    return res.status(200).send('test event ignored');
  }

  try {
    switch (event.type) {
      // ─── Pago exitoso (checkout completado) ───
      case 'checkout.session.completed': {
        const session = event.data.object;
        const uid = session.metadata?.firebaseUid;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        // ─── Ficha de congreso (pago único, sin cuenta/membresía) ───
        if (session.metadata?.source === 'congreso') {
          const md = session.metadata || {};

          /*
            Datos de networking: llegan en session.custom_fields (a diferencia
            de line_items, custom_fields SÍ viene en el payload del webhook).
            Compatibilidad: sesiones creadas con el flujo viejo (modal) traían
            md.extra como JSON en metadata; se conserva como fallback por si
            alguna sesión vieja se completa después del deploy.
          */
          let extra = {};
          try { extra = md.extra ? JSON.parse(md.extra) : {}; } catch (e) { extra = {}; }
          const cf = {};
          for (const f of (session.custom_fields || [])) {
            cf[f.key] = (f.text && f.text.value) || '';
          }
          if (Object.keys(cf).length) {
            extra = {
              'Empresa': cf.empresa || '',
              'LinkedIn/Web': cf.linkedin_web || '',
              'Instagram': cf.instagram || ''
            };
          }

          let registro = {
            nombre: session.customer_details?.name || md.nombre || '',
            correo: session.customer_details?.email || md.correo || '',
            telefono: session.customer_details?.phone || md.telefono || '',
            ficha: md.fichaNombre || md.ficha || '',
            asiento: md.asiento || null,
            monto: session.amount_total ? session.amount_total / 100 : null,
            fechaCompra: new Date().toISOString(),
            stripeSessionId: session.id,
            stripeCustomerId: customerId || null,
            extra
          };
          // El ID de sesión vuelve idempotente el procesamiento: si Stripe
          // reintenta el webhook, no duplica ni el registro ni la confirmación.
          const regRef = db.collection('congresoRegistrations').doc(session.id);
          const regAnterior = await regRef.get();
          const datosAnteriores = regAnterior.exists ? regAnterior.data() : {};
          if (regAnterior.exists) {
            // Un reintento tardío de Stripe nunca debe deshacer cambios hechos
            // en taquilla (por ejemplo, cambio de asiento o corrección de correo).
            // Los datos ya guardados prevalecen sobre el payload original.
            registro = { ...registro, ...datosAnteriores };
            await regRef.set({ ultimoWebhookEn: new Date().toISOString() }, { merge: true });
          } else {
            await regRef.set(registro);
          }
          console.log('🎟️  Registro de congreso guardado:', registro.correo, '-', registro.ficha, '- asiento', registro.asiento || '—');

          // Si el administrador canceló la entrada, un retry del webhook no
          // puede volver a ocupar el asiento ni reenviar una confirmación.
          if (datosAnteriores.estadoRegistro === 'cancelado') {
            console.log('⏭️  Registro cancelado conservado en webhook:', regRef.id);
            break;
          }

          // Marcar el asiento como VENDIDO (el hold pasa a definitivo).
          if (registro.asiento) {
            await db.collection('congresoAsientos').doc(registro.asiento).set({
              estado: 'vendido',
              holdUntil: null,
              sessionId: session.id,
              registroId: regRef.id,
              nombre: registro.nombre || registro.correo || '',
              actualizadoEn: new Date().toISOString()
            }, { merge: true }).catch((e) => console.error('Error marcando asiento vendido:', e));
          }

          if (registro.correo && !datosAnteriores.notificacionEnviadaEn) {
            const notificacion = await sendEmail(registro.correo, '¡Tu ficha al congreso está confirmada!',
              congresoEmailTemplate('¡Gracias por tu compra!',
                '<p>Tu ficha <strong>' + registro.ficha + '</strong> ha sido confirmada.</p>' +
                (registro.asiento ? '<p><strong>Tu asiento:</strong> ' + registro.asiento + '</p>' : '') +
                (registro.monto ? '<p><strong>Monto pagado:</strong> $' + registro.monto.toLocaleString('es-MX') + ' MXN</p>' : '')),
              { idempotencyKey: 'congreso-comprador-' + session.id }
            );
            await regRef.set({
              notificacionCompra: notificacion.reason,
              notificacionEnviadaEn: notificacion.sent ? new Date().toISOString() : null
            }, { merge: true });
          } else if (!registro.correo) {
            await regRef.set({ notificacionCompra: 'sin_correo', notificacionEnviadaEn: null }, { merge: true });
          }
          setTimeout(function(){
            sendEmail(
              ADMIN_EMAIL,
              'Nuevo registro al congreso',
              congresoEmailTemplate('Nueva ficha vendida',
                '<p><strong>' + (registro.nombre || registro.correo) + '</strong> compró la ficha <strong>' + registro.ficha + '</strong>.</p>' +
                '<p style="margin-top:1rem;"><strong>Correo:</strong> ' + registro.correo + '<br><strong>Teléfono:</strong> ' + (registro.telefono || '—') + '</p>'),
              { idempotencyKey: 'congreso-admin-' + session.id }
            );
          }, 3000);
          break;
        }

        if (uid && subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          if (!(await _perteneceAEsteClub(session.metadata?.source, sub))) {
            console.log('⏭️  checkout.session.completed ignorado (evento de otro club):', uid);
            break;
          }
          const interval = sub.items.data[0]?.price?.recurring?.interval;
          // OJO: session.line_items NO viene en el payload del webhook (requiere expand).
          // session.amount_total SÍ viene siempre (en centavos). Fallback: el precio
          // de la suscripción recuperada de Stripe.
          const amount = session.amount_total
            ? session.amount_total / 100
            : (sub.items.data[0]?.price?.unit_amount ? sub.items.data[0].price.unit_amount / 100 : null);

          await db.collection('users').doc(uid).set({
            subscription: {
              status: 'active',
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscriptionId,
              plan: interval === 'year' ? 'anual' : 'mensual',
              amountPaid: amount,
              currentPeriodEnd: (sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : new Date().toISOString()),
              subscribedAt: new Date().toISOString(),
              cancelAtPeriodEnd: false,
              updatedAt: new Date().toISOString()
            }
          }, { merge: true });

          try {
            await db.collection('members').doc(uid).set({
              plan: interval === 'year' ? 'Anual' : 'Mensual',
              status: 'active'
            }, { merge: true });
          } catch(e) {}
          console.log('✅ Suscripción activada para:', uid, '- Plan:', interval);

          // Enviar email al miembro (con precio dinámico; si no hay monto, sin cifra — nunca "$null")
          const memberEmail = session.customer_details?.email || '';
          const _lblPeriodo = interval === 'year' ? 'año' : 'mes';
          const _lblPlan = interval === 'year' ? 'Anual' : 'Mensual';
          const planName = amount ? `${_lblPlan} ($${amount.toLocaleString('es-MX')} MXN/${_lblPeriodo})` : _lblPlan;
          if (memberEmail) {
            sendEmail(memberEmail, '¡Bienvenido al Club Dermalysse!',
              emailTemplate('¡Gracias por suscribirte!',
                '<p>Tu suscripción al <strong>Plan ' + planName + '</strong> ha sido activada exitosamente.</p>' +
                '<p>Ya tienes acceso completo a todos los cursos, webinars en vivo, material PDF y la comunidad del Club Dermalysse.</p>' +
                '<p style="margin-top:1rem;"><strong>Plan:</strong> ' + planName + '<br><strong>Estado:</strong> Activa</p>',
                'Ir al Club', 'https://club.dermalyssemx.com/')
            );
          }

          setTimeout(function(){ sendEmail(ADMIN_EMAIL, 'Nueva suscripción - Club Dermalysse',
            emailTemplate('Nueva suscripción',
              '<p><strong>' + (memberEmail || uid) + '</strong> se ha suscrito al <strong>Plan ' + planName + '</strong>.</p>' +
              '<p style="margin-top:1rem;"><strong>ID de suscripción:</strong> ' + subscriptionId + '<br><strong>Fecha:</strong> ' + new Date().toLocaleString('es-MX') + '</p>',
              'Ver en Admin', 'https://teccapitalweb.github.io/admin_club_dermalysse-main/')
          ); }, 3000);

          try {
            const memberDoc = await db.collection('members').doc(uid).get();
            const memberName = memberDoc.exists ? memberDoc.data().name : uid;
            await db.collection('activity').add({
              text: '<strong>' + memberName + '</strong> se suscribió al plan ' + (interval === 'year' ? 'Anual' : 'Mensual'),
              color: 'blue',
              date: new Date().toISOString()
            });
          } catch(e) {}
        }
        break;
      }

      // ─── Checkout abandonado: liberar el asiento apartado del congreso ───
      case 'checkout.session.expired': {
        const session = event.data.object;
        if (session.metadata?.source === 'congreso' && session.metadata?.asiento) {
          const ref = db.collection('congresoAsientos').doc(session.metadata.asiento);
          try {
            await db.runTransaction(async (tx) => {
              const doc = await tx.get(ref);
              if (!doc.exists) return;
              const a = doc.data();
              // Solo liberar si el hold es de ESTA sesión (no pisar una venta
              // posterior del mismo asiento por otra persona).
              if (a.estado === 'hold' && a.sessionId === session.id) {
                tx.update(ref, { estado: 'libre', holdUntil: null, sessionId: null, actualizadoEn: new Date().toISOString() });
              }
            });
            console.log('🪑 Asiento liberado por sesión expirada:', session.metadata.asiento);
          } catch (e) {
            console.error('Error liberando asiento:', e);
          }
        }
        break;
      }

      // ─── Renovación exitosa ───
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        if (!subscriptionId) break;

        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const uid = sub.metadata?.firebaseUid;

        if (uid) {
          if (!(await _perteneceAEsteClub(sub.metadata?.source, sub))) {
            console.log('⏭️  invoice.payment_succeeded ignorado (evento de otro club):', uid);
            break;
          }
          await db.collection('users').doc(uid).set({
            subscription: {
              status: 'active',
              currentPeriodEnd: (sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : new Date().toISOString()),
              cancelAtPeriodEnd: sub.cancel_at_period_end,
              updatedAt: new Date().toISOString()
            }
          }, { merge: true });
          console.log('✅ Renovación exitosa para:', uid);
        }
        break;
      }

      // ─── Suscripción cancelada ───
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const uid = sub.metadata?.firebaseUid;

        if (uid) {
          if (!(await _perteneceAEsteClub(sub.metadata?.source, sub))) {
            console.log('⏭️  customer.subscription.deleted ignorado (evento de otro club):', uid);
            break;
          }
          if (await _isStaleSubEvent(uid, sub.id, sub.status)) break;
          await db.collection('users').doc(uid).set({
            subscription: {
              status: 'canceled',
              canceledAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          }, { merge: true });

          try {
            await db.collection('members').doc(uid).set({
              plan: 'Free',
              status: 'paused'
            }, { merge: true });
          } catch(e) {}
          console.log('❌ Suscripción cancelada para:', uid);

          try {
            const userDoc = await db.collection('users').doc(uid).get();
            const userData = userDoc.exists ? userDoc.data() : {};
            const memberEmail = userData.email || '';
            const memberName = userData.name || '';
            if (memberEmail) {
              sendEmail(memberEmail, 'Tu suscripción ha sido cancelada - Club Dermalysse',
                emailTemplate('Suscripción cancelada',
                  '<p>Hola ' + memberName + ',</p>' +
                  '<p>Tu suscripción al Club Dermalysse ha sido cancelada.</p>' +
                  '<p>Lamentamos verte partir. Si deseas regresar, puedes reactivar tu suscripción en cualquier momento desde el Club.</p>',
                  'Volver al Club', 'https://club.dermalyssemx.com/')
              );
            }

            setTimeout(function(){ sendEmail(ADMIN_EMAIL, 'Cancelación de suscripción - Club Dermalysse',
              emailTemplate('Suscripción cancelada',
                '<p><strong>' + (memberName || memberEmail || uid) + '</strong> ha cancelado su suscripción.</p>' +
                '<p style="margin-top:1rem;"><strong>Email:</strong> ' + memberEmail + '<br><strong>Fecha:</strong> ' + new Date().toLocaleString('es-MX') + '</p>',
                'Ver en Admin', 'https://teccapitalweb.github.io/admin_club_dermalysse-main/')
            ); }, 3000);
          } catch(e) { console.error('Cancel email error:', e); }

          try {
            const memberDoc = await db.collection('members').doc(uid).get();
            const memberName = memberDoc.exists ? memberDoc.data().name : uid;
            await db.collection('activity').add({
              text: '<strong>' + memberName + '</strong> canceló su suscripción',
              color: 'orange',
              date: new Date().toISOString()
            });
          } catch(e) {}
        }
        break;
      }

      // ─── Suscripción actualizada ───
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const uid = sub.metadata?.firebaseUid;

        if (uid) {
          if (!(await _perteneceAEsteClub(sub.metadata?.source, sub))) {
            console.log('⏭️  customer.subscription.updated ignorado (evento de otro club):', uid);
            break;
          }
          if (await _isStaleSubEvent(uid, sub.id, sub.status)) break;
          await db.collection('users').doc(uid).set({
            subscription: {
              status: sub.status === 'active' ? 'active' : sub.status,
              cancelAtPeriodEnd: sub.cancel_at_period_end,
              currentPeriodEnd: (sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : new Date().toISOString()),
              updatedAt: new Date().toISOString()
            }
          }, { merge: true });
          console.log('🔄 Suscripción actualizada para:', uid);
        }
        break;
      }

      // ─── Pago fallido ───
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        if (!subscriptionId) break;

        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const uid = sub.metadata?.firebaseUid;

        if (uid) {
          if (!(await _perteneceAEsteClub(sub.metadata?.source, sub))) {
            console.log('⏭️  invoice.payment_failed ignorado (evento de otro club):', uid);
            break;
          }
          if (await _isStaleSubEvent(uid, sub.id, sub.status)) break;
          await db.collection('users').doc(uid).set({
            subscription: {
              status: 'past_due',
              updatedAt: new Date().toISOString()
            }
          }, { merge: true });
          console.log('⚠️ Pago fallido para:', uid);
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.json({ received: true });
});

// ═══ JSON parser (para las demás rutas) ═══
app.use(express.json());

// ═══ AUTENTICACIÓN FIREBASE PARA RECURSOS PROTEGIDOS ═══
async function requireFirebaseUser(req, res, next) {
  try {
    const authorization = String(req.headers.authorization || '');
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Inicia sesión para continuar' });
    req.firebaseUser = await admin.auth().verifyIdToken(match[1]);
    next();
  } catch (error) {
    return res.status(401).json({ error: 'La sesión no es válida o expiró' });
  }
}

async function requireFirebaseAdmin(req, res, next) {
  try {
    const adminDoc = await db.collection('admins').doc(req.firebaseUser.uid).get();
    if (!adminDoc.exists) return res.status(403).json({ error: 'No tienes permisos de administrador' });
    next();
  } catch (error) {
    return res.status(503).json({ error: 'No se pudieron verificar los permisos' });
  }
}

async function findCourse(courseId) {
  const snapshot = await db.collection('courses').doc(courseId).get();
  if (snapshot.exists) return { id: snapshot.id, ...snapshot.data() };
  return bundledCourseCatalog.find(course => course.id === courseId) || null;
}

async function findLessonByVideoId(videoId) {
  for (const course of bundledCourseCatalog) {
    const lesson = Array.isArray(course.lessons)
      ? course.lessons.find(item => String(item.videoId || '').toLowerCase() === videoId)
      : null;
    if (lesson) return { course, lesson };
  }
  const snapshot = await db.collection('courses').get();
  for (const docSnapshot of snapshot.docs) {
    const course = { id: docSnapshot.id, ...docSnapshot.data() };
    const lessons = course.lessons;
    const lesson = Array.isArray(lessons)
      ? lessons.find(item => String(item.videoId || '').toLowerCase() === videoId)
      : null;
    if (lesson) return { course, lesson };
  }
  return null;
}

function publicCourseAccess(course) {
  if (!course || (course.status && course.status !== 'published')) {
    return { allowed: false, reason: 'course_not_published' };
  }
  if (String(course.releaseType || 'immediate').toLowerCase() === 'scheduled') {
    const unlockAt = Date.parse(course.unlockDate || '');
    if (!Number.isFinite(unlockAt) || unlockAt > Date.now()) {
      return { allowed: false, reason: 'scheduled_locked', unlockAt };
    }
  }
  return { allowed: true, reason: 'preview' };
}

async function authorizeLesson(uid, course, lesson) {
  const [adminDoc, userDoc] = await Promise.all([
    db.collection('admins').doc(uid).get(),
    db.collection('users').doc(uid).get()
  ]);
  const isAdmin = adminDoc.exists;
  const userData = userDoc.exists ? userDoc.data() : {};
  const memberAccess = membershipAccess(userData);
  const releaseAccess = courseReleaseAccess(course, bundledCourseCatalog, userData);

  if (isAdmin) return { allowed: true, isAdmin, userData, progressAllowed: true, releaseAccess };
  if (lesson.isPreview) {
    const previewAccess = publicCourseAccess(course);
    return {
      allowed: previewAccess.allowed,
      reason: previewAccess.reason,
      isAdmin,
      userData,
      progressAllowed: memberAccess.allowed && releaseAccess.allowed,
      releaseAccess
    };
  }
  if (!memberAccess.allowed) {
    return { allowed: false, reason: 'membership_required', isAdmin, userData, progressAllowed: false, releaseAccess };
  }
  if (!releaseAccess.allowed) {
    return { allowed: false, reason: releaseAccess.reason, isAdmin, userData, progressAllowed: false, releaseAccess };
  }
  return { allowed: true, isAdmin, userData, progressAllowed: true, releaseAccess };
}

function accessErrorMessage(reason) {
  if (reason === 'drip_locked') return 'Este curso todavía no se ha liberado para tu membresía';
  if (reason === 'scheduled_locked') return 'Este curso todavía no está disponible';
  if (reason === 'course_not_published') return 'Este curso no está publicado';
  if (reason === 'previous_lesson_required') return 'Completa la clase anterior antes de continuar';
  return 'Esta clase requiere una membresía vigente';
}

async function lessonSequenceAccess(uid, course, lesson, authorization) {
  if (authorization.isAdmin || lesson.isPreview) return { allowed: true };
  const lessons = Array.isArray(course.lessons) ? course.lessons : [];
  const lessonIndex = lessons.findIndex(item => String(item.id || '') === String(lesson.id || ''));
  if (lessonIndex <= 0) return { allowed: true };
  const progressSnapshot = await db.collection('users').doc(uid)
    .collection('courseProgress').doc(course.id).get();
  const completedLessonIds = progressSnapshot.exists && Array.isArray(progressSnapshot.data().completedLessonIds)
    ? progressSnapshot.data().completedLessonIds.map(String)
    : [];
  return isLessonSequenceUnlocked(course, lesson, completedLessonIds, authorization.isAdmin)
    ? { allowed: true }
    : { allowed: false, reason: 'previous_lesson_required' };
}

// Compatibilidad temporal con el reproductor publicado anteriormente.
app.post('/api/bunny/embed-token', requireFirebaseUser, async (req, res) => {
  try {
    if (!BUNNY_STREAM_LIBRARY_ID || !BUNNY_STREAM_TOKEN_KEY) {
      return res.status(503).json({ error: 'Bunny Stream no está configurado en Railway' });
    }
    const videoId = String(req.body?.videoId || '').trim().toLowerCase();
    if (!/^[0-9a-f-]{36}$/.test(videoId)) {
      return res.status(400).json({ error: 'Video ID inválido' });
    }
    const match = await findLessonByVideoId(videoId);
    if (!match) return res.status(404).json({ error: 'El video no pertenece al catálogo publicado' });
    const authorization = await authorizeLesson(req.firebaseUser.uid, match.course, match.lesson);
    if (!authorization.allowed) return res.status(403).json({ error: accessErrorMessage(authorization.reason) });
    const sequenceAccess = await lessonSequenceAccess(req.firebaseUser.uid, match.course, match.lesson, authorization);
    if (!sequenceAccess.allowed) return res.status(403).json({ error: accessErrorMessage(sequenceAccess.reason) });
    const expires = Math.floor(Date.now() / 1000) + BUNNY_TOKEN_TTL_SECONDS;
    const token = crypto.createHash('sha256').update(BUNNY_STREAM_TOKEN_KEY + videoId + expires).digest('hex');
    const embedUrl = `https://iframe.mediadelivery.net/embed/${encodeURIComponent(BUNNY_STREAM_LIBRARY_ID)}/${videoId}?token=${token}&expires=${expires}`;
    res.set('Cache-Control', 'no-store, private');
    return res.json({ embedUrl, expires, preview: !!match.lesson.isPreview });
  } catch (error) {
    console.error('[Bunny token]', error.message);
    return res.status(500).json({ error: 'No se pudo autorizar el video' });
  }
});

// ═══ CREAR CHECKOUT SESSION CON PRECIO DINÁMICO ═══
// ¡CAMBIO PRINCIPAL! En vez de recibir un priceId fijo, ahora calculamos
// el precio dinámicamente desde Firestore según el plan elegido.
app.post('/create-checkout-session', requireFirebaseUser, async (req, res) => {
  try {
    const { plan, successUrl, cancelUrl } = req.body;
    const firebaseUid = req.firebaseUser.uid;
    const email = req.firebaseUser.email || '';

    // Validar plan
    if (!['mensual', 'anual'].includes(plan)) {
      return res.status(400).json({ error: 'Plan inválido (mensual o anual)' });
    }

    // ← LEE PRECIOS DEL ADMIN (dinámico desde Firestore)
    const { precioMes, precioAno } = await leerPreciosConfig();
    const montoMXN = plan === 'mensual' ? precioMes : precioAno;
    const interval = plan === 'mensual' ? 'month' : 'year';

    // Stripe rechaza cargos menores a $10 MXN — mejor avisar claro que fallar críptico
    if (montoMXN < 10) {
      return res.status(400).json({ error: 'El precio configurado ($' + montoMXN + ' MXN) es menor al mínimo de Stripe ($10 MXN). Revisa Configuración en el panel admin.' });
    }

    // Buscar o crear customer de Stripe
    let customerId;
    const userDoc = await db.collection('users').doc(firebaseUid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    if (userData.subscription?.stripeCustomerId) {
      customerId = userData.subscription.stripeCustomerId;
    } else {
      const customer = await stripe.customers.create({
        email: email || userData.email || '',
        metadata: { firebaseUid }
      });
      customerId = customer.id;
    }

    // ← PRECIO DINÁMICO: en vez de Price ID fijo, armamos el price_data aquí
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'mxn',
          unit_amount: Math.round(montoMXN * 100),
          recurring: { interval },
          product_data: {
            name: `Club Dermalysse · Plan ${plan === 'mensual' ? 'Mensual' : 'Anual'}`
          }
        },
        quantity: 1
      }],
      mode: 'subscription',
      success_url: successUrl || 'https://club.dermalyssemx.com/?payment=success',
      cancel_url: cancelUrl || 'https://club.dermalyssemx.com/?payment=canceled',
      metadata: { firebaseUid, source: 'dermalysse' },
      subscription_data: {
        metadata: { firebaseUid, source: 'dermalysse' }
      }
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ CREAR CHECKOUT SESSION — FICHA DEL CONGRESO (pago único, sin cuenta) ═══
app.post('/create-checkout-session-congreso', async (req, res) => {
  try {
    /*
      FLUJO DIRECTO A STRIPE con selección de asiento tipo cine:
      1. El frontend manda { ficha, asiento } (el asiento elegido en el mapa).
      2. Se valida que el asiento exista, sea de la zona de esa ficha
         (ficha1=preferente filas A–D, ficha2=general filas E–J) y esté libre.
      3. TRANSACCIÓN de Firestore: se aparta con 'hold' 35 min — dos personas
         no pueden apartar el mismo asiento aunque paguen al mismo tiempo.
      4. La sesión de Stripe expira a los 30 min (expires_at): si no paga,
         checkout.session.expired libera el asiento; el hold vence solo como
         red de seguridad extra.
      Los datos personales se piden DENTRO de Stripe: nombre y correo nativos,
      teléfono con phone_number_collection, networking en custom_fields (máx 3).
      El registro se crea en el webhook checkout.session.completed.
    */
    const { ficha, asiento, successUrl, cancelUrl } = req.body;

    if (!['ficha1', 'ficha2'].includes(ficha)) {
      return res.status(400).json({ error: 'Ficha inválida' });
    }
    if (!asiento || typeof asiento !== 'string') {
      return res.status(400).json({ error: 'Elige un asiento para continuar' });
    }

    const fichas = await leerFichasCongreso();
    const fichaNombre = ficha === 'ficha1' ? fichas.ficha1Nombre : fichas.ficha2Nombre;
    const monto = ficha === 'ficha1' ? fichas.ficha1Precio : fichas.ficha2Precio;

    if (monto < 10) {
      return res.status(400).json({ error: 'El precio configurado ($' + monto + ' MXN) es menor al mínimo de Stripe ($10 MXN). Revisa la pestaña Congreso en el panel admin.' });
    }

    await asegurarAsientos();
    const zonaEsperada = ZONA_POR_FICHA[ficha];
    const asientoRef = db.collection('congresoAsientos').doc(asiento.toUpperCase());

    // Apartar el asiento ANTES de crear la sesión de Stripe.
    try {
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(asientoRef);
        if (!doc.exists) throw new Error('SEAT_NOT_FOUND');
        const data = doc.data();
        if (data.zona !== zonaEsperada) throw new Error('SEAT_WRONG_ZONE');
        if (estadoEfectivo(data) !== 'libre') throw new Error('SEAT_TAKEN');
        tx.update(asientoRef, {
          estado: 'hold',
          holdUntil: new Date(Date.now() + HOLD_MINUTOS * 60000).toISOString(),
          sessionId: null,
          actualizadoEn: new Date().toISOString()
        });
      });
    } catch (e) {
      if (e.message === 'SEAT_NOT_FOUND') return res.status(400).json({ error: 'Ese asiento no existe' });
      if (e.message === 'SEAT_WRONG_ZONE') return res.status(400).json({ error: 'Ese asiento no corresponde a la ficha ' + fichaNombre });
      if (e.message === 'SEAT_TAKEN') return res.status(409).json({ error: 'Ese asiento acaba de ocuparse, elige otro' });
      throw e;
    }

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'mxn',
            unit_amount: Math.round(monto * 100),
            product_data: {
              name: `Congreso DermaFutura · Ficha ${fichaNombre} · Asiento ${asiento.toUpperCase()}`
            }
          },
          quantity: 1
        }],
        mode: 'payment',
        // 30 min es el mínimo que permite Stripe; si no paga, el asiento se libera.
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        // Teléfono lo pide Stripe de forma nativa:
        phone_number_collection: { enabled: true },
        // Datos de networking (3 campos = máximo permitido por Stripe).
        locale: 'es-419',
        custom_fields: [
          {
            key: 'empresa',
            label: { type: 'custom', custom: 'Empresa o lugar donde trabajas' },
            type: 'text',
            optional: false
          },
          {
            key: 'linkedin_web',
            label: { type: 'custom', custom: 'LinkedIn o sitio web (opcional)' },
            type: 'text',
            optional: true
          },
          {
            key: 'instagram',
            label: { type: 'custom', custom: 'Instagram (opcional)' },
            type: 'text',
            optional: true
          }
        ],
        success_url: successUrl || 'https://teccapitalweb.github.io/dermafutura-expo-2027/?congreso=success',
        cancel_url: cancelUrl || 'https://teccapitalweb.github.io/dermafutura-expo-2027/?congreso=canceled',
        metadata: {
          source: 'congreso',
          ficha,
          fichaNombre,
          asiento: asiento.toUpperCase()
        }
      });
    } catch (e) {
      // Si Stripe falla, no dejar el asiento colgado en hold.
      await asientoRef.update({ estado: 'libre', holdUntil: null, sessionId: null, actualizadoEn: new Date().toISOString() }).catch(() => {});
      throw e;
    }

    // Amarrar el hold a esta sesión para poder liberarlo si expira.
    await asientoRef.update({ sessionId: session.id }).catch(() => {});

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout congreso error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ CANCELAR CHECKOUT DEL CONGRESO Y LIBERAR SU ASIENTO ═══
// El sessionId es un identificador no predecible. Aun así, el backend valida
// con Stripe que sea una sesión del congreso, que no esté pagada y la expira
// antes de liberar el hold correspondiente.
app.post('/congreso/cancelar-reserva', async (req, res) => {
  try {
    const resultado = await cancelarReservaCongreso({ stripe, db, sessionId: req.body?.sessionId });
    res.json(resultado);
  } catch (err) {
    if (err.message === 'INVALID_CHECKOUT_SESSION' || err.message === 'NOT_CONGRESS_SESSION') {
      return res.status(400).json({ error: 'La reservación no es válida' });
    }
    console.error('Cancelar reserva congreso error:', err);
    res.status(500).json({ error: 'No se pudo liberar la reservación' });
  }
});

// El panel obtiene los registros desde el mismo backend que procesa Stripe.
// Así se garantiza que ambos leen el mismo proyecto de Firestore y la ruta
// queda protegida por el token Firebase y la colección de administradores.
app.get('/congreso/admin/registros', requireFirebaseUser, requireFirebaseAdmin, async (req, res) => {
  try {
    const snap = await db.collection('congresoRegistrations')
      .orderBy('fechaCompra', 'desc')
      .limit(500)
      .get();
    res.set('Cache-Control', 'no-store');
    res.json({ registros: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (err) {
    console.error('GET registros congreso admin error:', err);
    res.status(500).json({ error: 'No se pudieron cargar los registros del congreso' });
  }
});

function fichaCongresoSeleccionada(fichaId, fichas) {
  if (fichaId === 'ficha1') {
    return { id: 'ficha1', nombre: fichas.ficha1Nombre, precio: fichas.ficha1Precio, zona: 'preferente' };
  }
  if (fichaId === 'ficha2') {
    return { id: 'ficha2', nombre: fichas.ficha2Nombre, precio: fichas.ficha2Precio, zona: 'general' };
  }
  return null;
}

function textoFormulario(value, max = 240) {
  return String(value || '').trim().slice(0, max);
}

function datosRegistroTaquilla(body, ficha) {
  const montoIngresado = Number(body.monto);
  const tieneMonto = body.monto !== '' && body.monto !== null && body.monto !== undefined;
  return {
    nombre: textoFormulario(body.nombre, 160),
    correo: textoFormulario(body.correo, 180).toLowerCase(),
    telefono: textoFormulario(body.telefono, 60),
    fichaId: ficha.id,
    ficha: ficha.nombre,
    asiento: textoFormulario(body.asiento, 8).toUpperCase(),
    monto: tieneMonto && Number.isFinite(montoIngresado) && montoIngresado >= 0 ? montoIngresado : ficha.precio,
    metodoPago: textoFormulario(body.metodoPago || 'efectivo', 40),
    extra: {
      Empresa: textoFormulario(body.empresa, 180),
      'LinkedIn/Web': textoFormulario(body.linkedinWeb, 240),
      Instagram: textoFormulario(body.instagram, 120),
      Notas: textoFormulario(body.notas, 600)
    }
  };
}

// La taquilla del panel usa estas rutas para leer y modificar la MISMA base
// que Stripe. Ningún dato sensible queda expuesto en el mapa público.
app.get('/congreso/admin/asientos', requireFirebaseUser, requireFirebaseAdmin, async (req, res) => {
  try {
    await asegurarAsientos();
    const snap = await db.collection('congresoAsientos').get();
    const asientos = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      estado: estadoEfectivo(doc.data())
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ layout: SEATMAP, asientos });
  } catch (err) {
    console.error('GET asientos congreso admin error:', err);
    res.status(500).json({ error: 'No se pudo cargar el mapa administrativo' });
  }
});

app.post('/congreso/admin/registros', requireFirebaseUser, requireFirebaseAdmin, async (req, res) => {
  try {
    const fichas = await leerFichasCongreso();
    const ficha = fichaCongresoSeleccionada(req.body?.fichaId, fichas);
    if (!ficha) return res.status(400).json({ error: 'Selecciona una ficha válida' });

    const datos = datosRegistroTaquilla(req.body || {}, ficha);
    if (!datos.nombre) return res.status(400).json({ error: 'Escribe el nombre del asistente' });
    if (!datos.asiento) return res.status(400).json({ error: 'Selecciona un asiento' });
    if (req.body?.enviarConfirmacion && !datos.correo) {
      return res.status(400).json({ error: 'Agrega un correo para enviar la confirmación' });
    }

    await asegurarAsientos();
    const registroId = 'manual-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    const ahora = new Date().toISOString();
    const registroRef = db.collection('congresoRegistrations').doc(registroId);
    const asientoRef = db.collection('congresoAsientos').doc(datos.asiento);
    const registro = {
      ...datos,
      fechaCompra: ahora,
      origen: 'taquilla',
      estadoRegistro: 'activo',
      creadoPor: req.firebaseUser.email || req.firebaseUser.uid,
      stripeSessionId: null,
      stripeCustomerId: null,
      notificacionCompra: req.body?.enviarConfirmacion ? 'pendiente' : 'no_solicitada',
      notificacionEnviadaEn: null
    };

    await db.runTransaction(async (tx) => {
      const asientoSnap = await tx.get(asientoRef);
      if (!asientoSnap.exists) throw new Error('SEAT_NOT_FOUND');
      const asiento = asientoSnap.data();
      if (asiento.zona !== ficha.zona) throw new Error('SEAT_WRONG_ZONE');
      if (estadoEfectivo(asiento) !== 'libre') throw new Error('SEAT_TAKEN');

      tx.set(registroRef, registro);
      tx.set(asientoRef, {
        estado: 'vendido',
        holdUntil: null,
        sessionId: null,
        registroId,
        nombre: datos.nombre,
        actualizadoEn: ahora
      }, { merge: true });
    });

    if (req.body?.enviarConfirmacion && datos.correo) {
      const notificacion = await sendEmail(
        datos.correo,
        '¡Tu ficha al congreso está confirmada!',
        congresoEmailTemplate('¡Gracias por tu compra!',
          '<p>Tu ficha <strong>' + ficha.nombre + '</strong> ha sido confirmada.</p>' +
          '<p><strong>Tu asiento:</strong> ' + datos.asiento + '</p>' +
          '<p><strong>Monto registrado:</strong> $' + datos.monto.toLocaleString('es-MX') + ' MXN</p>'),
        { idempotencyKey: 'congreso-manual-' + registroId }
      );
      registro.notificacionCompra = notificacion.reason;
      registro.notificacionEnviadaEn = notificacion.sent ? new Date().toISOString() : null;
      await registroRef.set({
        notificacionCompra: registro.notificacionCompra,
        notificacionEnviadaEn: registro.notificacionEnviadaEn
      }, { merge: true });
    }

    res.status(201).json({ registro: { id: registroId, ...registro } });
  } catch (err) {
    if (err.message === 'SEAT_NOT_FOUND') return res.status(400).json({ error: 'Ese asiento no existe' });
    if (err.message === 'SEAT_WRONG_ZONE') return res.status(400).json({ error: 'El asiento no corresponde a la ficha seleccionada' });
    if (err.message === 'SEAT_TAKEN') return res.status(409).json({ error: 'Ese asiento ya no está disponible' });
    console.error('POST registro congreso admin error:', err);
    res.status(500).json({ error: 'No se pudo registrar al asistente' });
  }
});

app.put('/congreso/admin/registros/:id', requireFirebaseUser, requireFirebaseAdmin, async (req, res) => {
  try {
    const fichas = await leerFichasCongreso();
    const ficha = fichaCongresoSeleccionada(req.body?.fichaId, fichas);
    if (!ficha) return res.status(400).json({ error: 'Selecciona una ficha válida' });
    const datos = datosRegistroTaquilla(req.body || {}, ficha);
    if (!datos.nombre || !datos.asiento) return res.status(400).json({ error: 'Nombre y asiento son obligatorios' });
    if (req.body?.enviarConfirmacion && !datos.correo) {
      return res.status(400).json({ error: 'Agrega un correo para enviar la confirmación' });
    }

    await asegurarAsientos();
    const registroId = req.params.id;
    const registroRef = db.collection('congresoRegistrations').doc(registroId);
    const asientoNuevoRef = db.collection('congresoAsientos').doc(datos.asiento);
    const ahora = new Date().toISOString();
    let anterior;

    await db.runTransaction(async (tx) => {
      const registroSnap = await tx.get(registroRef);
      if (!registroSnap.exists) throw new Error('REG_NOT_FOUND');
      anterior = registroSnap.data();
      const asientoAnteriorId = textoFormulario(anterior.asiento, 8).toUpperCase();
      const asientoAnteriorRef = asientoAnteriorId ? db.collection('congresoAsientos').doc(asientoAnteriorId) : null;

      const refs = [asientoNuevoRef];
      if (asientoAnteriorRef && asientoAnteriorId !== datos.asiento) refs.push(asientoAnteriorRef);
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      const asientoNuevoSnap = snaps[0];
      if (!asientoNuevoSnap.exists) throw new Error('SEAT_NOT_FOUND');
      const asientoNuevo = asientoNuevoSnap.data();
      if (asientoNuevo.zona !== ficha.zona) throw new Error('SEAT_WRONG_ZONE');
      const conservaAsiento = asientoAnteriorId === datos.asiento && asientoNuevo.registroId === registroId;
      if (!conservaAsiento && estadoEfectivo(asientoNuevo) !== 'libre') throw new Error('SEAT_TAKEN');

      if (asientoAnteriorRef && asientoAnteriorId !== datos.asiento) {
        const asientoAnterior = snaps[1]?.data();
        if (asientoAnterior && asientoAnterior.registroId === registroId) {
          tx.set(asientoAnteriorRef, {
            estado: 'libre', holdUntil: null, sessionId: null,
            registroId: null, nombre: null, actualizadoEn: ahora
          }, { merge: true });
        }
      }

      tx.set(asientoNuevoRef, {
        estado: 'vendido', holdUntil: null, sessionId: anterior.stripeSessionId || null,
        registroId, nombre: datos.nombre, actualizadoEn: ahora
      }, { merge: true });
      tx.set(registroRef, {
        ...datos,
        estadoRegistro: 'activo',
        actualizadoEn: ahora,
        actualizadoPor: req.firebaseUser.email || req.firebaseUser.uid
      }, { merge: true });
    });

    const actualizacion = { ...datos, estadoRegistro: 'activo', actualizadoEn: ahora };
    if (req.body?.enviarConfirmacion && datos.correo) {
      const notificacion = await sendEmail(
        datos.correo,
        'Actualización de tu ficha al congreso',
        congresoEmailTemplate('Tu registro está actualizado',
          '<p>Tu ficha <strong>' + ficha.nombre + '</strong> está confirmada.</p>' +
          '<p><strong>Tu asiento:</strong> ' + datos.asiento + '</p>'),
        { idempotencyKey: 'congreso-edicion-' + registroId + '-' + Date.now() }
      );
      actualizacion.notificacionCompra = notificacion.reason;
      actualizacion.notificacionEnviadaEn = notificacion.sent ? new Date().toISOString() : null;
      await registroRef.set({
        notificacionCompra: actualizacion.notificacionCompra,
        notificacionEnviadaEn: actualizacion.notificacionEnviadaEn
      }, { merge: true });
    }

    res.json({ registro: { id: registroId, ...anterior, ...actualizacion } });
  } catch (err) {
    if (err.message === 'REG_NOT_FOUND') return res.status(404).json({ error: 'El registro ya no existe' });
    if (err.message === 'SEAT_NOT_FOUND') return res.status(400).json({ error: 'Ese asiento no existe' });
    if (err.message === 'SEAT_WRONG_ZONE') return res.status(400).json({ error: 'El asiento no corresponde a la ficha seleccionada' });
    if (err.message === 'SEAT_TAKEN') return res.status(409).json({ error: 'Ese asiento ya no está disponible' });
    console.error('PUT registro congreso admin error:', err);
    res.status(500).json({ error: 'No se pudo actualizar al asistente' });
  }
});

app.delete('/congreso/admin/registros/:id', requireFirebaseUser, requireFirebaseAdmin, async (req, res) => {
  try {
    const registroRef = db.collection('congresoRegistrations').doc(req.params.id);
    const ahora = new Date().toISOString();
    await db.runTransaction(async (tx) => {
      const registroSnap = await tx.get(registroRef);
      if (!registroSnap.exists) throw new Error('REG_NOT_FOUND');
      const registro = registroSnap.data();
      const asientoId = textoFormulario(registro.asiento, 8).toUpperCase();
      const asientoRef = asientoId ? db.collection('congresoAsientos').doc(asientoId) : null;
      const asientoSnap = asientoRef ? await tx.get(asientoRef) : null;

      if (asientoRef && asientoSnap?.exists && asientoSnap.data().registroId === req.params.id) {
        tx.set(asientoRef, {
          estado: 'libre', holdUntil: null, sessionId: null,
          registroId: null, nombre: null, actualizadoEn: ahora
        }, { merge: true });
      }
      tx.set(registroRef, {
        estadoRegistro: 'cancelado',
        canceladoEn: ahora,
        canceladoPor: req.firebaseUser.email || req.firebaseUser.uid
      }, { merge: true });
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'REG_NOT_FOUND') return res.status(404).json({ error: 'El registro ya no existe' });
    console.error('DELETE registro congreso admin error:', err);
    res.status(500).json({ error: 'No se pudo cancelar el registro' });
  }
});

app.patch('/congreso/admin/asientos/:id', requireFirebaseUser, requireFirebaseAdmin, async (req, res) => {
  try {
    const accion = req.body?.accion;
    if (!['bloquear', 'liberar'].includes(accion)) return res.status(400).json({ error: 'Acción inválida' });
    await asegurarAsientos();
    const asientoRef = db.collection('congresoAsientos').doc(req.params.id.toUpperCase());
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(asientoRef);
      if (!snap.exists) throw new Error('SEAT_NOT_FOUND');
      const asiento = snap.data();
      if (asiento.zona === 'ponente') throw new Error('SPEAKER_SEAT');
      const estado = estadoEfectivo(asiento);
      if (estado === 'vendido' || estado === 'hold') throw new Error('SEAT_PROTECTED');
      tx.set(asientoRef, {
        estado: accion === 'bloquear' ? 'bloqueado' : 'libre',
        holdUntil: null,
        sessionId: null,
        actualizadoEn: new Date().toISOString()
      }, { merge: true });
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'SEAT_NOT_FOUND') return res.status(404).json({ error: 'Ese asiento no existe' });
    if (err.message === 'SPEAKER_SEAT') return res.status(400).json({ error: 'Los lugares de ponentes permanecen reservados' });
    if (err.message === 'SEAT_PROTECTED') return res.status(409).json({ error: 'Ese asiento tiene una venta o un pago en proceso' });
    console.error('PATCH asiento congreso admin error:', err);
    res.status(500).json({ error: 'No se pudo cambiar el asiento' });
  }
});

// ═══ PRECIOS PÚBLICOS DEL CONGRESO (para pintar el landing) ═══
app.get('/congreso/precios', async (req, res) => {
  try {
    const fichas = await leerFichasCongreso();
    res.set('Cache-Control', 'public, max-age=60');
    res.json(fichas);
  } catch (err) {
    res.status(500).json({ error: 'No se pudieron cargar las fichas' });
  }
});

// ═══ MAPA DE ASIENTOS PÚBLICO (estado en vivo, para el selector tipo cine) ═══
// El frontend distingue una venta definitiva de un checkout aún en proceso;
// nombres y sesiones NO se exponen aquí (eso vive en el panel admin).
app.get('/congreso/asientos', async (req, res) => {
  try {
    await asegurarAsientos();
    const snap = await db.collection('congresoAsientos').get();
    const asientos = snap.docs.map((d) => {
      const a = d.data();
      const estado = estadoEfectivo(a);
      return {
        id: d.id,
        fila: a.fila,
        numero: a.numero,
        zona: a.zona,
        // Público: hold = reservado temporal; vendido = ocupado definitivo.
        estado: estado === 'libre' ? 'libre'
          : estado === 'vendido' ? 'ocupado'
          : 'reservado'
      };
    });
    res.set('Cache-Control', 'no-store');
    res.json({ layout: SEATMAP, asientos });
  } catch (err) {
    console.error('GET asientos error:', err);
    res.status(500).json({ error: 'No se pudo cargar el mapa de asientos' });
  }
});

// ═══ CANCELAR SUSCRIPCIÓN (al final del período) ═══
app.post('/cancel-subscription', requireFirebaseUser, async (req, res) => {
  try {
    const firebaseUid = req.firebaseUser.uid;

    const userDoc = await db.collection('users').doc(firebaseUid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const subscriptionId = userData.subscription?.stripeSubscriptionId;

    if (!subscriptionId) {
      return res.status(400).json({ error: 'No se encontró suscripción activa' });
    }

    const sub = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true
    });

    await db.collection('users').doc(firebaseUid).set({
      subscription: {
        cancelAtPeriodEnd: true,
        currentPeriodEnd: (sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : new Date().toISOString()),
        updatedAt: new Date().toISOString()
      }
    }, { merge: true });

    res.json({
      success: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: (sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : new Date().toISOString())
    });

    try {
      const memberEmail = userData.email || '';
      const memberName = userData.name || '';
      const endDate = sub.current_period_end ? new Date(sub.current_period_end * 1000).toLocaleDateString('es-MX', { day:'numeric', month:'long', year:'numeric' }) : 'N/A';
      if (memberEmail) {
        sendEmail(memberEmail, 'Cancelación programada - Club Dermalysse',
          emailTemplate('Cancelación programada',
            '<p>Hola ' + memberName + ',</p>' +
            '<p>Tu suscripción ha sido marcada para cancelarse el <strong>' + endDate + '</strong>.</p>' +
            '<p>Seguirás teniendo acceso completo hasta esa fecha. Si cambias de opinión, puedes reactivar tu suscripción en cualquier momento.</p>',
            'Ir al Club', 'https://club.dermalyssemx.com/')
        );
      }
      setTimeout(function(){ sendEmail(ADMIN_EMAIL, 'Cancelación programada - Club Dermalysse',
        emailTemplate('Cancelación programada',
          '<p><strong>' + (memberName || memberEmail || firebaseUid) + '</strong> ha programado la cancelación de su suscripción.</p>' +
          '<p><strong>Acceso hasta:</strong> ' + endDate + '</p>',
          'Ver en Admin', 'https://teccapitalweb.github.io/admin_club_dermalysse-main/')
      ); }, 3000);
    } catch(e) {}
  } catch (err) {
    console.error('Cancel subscription error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ REACTIVAR SUSCRIPCIÓN ═══
app.post('/reactivate-subscription', requireFirebaseUser, async (req, res) => {
  try {
    const firebaseUid = req.firebaseUser.uid;

    const userDoc = await db.collection('users').doc(firebaseUid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const subscriptionId = userData.subscription?.stripeSubscriptionId;

    if (!subscriptionId) {
      return res.status(400).json({ error: 'No se encontró suscripción' });
    }

    await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false
    });

    await db.collection('users').doc(firebaseUid).set({
      subscription: {
        cancelAtPeriodEnd: false,
        updatedAt: new Date().toISOString()
      }
    }, { merge: true });

    res.json({ success: true, cancelAtPeriodEnd: false });

    try {
      const memberEmail = userData.email || '';
      const memberName = userData.name || '';
      if (memberEmail) {
        sendEmail(memberEmail, 'Suscripción reactivada - Club Dermalysse',
          emailTemplate('¡Tu suscripción está activa de nuevo!',
            '<p>Hola ' + (memberName || 'Miembro') + ',</p>' +
            '<p>Tu suscripción al Club Dermalysse ha sido reactivada exitosamente. Seguirás disfrutando de todos los beneficios del club.</p>' +
            '<p>¡Gracias por quedarte con nosotros!</p>',
            'Ir al Club', 'https://club.dermalyssemx.com/')
        );
      }
      setTimeout(function(){ sendEmail(ADMIN_EMAIL, 'Suscripción reactivada - Club Dermalysse',
        emailTemplate('Suscripción reactivada',
          '<p><strong>' + (memberName || memberEmail || firebaseUid) + '</strong> ha reactivado su suscripción.</p>' +
          '<p><strong>Fecha:</strong> ' + new Date().toLocaleString('es-MX') + '</p>',
          'Ver en Admin', 'https://teccapitalweb.github.io/admin_club_dermalysse-main/')
      ); }, 3000);
    } catch(e) { console.error('Reactivate email error:', e); }
  } catch (err) {
    console.error('Reactivate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ CREAR PORTAL SESSION ═══
app.post('/create-portal-session', requireFirebaseUser, async (req, res) => {
  try {
    const { returnUrl } = req.body;
    const firebaseUid = req.firebaseUser.uid;

    const userDoc = await db.collection('users').doc(firebaseUid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const customerId = userData.subscription?.stripeCustomerId;

    if (!customerId) {
      return res.status(400).json({ error: 'No se encontró suscripción activa' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl || 'https://club.dermalyssemx.com/'
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ VERIFICAR SUSCRIPCIÓN ═══
app.post('/check-subscription', requireFirebaseUser, async (req, res) => {
  try {
    const firebaseUid = req.firebaseUser.uid;
    const userDoc = await db.collection('users').doc(firebaseUid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const sub = userData.subscription || {};

    const access = membershipAccess(userData);
    res.json({
      status: sub.status || 'none',
      plan: sub.plan || null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd || false,
      currentPeriodEnd: sub.currentPeriodEnd || null,
      hasAccess: access.allowed,
      accessReason: access.reason,
      vigenciaHasta: userData.vigenciaHasta || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ REPRODUCCIÓN FIRMADA BUNNY STREAM ═══
// Solo recibe IDs de contenido. La clave de firma nunca sale del servidor.
app.post('/bunny/playback', requireFirebaseUser, async (req, res) => {
  try {
    const courseId = String(req.body.courseId || '');
    const lessonId = String(req.body.lessonId || '');
    if (!courseId || !lessonId) {
      return res.status(400).json({ error: 'Curso y clase requeridos' });
    }

    const course = await findCourse(courseId);
    const lesson = course && Array.isArray(course.lessons)
      ? course.lessons.find(item => String(item.id || '') === lessonId)
      : null;
    if (!course || !lesson || !lesson.videoId) {
      return res.status(404).json({ error: 'La clase no está disponible' });
    }

    const authorization = await authorizeLesson(req.firebaseUser.uid, course, lesson);
    if (!authorization.allowed) {
      return res.status(403).json({
        error: accessErrorMessage(authorization.reason),
        reason: authorization.reason,
        unlockAt: authorization.releaseAccess?.unlockAt || null
      });
    }
    const sequenceAccess = await lessonSequenceAccess(req.firebaseUser.uid, course, lesson, authorization);
    if (!sequenceAccess.allowed) {
      return res.status(403).json({
        error: accessErrorMessage(sequenceAccess.reason),
        reason: sequenceAccess.reason
      });
    }

    const libraryId = String(process.env.BUNNY_STREAM_LIBRARY_ID || '');
    const tokenKey = getBunnyTokenKey();
    if (!libraryId || !tokenKey) {
      return res.status(503).json({ error: 'La reproducción segura todavía no está configurada' });
    }

    const requestedTtl = Number(process.env.BUNNY_STREAM_TOKEN_TTL_SECONDS || 300);
    const tokenTtl = Math.min(600, Math.max(60, Number.isFinite(requestedTtl) ? requestedTtl : 300));
    const expires = Math.floor(Date.now() / 1000) + tokenTtl;
    const token = crypto
      .createHash('sha256')
      .update(tokenKey + lesson.videoId + expires)
      .digest('hex');
    const embedUrl = `https://iframe.mediadelivery.net/embed/${encodeURIComponent(libraryId)}/${encodeURIComponent(lesson.videoId)}?token=${token}&expires=${expires}&autoplay=true&preload=true&responsive=true&compactControls=true`;

    let playbackSessionId = null;
    if (authorization.progressAllowed) {
      playbackSessionId = crypto.randomBytes(18).toString('hex');
      const now = Date.now();
      await db.collection('users').doc(req.firebaseUser.uid).collection('playbackSessions').doc(playbackSessionId).set({
        courseId,
        lessonId,
        videoId: lesson.videoId,
        durationSeconds: Math.max(1, Number(lesson.durationSeconds) || 1),
        watchedSeconds: 0,
        lastPositionSeconds: 0,
        lastSeenAt: now,
        completed: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(now + (8 * 60 * 60 * 1000))
      });
    }

    res.set('Cache-Control', 'no-store');
    res.json({ embedUrl, expires, preview: !!lesson.isPreview, playbackSessionId });
  } catch (error) {
    console.error('Bunny playback error:', error.message);
    res.status(500).json({ error: 'No fue posible preparar la reproducción' });
  }
});

// ═══ PROGRESO ACREDITADO POR SESIÓN DE REPRODUCCIÓN ═══
// El navegador reporta eventos de Bunny player.js. El servidor acredita como
// máximo el tiempo transcurrido a velocidad 2x para evitar completar saltando.
app.post('/courses/progress', requireFirebaseUser, async (req, res) => {
  try {
    const courseId = String(req.body.courseId || '');
    const lessonId = String(req.body.lessonId || '');
    const playbackSessionId = String(req.body.playbackSessionId || '');
    const event = ['timeupdate', 'pause', 'ended'].includes(req.body.event) ? req.body.event : 'timeupdate';
    if (!courseId || !lessonId || !/^[0-9a-f]{36}$/.test(playbackSessionId)) {
      return res.status(400).json({ error: 'Sesión de reproducción inválida' });
    }

    const course = await findCourse(courseId);
    const lesson = course && Array.isArray(course.lessons)
      ? course.lessons.find(item => String(item.id || '') === lessonId)
      : null;
    if (!course || !lesson) return res.status(404).json({ error: 'La clase no está disponible' });

    const authorization = await authorizeLesson(req.firebaseUser.uid, course, lesson);
    if (!authorization.allowed || !authorization.progressAllowed) {
      return res.status(403).json({ error: accessErrorMessage(authorization.reason) });
    }

    const userRef = db.collection('users').doc(req.firebaseUser.uid);
    const sessionRef = userRef.collection('playbackSessions').doc(playbackSessionId);
    const progressRef = userRef.collection('courseProgress').doc(courseId);
    const now = Date.now();

    const result = await db.runTransaction(async transaction => {
      const sessionSnapshot = await transaction.get(sessionRef);
      const progressSnapshot = await transaction.get(progressRef);
      if (!sessionSnapshot.exists) {
        const error = new Error('Sesión de reproducción no encontrada');
        error.statusCode = 404;
        throw error;
      }
      const session = sessionSnapshot.data();
      if (session.courseId !== courseId || session.lessonId !== lessonId) {
        const error = new Error('La sesión no corresponde a esta clase');
        error.statusCode = 403;
        throw error;
      }
      if (session.expiresAt && session.expiresAt.toMillis() <= now) {
        const error = new Error('La sesión de reproducción expiró');
        error.statusCode = 410;
        throw error;
      }

      const state = advancePlaybackState(session, {
        positionSeconds: req.body.positionSeconds,
        durationSeconds: Number(lesson.durationSeconds) || session.durationSeconds,
        event
      }, now);
      const progress = progressSnapshot.exists ? progressSnapshot.data() : {};
      const lessonProgress = { ...(progress.lessonProgress || {}), [lessonId]: state };
      const completedLessonIds = new Set(Array.isArray(progress.completedLessonIds) ? progress.completedLessonIds : []);
      if (state.completed) completedLessonIds.add(lessonId);
      const completedIds = [...completedLessonIds];
      const completedIndexes = (course.lessons || []).reduce((indexes, item, index) => {
        if (completedLessonIds.has(String(item.id || ''))) indexes.push(index + 1);
        return indexes;
      }, []);
      const courseProgress = course.lessons.length
        ? Math.round((completedIndexes.length / course.lessons.length) * 100)
        : 0;

      transaction.set(sessionRef, state, { merge: true });
      transaction.set(progressRef, {
        courseId,
        lessonProgress,
        completedLessonIds: completedIds,
        courseProgress,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(userRef, { progress: { [courseId]: completedIndexes } }, { merge: true });

      return {
        completed: state.completed,
        completionRatio: state.completionRatio,
        watchedSeconds: state.watchedSeconds,
        completedLessonIndexes: completedIndexes,
        courseProgress
      };
    });

    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    console.error('Course progress error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'No fue posible guardar el progreso' });
  }
});

// ═══ CERTIFICADOS VERIFICABLES ═══
app.post('/courses/certificate', requireFirebaseUser, async (req, res) => {
  try {
    const courseId = String(req.body.courseId || '');
    const course = await findCourse(courseId);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    const lessons = Array.isArray(course.lessons) ? course.lessons : [];
    if (!lessons.length) return res.status(409).json({ error: 'El curso no tiene clases acreditables' });

    const firstLesson = lessons[0];
    const authorization = await authorizeLesson(req.firebaseUser.uid, course, firstLesson);
    if (!authorization.progressAllowed) {
      return res.status(403).json({ error: accessErrorMessage(authorization.reason) });
    }

    const progressSnapshot = await db.collection('users').doc(req.firebaseUser.uid)
      .collection('courseProgress').doc(courseId).get();
    const completedIds = new Set(progressSnapshot.exists && Array.isArray(progressSnapshot.data().completedLessonIds)
      ? progressSnapshot.data().completedLessonIds
      : []);
    const complete = lessons.every(lesson => completedIds.has(String(lesson.id || '')));
    if (!complete) return res.status(409).json({ error: 'Completa al menos 85% de cada clase para emitir el certificado' });

    const year = new Date().getUTCFullYear();
    const digest = crypto.createHash('sha256').update(`${req.firebaseUser.uid}|${courseId}`).digest('hex').slice(0, 12).toUpperCase();
    const code = `DRML-${year}-${digest}`;
    const fullName = [authorization.userData.name, authorization.userData.lastname].filter(Boolean).join(' ').trim()
      || req.firebaseUser.name
      || req.firebaseUser.email
      || 'Miembro Dermalysse';
    const certificate = {
      code,
      uid: req.firebaseUser.uid,
      userName: fullName,
      courseId,
      courseName: course.name,
      category: course.cat || 'Formación profesional',
      instructor: course.instructor || 'Equipo académico Dermalysse',
      lessonCount: lessons.length,
      status: 'valid',
      issuedAt: new Date().toISOString()
    };
    await db.collection('certificates').doc(code).set(certificate, { merge: true });
    res.set('Cache-Control', 'no-store');
    res.json(certificate);
  } catch (error) {
    console.error('Certificate error:', error.message);
    res.status(500).json({ error: 'No fue posible emitir el certificado' });
  }
});

app.get('/certificates/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    if (!/^DRML-\d{4}-[0-9A-F]{12}$/.test(code)) return res.status(400).json({ error: 'Folio inválido' });
    const snapshot = await db.collection('certificates').doc(code).get();
    if (!snapshot.exists || snapshot.data().status !== 'valid') return res.status(404).json({ error: 'Certificado no encontrado' });
    const data = snapshot.data();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      code: data.code,
      userName: data.userName,
      courseName: data.courseName,
      category: data.category,
      instructor: data.instructor,
      lessonCount: data.lessonCount,
      issuedAt: data.issuedAt,
      status: data.status
    });
  } catch (error) {
    res.status(503).json({ error: 'No fue posible verificar el certificado' });
  }
});

// ═══ HEALTH CHECK ═══
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Dermalysse Webhook Server (con precios dinámicos)',
    firebaseProjectId: serviceAccount.project_id || null,
    emailProvider: 'resend',
    emailNotifications: EMAIL_NOTIFICATIONS_CONFIGURED ? 'configured' : 'missing-config',
    bunnyStream: BUNNY_STREAM_LIBRARY_ID && BUNNY_STREAM_TOKEN_KEY ? 'configured' : 'missing-config',
    bunnyLibraryId: BUNNY_STREAM_LIBRARY_ID || null
  });
});

const BUNDLED_CATALOG_VERSION = 'bunny-2026-08-12';

async function ensureBundledCatalog() {
  const stateRef = db.collection('config').doc('contentCatalog');
  const stateSnapshot = await stateRef.get();
  const current = stateSnapshot.exists ? stateSnapshot.data() : {};
  if (current.version === BUNDLED_CATALOG_VERSION && current.courseCount === bundledCourseCatalog.length) {
    const courseRefs = bundledCourseCatalog.map(course => db.collection('courses').doc(course.id));
    const courseSnapshots = await db.getAll(...courseRefs);
    const complete = courseSnapshots.every((snapshot, index) => {
      if (!snapshot.exists) return false;
      const data = snapshot.data();
      const expectedLessons = bundledCourseCatalog[index].lessons || [];
      return data.catalogVersion === BUNDLED_CATALOG_VERSION
        && data.status === 'published'
        && Array.isArray(data.lessons)
        && data.lessons.length === expectedLessons.length
        && data.lessons.filter(lesson => lesson.isPreview === true).length === 1;
    });
    if (complete) return { changed: false, courseCount: bundledCourseCatalog.length };
  }

  const batch = db.batch();
  let videoCount = 0;
  let previewCount = 0;
  const activeCourseIds = [];
  bundledCourseCatalog.forEach(course => {
    const lessons = Array.isArray(course.lessons) ? course.lessons : [];
    videoCount += lessons.length;
    previewCount += lessons.filter(lesson => lesson.isPreview === true).length;
    activeCourseIds.push(course.id);
    batch.set(db.collection('courses').doc(course.id), {
      ...course,
      catalogVersion: BUNDLED_CATALOG_VERSION,
      catalogManaged: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
  batch.set(stateRef, {
    version: BUNDLED_CATALOG_VERSION,
    source: 'bundled-bunny-catalog',
    courseCount: bundledCourseCatalog.length,
    videoCount,
    previewCount,
    activeCourseIds,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await batch.commit();
  return { changed: true, courseCount: bundledCourseCatalog.length, videoCount, previewCount };
}

app.get('/catalog/status', async (req, res) => {
  try {
    const snapshot = await db.collection('config').doc('contentCatalog').get();
    const data = snapshot.exists ? snapshot.data() : {};
    res.set('Cache-Control', 'no-store');
    res.json({
      status: data.version === BUNDLED_CATALOG_VERSION ? 'ready' : 'pending',
      version: data.version || null,
      courseCount: data.courseCount || 0,
      videoCount: data.videoCount || 0,
      previewCount: data.previewCount || 0
    });
  } catch (error) {
    res.status(503).json({ status: 'unavailable' });
  }
});

// ═══ START ═══
const PORT = process.env.PORT || 3000;
ensureBundledCatalog()
  .then(result => console.log('📚 Catálogo Firestore verificado:', result))
  .catch(error => console.error('Catalog sync error:', error.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Dermalysse webhook server running on port ${PORT}`);
      console.log('💡 Precios dinámicos habilitados (leer desde config/club en Firestore)');
    });
  });
