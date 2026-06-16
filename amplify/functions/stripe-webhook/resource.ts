import { defineFunction } from "@aws-amplify/backend";

// Stripe webhook receiver. Its config (STRIPE_WEBHOOK_SECRET, table names, email)
// is injected as environment variables in backend.ts. With STRIPE_WEBHOOK_SECRET
// blank it returns 503, so the deploy succeeds before the webhook is configured.
export const stripeWebhook = defineFunction({
  name: "soccer-stripe-webhook",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 256,
});
