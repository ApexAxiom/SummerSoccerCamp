// Stripe webhook Lambda behind its own Function URL (this URL goes in the Stripe
// dashboard). It verifies the signature over the exact raw bytes, then marks the
// group paid (and emails) or releases an expired checkout. Payment state is only
// ever set from this verified webhook, never from a browser redirect.
import * as stripeModule from "../../../shared/stripe";
import * as emailModule from "../../../shared/email";
import * as storeModule from "../lib/store";

// CommonJS modules without type declarations; aliased to any (logic is unit-tested).
const stripe: any = stripeModule;
const email: any = emailModule;
const store: any = storeModule;

export const handler = async (event: any) => {
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : Buffer.from(event.body || "", "utf8");
    const signature = event.headers?.["stripe-signature"] || event.headers?.["Stripe-Signature"];

    stripe.verifyStripeSignature(raw, signature);

    let evt: any;
    try {
      evt = JSON.parse(raw.toString("utf8"));
    } catch {
      return { statusCode: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Webhook payload is not valid JSON." }) };
    }

    if (evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded") {
      const session = evt.data.object;
      const groupId = stripe.sessionGroupId(session);
      if (groupId) {
        const paid = await store.markGroupPaid(session, groupId);
        if (paid.length) await email.sendSignupEmails(paid);
      }
    } else if (evt.type === "checkout.session.expired") {
      const session = evt.data.object;
      const groupId = stripe.sessionGroupId(session);
      if (groupId) await store.releaseGroup(groupId, "expired", { stripeCheckoutSessionId: session.id });
    }

    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ received: true }) };
  } catch (error: any) {
    // Return Stripe's expected error status so it knows whether to retry.
    const status = error?.statusCode || 400;
    return { statusCode: status, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: error?.message || "Webhook error." }) };
  }
};
