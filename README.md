# Noah Westra Soccer Training

Simple camp calendar, parent signup, coach roster, and Stripe Checkout flow for Noah's summer soccer training.

## Run locally

1. Copy `.env.example` to `.env` and fill in Stripe test values. The server reads `.env` automatically.
2. Start the site:

```powershell
npm start
```

3. Open `http://localhost:4242`.

When no camp file exists yet, the app creates an editable starter summer schedule with one Monday-through-Thursday group camp each week from June 15 through August 13, 2026. It does not create fake registrations or fake paid records. If Stripe is not configured, the calendar and coach tools still load, but checkout shows the missing setup instead of pretending payment worked.

## Camp workflow

1. Set `ADMIN_TOKEN` in `.env`.
2. Open `http://localhost:4242/admin.html`.
3. Enter the admin token.
4. Edit each camp's start/end dates, color, time, location, capacity, and price label. Noah can add overlapping camps, one-day sessions, close signup, or archive dates he is no longer offering.
5. Parents pick a camp from the public calendar, fill out the signup form, and continue to Stripe.
6. Noah sees each camp's roster with pending checkout and paid counts.

## Stripe backend choice

From the Stripe options in the screenshot, I would pick **Node.js** for this project unless you specifically want a Ruby app. The frontend is plain HTML/CSS/JS, and the backend only needs a few endpoints:

- `GET /api/camps` serves the public camp calendar with spot counts.
- `POST /api/create-checkout-session` validates the selected camp/signup and sends the parent to Stripe Checkout.
- `POST /api/stripe/webhook` verifies Stripe's signature and marks the registration paid only after Stripe confirms it.
- `GET /api/admin/dashboard` lets Noah view camps, capacity, pending checkout, and paid rosters.
- `POST /api/admin/camps` lets Noah add real camp weeks/sessions.
- `PATCH /api/admin/camps/:id` lets Noah edit, close, reopen, or archive a camp.

This repo currently uses no production dependencies. Before going live, I would add Stripe's official Node SDK after your approval, because Stripe recommends official libraries for webhook verification.

## Environment variables

- `STRIPE_SECRET_KEY`: Stripe secret key.
- `STRIPE_WEBHOOK_SECRET`: webhook signing secret from Stripe.
- `STRIPE_GROUP_PRICE_ID`: Stripe Price ID for small group training.
- `STRIPE_PRIVATE_PRICE_ID`: Stripe Price ID for one-on-one training.
- `APP_URL`: public site URL, such as `https://example.com`.
- `ADMIN_TOKEN`: long private token for Noah's admin page.

Optional display labels:

- `GROUP_DISPLAY_PRICE`
- `PRIVATE_DISPLAY_PRICE`

Keep Stripe Price IDs as the payment source of truth. The display labels are only convenience text.

## Checks

```powershell
npm run check
```

Use Stripe CLI locally for webhook testing:

```powershell
stripe listen --forward-to localhost:4242/api/stripe/webhook
```
