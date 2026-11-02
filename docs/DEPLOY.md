# Deploying

One Docker image, three Cloud Run services (`cloudbuild.yaml`):

| Service | Role | Scaling |
|---|---|---|
| `rektbull-api` | `SERVICE_ROLE=web` | With traffic, public |
| `rektbull-worker` | `SERVICE_ROLE=worker` | Exactly 1 instance, CPU always on, private (the deposit watcher must run continuously) |
| `rektbull-trade` | `SERVICE_ROLE=trade` | Exactly 1 instance, private, **its own service account**: the only identity that may sign with RektBull's KMS keys |

Migrations run on start.

## One-time setup

1. **A separate Google Cloud project** for RektBull, so its secrets, database
   and billing are apart from Soyjak's.
2. **Postgres**: Cloud SQL (small instance) or a free Neon/Supabase plan to start.
3. **Artifact Registry** repository named `rektbull` in the region in `cloudbuild.yaml`.
4. **Secrets** in Secret Manager, named as in `cloudbuild.yaml`:
   `rektbull-database-url`, `rektbull-jwt-secret`,
   `rektbull-anthropic-api-key`, `rektbull-cdp-api-key-id`,
   `rektbull-cdp-api-key-secret`, `rektbull-etherscan-api-key`,
   `rektbull-blockscout-api-key`. The worker only needs the database URL and
   JWT secret.
5. Non-secret settings (`X402_PAY_TO`, `CRYPTO_DEPOSIT_XPUB`,
   `PAYMENT_CHAINS`, `RPC_URLS_*`, `PROVIDER_DAILY_LIMITS`, `ADMIN_WALLETS`)
   as environment variables on the services. `RPC_URLS_*` hold API keys in
   their URLs, so treat those as secrets too. The worker needs
   `CRYPTO_DEPOSIT_XPUB`, `PAYMENT_CHAINS` and `RPC_URLS_*`.
6. A Cloud Build trigger on pushes to `main`.

## Privacy page

`/privacy` names who runs RektBull and where privacy requests go: set
`OPERATOR_NAME` (the person or company responsible) and `PRIVACY_CONTACT`
(an address someone reads) before launch. The page states what each
feature keeps and for how long; `src/privacy/retention.js` deletes data on
those same periods (the worker runs it hourly). Change both together, and
have the page reviewed by a lawyer for the places you serve.

## Alerts: Telegram, email, browser push

The risk monitor sends alerts to whatever each user links. Each channel is
optional; one that isn't set up shows as "not available yet" on the page.
Set `PUBLIC_URL=https://rektbull.com` so links in alerts point to the site.

**Telegram** (free):
1. In Telegram, message @BotFather: `/newbot`, name it (e.g. RektBull Alerts)
   and get its token. `/setprivacy` → Enable (it only needs its own chats).
2. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (without @), and
   `TELEGRAM_WEBHOOK_SECRET` (a long random string: `openssl rand -hex 32`).
3. Point Telegram at the web service, with the same secret:
   ```bash
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d url=https://rektbull.com/v1/telegram/webhook \
     -d secret_token=$TELEGRAM_WEBHOOK_SECRET -d 'allowed_updates=["message"]'
   ```
   Requests without that secret are refused.

**Email** (Resend; another provider is one function in `src/alerts/transports.js`):
1. Create a Resend account, add and verify the sending domain (it gives
   SPF and DKIM records for rektbull.com's DNS). Without them, alerts land
   in spam.
2. Set `RESEND_API_KEY` and `EMAIL_FROM` (e.g. `RektBull <alerts@rektbull.com>`).
   Every alert email has a one-click unsubscribe link and header.

**Browser push** (free; Web Push with VAPID):
1. `npx web-push generate-vapid-keys` once. Keep the private key secret
   (Secret Manager), and never change the pair: changing it ends every
   existing subscription.
2. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`
   (`mailto:` an address you read).

The worker sends due alerts every 20 seconds, retrying a failed send after
1, 5 and 30 minutes, then 2 and 6 hours. A channel that can't work any more
(bot blocked, browser unsubscribed, address rejected) is switched off and the
user sees why.

## Domain: rektbull.com

- Map `api.rektbull.com` to `rektbull-api` (Cloud Run domain mapping, or a
  load balancer), and keep `rektbull.com` for the website.
- Register `rektbull.app` and redirect it to `rektbull.com`.
- **Email authentication before any alert email goes out:** SPF, DKIM and
  DMARC records for `rektbull.com` (start DMARC at `p=quarantine`). For a
  safety brand, spoofed email from your domain would do real damage. If the
  domain sends no mail yet, publish `v=spf1 -all` and `p=reject` now so no
  one can send as it.
- Set `SIWE_DOMAIN` and `SIWE_URI` to the website's real domain, or wallets
  will show a mismatch warning on sign-in.

## RektBull's own keys in Google Cloud KMS

Only RektBull's own key lives in KMS: the session key that uses users'
trading permissions. It also pays the gas for the trades it sends (MetaMask's
Redeemer rule means it must send them itself), so keep a little ETH on it. **Never user keys**; users sign with
their own wallets. The fee wallet and treasury are receive-only and stay cold
(a Safe or hardware wallet), outside KMS.

```bash
gcloud kms keyrings create rektbull --location=us-central1
gcloud kms keys create session-key --keyring=rektbull --location=us-central1 \
  --purpose=asymmetric-signing --default-algorithm=ec-sign-secp256k1-sha256 --protection-level=hsm

gcloud iam service-accounts create rektbull-trade
gcloud kms keys add-iam-policy-binding session-key --keyring=rektbull --location=us-central1 \
  --member=serviceAccount:rektbull-trade@$PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/cloudkms.signerVerifier
```

- Grant the signer role **on this key only**, and **only** to
  `rektbull-trade`. The API and worker services must have no KMS role.
- Set `KMS_SESSION_KEY_VERSION` on the trade service
  (full `…/cryptoKeyVersions/1` names). Put the session key's public address in
  `SESSION_KEY_ADDRESS` on the API (it only needs the address); the trade
  service derives it from KMS and the two must match.
- Turn on **Data Access audit logs** for Cloud KMS. Every signature is then
  logged. RektBull writes each signature it asks for to `key_signatures` first
  (digest and purpose), so any KMS signature without a matching row is an alarm.
- Emergency stop: remove `rektbull-trade`'s binding on `session-key`. Automatic
  trading stops at once; no user funds are at risk either way.
