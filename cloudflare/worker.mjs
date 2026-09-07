import core from '../shared/core.js';
import stripe from '../shared/stripe.js';
import email from '../shared/email.js';
import { createStore } from './store.mjs';

const supportedEvents = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired']);
const json = (payload, status = 200) => Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });
const unavailable = () => core.createHttpError('Camp registration is temporarily unavailable. Please try again shortly.', 503);

function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) throw core.createHttpError('Coach access is not configured.', 503);
  const value = request.headers.get('authorization') || '';
  if (!core.checkAdminToken(value.startsWith('Bearer ') ? value.slice(7) : '', env)) throw core.createHttpError('Wrong PIN.', 401);
}

async function readBytes(request, limit) {
  if (Number(request.headers.get('content-length') || 0) > limit) throw core.createHttpError('Request is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw core.createHttpError('Request is too large.', 413); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function readBody(request) {
  const raw = (await readBytes(request, 32768)).toString('utf8');
  try {
    const result = raw ? JSON.parse(raw) : {};
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Not an object');
    return result;
  }
  catch { throw core.createHttpError('Request body must be valid JSON.', 400); }
}

async function startCheckout(group, camp, env, store) {
  // Retries use the original registration snapshots, so editing a camp cannot
  // change an in-flight Stripe idempotent request.
  const first = group.registrations[0];
  const service = core.serviceFor(first.trainingType);
  const params = JSON.parse(group.checkout_params || '{}');
  if (!params.priceId || !params.appUrl) throw core.createHttpError('Historical checkout needs payment reconciliation before retry.', 409);
  const checkoutEnv = { ...env, [service.priceEnv]: params.priceId, APP_URL: params.appUrl };
  const snapshotCamp = { id: camp.id };
  let session;
  try { session = await stripe.createStripeCheckoutSession(group, service, snapshotCamp, checkoutEnv); }
  catch (error) {
    // A timeout may mean Stripe created the session. Keep its reservation and
    // retry with the same idempotency key; never free a potentially payable seat.
    if (error.retryable === false && error.stripe?.type !== 'idempotency_error') await store.releaseGroup(group.id, 'checkout_failed');
    throw core.createHttpError('Checkout could not be started. Please contact the coach before retrying.', 502);
  }
  if (!session.id || !session.url) throw core.createHttpError('Stripe returned an incomplete checkout session.', 502);
  await store.attachSession(group.id, session);
  return session;
}

async function verifiedSession(event, group, env) {
  const session = event.data.object;
  if (!session.id?.startsWith('cs_') || stripe.sessionGroupId(session) !== group.id ||
      (group.stripe_session_id && group.stripe_session_id !== session.id)) throw core.createHttpError('Checkout session does not match its reservation.', 409);
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session.id)}?expand[]=line_items`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw core.createHttpError('Payment verification is temporarily unavailable.', 503);
  const actual = await response.json();
  const service = core.serviceFor(group.registrations[0].trainingType);
  const expectedPrice = JSON.parse(group.checkout_params || '{}').priceId || env[service.priceEnv];
  const line = actual.line_items?.data?.[0];
  const live = !env.STRIPE_SECRET_KEY?.includes('_test_');
  if (actual.id !== session.id || actual.livemode !== live || event.livemode !== live ||
      stripe.sessionGroupId(actual) !== group.id || actual.metadata?.camp_id !== group.camp_id ||
      actual.mode !== 'payment' || actual.line_items?.data?.length !== 1 || actual.line_items?.has_more ||
      line?.quantity !== group.child_count || line?.price?.id !== expectedPrice ||
      actual.amount_total !== session.amount_total || actual.currency !== session.currency ||
      !Number.isInteger(actual.amount_total) || actual.amount_total < 0) {
    throw core.createHttpError('Payment details do not match the reservation.', 409);
  }
  return actual;
}

export async function deliverPending(store, env) {
  for (const { id } of await store.pendingMail()) {
    const row = await store.claimMail(id, env.EMAIL_TRANSPORT !== 'cloudflare');
    if (!row) continue;
    const result = await email.sendEmail({ ...JSON.parse(row.payload), idempotencyKey: `noah-${id}` }, env);
    await store.finishMail(id, row.attempts, result);
  }
}

async function webhook(request, env, store, ctx) {
  const raw = await readBytes(request, 262144);
  stripe.verifyStripeSignature(raw, request.headers.get('stripe-signature'), env);
  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { throw core.createHttpError('Webhook payload must be valid JSON.', 400); }
  if (!supportedEvents.has(event.type)) return json({ received: true });
  if (!event.id?.startsWith('evt_') || !event.data?.object) throw core.createHttpError('Invalid payment event.', 400);
  const groupId = stripe.sessionGroupId(event.data.object);
  if (!groupId) throw core.createHttpError('Payment event has no reservation.', 400);
  const group = await store.group(groupId);
  if (!group) throw core.createHttpError('Reservation has not been imported or created yet.', 503);
  const session = await verifiedSession(event, group, env);
  if (event.type === 'checkout.session.expired') {
    if (session.status !== 'expired') return json({ received: true });
  } else if (event.type === 'checkout.session.async_payment_failed') {
    if (session.payment_status === 'paid') return json({ received: true });
  } else if (session.payment_status !== 'paid') {
    return json({ received: true }); // Delayed methods await async_payment_succeeded.
  }
  const messages = email.signupMessages(group.registrations, env);
  await store.applyWebhook({ ...event, data: { object: session } }, group, messages);
  // Payment + email intent are already durable. A bounded scheduled retry handles
  // provider failures without rolling back a successfully recorded payment.
  ctx.waitUntil(deliverPending(store, env));
  return json({ received: true });
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  const method = request.method;
  if (method === 'GET' && (path === '/' || path === '/health')) return json({ ok: true, backend: 'cloudflare', enabled: env.BACKEND_ENABLED === 'true', sourceSha: env.SOURCE_SHA || null });
  // The draft can be deployed inert. Neither reads nor callbacks can seed,
  // import, send mail, reserve seats, or alter payment state before cutover.
  if (env.BACKEND_ENABLED !== 'true') throw unavailable();
  const store = createStore(env.DB);
  if (method === 'POST' && path === '/stripe/webhook') return webhook(request, env, store, ctx);
  if (path.startsWith('/admin/')) requireAdmin(request, env);
  if (method === 'GET' && path === '/config') return json(core.publicConfig(env));
  if (method === 'GET' && path === '/camps') {
    const camps = (await store.listCamps()).filter(camp => camp.status !== 'archived').sort(core.sortByStartDate)
      .map(camp => core.publicCamp(camp, { active: camp.reservedCount, paid: camp.paidCount }));
    return json({ camps });
  }
  if (method === 'POST' && path === '/create-checkout-session') {
    const input = await readBody(request);
    const camp = await store.getCamp(input.campId);
    if (!camp) throw core.createHttpError('Choose a camp before checkout.', 400, { details: { campId: 'Choose a camp before checkout.' } });
    const service = core.serviceFor(camp.trainingType);
    if (!service) throw core.createHttpError('This camp is missing a payment setup type.', 400);
    const priceId = core.requireStripeConfig(service, env);
    if (!env.STRIPE_WEBHOOK_SECRET) throw core.createHttpError('Payment confirmation is not configured.', 503);
    const { children } = core.validateSignup(input, camp, await store.listRegistrationsByCamp(camp.id));
    const group = await store.reserveGroup(camp, children, { priceId, appUrl: env.APP_URL });
    const session = await startCheckout(group, camp, env, store);
    return json({ url: session.url });
  }
  if (method === 'GET' && path === '/session-status') {
    const id = url.searchParams.get('session_id');
    if (!id) return json({ error: 'Missing session_id.' }, 400);
    const group = await store.findRegistrationsBySession(id);
    if (!group.length) return json({ status: 'unknown' }, 404);
    const first = group[0];
    const result = { status: first.status, trainingType: first.trainingType,
      serviceName: core.serviceFor(first.trainingType)?.name || first.trainingType,
      camperNames: group.map(row => row.camperName), childCount: group.length };
    for (const key of ['campTitle','campStartDate','campEndDate','campStartTime','campEndTime','campLocation','campNotes','paidAt','amountTotal','currency']) result[key] = first[key] ?? null;
    return json(result);
  }
  if (method === 'GET' && path === '/admin/dashboard') {
    const camps = await store.listCamps();
    const all = await store.listAllRegistrations();
    return json({ camps: camps.sort(core.sortByStartDate).map(camp => {
      const counts = core.countCampRegistrations(camp.id, all);
      return { ...camp, counts, spotsLeft: Math.max(camp.capacity-counts.active,0),
        roster: all.filter(row => row.campId === camp.id).sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt))) };
    }), delivery: await store.diagnostics() });
  }
  if (method === 'GET' && path === '/admin/registrations') return json({ registrations: (await store.listAllRegistrations()).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
  if (method === 'POST' && path === '/admin/camps') {
    const camp = core.validateCamp(await readBody(request));
    await store.putCamp(camp, true);
    return json({ camp }, 201);
  }
  const campMatch = path.match(/^\/admin\/camps\/([^/]+)$/);
  if (method === 'PATCH' && campMatch) {
    const id = decodeURIComponent(campMatch[1]);
    const existing = await store.getCamp(id);
    if (!existing) return json({ error: 'Camp not found.' }, 404);
    const camp = core.validateCamp({ ...existing, ...await readBody(request), id }, existing);
    await store.putCamp(camp);
    return json({ camp });
  }
  const messageMatch = path.match(/^\/admin\/camps\/([^/]+)\/message$/);
  if (method === 'POST' && messageMatch) {
    const input = await readBody(request);
    const subject = core.text(input.subject, 150);
    const message = core.text(input.message, 2000);
    if (!subject || !message) throw core.createHttpError('Add a subject and a message.', 400);
    const camp = await store.getCamp(decodeURIComponent(messageMatch[1]));
    if (!camp) return json({ error: 'Camp not found.' }, 404);
    const parents = (await store.listRegistrationsByCamp(camp.id)).filter(row => row.status === 'paid').map(row => ({ email: row.parentEmail }));
    const result = await email.sendCampMessage(camp, parents, subject, message, env);
    if (result.reason === 'not_configured') return json({ error: 'Email sending is not configured.' }, 503);
    return json({ sent: result.sent || 0, total: result.total || 0 });
  }
  return json({ error: 'Method not allowed.' }, 405);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
    if (origin && !allowed.includes(origin)) return json({ error: 'Origin is not allowed.' }, 403);
    let response;
    try {
      if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
      else response = await route(request, env, ctx);
    } catch (error) {
      const status = error.statusCode || 503;
      response = json({ error: error.statusCode ? error.message : 'Service temporarily unavailable.',
        ...(error.details ? { details: error.details } : {}), ...(error.missingEnv ? { missingEnv: error.missingEnv } : {}) }, status);
      if (!error.statusCode) console.error(JSON.stringify({ event: 'backend_error', name: error.name || 'Error' }));
    }
    if (origin && allowed.includes(origin)) {
      response.headers.set('access-control-allow-origin', origin);
      response.headers.set('vary', 'Origin');
      response.headers.set('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
      response.headers.set('access-control-allow-headers', 'authorization,content-type');
    }
    return response;
  },
  async scheduled(_event, env) {
    if (env.BACKEND_ENABLED !== 'true') return;
    const store = createStore(env.DB);
    for (const { id } of await store.pendingGroups()) {
      const group = await store.group(id);
      if (Date.now()-Date.parse(group.created_at) > 23*3600000) continue;
      try { await startCheckout(group, await store.getCamp(group.camp_id), env, store); }
      catch { console.error(JSON.stringify({ event: 'checkout_retry_failed', groupId: id })); }
    }
    await deliverPending(store, env);
  },
};
