const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// ═══ FIREBASE ADMIN ═══
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ═══ EMAIL (EmailJS API — Club Dermalysse) ═══
const ADMIN_EMAIL = 'teccapitalweb@gmail.com';
const EMAILJS_SERVICE_ID = 'service_i8pm87h';
const EMAILJS_TEMPLATE_ID = 'template_0xcszxa';
const EMAILJS_PUBLIC_KEY = 'iIBc65PznIzD84KgR';
const EMAILJS_PRIVATE_KEY = '75xg9N1EQU1Cy2MEfK75k';

async function sendEmail(to, subject, html) {
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

const app = express();

// ═══ CORS ═══
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
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

  try {
    switch (event.type) {
      // ─── Pago exitoso (checkout completado) ───
      case 'checkout.session.completed': {
        const session = event.data.object;
        const uid = session.metadata?.firebaseUid;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if (uid && subscriptionId) {
          // Obtener detalles de la suscripción
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          const priceId = sub.items.data[0]?.price?.id;
          const interval = sub.items.data[0]?.price?.recurring?.interval;

          await db.collection('users').doc(uid).set({
            subscription: {
              status: 'active',
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscriptionId,
              priceId: priceId,
              plan: interval === 'year' ? 'anual' : 'mensual',
              currentPeriodEnd: (sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : new Date().toISOString()),
              subscribedAt: new Date().toISOString(),
              cancelAtPeriodEnd: false,
              updatedAt: new Date().toISOString()
            }
          }, { merge: true });

          // Actualizar member doc con plan
          try {
            await db.collection('members').doc(uid).set({
              plan: interval === 'year' ? 'Anual' : 'Mensual',
              status: 'active'
            }, { merge: true });
          } catch(e) {}
          console.log('✅ Suscripción activada para:', uid, '- Plan:', interval);

          // Enviar email al miembro
          const memberEmail = session.customer_details?.email || '';
          const planName = interval === 'year' ? 'Anual ($1,799 MXN/año)' : 'Mensual ($200 MXN/mes)';
          if (memberEmail) {
            sendEmail(memberEmail, '¡Bienvenido/a al Club Dermalysse!',
              emailTemplate('¡Gracias por suscribirte!',
                '<p>Tu suscripción al <strong>Plan ' + planName + '</strong> ha sido activada exitosamente.</p>' +
                '<p>Ya tienes acceso completo a todos los cursos, webinars en vivo, material PDF y la comunidad del Club Dermalysse.</p>' +
                '<p style="margin-top:1rem;"><strong>Plan:</strong> ' + planName + '<br><strong>Estado:</strong> Activa</p>',
                'Ir al Club', 'https://teccapitalweb.github.io/Club-Dermalysse-main/')
            );
          }

          // Enviar email al admin
          sendEmail(ADMIN_EMAIL, 'Nueva suscripción - Club Dermalysse',
            emailTemplate('Nueva suscripción',
              '<p><strong>' + (memberEmail || uid) + '</strong> se ha suscrito al <strong>Plan ' + planName + '</strong>.</p>' +
              '<p style="margin-top:1rem;"><strong>ID de suscripción:</strong> ' + subscriptionId + '<br><strong>Fecha:</strong> ' + new Date().toLocaleString('es-MX') + '</p>',
              'Ver en Admin', 'https://teccapitalweb.github.io/admin_club_dermalysse-main/')
          );

          // Registrar actividad
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
          await db.collection('users').doc(uid).set({
            subscription: {
              status: 'canceled',
              canceledAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          }, { merge: true });
          // Actualizar member doc
          try {
            await db.collection('members').doc(uid).set({
              plan: 'Free',
              status: 'paused'
            }, { merge: true });
          } catch(e) {}
          console.log('❌ Suscripción cancelada para:', uid);

          // Enviar email al miembro
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
                  'Volver al Club', 'https://teccapitalweb.github.io/Club-Dermalysse-main/')
              );
            }

            // Enviar email al admin
            sendEmail(ADMIN_EMAIL, 'Cancelación de suscripción - Club Dermalysse',
              emailTemplate('Suscripción cancelada',
                '<p><strong>' + (memberName || memberEmail || uid) + '</strong> ha cancelado su suscripción.</p>' +
                '<p style="margin-top:1rem;"><strong>Email:</strong> ' + memberEmail + '<br><strong>Fecha:</strong> ' + new Date().toLocaleString('es-MX') + '</p>',
                'Ver en Admin', 'https://teccapitalweb.github.io/admin_club_dermalysse-main/')
            );
          } catch(e) { console.error('Cancel email error:', e); }

          // Registrar actividad
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

      // ─── Suscripción actualizada (ej: marcada para cancelar al final del período) ───
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const uid = sub.metadata?.firebaseUid;

        if (uid) {
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

// ═══ CREAR CHECKOUT SESSION ═══
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { priceId, firebaseUid, email, successUrl, cancelUrl } = req.body;

    if (!priceId || !firebaseUid) {
      return res.status(400).json({ error: 'priceId y firebaseUid son requeridos' });
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

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: successUrl || 'https://teccapitalweb.github.io/Club-Dermalysse-main/?payment=success',
      cancel_url: cancelUrl || 'https://teccapitalweb.github.io/Club-Dermalysse-main/?payment=canceled',
      metadata: { firebaseUid },
      subscription_data: {
        metadata: { firebaseUid }
      }
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ CANCELAR SUSCRIPCIÓN (al final del período) ═══
app.post('/cancel-subscription', async (req, res) => {
  try {
    const { firebaseUid } = req.body;
    if (!firebaseUid) return res.status(400).json({ error: 'firebaseUid requerido' });

    const userDoc = await db.collection('users').doc(firebaseUid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const subscriptionId = userData.subscription?.stripeSubscriptionId;

    if (!subscriptionId) {
      return res.status(400).json({ error: 'No se encontró suscripción activa' });
    }

    // Cancelar al final del período (no inmediatamente)
    const sub = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true
    });

    // Actualizar Firestore
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

    // Enviar emails de cancelación programada
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
            'Ir al Club', 'https://teccapitalweb.github.io/Club-Dermalysse-main/')
        );
      }
      sendEmail(ADMIN_EMAIL, 'Cancelación programada - Club Dermalysse',
        emailTemplate('Cancelación programada',
          '<p><strong>' + (memberName || memberEmail || firebaseUid) + '</strong> ha programado la cancelación de su suscripción.</p>' +
          '<p><strong>Acceso hasta:</strong> ' + endDate + '</p>',
          'Ver en Admin', 'https://teccapitalweb.github.io/admin_club_dermalysse-main/')
      );
    } catch(e) {}
  } catch (err) {
    console.error('Cancel subscription error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ REACTIVAR SUSCRIPCIÓN (quitar cancelación pendiente) ═══
app.post('/reactivate-subscription', async (req, res) => {
  try {
    const { firebaseUid } = req.body;
    if (!firebaseUid) return res.status(400).json({ error: 'firebaseUid requerido' });

    const userDoc = await db.collection('users').doc(firebaseUid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const subscriptionId = userData.subscription?.stripeSubscriptionId;

    if (!subscriptionId) {
      return res.status(400).json({ error: 'No se encontró suscripción' });
    }

    // Reactivar (quitar cancel_at_period_end)
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

    // Enviar emails de reactivación
    try {
      const memberEmail = userData.email || '';
      const memberName = userData.name || '';
      if (memberEmail) {
        sendEmail(memberEmail, 'Suscripción reactivada - Club Dermalysse',
          emailTemplate('¡Tu suscripción está activa de nuevo!',
            '<p>Hola ' + (memberName || 'Miembro') + ',</p>' +
            '<p>Tu suscripción al Club Dermalysse ha sido reactivada exitosamente. Seguirás disfrutando de todos los beneficios del club.</p>' +
            '<p>¡Gracias por quedarte con nosotros!</p>',
            'Ir al Club', 'https://teccapitalweb.github.io/Club-Dermalysse-main/')
        );
      }
      sendEmail(ADMIN_EMAIL, 'Suscripción reactivada - Club Dermalysse',
        emailTemplate('Suscripción reactivada',
          '<p><strong>' + (memberName || memberEmail || firebaseUid) + '</strong> ha reactivado su suscripción.</p>' +
          '<p><strong>Fecha:</strong> ' + new Date().toLocaleString('es-MX') + '</p>',
          'Ver en Admin', 'https://teccapitalweb.github.io/admin_club_dermalysse-main/')
      );
    } catch(e) { console.error('Reactivate email error:', e); }
  } catch (err) {
    console.error('Reactivate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ CREAR PORTAL SESSION (para cancelar/gestionar suscripción) ═══
app.post('/create-portal-session', async (req, res) => {
  try {
    const { firebaseUid, returnUrl } = req.body;

    const userDoc = await db.collection('users').doc(firebaseUid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const customerId = userData.subscription?.stripeCustomerId;

    if (!customerId) {
      return res.status(400).json({ error: 'No se encontró suscripción activa' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl || 'https://teccapitalweb.github.io/Club-Dermalysse-main/'
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══ VERIFICAR SUSCRIPCIÓN ═══
app.post('/check-subscription', async (req, res) => {
  try {
    const { firebaseUid } = req.body;
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

// ═══ HEALTH CHECK ═══
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Dermalysse Webhook Server' });
});

// ═══ START ═══
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Dermalysse webhook server running on port ${PORT}`);
});
