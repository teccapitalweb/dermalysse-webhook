const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const bundledCourseCatalog = require('./data/dermalysse-courses.json');

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
const BUNNY_STREAM_TOKEN_KEY = [
  process.env.BUNNY_STREAM_TOKEN_KEY,
  process.env.BUNNY_STREAM_TOKEN_SECURITY_KEY,
  process.env.BUNNY_STREAM_TOKEN_AUTH_KEY,
  process.env.BUNNY_STREAM_API_KEY
].map(value => String(value || '').trim()).find(value => value && !/^PEGA_AQUI/i.test(value)) || '';
const BUNNY_TOKEN_TTL_SECONDS = Math.min(600, Math.max(60, Number(process.env.BUNNY_TOKEN_TTL_SECONDS || process.env.BUNNY_STREAM_TOKEN_TTL_SECONDS) || 300));

// ═══ EMAIL (EmailJS API — Club Dermalysse) ═══
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || '';
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || '';
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || '';
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY || '';

async function sendEmail(to, subject, html) {
  if (!to || !EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY) {
    console.warn('Email omitido: integración no configurada en el entorno');
    return;
  }
  try {
    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: EMAILJS_PRIVATE_KEY,
        template_params: {
          to_email: to,
          subject: subject,
          message: html
        }
      })
    });
    if (res.ok) {
      console.log('📧 Email enviado a:', to);
    } else {
      const text = await res.text();
      console.error('Email error:', text);
    }
  } catch(e) { console.error('Email error:', e.message); }
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

const app = express();

// ═══ CORS ═══
const allowedOrigins = new Set([
  'https://club.dermalyssemx.com',
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
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

function hasCurrentMembership(userData) {
  const now = Date.now();
  const courtesyUntil = Date.parse(userData.vigenciaHasta || '');
  if (Number.isFinite(courtesyUntil) && courtesyUntil > now) return true;

  const subscription = userData.subscription || {};
  const periodEnd = Date.parse(subscription.currentPeriodEnd || '');
  if (['active', 'trialing'].includes(subscription.status)) {
    return !Number.isFinite(periodEnd) || periodEnd > now;
  }
  if ((subscription.status === 'canceled' || subscription.cancelAtPeriodEnd === true) && Number.isFinite(periodEnd)) {
    return periodEnd > now;
  }
  return false;
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
    if (lesson) return lesson;
  }
  const snapshot = await db.collection('courses').get();
  for (const docSnapshot of snapshot.docs) {
    const lessons = docSnapshot.data()?.lessons;
    const lesson = Array.isArray(lessons)
      ? lessons.find(item => String(item.videoId || '').toLowerCase() === videoId)
      : null;
    if (lesson) return lesson;
  }
  return null;
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
    const lesson = await findLessonByVideoId(videoId);
    if (!lesson) return res.status(404).json({ error: 'El video no pertenece al catálogo publicado' });
    if (!lesson.isPreview) {
      const [adminDoc, userDoc] = await Promise.all([
        db.collection('admins').doc(req.firebaseUser.uid).get(),
        db.collection('users').doc(req.firebaseUser.uid).get()
      ]);
      const userData = userDoc.exists ? userDoc.data() : {};
      if (!adminDoc.exists && !hasCurrentMembership(userData)) {
        return res.status(403).json({ error: 'Esta clase requiere una membresía vigente' });
      }
    }
    const expires = Math.floor(Date.now() / 1000) + BUNNY_TOKEN_TTL_SECONDS;
    const token = crypto.createHash('sha256').update(BUNNY_STREAM_TOKEN_KEY + videoId + expires).digest('hex');
    const embedUrl = `https://iframe.mediadelivery.net/embed/${encodeURIComponent(BUNNY_STREAM_LIBRARY_ID)}/${videoId}?token=${token}&expires=${expires}`;
    res.set('Cache-Control', 'no-store, private');
    return res.json({ embedUrl, expires, preview: !!lesson.isPreview });
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

    res.json({
      status: sub.status || 'none',
      plan: sub.plan || null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd || false,
      currentPeriodEnd: sub.currentPeriodEnd || null
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

    if (!lesson.isPreview) {
      const userSnapshot = await db.collection('users').doc(req.firebaseUser.uid).get();
      const userData = userSnapshot.exists ? userSnapshot.data() : {};
      if (!hasCurrentMembership(userData)) {
        return res.status(403).json({ error: 'Esta clase requiere una membresía vigente' });
      }
    }

    const libraryId = String(process.env.BUNNY_STREAM_LIBRARY_ID || '');
    const tokenKey = [
      process.env.BUNNY_STREAM_TOKEN_SECURITY_KEY,
      process.env.BUNNY_STREAM_TOKEN_AUTH_KEY,
      process.env.BUNNY_STREAM_API_KEY
    ].map(value => String(value || '').trim()).find(value => value && !/^PEGA_AQUI/i.test(value)) || '';
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
    const embedUrl = `https://iframe.mediadelivery.net/embed/${encodeURIComponent(libraryId)}/${encodeURIComponent(lesson.videoId)}?token=${token}&expires=${expires}&autoplay=true`;

    res.set('Cache-Control', 'no-store');
    res.json({ embedUrl, expires, preview: !!lesson.isPreview });
  } catch (error) {
    console.error('Bunny playback error:', error.message);
    res.status(500).json({ error: 'No fue posible preparar la reproducción' });
  }
});

// ═══ HEALTH CHECK ═══
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Dermalysse Webhook Server (con precios dinámicos)',
    bunnyStream: BUNNY_STREAM_LIBRARY_ID && BUNNY_STREAM_TOKEN_KEY ? 'configured' : 'missing-config',
    bunnyLibraryId: BUNNY_STREAM_LIBRARY_ID || null
  });
});

// ═══ START ═══
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Dermalysse webhook server running on port ${PORT}`);
  console.log('💡 Precios dinámicos habilitados (leer desde config/club en Firestore)');
});
