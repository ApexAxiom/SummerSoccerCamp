# Noah's native Cloudflare backend

This replaces the two production Lambda URLs and two DynamoDB tables with one
Worker and one D1 database. The existing Pages frontend, real camp records,
registration snapshots, Stripe account/prices, coach token, Resend sender and
parent messages are retained. The draft is inert: `BACKEND_ENABLED=false`, no
production database ID, no public Worker URL and no automatic deployment.

The local Node server and current Amplify source remain the existing development
and rollback consumers while cutover is pending. They are not bundled into the
Worker. Retire the Amplify deployment path only after the source archive,
payment reconciliation and accepted production release; do not redeploy it while
D1 is the writer. No production library has been added. The isolated
`cloudflare/package.json` pins only Wrangler as a development tool.

## Runtime contract

The Worker retains `/health`, `/config`, `/camps`, `/create-checkout-session`,
`/session-status` and all `/admin/*` routes. Stripe uses `/stripe/webhook` on the
new API hostname. Apex and www origins are allowed explicitly. The existing
`public/amplify_outputs.json` shape (`version`, `custom.apiUrl`) is retained
because both browser scripts and the Pages release consume it. The frontend
workflow accepts the old Lambda hostname or exactly `api.noahscompany.com`.
Change its existing Production `AMPLIFY_OUTPUTS_JSON` variable only at cutover.

D1 contains camps, signup groups, registration snapshots, Stripe event receipts
and durable confirmation-email deliveries. SQLite triggers enforce capacity in
the transaction even when callers hold stale camp snapshots. Counters are
derived from committed groups, not separately incremented fields. Coach camp
updates cannot reduce capacity below occupied spots. GET requests never seed
data. Empty data remains empty.

Only a signature-verified webhook plus a Stripe API read matching account mode,
group, camp, price, quantity, total and currency can mark a group paid. An unpaid
completed session waits for asynchronous payment success. Verified asynchronous
payment failures release only unpaid reservations.
Subscribe the new Stripe destination to `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
and `checkout.session.expired`. Duplicate events and
out-of-order expirations cannot double-fulfill or free paid seats. A late payment
reclaims capacity atomically if available; otherwise `payment_review` records
payment and exposes the problem to coach and parent without overselling. Such
reviews need an owner decision and Stripe reconciliation; this application does
not issue refunds or invent a seat.

Checkout creation uses a stable Stripe idempotency key and snapshots the price
and callback origin. Ambiguous failures retain their seat and are retried for up
to 23 hours; older ones are shown for coach reconciliation. Imported historical
pending groups have no new idempotency contract and are never recreated.

Payment and email intents commit together. Confirmation delivery is attempted
after the webhook acknowledgement and retried by the same Worker's bounded
five-minute schedule. Each run checks at most ten pending checkouts and twenty
emails. An email claim has a fenced lease and stable Resend idempotency key.
After 23 hours, uncertain deliveries require review rather than a potentially
duplicate resend. `sent` means the provider accepted the message; it is not
inbox evidence. Coach dashboard notices show pending mail, uncertain delivery,
old checkout and payment/capacity reviews. Existing coach-authored messages
retain the immediate distinct-paid-parent send contract and its sent/total
result.

## Private configuration and data preparation

Before using any real credential, read the owner's shared-credentials skill and
use the existing Edmond/Codex store; do not add credentials to this repository.
Transfer secrets privately from the actual deployed Lambda configuration or
canonical store into Worker secrets: `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `ADMIN_TOKEN`, `RESEND_API_KEY`. A newly registered
Stripe webhook destination has its own signing secret; do not assume the old
destination's secret applies. Preserve the current Stripe account/mode and
existing sender domain. The Worker fails coach authorization closed when its
explicit token is absent; it never uses the old local default PIN.

Public runtime values are `APP_URL`, group/private Stripe price IDs, contact
email/phone, coach email, sender address, and display prices. The deploy workflow
fixes APP_URL to the existing www origin and allows only the other listed values
through `NOAH_BACKEND_VARS_JSON`. It needs the real
`NOAH_D1_DATABASE_ID`; `NOAH_BACKEND_ENABLED` defaults to false. Secrets are
provisioned through the private operator path and retained by deployment.

The September 6 retained inventory showed nine camps and zero registrations;
it is not a current source snapshot and is not sufficient to release. Exact
source function/table IDs are in `cloudflare/migrate.mjs`; verify them again
before the final freeze. The tool checks both Lambda concurrency values are
zero, verifies their mapped table names, waits once for the actual longest
Lambda timeout to drain, then performs consistent, completely paginated scans
and rechecks both fences. It never disables writers, imports D1 data, changes
Stripe, enables the Worker, or sends email.

Use an existing access-restricted private directory outside the repository and
public reports for exports. Windows ACL protection must be established there;
POSIX file modes alone do not secure a Windows directory. Commands below take
explicit real private paths, not sample production data:

```
node cloudflare/migrate.mjs export PRIVATE_SNAPSHOT_PATH
node cloudflare/migrate.mjs sql PRIVATE_SNAPSHOT_PATH PRIVATE_SQL_PATH
```

The output reports counts and SHA256 only. Keep the original JSON archive,
SQL hash and source-fence/provider receipts privately. The converter rejects
duplicate IDs, incomplete relationships, mixed group states/payment facts,
unsupported data types and counters inconsistent with registrations. Import
into an empty, disabled D1 database. Never overwrite an active database.
Reconcile every camp/group/registration ID and private payload, not merely
counts. Review Stripe pending sessions and recent undelivered events separately;
they are not fully represented by a DynamoDB export. Imported paid groups do not
automatically resend historical confirmations.

## Release and rollback gates

1. Run `npm run check` and `npm test` at the repository root. Run
   `npm ci --prefix cloudflare --ignore-scripts`, then the Cloudflare check,
   dry-run build and test scripts. The runtime suite uses actual local D1 and
   intercepts every provider call; its fixtures never reach production.
2. Create actual D1 and apply the reviewed schema. Provision the actual Worker
   secrets and public configuration. Deploy inert and verify health says
   `enabled:false`; every data/payment/coach route must return 503. The manual
  main-only Production deployment does not apply schema or import data.
   Both release workflows verify the current main SHA through authenticated
   GitHub API access immediately before uploading; a queued stale run stops.
3. Run isolated Stripe **test-mode** checkout/webhook acceptance and owner-only
   test mail. A test-mode Worker must use its own database, test API/signing keys
   and test prices; do not overwrite production secrets or submit test campers
   to production D1. Compare real camp/public UI data and coach authorization.
4. During a bounded maintenance window, stop both old Lambda writers, drain
   invocations and create the final complete export. Import and independently
   compare D1 records. Reconcile old pending checkout sessions, payment events
   and delivery history. Preserve existing Stripe sessions and their original
   callback URLs. Keep the old webhook destination retrying while fenced until
   its undelivered events are captured and replayed to the new verified endpoint.
5. Enable exactly the new Worker, confirm its five-minute retry schedule,
   switch the Stripe destination with its matching signing secret, replay the
   captured events, then change the frontend API variable and deploy Pages.
   Recheck both apex and www in a real browser. Accept a real authorized owner
   registration, Stripe receipt, coach roster/capacity and actual parent/coach
   inbox delivery. Infrastructure health or provider acceptance cannot replace
   those outcome checks. Disable the old destination only after reconciliation.
6. Keep the old AWS source fenced and archive verified during the recovery
   interval. Rollback before new D1 writes can restore the old writer and public
   endpoint. After new writes, first reconcile D1 deltas, Stripe receipts and
   mail delivery state back into a single chosen authority; a hostname reversal
   alone is not safe. Retire exact old resources only after this gate.

The retained cost model separately allocated approximately $0.01/month of Noah
Amplify overhead after frontend/DNS cleanup, plus unallocated backend/storage
usage. This migration consolidates authority; it does not justify a large new
monthly savings claim. Current billing has not been refreshed here.

Platform references: [D1 transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[Stripe duplicate and unordered webhook handling](https://docs.stripe.com/webhooks),
[Resend's 24-hour idempotency window](https://resend.com/docs/api-reference/emails/send-email).
