// API Lambda behind a Function URL. Routes the same endpoints as the local
// server.js, but reads/writes DynamoDB (via ../lib/store) and reuses the shared
// business logic. Authored as an Amplify-idiomatic ESM handler; the shared and
// store modules are CommonJS and are pulled in with namespace imports.
import * as coreModule from "../../../shared/core";
import * as stripeModule from "../../../shared/stripe";
import * as storeModule from "../lib/store";
import * as emailModule from "../../../shared/email";

// The shared and store modules are plain CommonJS (no type declarations); their
// logic is covered by test/logic.test.js. Alias them as any so tsc checks the
// handler glue without choking on signatures inferred from untyped JS.
const core: any = coreModule;
const stripe: any = stripeModule;
const store: any = storeModule;
const email: any = emailModule;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(statusCode: number, payload: unknown) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

function errorResponse(error: any) {
  const status = error?.statusCode || 500;
  const payload: any = { error: error?.message || "Unexpected server error." };
  if (error?.details) payload.details = error.details;
  if (error?.missingEnv) payload.missingEnv = error.missingEnv;
  if (error?.stripe) payload.stripe = error.stripe;
  return json(status, payload);
}

function readBody(event: any) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw core.createHttpError("Request body must be valid JSON.", 400);
  }
}

function requireAdmin(event: any) {
  const header = (event.headers?.authorization || event.headers?.Authorization || "") as string;
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!core.checkAdminToken(token)) {
    throw core.createHttpError("Wrong PIN.", 401);
  }
}

async function handleCamps() {
  await store.ensureStarterCamps();
  const camps = await store.listCamps();
  const visible = camps
    .filter((camp: any) => camp.status !== "archived")
    .sort(core.sortByStartDate)
    .map((camp: any) => core.publicCamp(camp, { active: Number(camp.reservedCount || 0), paid: Number(camp.paidCount || 0) }));
  return json(200, { camps: visible });
}

async function handleCreateCheckout(input: any) {
  const camp = await store.getCamp(input.campId);
  if (!camp) {
    throw core.createHttpError("Choose a camp before checkout.", 400, { details: { campId: "Choose a camp before checkout." } });
  }
  const service = core.serviceFor(camp.trainingType);
  if (!service) throw core.createHttpError("This camp is missing a payment setup type.", 400);
  core.requireStripeConfig(service);

  // Field validation up front (names, ages, contact, waiver). Capacity is enforced
  // atomically inside store.reserveGroup, so the current rows here only drive the
  // friendly "N spots left" message.
  const rows = await store.listRegistrationsByCamp(camp.id);
  const { children } = core.validateSignup(input, camp, rows);

  const group = await store.reserveGroup(camp, children);
  try {
    const session = await stripe.createStripeCheckoutSession(group, service, camp);
    await store.patchGroup(group.id, { status: "checkout_started", stripeCheckoutSessionId: session.id });
    return json(200, { url: session.url });
  } catch (error: any) {
    await store.releaseGroup(group.id, "checkout_failed", { checkoutError: error?.message });
    throw error;
  }
}

async function handleSessionStatus(sessionId?: string) {
  if (!sessionId) return json(400, { error: "Missing session_id." });
  const group = await store.findRegistrationsBySession(sessionId);
  if (!group.length) return json(404, { status: "unknown" });

  const r = group[0];
  const service = core.serviceFor(r.trainingType);
  const allPaid = group.every((x: any) => x.status === "paid");
  return json(200, {
    status: allPaid ? "paid" : r.status,
    trainingType: r.trainingType,
    serviceName: service?.name || r.trainingType,
    campTitle: r.campTitle || null,
    campStartDate: r.campStartDate || null,
    campEndDate: r.campEndDate || null,
    campStartTime: r.campStartTime || null,
    campEndTime: r.campEndTime || null,
    campLocation: r.campLocation || null,
    campNotes: r.campNotes || null,
    camperNames: group.map((x: any) => x.camperName),
    childCount: group.length,
    paidAt: r.paidAt || null,
    amountTotal: r.amountTotal ?? null,
    currency: r.currency || null,
  });
}

async function handleAdminDashboard() {
  await store.ensureStarterCamps();
  const camps = await store.listCamps();
  const all = await store.listAllRegistrations();
  const withRosters = camps.slice().sort(core.sortByStartDate).map((camp: any) => {
    const counts = core.countCampRegistrations(camp.id, all);
    const roster = all
      .filter((r: any) => r.campId === camp.id)
      .sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return { ...camp, counts, spotsLeft: Math.max(Number(camp.capacity || 0) - counts.active, 0), roster };
  });
  return json(200, { camps: withRosters });
}

async function handleAdminCreateCamp(input: any) {
  const camp = core.validateCamp(input);
  await store.putCamp({ ...camp, reservedCount: 0, paidCount: 0 });
  return json(201, { camp });
}

async function handleAdminUpdateCamp(id: string, input: any) {
  const existing = await store.getCamp(id);
  if (!existing) return json(404, { error: "Camp not found." });
  const merged = { ...existing, ...input, id: existing.id };
  const camp = core.validateCamp(merged, existing);
  // Preserve the counters maintained by the reservation transactions.
  await store.putCamp({ ...camp, reservedCount: existing.reservedCount || 0, paidCount: existing.paidCount || 0 });
  return json(200, { camp });
}

async function handleAdminRegistrations() {
  const regs = await store.listAllRegistrations();
  regs.sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return json(200, { registrations: regs });
}

async function handleAdminMessage(id: string, input: any) {
  const subject = core.text(input.subject, 150);
  const message = core.text(input.message, 2000);
  if (!subject || !message) {
    throw core.createHttpError("Add a subject and a message.", 400);
  }

  const camp = await store.getCamp(id);
  if (!camp) return json(404, { error: "Camp not found." });

  const rows = await store.listRegistrationsByCamp(id);
  const parents = rows
    .filter((r: any) => r.status === "paid")
    .map((r: any) => ({ name: r.parentName, email: r.parentEmail }));

  const result = await email.sendCampMessage(camp, parents, subject, message);
  if (result.reason === "not_configured") {
    return json(503, {
      error: "Email sending isn't set up yet. Add RESEND_API_KEY and MAIL_FROM in Amplify to message parents.",
      missingEnv: ["RESEND_API_KEY", "MAIL_FROM"],
    });
  }
  return json(200, { sent: result.sent || 0, total: result.total || 0 });
}

export const handler = async (event: any) => {
  try {
    const method = event.requestContext?.http?.method || event.httpMethod || "GET";
    const path = (event.rawPath || event.path || "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
    const query = event.queryStringParameters || {};

    if (method === "GET" && (path === "/" || path === "/health")) return json(200, { ok: true });
    if (method === "GET" && path === "/config") return json(200, core.publicConfig());
    if (method === "GET" && path === "/camps") return await handleCamps();
    if (method === "POST" && path === "/create-checkout-session") return await handleCreateCheckout(readBody(event));
    if (method === "GET" && path === "/session-status") return await handleSessionStatus(query.session_id);

    if (method === "GET" && path === "/admin/dashboard") { requireAdmin(event); return await handleAdminDashboard(); }
    if (method === "POST" && path === "/admin/camps") { requireAdmin(event); return await handleAdminCreateCamp(readBody(event)); }
    const messageMatch = path.match(/^\/admin\/camps\/([^/]+)\/message$/);
    if (method === "POST" && messageMatch) { requireAdmin(event); return await handleAdminMessage(decodeURIComponent(messageMatch[1]), readBody(event)); }
    const updateMatch = path.match(/^\/admin\/camps\/([^/]+)$/);
    if (method === "PATCH" && updateMatch) { requireAdmin(event); return await handleAdminUpdateCamp(decodeURIComponent(updateMatch[1]), readBody(event)); }
    if (method === "GET" && path === "/admin/registrations") { requireAdmin(event); return await handleAdminRegistrations(); }

    return json(405, { error: "Method not allowed." });
  } catch (error) {
    return errorResponse(error);
  }
};
