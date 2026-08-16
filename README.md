# BookLocal Stripe backend

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | yes | `sk_test_…` for staging, `sk_live_…` for production |
| `STRIPE_WEBHOOK_SECRET` | yes | `whsec_…` from the Stripe webhook endpoint |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | yes | Whole service-account JSON on one line |
| `ALLOWED_ORIGINS` | no | Comma-separated browser origins. Leave empty for the mobile app |
| `PORT` | no | Defaults to `3000` |

## Stripe webhook setup

Add an endpoint in the Stripe dashboard pointing at `https://<your-host>/stripe-webhook`
and subscribe to:

- `payment_intent.amount_capturable_updated` — authorization succeeded, booking becomes `confirmed`
- `payment_intent.succeeded` — funds captured, booking becomes `completed`
- `payment_intent.canceled` — booking becomes `cancelled` / `expired`
- `payment_intent.payment_failed`
- `account.updated` — flips the guide's `payoutsEnabled` flag; without it no
  guide can ever be booked

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Without it the webhook
route rejects every request and booking status will never leave `pending_payment`.

## Authentication

Every endpoint except `/` and `/stripe-webhook` requires a Firebase ID token:

```
Authorization: Bearer <token from user.getIDToken()>
```

`/resolve-dispute` and `/send-support-notification` additionally require the
`admin` custom claim. Grant it with:

```bash
node set-admin.js you@example.com
```

The user has to sign out and back in before the claim reaches their token.

## Booking flow

1. App calls `POST /create-booking-intent` with `{ guideId, serviceId, date, hours, peopleCount, notes }`.
   The server reads the guide's own prices from Firestore, computes the amount,
   rejects duplicate bookings, writes the booking as `pending_payment` and
   returns a `clientSecret`. **The client never sends an amount.**
2. App presents the Stripe PaymentSheet.
3. Stripe calls `payment_intent.amount_capturable_updated` → booking becomes
   `confirmed`, guide gets a push notification.
4. Guide calls `POST /mark-trip-finished` → `waiting_tourist_confirmation`.
5. Tourist calls `POST /capture-payment` (release) or `POST /report-problem`
   (dispute). After 24 h with no answer the cron releases automatically.

## Data layout

Contact details are **not** stored on the profile document, because any signed-in
user can read guide profiles while browsing. They live one level down:

```
guides/{uid}                  public: name, city, languages, rating, payoutsEnabled…
guides/{uid}/private/secure   email, phone, fcmToken, stripeAccountId
tourists/{uid}                public-ish: fullName, profileImageUrl, isOnline
tourists/{uid}/private/secure email, phone, fcmToken
```

`rating`, `reviewsCount`, `isVerified` and `payoutsEnabled` are rejected by
`firestore.rules` on client writes and are only ever set here.

## Firestore indexes

The queries below need composite indexes; Firestore prints a creation link on
first run:

- `bookings`: `touristId` + `guideId` + `status`
- `bookings`: `status` + `paymentStatus` + `finishedAt`
- `bookings`: `status` + `createdAt`
- `bookings`: `touristId` + `createdAt` (desc)
- `bookings`: `guideId` + `createdAt` (desc)
- `bookings`: `guideId` + `status` + `date` — the slot-conflict check in
  `assertGuideIsFree` and `POST /guide-availability`
- `chats`: `touristId` + `updatedAt` (desc), `guideId` + `updatedAt` (desc) —
  the two chat lists
- `guides`: `country` + `cities` (array-contains) + `rating` (desc) — the paged
  guide search

## Deploying to Railway

The GitHub repo `booklocal-clean` has `server.js` at its root, so Railway needs
no root-directory override: Nixpacks detects Node, installs, and runs
`npm start`.

**Environment variables** (Railway -> service -> Variables):

| Variable | Where to get it |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe Dashboard -> Developers -> API keys (`sk_live_…` / `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | Created with the webhook endpoint below (`whsec_…`) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Console -> Project settings -> Service accounts -> Generate new private key, then paste the whole file as **one line** |
| `ALLOWED_ORIGINS` | Optional. Leave unset — the iOS app sends no Origin header. |

`PORT` is injected by Railway; the server already reads it.

**After the first deploy**, Railway shows a public URL such as
`https://booklocal-production-xxxx.up.railway.app`. Three places must then point
at it:

1. **Stripe webhooks** — **two** endpoints, both pointing at
   `<railway-url>/stripe-webhook`.

   Payments are destination charges (`transfer_data.destination` on a
   PaymentIntent created on the platform), so the payment events land on the
   platform while `account.updated` lands on the connected account:

   | Endpoint scope | Events |
   | --- | --- |
   | Your account | `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`, `payment_intent.canceled`, `payment_intent.payment_failed` |
   | Connected accounts | `account.updated` |

   Each endpoint has its own signing secret. Put both in
   `STRIPE_WEBHOOK_SECRET`, comma separated:

   ```
   STRIPE_WEBHOOK_SECRET=whsec_platform...,whsec_connect...
   ```
2. **iOS app** — `BACKEND_BASE_URL` in the Xcode target's build settings
   (Debug and Release both).
3. **Stripe Connect return URLs** — the `refresh_url` / `return_url` in
   `/create-connect-account` currently point at `booklocalguide.com`.

Without step 1 no guide ever becomes bookable: `payoutsEnabled` is only ever
set by the `account.updated` webhook.
