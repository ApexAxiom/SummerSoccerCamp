import { defineFunction } from "@aws-amplify/backend";

// Public + admin API. All configuration (table names, Stripe keys, admin token,
// email settings) is injected as environment variables in backend.ts so the
// backend deploys with no pre-configured secrets and degrades gracefully until
// the values are filled in. For production, move STRIPE_SECRET_KEY / ADMIN_TOKEN
// to Amplify secrets — see DEPLOY_AMPLIFY.md.
export const api = defineFunction({
  name: "soccer-api",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 256,
});
