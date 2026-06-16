import { defineFunction, secret } from "@aws-amplify/backend";

// Public + admin API. Secrets are set with `npx ampx sandbox secret set <NAME>`
// (or in the Amplify console for the deployed branch). Table names, APP_URL, and
// the optional integration config are injected as plain env vars in backend.ts.
export const api = defineFunction({
  name: "soccer-api",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  memoryMB: 256,
  environment: {
    STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
    STRIPE_GROUP_PRICE_ID: secret("STRIPE_GROUP_PRICE_ID"),
    ADMIN_TOKEN: secret("ADMIN_TOKEN"),
  },
});
