# Deploying the Amplify Gen 2 backend

The code for a full AWS Amplify deployment is already in this repo. The frontend
(`public/`) is static; the dynamic backend lives in `amplify/` as an Amplify
Gen 2 app: two DynamoDB tables and two Lambda functions exposed via Function URLs.

What's left is the AWS-side deploy, which needs AWS credentials. Hand the prompt
below to **Cursor** (or **Amazon Q Developer** — it works for either) in an
environment that has AWS access for the target account.

---

## PROMPT FOR CURSOR / AMAZON Q

> You are deploying an **AWS Amplify Gen 2** app from this repository. The
> application code is complete and committed — do **not** rewrite the business
> logic. Your job is to provision the backend on AWS, wire up Stripe, and verify
> it end-to-end. Work in **Stripe test mode first**, then switch to live.
>
> ### Repository layout (read these first)
> - `amplify/backend.ts` — provisions two **DynamoDB** tables (`Camps`,
>   `Registrations` with `byCamp`/`byGroup`/`bySession` GSIs), grants the Lambdas
>   access, injects env vars, and creates two **Lambda Function URLs**. The API
>   URL is published to `amplify_outputs.json` (`custom.apiUrl`); the webhook URL
>   is a CloudFormation stack output named `StripeWebhookUrl`.
> - `amplify/functions/api/` — the public + admin API (config, camps,
>   create-checkout-session, session-status, admin/*).
> - `amplify/functions/stripe-webhook/` — verifies the Stripe signature over the
>   **raw** body and marks a group paid. Raw-body handling for the Function URL
>   is already implemented (`isBase64Encoded`).
> - `amplify/functions/lib/store.js` — DynamoDB data layer. Capacity/overselling
>   is enforced with a conditional `TransactWriteItems` on a per-camp
>   `reservedCount` counter. Do not replace this with the in-process lock.
> - `shared/` — business logic shared with the local `server.js` (the reference
>   implementation; `npm test` covers it). Reuse it; don't fork it.
> - `amplify.yml` — Gen 2 fullstack build: deploy backend, copy
>   `amplify_outputs.json` into `public/`, publish `public/`.
>
> ### Context about the existing AWS setup
> - There is already an Amplify Hosting app for this repo. From an earlier build
>   log the app id was `d3qcyohuot5wl5`, branch `main`, custom domain
>   `https://noahscompany.com`. Confirm this app and branch, or create/connect a
>   Gen 2 app if needed.
> - **Verify the Amplify app's service/compute role can deploy a Gen 2 backend**
>   (CloudFormation + DynamoDB + Lambda + IAM). If the existing app is
>   hosting-only, enable the fullstack/backend build or recreate it as a Gen 2
>   app pointed at this repo. This is the most likely source of a failed deploy.
>
> ### Steps
> 1. `npm ci` (a `package-lock.json` is committed).
> 2. **Set configuration values.** The backend deploys with these **blank** (the
>    app degrades gracefully — empty Stripe keys show "Stripe setup needed", an
>    empty `ADMIN_TOKEN` returns 503), so an initial deploy needs no setup. To
>    enable payments and the coach view, set them (Stripe **test** values first):
>    - `STRIPE_SECRET_KEY`, `STRIPE_GROUP_PRICE_ID` — enable checkout
>    - `ADMIN_TOKEN` — enable the coach view (any long random string)
>    - `STRIPE_WEBHOOK_SECRET` — from the webhook you create in step 6
>    Quickest: edit `sharedEnv` in `amplify/backend.ts`. **Better for production
>    (Hardening):** convert `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
>    `ADMIN_TOKEN` to `secret("NAME")` in the resource files and set them with
>    `npx ampx sandbox secret set <NAME>` (sandbox) or the Amplify console (main).
> 3. **Edit `amplify/backend.ts` → `sharedEnv`**: set `APP_URL` to the public site
>    origin (`https://noahscompany.com`). Optionally set `CONTACT_EMAIL`,
>    `CONTACT_PHONE`, `COACH_EMAIL`, `STRIPE_PRIVATE_PRICE_ID`, and the display
>    prices. For email confirmations set `RESEND_API_KEY` + `MAIL_FROM` (consider
>    moving `RESEND_API_KEY` to a `secret()` for production).
> 4. **Validate in a sandbox first**: `npx ampx sandbox`. Confirm it provisions
>    the tables + functions and writes `amplify_outputs.json` with
>    `custom.apiUrl`. Hit `<apiUrl>/camps` (should return the starter camps) and
>    `<apiUrl>/config`.
> 5. **Deploy to the branch**: push to `main` so Amplify's CI runs `amplify.yml`,
>    or run `npx ampx pipeline-deploy --branch main --app-id <APP_ID>`. Confirm
>    the build is green and `public/amplify_outputs.json` is published.
> 6. **Wire up Stripe**: get the webhook URL from the `StripeWebhookUrl`
>    CloudFormation output (or Amplify console). In the Stripe dashboard add a
>    webhook endpoint = that URL, subscribed to `checkout.session.completed`,
>    `checkout.session.async_payment_succeeded`, and `checkout.session.expired`.
>    Copy the signing secret into the `STRIPE_WEBHOOK_SECRET` secret and redeploy.
> 7. **Create real camps / prices**: the app seeds a starter summer schedule on
>    first load. Create a Stripe Price for group training and put its id in
>    `STRIPE_GROUP_PRICE_ID`. Use the coach view (`/admin.html`, log in with
>    `ADMIN_TOKEN`) to add/edit camps.
>
> ### Acceptance criteria (verify before finishing)
> - The Amplify build is green and `https://noahscompany.com` loads; the **camps
>   page calendar populates** (the browser reads `amplify_outputs.json` →
>   `custom.apiUrl` → `/camps`).
> - A **Stripe test-mode checkout** for a camp completes; the webhook fires and
>   the registration shows as **paid** in the coach view; capacity (`spotsLeft`)
>   decrements and cannot be oversold (try two near-simultaneous checkouts for the
>   last spot — exactly one should succeed).
> - The coach view requires the `ADMIN_TOKEN` (401 without it).
> - Report back the **API Function URL** and the **Stripe webhook URL**.
>
> ### Notes / gotchas
> - Node 20 runtime. The AWS SDK v3 is in the runtime; Amplify bundles the
>   handlers with esbuild (already verified to bundle cleanly).
> - Function URL CORS is currently `*`; tighten `allowedOrigins` in `backend.ts`
>   to `https://noahscompany.com` once verified.
> - Payment state is set **only** from the verified webhook, never from the
>   browser redirect — keep it that way.
> - The local `server.js` + JSON files are the dev/reference path; the deployed
>   app uses DynamoDB. Don't point production at the JSON files.

---

## Quick reference: configuration values

All of these live in `amplify/backend.ts` (`sharedEnv`) and are **blank by
default** — the backend deploys without them and degrades gracefully. Fill them
in to turn features on.

| Value | Needed for | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | checkout | Stripe secret key (test then live); harden to a secret |
| `STRIPE_GROUP_PRICE_ID` | checkout | Stripe Price id for group training |
| `STRIPE_WEBHOOK_SECRET` | confirming payment | From the webhook in step 6; harden to a secret |
| `ADMIN_TOKEN` | coach view | Long random string; harden to a secret |
| `APP_URL` | Stripe redirect URLs | Set to `https://noahscompany.com` |
| `CONTACT_EMAIL` / `CONTACT_PHONE` | footer + emails | Optional |
| `COACH_EMAIL` | new-signup alerts | Optional; defaults to `CONTACT_EMAIL` |
| `RESEND_API_KEY` / `MAIL_FROM` | confirmation emails | Optional |
| `STRIPE_PRIVATE_PRICE_ID` | 1-on-1 checkout | Optional |
| `GROUP_DISPLAY_PRICE` / `PRIVATE_DISPLAY_PRICE` | price labels | Optional |
