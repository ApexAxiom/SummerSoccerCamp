# Stripe Backend Shape

Recommended backend option: **Node.js**.

Ruby would work, but for this folder Node.js keeps the frontend and backend in one small JavaScript project. The backend should own prices, payment state, and roster persistence. The browser should never decide that a signup is paid.

## Flow

1. Noah reviews the Monday-through-Thursday starter summer schedule in Coach view, then edits each camp's duration/color, adds single-day or overlapping sessions, closes signup, or archives dates he is not offering.
2. Parent picks a camp from the public calendar and fills out the signup form.
3. Frontend sends the selected camp and registration to `POST /api/create-checkout-session`.
4. Backend validates fields, capacity, camp status, and Stripe setup, then creates a Stripe Checkout Session using the configured Stripe Price ID for that camp type.
5. Parent pays on Stripe-hosted Checkout.
6. Stripe sends `checkout.session.completed` to `POST /api/stripe/webhook`.
7. Backend verifies the Stripe signature and marks the registration paid.
8. Noah sees paid and pending registrations grouped by camp in Coach view.

## Data to store

- registration id
- group id (links siblings registered in one checkout)
- camp id
- camp title, dates, time, location, and notes at signup time
- training type
- camper name and age
- parent name, email, and phone
- emergency contact name and phone
- allergy or medical notes
- player goals or notes
- waiver acceptance timestamp
- Stripe checkout session id
- Stripe payment status
- amount and currency from Stripe

One registration is stored per child. A multi-child signup creates several
registrations that share a group id, and the webhook marks the whole group paid.

Do not store card numbers. Stripe Checkout handles card data.

## Production notes

- Use Stripe Price IDs instead of hard-coded dollar amounts.
- Keep `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` on the server only.
- Treat the success page as a receipt/status screen, not proof of payment.
- Mark paid from webhooks, not from browser redirects.
- Add database storage before real volume. The current JSON file store is fine for a tiny MVP and local testing, but not for concurrent production traffic.
- Keep camp schedules editable in the admin flow. Avoid changing paid roster history when a camp is archived.
