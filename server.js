const crypto = require("crypto");
const fsSync = require("fs");
const fs = require("fs/promises");
const http = require("http");
const path = require("path");

const {
  serviceFor,
  sortByStartDate,
  publicConfig,
  validateCamp,
  validateSignup,
  countCampRegistrations,
  publicCamp,
  normalizeStoredCamps,
  createStarterCamps,
  requireStripeConfig,
  createRegistrationId,
  createGroupId,
  createHttpError,
} = require("./shared/core");
const { createStripeCheckoutSession, verifyStripeSignature, sessionGroupId } = require("./shared/stripe");
const { sendSignupEmails } = require("./shared/email");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const CAMPS_FILE = path.join(DATA_DIR, "camps.json");
const REGISTRATIONS_FILE = path.join(DATA_DIR, "registrations.json");

loadEnvFile(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 4242);
// Publish APP_URL back to the environment so the shared Stripe helper builds the
// same success/cancel URLs the local server expects.
process.env.APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const APP_URL = process.env.APP_URL;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function loadEnvFile(envPath) {
  if (!fsSync.existsSync(envPath)) return;
  const raw = fsSync.readFileSync(envPath, "utf8");

  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) return;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendPlain(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

async function readRequestBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw createHttpError("Request body is too large.", 413);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readRequestBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw createHttpError("Request body must be valid JSON.", 400);
  }
}

async function readJsonArray(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`${path.basename(filePath)} must contain a JSON array.`);
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonArray(filePath, records) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
}

async function readCamps() {
  const camps = await readJsonArray(CAMPS_FILE);
  if (camps.length) {
    const normalized = normalizeStoredCamps(camps);
    if (normalized.changed) {
      await writeJsonArray(CAMPS_FILE, normalized.camps);
    }
    return normalized.camps;
  }

  const starterCamps = createStarterCamps();
  await writeJsonArray(CAMPS_FILE, starterCamps);
  return starterCamps;
}

async function writeCamps(camps) {
  await writeJsonArray(CAMPS_FILE, camps.slice().sort(sortByStartDate));
}

async function readRegistrations() {
  return readJsonArray(REGISTRATIONS_FILE);
}

async function writeRegistrations(registrations) {
  await writeJsonArray(REGISTRATIONS_FILE, registrations);
}

// Serialize read-modify-write on the registrations file so two parents racing
// for the last spot in the same camp cannot both pass the capacity check. (In
// the Lambda deployment this is replaced by a DynamoDB conditional transaction.)
let registrationsChain = Promise.resolve();
function withRegistrationsLock(task) {
  const run = registrationsChain.then(() => task());
  registrationsChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function handlePublicCamps(res) {
  const [camps, registrations] = await Promise.all([readCamps(), readRegistrations()]);
  const visible = camps
    .filter((camp) => camp.status !== "archived")
    .sort(sortByStartDate)
    .map((camp) => publicCamp(camp, countCampRegistrations(camp.id, registrations)));

  sendJson(res, 200, { camps: visible });
}

async function handleCreateCheckoutSession(req, res) {
  const input = await readJson(req);
  const camps = await readCamps();
  const camp = camps.find((item) => item.id === input.campId);

  if (!camp) {
    throw createHttpError("Choose a camp before checkout.", 400, {
      details: { campId: "Choose a camp before checkout." },
    });
  }

  // Validate Stripe config before reserving spots, so a misconfigured camp never
  // creates pending registrations it cannot collect payment for.
  const service = serviceFor(camp.trainingType);
  if (!service) {
    throw createHttpError("This camp is missing a payment setup type.", 400);
  }
  requireStripeConfig(service);

  // Reserve every child's spot in one locked read-modify-write so concurrent
  // checkouts cannot oversell the camp.
  const group = await withRegistrationsLock(async () => {
    const registrations = await readRegistrations();
    const { children } = validateSignup(input, camp, registrations);

    const now = new Date().toISOString();
    const groupId = createGroupId();
    const reserved = children.map((child) => ({
      id: createRegistrationId(),
      groupId,
      status: "pending_checkout",
      createdAt: now,
      updatedAt: now,
      waiverAcceptedAt: now,
      ...child,
    }));

    await writeRegistrations([...registrations, ...reserved]);
    return { id: groupId, parentEmail: reserved[0].parentEmail, registrations: reserved };
  });

  try {
    const session = await createStripeCheckoutSession(group, service, camp);
    await withRegistrationsLock(async () => {
      const registrations = await readRegistrations();
      const updated = registrations.map((item) => (item.groupId === group.id
        ? { ...item, status: "checkout_started", updatedAt: new Date().toISOString(), stripeCheckoutSessionId: session.id }
        : item));
      await writeRegistrations(updated);
    });

    sendJson(res, 200, { url: session.url });
  } catch (error) {
    await withRegistrationsLock(async () => {
      const registrations = await readRegistrations();
      const updated = registrations.map((item) => (item.groupId === group.id
        ? { ...item, status: "checkout_failed", updatedAt: new Date().toISOString(), checkoutError: error.message }
        : item));
      await writeRegistrations(updated);
    });
    throw error;
  }
}

async function handleStripeWebhook(req, res) {
  const raw = await readRequestBody(req, 2_000_000);
  verifyStripeSignature(raw, req.headers["stripe-signature"]);

  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw createHttpError("Webhook payload is not valid JSON.", 400);
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    await markCheckoutPaid(event.data.object);
  }

  if (event.type === "checkout.session.expired") {
    await markCheckoutExpired(event.data.object);
  }

  sendJson(res, 200, { received: true });
}

async function markCheckoutPaid(session) {
  const groupId = sessionGroupId(session);
  if (!groupId) return;

  // Split the total Stripe charged evenly across the children in the group so
  // each roster row shows a per-child amount.
  const paid = await withRegistrationsLock(async () => {
    const registrations = await readRegistrations();
    const groupRows = registrations.filter((item) => item.groupId === groupId);
    if (!groupRows.length) return [];

    const now = new Date().toISOString();
    const perChild = typeof session.amount_total === "number"
      ? Math.round(session.amount_total / groupRows.length)
      : null;

    const updated = registrations.map((item) => (item.groupId === groupId
      ? {
        ...item,
        status: "paid",
        updatedAt: now,
        paidAt: now,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: session.payment_intent || item.stripePaymentIntentId || null,
        stripeCustomerId: session.customer || null,
        amountTotal: perChild,
        currency: session.currency || null,
      }
      : item));

    await writeRegistrations(updated);
    return updated.filter((item) => item.groupId === groupId);
  });

  if (paid.length) {
    await sendSignupEmails(paid);
  }
}

async function markCheckoutExpired(session) {
  const groupId = sessionGroupId(session);
  if (!groupId) return;

  await withRegistrationsLock(async () => {
    const registrations = await readRegistrations();
    const updated = registrations.map((item) => (item.groupId === groupId && item.status !== "paid"
      ? { ...item, status: "expired", updatedAt: new Date().toISOString(), stripeCheckoutSessionId: session.id }
      : item));
    await writeRegistrations(updated);
  });
}

async function handleSessionStatus(url, res) {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    sendJson(res, 400, { error: "Missing session_id." });
    return;
  }

  const registrations = await readRegistrations();
  const group = registrations.filter((item) => item.stripeCheckoutSessionId === sessionId);
  if (!group.length) {
    sendJson(res, 404, { status: "unknown" });
    return;
  }

  const registration = group[0];
  const service = serviceFor(registration.trainingType);
  const allPaid = group.every((item) => item.status === "paid");
  sendJson(res, 200, {
    status: allPaid ? "paid" : registration.status,
    trainingType: registration.trainingType,
    serviceName: service?.name || registration.trainingType,
    campTitle: registration.campTitle || null,
    campStartDate: registration.campStartDate || null,
    campEndDate: registration.campEndDate || null,
    campStartTime: registration.campStartTime || null,
    campEndTime: registration.campEndTime || null,
    campLocation: registration.campLocation || null,
    campNotes: registration.campNotes || null,
    camperNames: group.map((item) => item.camperName),
    childCount: group.length,
    paidAt: registration.paidAt || null,
    amountTotal: registration.amountTotal ?? null,
    currency: registration.currency || null,
  });
}

function authorized(req) {
  const configured = process.env.ADMIN_TOKEN;
  if (!configured) return false;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const configuredBuffer = Buffer.from(configured);
  const tokenBuffer = Buffer.from(token);
  return tokenBuffer.length === configuredBuffer.length && crypto.timingSafeEqual(tokenBuffer, configuredBuffer);
}

function requireAdmin(req, res) {
  if (!process.env.ADMIN_TOKEN) {
    sendJson(res, 503, { error: "Admin view is not configured.", missingEnv: ["ADMIN_TOKEN"] });
    return false;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { error: "Unauthorized." });
    return false;
  }

  return true;
}

async function handleAdminDashboard(req, res) {
  if (!requireAdmin(req, res)) return;

  const [camps, registrations] = await Promise.all([readCamps(), readRegistrations()]);
  const campsWithRosters = camps.slice().sort(sortByStartDate).map((camp) => {
    const counts = countCampRegistrations(camp.id, registrations);
    const roster = registrations
      .filter((registration) => registration.campId === camp.id)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return {
      ...camp,
      counts,
      spotsLeft: Math.max(Number(camp.capacity || 0) - counts.active, 0),
      roster,
    };
  });

  sendJson(res, 200, { camps: campsWithRosters });
}

async function handleAdminCreateCamp(req, res) {
  if (!requireAdmin(req, res)) return;

  const input = await readJson(req);
  const camps = await readCamps();
  const nextCamp = validateCamp(input);
  camps.push(nextCamp);
  await writeCamps(camps);
  sendJson(res, 201, { camp: nextCamp });
}

async function handleAdminUpdateCamp(req, res, campId) {
  if (!requireAdmin(req, res)) return;

  const input = await readJson(req);
  const camps = await readCamps();
  const index = camps.findIndex((camp) => camp.id === campId);
  if (index < 0) {
    sendJson(res, 404, { error: "Camp not found." });
    return;
  }

  const merged = { ...camps[index], ...input, id: camps[index].id };
  const nextCamp = validateCamp(merged, camps[index]);
  camps[index] = nextCamp;
  await writeCamps(camps);
  sendJson(res, 200, { camp: nextCamp });
}

async function handleAdminRegistrations(req, res) {
  if (!requireAdmin(req, res)) return;

  const registrations = await readRegistrations();
  const sorted = registrations.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  sendJson(res, 200, { registrations: sorted });
}

async function serveStatic(url, res) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const requested = path.normalize(path.join(PUBLIC_DIR, pathname));
  const relative = path.relative(PUBLIC_DIR, requested);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendPlain(res, 403, "Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(requested);
    const ext = path.extname(requested).toLowerCase();
    const cacheControl = [".png", ".webp", ".svg", ".ico"].includes(ext)
      ? "public, max-age=3600"
      : "no-store";
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": cacheControl,
    });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendPlain(res, 404, "Not found");
      return;
    }
    throw error;
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, APP_URL);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/amplify_outputs.json") {
    // Local dev has no Amplify backend: report no custom config so the frontend
    // falls back to these same-origin /api routes (and avoids a console 404).
    sendJson(res, 200, {});
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, publicConfig());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/camps") {
    await handlePublicCamps(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/create-checkout-session") {
    await handleCreateCheckoutSession(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stripe/webhook") {
    await handleStripeWebhook(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/session-status") {
    await handleSessionStatus(url, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/dashboard") {
    await handleAdminDashboard(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/camps") {
    await handleAdminCreateCamp(req, res);
    return;
  }

  const campUpdateMatch = url.pathname.match(/^\/api\/admin\/camps\/([^/]+)$/);
  if (req.method === "PATCH" && campUpdateMatch) {
    await handleAdminUpdateCamp(req, res, decodeURIComponent(campUpdateMatch[1]));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/registrations") {
    await handleAdminRegistrations(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(url, res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    const status = error.statusCode || 500;
    const payload = {
      error: error.message || "Unexpected server error.",
    };
    if (error.details) payload.details = error.details;
    if (error.missingEnv) payload.missingEnv = error.missingEnv;
    if (error.stripe) payload.stripe = error.stripe;
    sendJson(res, status, payload);
  });
});

server.listen(PORT, () => {
  console.log(`Noah's soccer camp site running at ${APP_URL}`);
});
