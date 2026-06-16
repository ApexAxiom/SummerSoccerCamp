const crypto = require("crypto");
const fsSync = require("fs");
const fs = require("fs/promises");
const http = require("http");
const path = require("path");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const CAMPS_FILE = path.join(DATA_DIR, "camps.json");
const REGISTRATIONS_FILE = path.join(DATA_DIR, "registrations.json");

loadEnvFile(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 4242);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "";
const CONTACT_PHONE = process.env.CONTACT_PHONE || "";
const COACH_EMAIL = process.env.COACH_EMAIL || CONTACT_EMAIL;
const MAIL_FROM = process.env.MAIL_FROM || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

const MAX_CHILDREN_PER_SIGNUP = 8;

const SERVICES = [
  {
    id: "group",
    name: "Small group summer training",
    description: "A focused group session for young players who want more touches, confidence, and game-speed reps.",
    priceEnv: "STRIPE_GROUP_PRICE_ID",
    displayPrice: process.env.GROUP_DISPLAY_PRICE || "",
  },
  {
    id: "private",
    name: "One-on-one training",
    description: "A private session with Noah built around your child's goals, position, and confidence on the ball.",
    priceEnv: "STRIPE_PRIVATE_PRICE_ID",
    displayPrice: process.env.PRIVATE_DISPLAY_PRICE || "",
  },
];

const STARTER_CAMP_WEEKS = [
  { startDate: "2026-06-15", endDate: "2026-06-18" },
  { startDate: "2026-06-22", endDate: "2026-06-25" },
  { startDate: "2026-06-29", endDate: "2026-07-02" },
  { startDate: "2026-07-06", endDate: "2026-07-09" },
  { startDate: "2026-07-13", endDate: "2026-07-16" },
  { startDate: "2026-07-20", endDate: "2026-07-23" },
  { startDate: "2026-07-27", endDate: "2026-07-30" },
  { startDate: "2026-08-03", endDate: "2026-08-06" },
  { startDate: "2026-08-10", endDate: "2026-08-13" },
];

const STARTER_CAMP_BY_ID = new Map(STARTER_CAMP_WEEKS.map((week) => [`starter_${week.startDate}`, week]));
const CAMP_COLORS = new Set(["green", "blue", "gold", "red", "purple", "slate"]);
const DEFAULT_CAMP_COLOR = "green";

const ACTIVE_REGISTRATION_STATUSES = new Set(["pending_checkout", "checkout_started", "paid"]);

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

function stripeConfiguredFor(service) {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env[service.priceEnv]);
}

function serviceFor(id) {
  return SERVICES.find((service) => service.id === id);
}

function serviceConfig(service) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    displayPrice: service.displayPrice,
    checkoutEnabled: stripeConfiguredFor(service),
    missingEnv: [
      !process.env.STRIPE_SECRET_KEY ? "STRIPE_SECRET_KEY" : null,
      !process.env[service.priceEnv] ? service.priceEnv : null,
    ].filter(Boolean),
  };
}

function publicConfig() {
  return {
    appUrl: APP_URL,
    services: SERVICES.map(serviceConfig),
    webhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    adminConfigured: Boolean(process.env.ADMIN_TOKEN),
    contactEmail: CONTACT_EMAIL,
    contactPhone: CONTACT_PHONE,
  };
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
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
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
    const parseError = new Error("Request body must be valid JSON.");
    parseError.statusCode = 400;
    throw parseError;
  }
}

function text(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function dateValue(value) {
  return new Date(`${value}T00:00:00Z`).getTime();
}

function sortByStartDate(a, b) {
  return String(a.startDate).localeCompare(String(b.startDate)) || String(a.title).localeCompare(String(b.title));
}

function campColor(value, fallback = DEFAULT_CAMP_COLOR) {
  const color = text(value, 24).toLowerCase();
  return CAMP_COLORS.has(color) ? color : fallback;
}

function createStarterCamps() {
  const now = new Date().toISOString();
  return STARTER_CAMP_WEEKS.map((week) => ({
    id: `starter_${week.startDate}`,
    createdAt: now,
    updatedAt: now,
    title: "Summer Skills Camp",
    trainingType: "group",
    startDate: week.startDate,
    endDate: week.endDate,
    startTime: "9:00 AM",
    endTime: "11:00 AM",
    location: "Cole's Crossing Soccer Field",
    ageMin: 5,
    ageMax: 12,
    capacity: 20,
    displayPrice: "$50",
    notes: "Bring water, cleats, shin guards, and a ball if you have one.",
    status: "open",
    color: DEFAULT_CAMP_COLOR,
  }));
}

function normalizeStoredCamps(camps) {
  let changed = false;
  const now = new Date().toISOString();

  const normalized = camps.map((camp) => {
    const next = { ...camp };
    const starterWeek = STARTER_CAMP_BY_ID.get(next.id);

    if (starterWeek && next.endDate !== starterWeek.endDate) {
      next.endDate = starterWeek.endDate;
      next.updatedAt = now;
      changed = true;
    }

    const normalizedColor = campColor(next.color);
    if (next.color !== normalizedColor) {
      next.color = normalizedColor;
      changed = true;
    }

    return next;
  });

  return { camps: normalized, changed };
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

async function upsertRegistration(nextRegistration) {
  const registrations = await readRegistrations();
  const index = registrations.findIndex((item) => item.id === nextRegistration.id);
  if (index >= 0) {
    registrations[index] = nextRegistration;
  } else {
    registrations.push(nextRegistration);
  }
  await writeRegistrations(registrations);
  return nextRegistration;
}

function createRegistrationId() {
  return `reg_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function createCampId() {
  return `camp_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

function createGroupId() {
  return `grp_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

// Serialize read-modify-write on the registrations file so two parents racing
// for the last spot in the same camp cannot both pass the capacity check.
let registrationsChain = Promise.resolve();
function withRegistrationsLock(task) {
  const run = registrationsChain.then(() => task());
  registrationsChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function formatCampDates(startDate, endDate) {
  const options = { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" };
  const start = new Date(`${startDate}T00:00:00Z`).toLocaleDateString("en-US", options);
  if (!endDate || endDate === startDate) return start;
  const end = new Date(`${endDate}T00:00:00Z`).toLocaleDateString("en-US", options);
  return `${start} – ${end}`;
}

// Sends mail through Resend's HTTP API when configured, and otherwise logs the
// message and returns without throwing. This mirrors how the rest of the app
// degrades gracefully when an integration is not set up yet, so a missing email
// key never blocks a real payment from being recorded.
async function sendEmail({ to, subject, text, html }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: "no_recipient" };

  if (!RESEND_API_KEY || !MAIL_FROM) {
    console.log(`[email skipped] to=${recipients.join(", ")} subject="${subject}" (set RESEND_API_KEY and MAIL_FROM to send)`);
    return { sent: false, reason: "not_configured" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: MAIL_FROM, to: recipients, subject, text, html }),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`[email failed] ${response.status} ${body}`);
      return { sent: false, reason: "api_error" };
    }
    return { sent: true };
  } catch (error) {
    console.error(`[email error] ${error.message}`);
    return { sent: false, reason: "exception" };
  }
}

function campSummaryLines(registration) {
  const lines = [
    `Camp: ${registration.campTitle}`,
    `Dates: ${formatCampDates(registration.campStartDate, registration.campEndDate)}`,
  ];
  if (registration.campStartTime || registration.campEndTime) {
    lines.push(`Time: ${registration.campStartTime} to ${registration.campEndTime}`);
  }
  if (registration.campLocation) lines.push(`Location: ${registration.campLocation}`);
  if (registration.campNotes) lines.push(`What to bring / notes: ${registration.campNotes}`);
  return lines;
}

async function sendSignupEmails(groupRegistrations) {
  if (!groupRegistrations.length) return;
  const first = groupRegistrations[0];
  const camperNames = groupRegistrations.map((item) => item.camperName);
  const summary = campSummaryLines(first);

  const parentText = [
    `Hi ${first.parentName},`,
    "",
    `You're signed up${camperNames.length > 1 ? ` for ${camperNames.length} players` : ""}: ${camperNames.join(", ")}.`,
    "",
    ...summary,
    "",
    CONTACT_EMAIL || CONTACT_PHONE ? `Questions? Reach Noah at ${[CONTACT_EMAIL, CONTACT_PHONE].filter(Boolean).join(" or ")}.` : "",
    "See you on the field!",
  ].filter((line) => line !== null).join("\n");

  await sendEmail({
    to: first.parentEmail,
    subject: `You're signed up: ${first.campTitle}`,
    text: parentText,
    html: `<p>Hi ${escapeForEmail(first.parentName)},</p>`
      + `<p>You're signed up${camperNames.length > 1 ? ` for ${camperNames.length} players` : ""}: <strong>${escapeForEmail(camperNames.join(", "))}</strong>.</p>`
      + `<ul>${summary.map((line) => `<li>${escapeForEmail(line)}</li>`).join("")}</ul>`
      + (CONTACT_EMAIL || CONTACT_PHONE ? `<p>Questions? Reach Noah at ${escapeForEmail([CONTACT_EMAIL, CONTACT_PHONE].filter(Boolean).join(" or "))}.</p>` : "")
      + "<p>See you on the field!</p>",
  });

  if (COACH_EMAIL) {
    const coachText = [
      `New paid signup for ${first.campTitle} (${formatCampDates(first.campStartDate, first.campEndDate)}).`,
      "",
      `Players: ${camperNames.join(", ")}`,
      `Parent: ${first.parentName} — ${first.parentEmail} — ${first.parentPhone}`,
      first.emergencyName ? `Emergency contact: ${first.emergencyName} — ${first.emergencyPhone}` : "",
      first.medicalNotes ? `Allergies / medical: ${first.medicalNotes}` : "",
      first.goals ? `Goals: ${first.goals}` : "",
    ].filter(Boolean).join("\n");

    await sendEmail({
      to: COACH_EMAIL,
      subject: `New signup: ${camperNames.join(", ")} — ${first.campTitle}`,
      text: coachText,
      html: coachText.split("\n").map((line) => `<p>${escapeForEmail(line)}</p>`).join(""),
    });
  }
}

function escapeForEmail(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function countCampRegistrations(campId, registrations) {
  const campRegistrations = registrations.filter((item) => item.campId === campId);
  return {
    active: campRegistrations.filter((item) => ACTIVE_REGISTRATION_STATUSES.has(item.status)).length,
    paid: campRegistrations.filter((item) => item.status === "paid").length,
    pending: campRegistrations.filter((item) => item.status !== "paid" && item.status !== "expired").length,
    total: campRegistrations.length,
  };
}

function publicCamp(camp, registrations) {
  const service = serviceFor(camp.trainingType);
  const config = service ? serviceConfig(service) : null;
  const counts = countCampRegistrations(camp.id, registrations);
  const capacity = Number(camp.capacity || 0);
  const spotsLeft = Math.max(capacity - counts.active, 0);

  return {
    id: camp.id,
    title: camp.title,
    trainingType: camp.trainingType,
    serviceName: service?.name || camp.trainingType,
    startDate: camp.startDate,
    endDate: camp.endDate,
    startTime: camp.startTime,
    endTime: camp.endTime,
    location: camp.location,
    ageMin: camp.ageMin,
    ageMax: camp.ageMax,
    capacity,
    displayPrice: camp.displayPrice || service?.displayPrice || "",
    notes: camp.notes || "",
    status: camp.status || "open",
    color: campColor(camp.color),
    spotsLeft,
    activeCount: counts.active,
    paidCount: counts.paid,
    checkoutEnabled: Boolean(config?.checkoutEnabled),
    missingEnv: config?.missingEnv || [],
  };
}

async function handlePublicCamps(res) {
  const [camps, registrations] = await Promise.all([readCamps(), readRegistrations()]);
  const visible = camps
    .filter((camp) => camp.status !== "archived")
    .sort(sortByStartDate)
    .map((camp) => publicCamp(camp, registrations));

  sendJson(res, 200, { camps: visible });
}

function validateCamp(input, existingCamp = null) {
  const errors = {};
  const service = serviceFor(input.trainingType);

  if (!service) {
    errors.trainingType = "Choose a valid camp type.";
  }

  const title = text(input.title, 120) || service?.name || "Soccer training";
  const startDate = text(input.startDate, 20);
  const endDate = text(input.endDate || input.startDate, 20);

  if (!isDateString(startDate)) {
    errors.startDate = "Enter a start date.";
  }
  if (!isDateString(endDate)) {
    errors.endDate = "Enter an end date.";
  }
  if (isDateString(startDate) && isDateString(endDate) && dateValue(endDate) < dateValue(startDate)) {
    errors.endDate = "End date must be on or after the start date.";
  }

  const capacity = Number(input.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) {
    errors.capacity = "Capacity must be between 1 and 100.";
  }

  const ageMin = Number(input.ageMin);
  const ageMax = Number(input.ageMax);
  if (!Number.isInteger(ageMin) || ageMin < 3 || ageMin > 18) {
    errors.ageMin = "Youngest age must be between 3 and 18.";
  }
  if (!Number.isInteger(ageMax) || ageMax < ageMin || ageMax > 18) {
    errors.ageMax = "Oldest age must be at least the youngest age and no more than 18.";
  }

  const startTime = text(input.startTime, 30);
  const endTime = text(input.endTime, 30);
  if (!startTime) errors.startTime = "Enter a start time.";
  if (!endTime) errors.endTime = "Enter an end time.";

  const location = text(input.location, 160);
  if (!location) {
    errors.location = "Enter a location.";
  }

  const status = ["open", "closed", "archived"].includes(input.status) ? input.status : existingCamp?.status || "open";
  const color = campColor(input.color, existingCamp?.color || DEFAULT_CAMP_COLOR);

  if (Object.keys(errors).length) {
    const error = new Error("Camp validation failed.");
    error.statusCode = 400;
    error.details = errors;
    throw error;
  }

  const now = new Date().toISOString();
  return {
    id: existingCamp?.id || createCampId(),
    createdAt: existingCamp?.createdAt || now,
    updatedAt: now,
    title,
    trainingType: service.id,
    startDate,
    endDate,
    startTime,
    endTime,
    location,
    ageMin,
    ageMax,
    capacity,
    displayPrice: text(input.displayPrice, 60),
    notes: text(input.notes, 800),
    status,
    color,
  };
}

function normalizeChildren(input) {
  if (Array.isArray(input.children) && input.children.length) {
    return input.children.slice(0, MAX_CHILDREN_PER_SIGNUP);
  }
  // Accept a single camper too, so older clients keep working.
  return [{ camperName: input.camperName, camperAge: input.camperAge }];
}

function validateSignup(input, camp, registrations) {
  const errors = {};
  const service = serviceFor(camp.trainingType);
  const counts = countCampRegistrations(camp.id, registrations);
  const rawChildren = normalizeChildren(input);
  const spotsLeft = Math.max(Number(camp.capacity) - counts.active, 0);

  if (text(input.website)) {
    errors.form = "Signup could not be accepted.";
  }

  if (!service) {
    errors.campId = "This camp is missing a payment setup type.";
  }

  if ((camp.status || "open") !== "open") {
    errors.campId = "This camp is not open for signup.";
  }

  if (rawChildren.length > spotsLeft) {
    errors.campId = spotsLeft <= 0
      ? "This camp is full."
      : `Only ${spotsLeft} spot${spotsLeft === 1 ? "" : "s"} left in this camp.`;
  }

  const children = rawChildren.map((child, index) => {
    const camperName = text(child.camperName, 120);
    const camperAge = Number(child.camperAge);
    if (camperName.length < 2) {
      errors[`child_${index}_name`] = `Enter a name for child ${index + 1}.`;
    }
    if (!Number.isInteger(camperAge) || camperAge < camp.ageMin || camperAge > camp.ageMax) {
      errors[`child_${index}_age`] = `Enter an age from ${camp.ageMin} to ${camp.ageMax} for child ${index + 1}.`;
    }
    return { camperName, camperAge, goals: text(child.goals, 800) };
  });

  const parentName = text(input.parentName, 120);
  if (parentName.length < 2) {
    errors.parentName = "Enter the parent or guardian name.";
  }

  const parentEmail = text(input.parentEmail, 180).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parentEmail)) {
    errors.parentEmail = "Enter a valid email address.";
  }

  const parentPhone = text(input.parentPhone, 40);
  if (parentPhone.replace(/\D/g, "").length < 10) {
    errors.parentPhone = "Enter a valid phone number.";
  }

  const emergencyName = text(input.emergencyName, 120);
  if (emergencyName.length < 2) {
    errors.emergencyName = "Enter an emergency contact name.";
  }

  const emergencyPhone = text(input.emergencyPhone, 40);
  if (emergencyPhone.replace(/\D/g, "").length < 10) {
    errors.emergencyPhone = "Enter a valid emergency contact phone number.";
  }

  if (input.waiverAccepted !== true) {
    errors.waiverAccepted = "A parent or guardian must accept the activity waiver.";
  }

  if (Object.keys(errors).length) {
    const error = new Error("Signup validation failed.");
    error.statusCode = 400;
    error.details = errors;
    throw error;
  }

  const sharedGoals = text(input.goals, 800);
  const medicalNotes = text(input.medicalNotes, 800);
  const shared = {
    campId: camp.id,
    campTitle: camp.title,
    campStartDate: camp.startDate,
    campEndDate: camp.endDate,
    campStartTime: camp.startTime,
    campEndTime: camp.endTime,
    campLocation: camp.location,
    campNotes: camp.notes || "",
    trainingType: service.id,
    parentName,
    parentEmail,
    parentPhone,
    emergencyName,
    emergencyPhone,
    medicalNotes,
    waiverAccepted: true,
  };

  return {
    service,
    shared,
    children: children.map((child) => ({
      ...shared,
      camperName: child.camperName,
      camperAge: child.camperAge,
      goals: child.goals || sharedGoals,
    })),
  };
}

async function createStripeCheckoutSession(group, service, camp) {
  const priceId = requireStripeConfig(service);
  const quantity = String(group.registrations.length);

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("line_items[0][price]", priceId);
  params.set("line_items[0][quantity]", quantity);
  params.set("client_reference_id", group.id);
  params.set("customer_email", group.parentEmail);
  params.set("success_url", `${APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", `${APP_URL}/#calendar`);
  params.set("metadata[group_id]", group.id);
  params.set("metadata[camp_id]", camp.id);
  params.set("metadata[training_type]", service.id);
  params.set("payment_intent_data[metadata][group_id]", group.id);
  params.set("payment_intent_data[metadata][camp_id]", camp.id);
  params.set("payment_intent_data[metadata][training_type]", service.id);

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    body = { raw: bodyText };
  }

  if (!response.ok) {
    const error = new Error(body.error?.message || "Stripe refused the checkout session.");
    error.statusCode = 502;
    error.stripe = body.error || body;
    throw error;
  }

  return body;
}

function requireStripeConfig(service) {
  const priceId = process.env[service.priceEnv];
  const missingEnv = [
    !process.env.STRIPE_SECRET_KEY ? "STRIPE_SECRET_KEY" : null,
    !priceId ? service.priceEnv : null,
  ].filter(Boolean);

  if (missingEnv.length) {
    const error = new Error("Stripe checkout is not configured for this camp type.");
    error.statusCode = 503;
    error.missingEnv = missingEnv;
    throw error;
  }

  return priceId;
}

async function handleCreateCheckoutSession(req, res) {
  const input = await readJson(req);
  const camps = await readCamps();
  const camp = camps.find((item) => item.id === input.campId);

  if (!camp) {
    const error = new Error("Choose a camp before checkout.");
    error.statusCode = 400;
    error.details = { campId: "Choose a camp before checkout." };
    throw error;
  }

  // Validate Stripe config before reserving spots, so a misconfigured camp
  // never creates pending registrations it cannot collect payment for.
  const service = serviceFor(camp.trainingType);
  if (!service) {
    const error = new Error("This camp is missing a payment setup type.");
    error.statusCode = 400;
    throw error;
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

function parseStripeSignature(header) {
  return String(header || "")
    .split(",")
    .reduce((acc, part) => {
      const [key, value] = part.split("=");
      if (!key || !value) return acc;
      if (!acc[key]) acc[key] = [];
      acc[key].push(value);
      return acc;
    }, {});
}

function verifyStripeSignature(rawBody, signatureHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    const error = new Error("Stripe webhook secret is not configured.");
    error.statusCode = 503;
    error.missingEnv = ["STRIPE_WEBHOOK_SECRET"];
    throw error;
  }

  const parts = parseStripeSignature(signatureHeader);
  const timestamp = parts.t?.[0];
  const signatures = parts.v1 || [];
  if (!timestamp || !signatures.length) {
    const error = new Error("Missing Stripe signature fields.");
    error.statusCode = 400;
    throw error;
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    const error = new Error("Stripe signature timestamp is outside the allowed tolerance.");
    error.statusCode = 400;
    throw error;
  }

  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]);
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  const matched = signatures.some((signature) => {
    const actualBuffer = Buffer.from(signature, "hex");
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  });

  if (!matched) {
    const error = new Error("Stripe webhook signature could not be verified.");
    error.statusCode = 400;
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
    const parseError = new Error("Webhook payload is not valid JSON.");
    parseError.statusCode = 400;
    throw parseError;
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    await markCheckoutPaid(event.data.object);
  }

  if (event.type === "checkout.session.expired") {
    await markCheckoutExpired(event.data.object);
  }

  sendJson(res, 200, { received: true });
}

function sessionGroupId(session) {
  return session.client_reference_id || session.metadata?.group_id || null;
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
