import { defineFunction, secret } from "@aws-amplify/backend";

// Stripe webhook receiver. Only needs the webhook signing secret; the rest of its
// config (table names, email settings) is injected as plain env vars in backend.ts.
export const stripeWebhook = defineFunction({
  name: "soccer-stripe-webhook",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 256,
  environment: {
    STRIPE_WEBHOOK_SECRET: secret("STRIPE_WEBHOOK_SECRET"),
  },
});
