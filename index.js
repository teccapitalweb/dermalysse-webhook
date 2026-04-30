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
              currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
              cancelAtPeriodEnd: false,
              updatedAt: new Date().toISOString()
            }
          }, { merge: true });

          console.log('✅ Suscripción activada para:', uid, '- Plan:', interval);
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
              currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
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
          console.log('❌ Suscripción cancelada para:', uid);
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
              currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
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
        currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
        updatedAt: new Date().toISOString()
      }
    }, { merge: true });

    res.json({
      success: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString()
    });
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
