"use strict";

// Stripe integration shared by the local server and the Lambda functions.
// Reads STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / APP_URL from the environment
// at call time. The browser never decides payment state; these helpers create a
// Checkout Session and verify the webhook signature server-side.

const crypto = require("crypto");
const { createHttpError, requireStripeConfig } = require("./core");

async function createStripeCheckoutSession(group, service, camp) {
  const priceId = requireStripeConfig(service);
  const quantity = String(group.registrations.length);
  const appUrl = process.env.APP_URL || "";

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("line_items[0][price]", priceId);
  params.set("line_items[0][quantity]", quantity);
  params.set("client_reference_id", group.id);
  params.set("customer_email", group.parentEmail);
  params.set("success_url", `${appUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", `${appUrl}/camps.html#calendar`);
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
    throw createHttpError(body.error?.message || "Stripe refused the checkout session.", 502, {
      stripe: body.error || body,
    });
  }

  return body;
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

// Verifies Stripe's signature over the exact raw request bytes. rawBody must be a
// Buffer of the unparsed body; re-serializing the JSON would change the bytes
// and break verification.
function verifyStripeSignature(rawBody, signatureHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw createHttpError("Stripe webhook secret is not configured.", 503, {
      missingEnv: ["STRIPE_WEBHOOK_SECRET"],
    });
  }

  const parts = parseStripeSignature(signatureHeader);
  const timestamp = parts.t?.[0];
  const signatures = parts.v1 || [];
  if (!timestamp || !signatures.length) {
    throw createHttpError("Missing Stripe signature fields.", 400);
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    throw createHttpError("Stripe signature timestamp is outside the allowed tolerance.", 400);
  }

  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]);
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  const matched = signatures.some((signature) => {
    const actualBuffer = Buffer.from(signature, "hex");
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  });

  if (!matched) {
    throw createHttpError("Stripe webhook signature could not be verified.", 400);
  }
}

function sessionGroupId(session) {
  return session.client_reference_id || session.metadata?.group_id || null;
}

module.exports = {
  createStripeCheckoutSession,
  parseStripeSignature,
  verifyStripeSignature,
  sessionGroupId,
};
