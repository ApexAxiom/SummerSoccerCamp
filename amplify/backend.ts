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
// Shared, non-secret configuration. Edit APP_URL and the optional integration
// values below before deploying. (RESEND_API_KEY is here for convenience; move it
// to a secret() in the resource files once you start sending email.)
// ---------------------------------------------------------------------------
const sharedEnv: Record<string, string> = {
  CAMPS_TABLE: campsTable.tableName,
  REGISTRATIONS_TABLE: registrationsTable.tableName,
  REGISTRATIONS_BY_CAMP_INDEX: "byCamp",
  REGISTRATIONS_BY_GROUP_INDEX: "byGroup",
  REGISTRATIONS_BY_SESSION_INDEX: "bySession",

  // The public site origin, used to build Stripe success/cancel URLs.
  APP_URL: "https://noahscompany.com",

  // Blank by default so the backend deploys with no setup. The app degrades
  // gracefully: empty Stripe keys -> checkout shows "Stripe setup needed"; empty
  // ADMIN_TOKEN -> coach view returns 503. Fill these in (and ideally move
  // STRIPE_SECRET_KEY / ADMIN_TOKEN to Amplify secrets) to go live.
  STRIPE_SECRET_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  STRIPE_GROUP_PRICE_ID: "",
  ADMIN_TOKEN: "",

  // Optional — leave blank until you use them.
  STRIPE_PRIVATE_PRICE_ID: "",
  CONTACT_EMAIL: "",
  CONTACT_PHONE: "",
  COACH_EMAIL: "",
  RESEND_API_KEY: "",
  MAIL_FROM: "",
  GROUP_DISPLAY_PRICE: "",
  PRIVATE_DISPLAY_PRICE: "",
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
