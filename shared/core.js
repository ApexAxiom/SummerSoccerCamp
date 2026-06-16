"use strict";

// Pure, runtime-agnostic business logic shared by the local Node server
// (server.js, file storage) and the AWS Lambda functions (DynamoDB storage).
// Nothing here touches a filesystem, a database, or the network. Anything that
// needs configuration reads process.env lazily at call time, so the same code
// works whether it runs on the local server or in a Lambda with Amplify secrets.

const crypto = require("crypto");

const MAX_CHILDREN_PER_SIGNUP = 8;

const SERVICES = [
  {
    id: "group",
    name: "Small group summer training",
    description: "A focused group session for young players who want more touches, confidence, and game-speed reps.",
    priceEnv: "STRIPE_GROUP_PRICE_ID",
    displayPriceEnv: "GROUP_DISPLAY_PRICE",
  },
  {
    id: "private",
    name: "One-on-one training",
    description: "A private session with Noah built around your child's goals, position, and confidence on the ball.",
    priceEnv: "STRIPE_PRIVATE_PRICE_ID",
    displayPriceEnv: "PRIVATE_DISPLAY_PRICE",
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

function createHttpError(message, statusCode = 500, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function serviceFor(id) {
  return SERVICES.find((service) => service.id === id);
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

function formatCampDates(startDate, endDate) {
  const options = { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" };
  const start = new Date(`${startDate}T00:00:00Z`).toLocaleDateString("en-US", options);
  if (!endDate || endDate === startDate) return start;
  const end = new Date(`${endDate}T00:00:00Z`).toLocaleDateString("en-US", options);
  return `${start} – ${end}`;
}

function escapeForEmail(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

function stripeConfiguredFor(service) {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env[service.priceEnv]);
}

function serviceConfig(service) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    displayPrice: process.env[service.displayPriceEnv] || "",
    checkoutEnabled: stripeConfiguredFor(service),
    missingEnv: [
      !process.env.STRIPE_SECRET_KEY ? "STRIPE_SECRET_KEY" : null,
      !process.env[service.priceEnv] ? service.priceEnv : null,
    ].filter(Boolean),
  };
}

function publicConfig() {
  return {
    appUrl: process.env.APP_URL || "",
    services: SERVICES.map(serviceConfig),
    webhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    adminConfigured: Boolean(process.env.ADMIN_TOKEN),
    contactEmail: process.env.CONTACT_EMAIL || "",
    contactPhone: process.env.CONTACT_PHONE || "",
  };
}

function requireStripeConfig(service) {
  const priceId = process.env[service.priceEnv];
  const missingEnv = [
    !process.env.STRIPE_SECRET_KEY ? "STRIPE_SECRET_KEY" : null,
    !priceId ? service.priceEnv : null,
  ].filter(Boolean);

  if (missingEnv.length) {
    throw createHttpError("Stripe checkout is not configured for this camp type.", 503, { missingEnv });
  }

  return priceId;
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
    capacity: 5,
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

function countCampRegistrations(campId, registrations) {
  const campRegistrations = registrations.filter((item) => item.campId === campId);
  return {
    active: campRegistrations.filter((item) => ACTIVE_REGISTRATION_STATUSES.has(item.status)).length,
    paid: campRegistrations.filter((item) => item.status === "paid").length,
    pending: campRegistrations.filter((item) => item.status !== "paid" && item.status !== "expired").length,
    total: campRegistrations.length,
  };
}

// counts is { active, paid }. The file server computes it from the registrations
// array (countCampRegistrations); the Lambda passes a maintained DynamoDB counter
// so it never has to read every registration just to render the calendar.
function publicCamp(camp, counts = {}) {
  const service = serviceFor(camp.trainingType);
  const config = service ? serviceConfig(service) : null;
  const active = Number(counts.active || 0);
  const paid = Number(counts.paid || 0);
  const capacity = Number(camp.capacity || 0);
  const spotsLeft = Math.max(capacity - active, 0);

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
    displayPrice: camp.displayPrice || config?.displayPrice || "",
    notes: camp.notes || "",
    status: camp.status || "open",
    color: campColor(camp.color),
    spotsLeft,
    activeCount: active,
    paidCount: paid,
    checkoutEnabled: Boolean(config?.checkoutEnabled),
    missingEnv: config?.missingEnv || [],
  };
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
    throw createHttpError("Camp validation failed.", 400, { details: errors });
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
    throw createHttpError("Signup validation failed.", 400, { details: errors });
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

module.exports = {
  MAX_CHILDREN_PER_SIGNUP,
  SERVICES,
  STARTER_CAMP_WEEKS,
  STARTER_CAMP_BY_ID,
  CAMP_COLORS,
  DEFAULT_CAMP_COLOR,
  ACTIVE_REGISTRATION_STATUSES,
  createHttpError,
  serviceFor,
  text,
  isDateString,
  dateValue,
  sortByStartDate,
  campColor,
  formatCampDates,
  escapeForEmail,
  createRegistrationId,
  createCampId,
  createGroupId,
  stripeConfiguredFor,
  serviceConfig,
  publicConfig,
  requireStripeConfig,
  createStarterCamps,
  normalizeStoredCamps,
  countCampRegistrations,
  publicCamp,
  validateCamp,
  normalizeChildren,
  validateSignup,
};
