"use strict";

// Unit tests for the shared business logic. These run with plain Node (no AWS,
// no server, no network) and cover the logic that both the local server and the
// Lambda functions rely on: validation, capacity, camp shaping, Stripe signature
// verification, and date formatting. Run with: npm test
//
// Each Stripe-config test sets process.env locally and restores it.

const assert = require("assert");
const crypto = require("crypto");
const core = require("../shared/core");
const { verifyStripeSignature, sessionGroupId, parseStripeSignature } = require("../shared/stripe");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

function throwsWith(fn, predicate) {
  try {
    fn();
  } catch (error) {
    return predicate(error);
  }
  throw new Error("Expected function to throw, but it did not.");
}

const sampleCamp = {
  id: "camp_1",
  title: "Summer Skills Camp",
  trainingType: "group",
  startDate: "2026-06-15",
  endDate: "2026-06-18",
  startTime: "9:00 AM",
  endTime: "11:00 AM",
  location: "Cole's Crossing Soccer Field",
  ageMin: 5,
  ageMax: 12,
  capacity: 20,
  notes: "Bring water and cleats.",
  status: "open",
  color: "green",
};

function validSignupInput(overrides = {}) {
  return {
    campId: "camp_1",
    children: [
      { camperName: "Sam", camperAge: 8, goals: "first touch" },
      { camperName: "Alex", camperAge: 10 },
    ],
    parentName: "Jamie Rivera",
    parentEmail: "JAMIE@example.com",
    parentPhone: "(281) 555-0100",
    emergencyName: "Pat Rivera",
    emergencyPhone: "281-555-0199",
    medicalNotes: "Sam: peanut allergy",
    goals: "have fun",
    waiverAccepted: true,
    ...overrides,
  };
}

test("validateSignup accepts a valid two-child signup and snapshots camp details", () => {
  const result = core.validateSignup(validSignupInput(), sampleCamp, []);
  assert.strictEqual(result.children.length, 2);
  assert.strictEqual(result.shared.parentEmail, "jamie@example.com", "email is lowercased");
  assert.strictEqual(result.children[0].campNotes, "Bring water and cleats.", "camp notes snapshotted");
  assert.strictEqual(result.children[0].campLocation, sampleCamp.location);
  assert.strictEqual(result.children[0].goals, "first touch", "per-child goal preserved");
  assert.strictEqual(result.children[1].goals, "have fun", "falls back to shared goal");
  assert.strictEqual(result.children[0].emergencyName, "Pat Rivera");
});

test("validateSignup reports field-level errors and does not throw a bare Error", () => {
  const bad = validSignupInput({
    children: [{ camperName: "A", camperAge: 99 }, { camperName: "", camperAge: 7 }],
    parentEmail: "not-an-email",
    parentPhone: "123",
    emergencyName: "",
    emergencyPhone: "",
    waiverAccepted: false,
  });
  assert.ok(throwsWith(() => core.validateSignup(bad, sampleCamp, []), (err) => {
    assert.strictEqual(err.statusCode, 400);
    const d = err.details;
    assert.ok(d.child_0_name, "child 0 short name flagged");
    assert.ok(d.child_0_age, "child 0 age out of range flagged");
    assert.ok(d.child_1_name, "child 1 empty name flagged");
    assert.ok(d.parentEmail && d.parentPhone, "parent contact flagged");
    assert.ok(d.emergencyName && d.emergencyPhone, "emergency contact flagged");
    assert.ok(d.waiverAccepted, "waiver flagged");
    return true;
  }));
});

test("validateSignup blocks the honeypot field", () => {
  const spam = validSignupInput({ website: "http://spam" });
  assert.ok(throwsWith(() => core.validateSignup(spam, sampleCamp, []), (err) => err.statusCode === 400 && err.details.form));
});

test("validateSignup enforces remaining capacity", () => {
  const smallCamp = { ...sampleCamp, capacity: 1 };
  assert.ok(throwsWith(() => core.validateSignup(validSignupInput(), smallCamp, []), (err) => {
    assert.strictEqual(err.statusCode, 400);
    assert.strictEqual(err.details.campId, "Only 1 spot left in this camp.");
    return true;
  }));
});

test("validateSignup rejects a full camp", () => {
  const reg = (id) => ({ id, campId: "camp_1", status: "paid" });
  const full = Array.from({ length: 20 }, (_, i) => reg(`r${i}`));
  assert.ok(throwsWith(() => core.validateSignup(validSignupInput(), sampleCamp, full), (err) => err.details.campId === "This camp is full."));
});

test("countCampRegistrations counts active, paid, pending correctly", () => {
  const regs = [
    { campId: "camp_1", status: "paid" },
    { campId: "camp_1", status: "checkout_started" },
    { campId: "camp_1", status: "expired" },
    { campId: "camp_1", status: "checkout_failed" },
    { campId: "other", status: "paid" },
  ];
  const counts = core.countCampRegistrations("camp_1", regs);
  assert.strictEqual(counts.active, 2, "paid + checkout_started are active");
  assert.strictEqual(counts.paid, 1);
  assert.strictEqual(counts.total, 4);
});

test("publicCamp computes spotsLeft from counts and hides internal fields", () => {
  const view = core.publicCamp(sampleCamp, { active: 2, paid: 1 });
  assert.strictEqual(view.capacity, 20);
  assert.strictEqual(view.spotsLeft, 18);
  assert.strictEqual(view.paidCount, 1);
  assert.strictEqual(view.activeCount, 2);
  assert.strictEqual(view.notes, "Bring water and cleats.");
  assert.strictEqual(view.stripeCustomerId, undefined, "no internal/registration fields leak");
});

test("validateCamp rejects an end date before the start date", () => {
  const bad = { ...sampleCamp, startDate: "2026-06-18", endDate: "2026-06-15" };
  assert.ok(throwsWith(() => core.validateCamp(bad), (err) => err.statusCode === 400 && err.details.endDate));
});

test("validateCamp returns a normalized camp with ids and timestamps", () => {
  const camp = core.validateCamp({ ...sampleCamp, id: undefined });
  assert.ok(camp.id.startsWith("camp_"));
  assert.ok(camp.createdAt && camp.updatedAt);
  assert.strictEqual(camp.color, "green");
});

test("requireStripeConfig throws 503 when unset and returns the price id when set", () => {
  const service = core.serviceFor("group");
  const saved = { key: process.env.STRIPE_SECRET_KEY, price: process.env.STRIPE_GROUP_PRICE_ID };
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_GROUP_PRICE_ID;
  assert.ok(throwsWith(() => core.requireStripeConfig(service), (err) => {
    assert.strictEqual(err.statusCode, 503);
    assert.deepStrictEqual(err.missingEnv, ["STRIPE_SECRET_KEY", "STRIPE_GROUP_PRICE_ID"]);
    return true;
  }));
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_GROUP_PRICE_ID = "price_x";
  assert.strictEqual(core.requireStripeConfig(service), "price_x");
  if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.key;
  if (saved.price === undefined) delete process.env.STRIPE_GROUP_PRICE_ID; else process.env.STRIPE_GROUP_PRICE_ID = saved.price;
});

test("formatCampDates renders a single day and a range", () => {
  assert.strictEqual(core.formatCampDates("2026-06-15", "2026-06-15"), "June 15, 2026");
  assert.strictEqual(core.formatCampDates("2026-06-15", "2026-06-18"), "June 15, 2026 to June 18, 2026");
});

test("verifyStripeSignature accepts a correct signature and rejects tampering", () => {
  const saved = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "checkout.session.completed" }));
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", "whsec_test").update(`${ts}.${body}`).digest("hex");
  // Correct signature verifies without throwing.
  verifyStripeSignature(body, `t=${ts},v1=${sig}`);
  // Tampered body throws.
  assert.ok(throwsWith(
    () => verifyStripeSignature(Buffer.from("{}"), `t=${ts},v1=${sig}`),
    (err) => err.statusCode === 400,
  ));
  // Stale timestamp throws.
  assert.ok(throwsWith(
    () => verifyStripeSignature(body, `t=${ts - 99999},v1=${sig}`),
    (err) => err.statusCode === 400,
  ));
  if (saved === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = saved;
});

test("sessionGroupId reads client_reference_id then metadata", () => {
  assert.strictEqual(sessionGroupId({ client_reference_id: "grp_1" }), "grp_1");
  assert.strictEqual(sessionGroupId({ metadata: { group_id: "grp_2" } }), "grp_2");
  assert.strictEqual(sessionGroupId({}), null);
});

test("parseStripeSignature groups t and v1 values", () => {
  const parsed = parseStripeSignature("t=123,v1=abc,v1=def");
  assert.deepStrictEqual(parsed.t, ["123"]);
  assert.deepStrictEqual(parsed.v1, ["abc", "def"]);
});

if (failures.length) {
  console.error(`\n${failures.length} test(s) FAILED:`);
  for (const f of failures) {
    console.error(`  ✗ ${f.name}\n    ${f.error.message}`);
  }
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`✓ all ${passed} logic tests passed`);
