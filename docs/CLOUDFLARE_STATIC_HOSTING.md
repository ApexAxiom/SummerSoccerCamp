# Cloudflare static frontend

Preparation starts from deployed commit `9e7deff9aa3d1cfb28cfe9b10208cb819c8ca5d3`, Amplify job 17. The frontend is the existing plain HTML/CSS/JavaScript `public/` directory. It needs no npm dependency installation or application build.

The old Amplify pipeline first deploys the backend to generate `amplify_outputs.json`; the Cloudflare workflow must not do that. Copy the already-deployed artifact's complete public `amplify_outputs.json` into GitHub Production environment variable `AMPLIFY_OUTPUTS_JSON`. Its current structure contains only `version` and `custom.apiUrl`; it has no server credentials. The workflow validates that real Lambda URL and writes the same JSON into ignored `public/amplify_outputs.json` before upload. Missing/invalid configuration fails rather than building a frontend which silently points at a missing same-origin API.

The manual-only, main-only `.github/workflows/deploy-cloudflare-static.yml` runs the existing Node syntax checks and fourteen dependency-free logic tests, restores that public configuration, and uploads only `public/` with pinned deployment-only Wrangler 4.129.0 to project `noahscompany`, production branch `main`. Configure secret `CLOUDFLARE_API_TOKEN` and variable `CLOUDFLARE_ACCOUNT_ID` in the same Production environment.

Do not invoke `ampx pipeline-deploy`, local `server.js`, Lambda deployments, or AWS infrastructure from this hosting workflow. Keep the existing camps/registrations API, Stripe checkout/webhook, coach administration, configured email and data services. Preserve current checkout return URLs and CORS. No root `404.html` or catch-all `_redirects` is added: Pages' native SPA fallback preserves the existing Amplify unknown-path homepage fallback while real `.html` pages and assets remain available.

For the first upload, use the recovered Amplify artifact, which already includes exact production configuration. The source release workflow must use the same public JSON. Live form/registration/payment/admin acceptance and custom-domain checks remain required before retiring Amplify hosting; these local tests do not send email, create registrations or charge payments.
