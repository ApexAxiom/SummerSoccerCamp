import { defineBackend } from "@aws-amplify/backend";
import { CfnOutput, Stack } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Function as LambdaFunction, FunctionUrlAuthType, HttpMethod } from "aws-cdk-lib/aws-lambda";
import { api } from "./functions/api/resource";
import { stripeWebhook } from "./functions/stripe-webhook/resource";

const backend = defineBackend({ api, stripeWebhook });

// ---------------------------------------------------------------------------
// DynamoDB tables (replace the JSON files). Pay-per-request so they cost ~nothing
// at low/seasonal traffic and need no capacity planning.
// ---------------------------------------------------------------------------
const dataStack = backend.createStack("soccer-camp-data");

const campsTable = new Table(dataStack, "Camps", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
});

const registrationsTable = new Table(dataStack, "Registrations", {
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
});
registrationsTable.addGlobalSecondaryIndex({
  indexName: "byCamp",
  partitionKey: { name: "campId", type: AttributeType.STRING },
  sortKey: { name: "createdAt", type: AttributeType.STRING },
});
registrationsTable.addGlobalSecondaryIndex({
  indexName: "byGroup",
  partitionKey: { name: "groupId", type: AttributeType.STRING },
});
registrationsTable.addGlobalSecondaryIndex({
  indexName: "bySession",
  partitionKey: { name: "stripeCheckoutSessionId", type: AttributeType.STRING },
});

// Cast to the concrete Function so we can call addEnvironment / addFunctionUrl.
const apiLambda = backend.api.resources.lambda as LambdaFunction;
const webhookLambda = backend.stripeWebhook.resources.lambda as LambdaFunction;

for (const fn of [apiLambda, webhookLambda]) {
  campsTable.grantReadWriteData(fn);
  registrationsTable.grantReadWriteData(fn);
}

// ---------------------------------------------------------------------------
// Configuration. Everything except the table wiring is read from Amplify build
// environment variables at deploy time (Amplify console -> App settings ->
// Environment variables), so no real keys ever live in this repo. Unset values
// fall back to blank and the app degrades gracefully: empty Stripe keys ->
// checkout shows "Stripe setup needed"; empty ADMIN_TOKEN -> coach view 503.
// ---------------------------------------------------------------------------
const sharedEnv: Record<string, string> = {
  CAMPS_TABLE: campsTable.tableName,
  REGISTRATIONS_TABLE: registrationsTable.tableName,
  REGISTRATIONS_BY_CAMP_INDEX: "byCamp",
  REGISTRATIONS_BY_GROUP_INDEX: "byGroup",
  REGISTRATIONS_BY_SESSION_INDEX: "bySession",

  // Public site origin, used to build Stripe success/cancel URLs.
  APP_URL: process.env.APP_URL || "https://www.noahscompany.com",

  // Set these as Amplify environment variables to go live (test values first).
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || "",
  STRIPE_GROUP_PRICE_ID: process.env.STRIPE_GROUP_PRICE_ID || "",
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "",

  // Optional integrations — set when you use them.
  STRIPE_PRIVATE_PRICE_ID: process.env.STRIPE_PRIVATE_PRICE_ID || "",
  CONTACT_EMAIL: process.env.CONTACT_EMAIL || "",
  CONTACT_PHONE: process.env.CONTACT_PHONE || "",
  COACH_EMAIL: process.env.COACH_EMAIL || "",
  RESEND_API_KEY: process.env.RESEND_API_KEY || "",
  MAIL_FROM: process.env.MAIL_FROM || "",
  GROUP_DISPLAY_PRICE: process.env.GROUP_DISPLAY_PRICE || "",
  PRIVATE_DISPLAY_PRICE: process.env.PRIVATE_DISPLAY_PRICE || "",
};

for (const fn of [apiLambda, webhookLambda]) {
  for (const [key, value] of Object.entries(sharedEnv)) {
    fn.addEnvironment(key, value);
  }
}

// ---------------------------------------------------------------------------
// Function URLs. The browser calls the api URL (same-origin via amplify_outputs);
// Stripe calls the webhook URL (put it in the Stripe dashboard).
// ---------------------------------------------------------------------------
const apiUrl = apiLambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
  cors: {
    allowedOrigins: ["*"],
    allowedMethods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.PATCH],
    allowedHeaders: ["content-type", "authorization"],
  },
});

const webhookUrl = webhookLambda.addFunctionUrl({
  authType: FunctionUrlAuthType.NONE,
});

// Only the API URL goes into amplify_outputs.json (the browser reads it). The
// webhook URL is a stack output instead, so it isn't published in a static file —
// retrieve it from the Amplify console / CloudFormation outputs to paste into Stripe.
backend.addOutput({
  custom: {
    apiUrl: apiUrl.url,
  },
});

new CfnOutput(Stack.of(webhookLambda), "StripeWebhookUrl", {
  value: webhookUrl.url,
  description: "Put this URL in the Stripe dashboard as the webhook endpoint.",
});
