'use strict';

// Reconciliación segura Stripe -> Firestore.
// Por defecto es SOLO lectura. Para aplicar exige:
//   node scripts/reconcile-memberships.js --apply --confirm=RECONCILIAR_DERMALYSSE
const { cert, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const Stripe = require('stripe');
const { membershipAccess } = require('../access-policy');
const { subscriptionIdFromInvoice } = require('../stripe-invoice');
const {
  memberPatch,
  persistStripeMembership,
  subscriptionPatch,
} = require('../stripe-membership');

const APPLY = process.argv.includes('--apply');
const CONFIRM = process.argv.includes('--confirm=RECONCILIAR_DERMALYSSE');
const NOW = new Date().toISOString();

function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function relevantSubscription(value) {
  const sub = value || {};
  return {
    status: sub.status || null,
    stripeSubscriptionId: sub.stripeSubscriptionId || null,
    stripeCustomerId: sub.stripeCustomerId || null,
    plan: sub.plan || null,
    currentPeriodEnd: sub.currentPeriodEnd || null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
  };
}

function priority(sub) {
  return ({ active: 6, trialing: 5, past_due: 4, unpaid: 3, canceled: 2, incomplete: 1, incomplete_expired: 0 })[sub.status] ?? -1;
}

function preferred(subs) {
  return [...subs].sort((a, b) => priority(b) - priority(a) || Number(b.created || 0) - Number(a.created || 0))[0] || null;
}

function countMemberTransition(stats, before, after) {
  const from = `${String(before?.plan || 'sin-plan')}/${String(before?.status || 'sin-estado')}`;
  const to = `${String(after?.plan || 'sin-plan')}/${String(after?.status || 'sin-estado')}`;
  const key = `${from} -> ${to}`;
  stats.memberTransitions[key] = (stats.memberTransitions[key] || 0) + 1;
}

async function main() {
  if (APPLY && !CONFIRM) throw new Error('Falta --confirm=RECONCILIAR_DERMALYSSE. No se escribió nada.');
  if (!process.env.STRIPE_SECRET_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Faltan variables de Railway.');

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const firebaseApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore(firebaseApp);
  const [allSubs, openInvoices, usersSnap, membersSnap] = await Promise.all([
    stripe.subscriptions.list({ status: 'all', limit: 100 }).autoPagingToArray({ limit: 10000 }),
    stripe.invoices.list({ status: 'open', limit: 100 }).autoPagingToArray({ limit: 10000 }),
    db.collection('users').get(),
    db.collection('members').get(),
  ]);
  // Las suscripciones nuevas llevan source=dermalysse. Algunas históricas no,
  // por lo que también se aceptan únicamente si ya están vinculadas desde un
  // usuario de este proyecto. Nunca se infiere pertenencia por email o customer.
  const storedSubscriptionIds = new Set(usersSnap.docs
    .map((doc) => String(doc.data()?.subscription?.stripeSubscriptionId || ''))
    .filter(Boolean));
  const subs = allSubs.filter((sub) =>
    sub.metadata?.source === 'dermalysse' || storedSubscriptionIds.has(sub.id));
  const byId = new Map(subs.map((sub) => [sub.id, sub]));
  const storedCustomerIds = new Set(usersSnap.docs
    .map((doc) => String(doc.data()?.subscription?.stripeCustomerId || ''))
    .filter(Boolean));
  const dermalysseOpenInvoices = openInvoices.filter((invoice) => {
    const subscriptionId = subscriptionIdFromInvoice(invoice);
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    return (subscriptionId && byId.has(subscriptionId)) || (customerId && storedCustomerIds.has(customerId));
  });
  const openInvoiceAmountDueByCurrency = {};
  const openInvoiceSubscriptionStatuses = {};
  for (const invoice of dermalysseOpenInvoices) {
    const currency = String(invoice.currency || 'unknown').toLowerCase();
    openInvoiceAmountDueByCurrency[currency] = (openInvoiceAmountDueByCurrency[currency] || 0)
      + Number(invoice.amount_due || 0);
    const subscriptionId = subscriptionIdFromInvoice(invoice);
    const subscriptionStatus = String(byId.get(subscriptionId)?.status || 'missing');
    openInvoiceSubscriptionStatuses[subscriptionStatus] = (openInvoiceSubscriptionStatuses[subscriptionStatus] || 0) + 1;
  }
  const byUid = new Map();
  for (const sub of subs) {
    const uid = String(sub.metadata?.firebaseUid || '');
    if (!uid) continue;
    const list = byUid.get(uid) || [];
    list.push(sub);
    byUid.set(uid, list);
  }
  const members = new Map(membersSnap.docs.map((doc) => [doc.id, doc.data()]));
  const actions = [];
  const stats = {
    mode: APPLY ? 'apply' : 'dry-run', users: usersSnap.size, stripeSubscriptions: subs.length,
    syncFromStripe: 0, closeMissingExpired: 0, syncMembersOnly: 0, alreadyCorrect: 0,
    skippedMissingStillCurrent: 0, stripeWithoutUser: 0, writesApplied: 0,
    openInvoices: dermalysseOpenInvoices.length,
    orphanOpenInvoices: dermalysseOpenInvoices.filter((invoice) => !subscriptionIdFromInvoice(invoice)).length,
    openInvoicesWithRetryScheduled: dermalysseOpenInvoices.filter((invoice) => Number.isFinite(invoice.next_payment_attempt)).length,
    openInvoicesAutoAdvance: dermalysseOpenInvoices.filter((invoice) => invoice.auto_advance === true).length,
    openInvoicesAttempted: dermalysseOpenInvoices.filter((invoice) => invoice.attempted === true).length,
    openInvoiceAmountDueMinorUnitsByCurrency: openInvoiceAmountDueByCurrency,
    openInvoiceSubscriptionStatuses,
    memberTransitions: {},
  };

  const userIds = new Set(usersSnap.docs.map((doc) => doc.id));
  for (const uid of byUid.keys()) if (!userIds.has(uid)) stats.stripeWithoutUser++;

  for (const doc of usersSnap.docs) {
    const uid = doc.id;
    const user = doc.data() || {};
    const stored = user.subscription && typeof user.subscription === 'object' ? user.subscription : {};
    const storedId = String(stored.stripeSubscriptionId || '');
    const exact = storedId && byId.get(storedId);
    const candidate = preferred(byUid.get(uid) || []);
    const stripeSub = exact || (candidate && !['incomplete', 'incomplete_expired'].includes(candidate.status) ? candidate : null);
    const memberExists = members.has(uid);
    const memberStored = members.get(uid) || {};

    if (stripeSub) {
      const patch = subscriptionPatch(stripeSub, { now: NOW });
      const merged = { ...stored, ...patch };
      const member = memberPatch(user, merged, Date.parse(NOW));
      const subDiff = !same(relevantSubscription(stored), relevantSubscription(merged));
      const memberDiff = Object.entries(member).some(([key, value]) => memberStored[key] !== value);
      if (!subDiff && !memberDiff) { stats.alreadyCorrect++; continue; }
      actions.push({ type: subDiff ? 'stripe' : 'member', uid, stripeSub, member });
      if (memberDiff) countMemberTransition(stats, memberStored, { ...memberStored, ...member });
      if (subDiff) stats.syncFromStripe++;
      else stats.syncMembersOnly++;
      continue;
    }

    const access = membershipAccess(user, Date.parse(NOW));
    const periodEnd = Date.parse(stored.currentPeriodEnd || '');
    const canClose = storedId && !byId.has(storedId) && !access.allowed && (!Number.isFinite(periodEnd) || periodEnd <= Date.parse(NOW));
    const closed = canClose ? {
      ...stored, status: 'canceled', cancelAtPeriodEnd: false,
      reconciledAt: NOW, reconcileReason: 'stripe_subscription_missing',
    } : stored;
    const member = memberPatch(user, closed, Date.parse(NOW));
    const shouldProjectMember = memberExists || Boolean(storedId) || access.allowed;
    const memberDiff = shouldProjectMember
      && Object.entries(member).some(([key, value]) => memberStored[key] !== value);
    if (canClose) {
      actions.push({ type: 'missing', uid, subscription: closed, member });
      if (memberDiff) countMemberTransition(stats, memberStored, { ...memberStored, ...member });
      stats.closeMissingExpired++;
    } else if (memberDiff) {
      actions.push({ type: 'member-only', uid, subscription: stored, member });
      countMemberTransition(stats, memberStored, { ...memberStored, ...member });
      stats.syncMembersOnly++;
    } else if (storedId && !byId.has(storedId)) {
      stats.skippedMissingStillCurrent++;
    } else {
      stats.alreadyCorrect++;
    }
  }

  if (APPLY) {
    for (const action of actions) {
      if (action.type === 'stripe' || action.type === 'member') {
        const result = await persistStripeMembership(db, action.uid, action.stripeSub, { allowReplace: true, now: NOW });
        if (result.applied) stats.writesApplied++;
        continue;
      }
      await db.runTransaction(async (tx) => {
        const userRef = db.collection('users').doc(action.uid);
        const memberRef = db.collection('members').doc(action.uid);
        if (action.type === 'missing') tx.set(userRef, { subscription: action.subscription }, { merge: true });
        tx.set(memberRef, action.member, { merge: true });
      });
      stats.writesApplied++;
    }
    await db.collection('v2_membresias_reconciliaciones').add({ ...stats, ejecutadoEn: NOW, version: 1 });
  }

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error?.message || 'Fallo de reconciliación' }));
  process.exitCode = 1;
});
