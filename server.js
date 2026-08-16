require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const cron = require("node-cron");
const admin = require("firebase-admin");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const stripeKey = process.env.STRIPE_SECRET_KEY;

if (!stripeKey) {
  console.error("❌ STRIPE_SECRET_KEY is missing");
  process.exit(1);
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT_JSON is missing");
  process.exit(1);
}

/**
 * Payments here are destination charges: the PaymentIntent is created on the
 * platform account with `transfer_data.destination`, so `payment_intent.*`
 * events arrive on the **platform** ("Your account") — while `account.updated`,
 * which drives `payoutsEnabled`, arrives on **Connected accounts**.
 *
 * Stripe scopes an endpoint to one or the other, so that is two endpoints
 * pointing at this same URL, each with its own signing secret. Hence a list:
 *
 *   STRIPE_WEBHOOK_SECRET=whsec_platform...,whsec_connect...
 */
const webhookSecrets = (process.env.STRIPE_WEBHOOK_SECRET || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!webhookSecrets.length) {
  console.warn(
    "⚠️  STRIPE_WEBHOOK_SECRET is missing — /stripe-webhook will reject every request"
  );
} else {
  // Count only, never the values. Two are expected: one for the platform
  // ("Your account") endpoint and one for the Connect endpoint.
  console.log(`🔑 ${webhookSecrets.length} webhook signing secret(s) loaded`);

  if (webhookSecrets.length === 1) {
    console.warn(
      "⚠️  Only one secret configured. account.updated arrives on a separate " +
        "Connect endpoint, so payoutsEnabled will never be set without its secret too."
    );
  }
}

/**
 * Verifies against each configured secret and returns the event, so one URL can
 * serve both endpoints. Stripe's own comparison is timing-safe.
 */
function constructWebhookEvent(rawBody, signature) {
  let lastError;

  for (const secret of webhookSecrets) {
    try {
      return stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No webhook signing secret configured");
}

const stripe = Stripe(stripeKey);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    ),
  });
}

const db = admin.firestore();

// Platform commission taken from every booking.
const PLATFORM_FEE_RATE = 0.2;

// How long the tourist has to confirm or dispute after the guide marks a trip
// finished, before the money is released automatically.
const AUTO_RELEASE_HOURS = 24;

// A payment intent that never got paid is abandoned after this long.
const PENDING_PAYMENT_TTL_MINUTES = 30;

const MAX_HOURS = 12;
const MAX_PEOPLE = 20;

// How long a user is muted after three contact-sharing warnings.
const MUTE_MINUTES = 30;

/**
 * Public origin of this server, used for the Stripe Connect return pages.
 * Railway injects RAILWAY_PUBLIC_DOMAIN; PUBLIC_BASE_URL overrides it if the
 * service ever moves behind a custom domain.
 */
const publicBaseUrl = (
  process.env.PUBLIC_BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : "")
).replace(/\/$/, "");

if (!publicBaseUrl) {
  console.warn(
    "⚠️  Neither PUBLIC_BASE_URL nor RAILWAY_PUBLIC_DOMAIN is set — Stripe " +
      "Connect onboarding will have nowhere to return to."
  );
}

const NAME_PLACEHOLDER = "Traveller";

/**
 * A display name must never be an email address. Older code fell back to the
 * signed-in user's email whenever `fullName` was missing, so reviews and
 * bookings ended up publishing traveller addresses.
 */
function displayName(value, fallback = NAME_PLACEHOLDER) {
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();

  if (!trimmed) return fallback;
  if (trimmed.includes("@")) return fallback;
  if (trimmed.toLowerCase() === "tourist") return fallback;

  return trimmed;
}

// Statuses that mean "this booking is live, don't let the tourist book the
// same guide again".
const ACTIVE_BOOKING_STATUSES = [
  "confirmed",
  "waiting_tourist_confirmation",
  "dispute",
];

// Statuses that occupy a slot in the guide's calendar. `pending_payment` is
// included so a slot is held while the tourist is on the payment sheet — two
// people paying at once would otherwise both succeed.
const HELD_BOOKING_STATUSES = [...ACTIVE_BOOKING_STATUSES, "pending_payment"];

const app = express();

// The app is a native client, so no browser origin is ever needed. Set
// ALLOWED_ORIGINS (comma separated) only if you add a web dashboard later.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Native apps and server-to-server calls send no Origin header.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin not allowed"));
    },
  })
);

// ---------------------------------------------------------------------------
// Stripe webhook — must be registered before express.json() so the raw body
// stays intact for signature verification.
// ---------------------------------------------------------------------------

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!webhookSecrets.length) {
      return res.status(500).send("Webhook secret not configured");
    }

    let event;

    try {
      event = constructWebhookEvent(
        req.body,
        req.headers["stripe-signature"]
      );
    } catch (error) {
      console.error("❌ Webhook signature verification failed:", error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
      await handleStripeEvent(event);
    } catch (error) {
      // Return 500 so Stripe retries rather than dropping the event.
      console.error("❌ Webhook handler error:", error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({ received: true });
  }
);

app.use(express.json());

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(header.slice(7));

    req.uid = decoded.uid;
    req.isAdmin = decoded.admin === true;

    next();
  } catch (error) {
    console.error("❌ Token verification failed:", error.message);
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: "Admin privileges required" });
  }

  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sendPushNotification({ token, title, body, data = {} }) {
  if (!token) {
    console.log("⚠️ No FCM token");
    return;
  }

  return admin.messaging().send({
    token,
    notification: { title, body },
    data,
    apns: { payload: { aps: { sound: "default" } } },
  });
}

/**
 * Contact details (email, phone, fcmToken, stripeAccountId) live in a private
 * subdocument so browsing profiles never exposes them — see firestore.rules.
 */
function privateRef(collection, uid) {
  return db.collection(collection).doc(uid).collection("private").doc("secure");
}

async function getPrivateData(collection, uid) {
  const doc = await privateRef(collection, uid).get();

  return doc.exists ? doc.data() : {};
}

async function getUserToken(role, userId) {
  const collection = role === "guide" ? "guides" : "tourists";
  const data = await getPrivateData(collection, userId);

  return data.fcmToken || "";
}

/**
 * Booking prices come from the guide's own profile, never from the client.
 * `services` entries look like { id, title, price, type }.
 */
function calculateAmountUsd(guideData, { serviceId, hours }) {
  const services = Array.isArray(guideData.services) ? guideData.services : [];
  const service = services.find((s) => s && s.id === serviceId);

  if (service && Number(service.price) > 0) {
    const price = Number(service.price);

    return service.type === "hourly" ? price * hours : price;
  }

  const hourly = Number(guideData.priceFrom) > 0 ? Number(guideData.priceFrom) : 50;

  return hourly * hours;
}

/**
 * Releases any half-finished payment attempt for this tourist/guide pair so a
 * retry does not leave dangling authorizations behind.
 */
async function clearStalePendingBookings(touristId, guideId) {
  const snapshot = await db
    .collection("bookings")
    .where("touristId", "==", touristId)
    .where("guideId", "==", guideId)
    .where("status", "==", "pending_payment")
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data();

    if (data.paymentIntentId) {
      try {
        await stripe.paymentIntents.cancel(data.paymentIntentId);
      } catch (error) {
        // Already captured/canceled intents are fine to skip.
        console.warn("⚠️ Could not cancel stale intent:", error.message);
      }
    }

    await doc.ref.update({
      status: "expired",
      paymentStatus: "canceled",
      expiredAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

/**
 * Reads wall-clock parts of an instant in the guide's own time zone. Working
 * hours are local to where the guide actually is, so comparing raw UTC hours
 * would put a 9am Tashkent slot at 4am.
 */
function localParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value])
  );

  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    weekday: weekdays[parts.weekday],
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) + Number(parts.minute) / 60,
  };
}

/**
 * Throws if the requested window falls outside the guide's working hours, on a
 * date they blocked, or on top of a booking they already have.
 *
 * Guides without an `availability` block keep the old always-open behaviour so
 * existing profiles do not suddenly stop accepting bookings.
 */
async function assertGuideIsFree(guideId, guide, start, hours) {
  const end = new Date(start.getTime() + hours * 60 * 60 * 1000);
  const availability = guide.availability || null;
  const timeZone = guide.timeZone || null;

  if (availability && timeZone) {
    let local;

    try {
      local = localParts(start, timeZone);
    } catch {
      // An invalid IANA zone must not block bookings outright.
      local = null;
    }

    if (local) {
      const blockedDates = Array.isArray(guide.blockedDates) ? guide.blockedDates : [];

      if (blockedDates.includes(local.isoDate)) {
        throw new Error("The guide is not available on that date.");
      }

      const workingDays = Array.isArray(availability.workingDays)
        ? availability.workingDays
        : [0, 1, 2, 3, 4, 5, 6];

      if (!workingDays.includes(local.weekday)) {
        throw new Error("The guide does not work on that day.");
      }

      const startHour = Number(availability.startHour ?? 0);
      const endHour = Number(availability.endHour ?? 24);

      if (local.hour < startHour || local.hour + hours > endHour) {
        throw new Error(
          `The guide works between ${String(startHour).padStart(2, "0")}:00 and ${String(endHour).padStart(2, "0")}:00.`
        );
      }
    }
  }

  // Overlap check. Firestore cannot range-filter two fields at once, so the
  // query brackets by start time and the overlap itself is decided here.
  const windowStart = admin.firestore.Timestamp.fromMillis(
    start.getTime() - MAX_HOURS * 60 * 60 * 1000
  );

  const snapshot = await db
    .collection("bookings")
    .where("guideId", "==", guideId)
    .where("status", "in", HELD_BOOKING_STATUSES)
    .where("date", ">=", windowStart)
    .where("date", "<=", admin.firestore.Timestamp.fromDate(end))
    .get();

  for (const doc of snapshot.docs) {
    const booking = doc.data();

    if (!booking.date) continue;

    const otherStart = booking.date.toDate();
    const otherEnd = new Date(
      otherStart.getTime() + (Number(booking.hours) || 1) * 60 * 60 * 1000
    );

    if (otherStart < end && start < otherEnd) {
      throw new Error("That time slot is already booked. Please pick another.");
    }
  }
}

async function findBookingByPaymentIntent(paymentIntentId) {
  const snapshot = await db
    .collection("bookings")
    .where("paymentIntentId", "==", paymentIntentId)
    .limit(1)
    .get();

  return snapshot.empty ? null : snapshot.docs[0];
}

async function handleStripeEvent(event) {
  const intent = event.data.object;

  // A guide can only be booked once Stripe says their account can actually
  // receive money — this is the single source of truth for payoutsEnabled.
  if (event.type === "account.updated") {
    const guideId = intent.metadata && intent.metadata.guideId;

    if (guideId) {
      const enabled =
        intent.charges_enabled === true && intent.payouts_enabled === true;

      await db.collection("guides").doc(guideId).update({
        payoutsEnabled: enabled,
      });

      console.log(`✅ payoutsEnabled=${enabled} for guide`, guideId);
    }

    return;
  }

  switch (event.type) {
    // Manual capture: the card was authorized and the money is now held.
    case "payment_intent.amount_capturable_updated": {
      const doc = await findBookingByPaymentIntent(intent.id);
      if (!doc) break;

      await doc.ref.update({
        status: "confirmed",
        paymentStatus: "authorized",
        authorizedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const booking = doc.data();

      const token = await getUserToken("guide", booking.guideId);

      await sendPushNotification({
        token,
        title: "New booking request",
        body: `${displayName(booking.touristName, "A traveller")} booked your guide service`,
        data: { type: "booking", bookingId: doc.id },
      });

      console.log("✅ Booking confirmed by webhook:", doc.id);
      break;
    }

    // Funds captured.
    case "payment_intent.succeeded": {
      const doc = await findBookingByPaymentIntent(intent.id);
      if (!doc) break;

      await doc.ref.update({
        status: "completed",
        paymentStatus: "captured",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("✅ Booking captured by webhook:", doc.id);
      break;
    }

    case "payment_intent.canceled": {
      const doc = await findBookingByPaymentIntent(intent.id);
      if (!doc) break;

      const current = doc.data().status;

      await doc.ref.update({
        status: current === "pending_payment" ? "expired" : "cancelled",
        paymentStatus: "canceled",
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("✅ Booking canceled by webhook:", doc.id);
      break;
    }

    case "payment_intent.payment_failed": {
      const doc = await findBookingByPaymentIntent(intent.id);
      if (!doc) break;

      await doc.ref.update({ paymentStatus: "failed" });
      break;
    }

    default:
      console.log("ℹ️ Unhandled event type:", event.type);
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.send("BookLocal Stripe backend is running");
});

// ---------------------------------------------------------------------------
// Stripe Connect return pages
// ---------------------------------------------------------------------------

/**
 * Stripe requires `return_url` / `refresh_url` on an Account Link to be public
 * https URLs — a custom scheme like `booklocalguide://` is rejected outright.
 * These two pages are that https hop: they bounce the guide's browser straight
 * back into the app, with a tappable fallback if the automatic redirect is
 * blocked.
 */
function appRedirectPage(target, heading, message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BookLocal Guide</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0;
         min-height: 100vh; display: flex; align-items: center;
         justify-content: center; background: #f6f7f9; color: #111; }
  .card { text-align: center; padding: 32px 24px; max-width: 340px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #666; font-size: 15px; line-height: 1.45; margin: 0 0 24px; }
  a { display: inline-block; background: #0a84ff; color: #fff;
      text-decoration: none; font-weight: 600; padding: 14px 28px;
      border-radius: 14px; }
  @media (prefers-color-scheme: dark) {
    body { background: #000; color: #fff; }
    p { color: #98989d; }
  }
</style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>${message}</p>
    <a href="${target}">Open BookLocal Guide</a>
  </div>
  <script>window.location.replace(${JSON.stringify(target)});</script>
</body>
</html>`;
}

app.get("/stripe-return", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(
    appRedirectPage(
      "booklocalguide://stripe-return",
      "All set",
      "Returning you to the app. Your payout details are being verified — this usually takes a moment."
    )
  );
});

app.get("/stripe-refresh", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(
    appRedirectPage(
      "booklocalguide://stripe-refresh",
      "Link expired",
      "That setup link is no longer valid. Open the app and tap Connect payouts again."
    )
  );
});

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

app.post("/send-chat-notification", requireAuth, async (req, res) => {
  try {
    const { receiverRole, receiverId, senderName, messageText } = req.body;

    if (!receiverRole || !receiverId) {
      return res
        .status(400)
        .json({ error: "Missing receiverRole or receiverId" });
    }

    // Only the two participants of a chat may trigger its notifications.
    const chatId =
      receiverRole === "guide"
        ? `${req.uid}_${receiverId}`
        : `${receiverId}_${req.uid}`;

    const chat = await db.collection("chats").doc(chatId).get();

    if (!chat.exists) {
      return res.status(403).json({ error: "Not a participant of this chat" });
    }

    const token = await getUserToken(receiverRole, receiverId);

    await sendPushNotification({
      token,
      title: senderName || "New message",
      body: messageText || "You received a new message",
      data: { type: "chat", chatId },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("❌ send-chat-notification error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/send-support-notification", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { receiverRole, receiverId, title, body } = req.body;

    if (!receiverRole || !receiverId) {
      return res
        .status(400)
        .json({ error: "Missing receiverRole or receiverId" });
    }

    const token = await getUserToken(receiverRole, receiverId);

    await sendPushNotification({
      token,
      title: title || "Support message",
      body: body || "You received a support reply",
      data: { type: "support" },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("❌ send-support-notification error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Stripe Connect onboarding (guides)
// ---------------------------------------------------------------------------

app.post("/create-connect-account", requireAuth, async (req, res) => {
  try {
    // A guide may only create a Connect account for themselves.
    const guideDoc = await db.collection("guides").doc(req.uid).get();

    if (!guideDoc.exists) {
      return res.status(403).json({ error: "Only guides can connect payouts" });
    }

    const secure = await getPrivateData("guides", req.uid);

    if (secure.stripeAccountId) {
      const link = await stripe.accountLinks.create({
        account: secure.stripeAccountId,
        refresh_url: `${publicBaseUrl}/stripe-refresh`,
        return_url: `${publicBaseUrl}/stripe-return`,
        type: "account_onboarding",
      });

      return res.json({ onboardingUrl: link.url });
    }

    const account = await stripe.accounts.create({
      type: "express",
      email: secure.email || undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: { guideId: req.uid },
    });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${publicBaseUrl}/stripe-refresh`,
      return_url: `${publicBaseUrl}/stripe-return`,
      type: "account_onboarding",
    });

    // Neither field is client-writable (see firestore.rules): the account id is
    // private, and payoutsEnabled only flips on the account.updated webhook.
    await privateRef("guides", req.uid).set(
      { stripeAccountId: account.id },
      { merge: true }
    );

    await guideDoc.ref.update({ payoutsEnabled: false });

    res.json({ onboardingUrl: accountLink.url });
  } catch (error) {
    console.error("❌ create-connect-account error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Booking + payment
// ---------------------------------------------------------------------------

/**
 * Creates the booking document AND the payment intent in one server-side step.
 * The client never sends an amount and never creates booking documents, so the
 * price and the duplicate check cannot be bypassed.
 */
app.post("/create-booking-intent", requireAuth, async (req, res) => {
  try {
    const { guideId, serviceId, date, hours, peopleCount, notes } = req.body;

    if (!guideId) {
      return res.status(400).json({ error: "Missing guideId" });
    }

    const parsedHours = Number(hours);
    const parsedPeople = Number(peopleCount);
    const parsedDate = new Date(date);

    if (!Number.isInteger(parsedHours) || parsedHours < 1 || parsedHours > MAX_HOURS) {
      return res.status(400).json({ error: "Invalid hours" });
    }

    if (
      !Number.isInteger(parsedPeople) ||
      parsedPeople < 1 ||
      parsedPeople > MAX_PEOPLE
    ) {
      return res.status(400).json({ error: "Invalid number of people" });
    }

    if (Number.isNaN(parsedDate.getTime()) || parsedDate.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Booking date must be in the future" });
    }

    const touristDoc = await db.collection("tourists").doc(req.uid).get();

    if (!touristDoc.exists) {
      return res.status(403).json({ error: "Only tourists can book guides" });
    }

    const guideDoc = await db.collection("guides").doc(guideId).get();

    if (!guideDoc.exists) {
      return res.status(404).json({ error: "Guide not found" });
    }

    const guide = guideDoc.data();
    const guideSecure = await getPrivateData("guides", guideId);

    if (!guideSecure.stripeAccountId || guide.payoutsEnabled !== true) {
      return res
        .status(400)
        .json({ error: "Guide has not connected a payout account yet." });
    }

    // Blocking works both ways: neither side can book the other after a block.
    const blocked = await db
      .collection("blocks")
      .where("pair", "in", [`${req.uid}_${guideId}`, `${guideId}_${req.uid}`])
      .limit(1)
      .get();

    if (!blocked.empty) {
      return res.status(403).json({ error: "This booking is not available." });
    }

    // Duplicate check happens BEFORE any money moves.
    const duplicate = await db
      .collection("bookings")
      .where("touristId", "==", req.uid)
      .where("guideId", "==", guideId)
      .where("status", "in", ACTIVE_BOOKING_STATUSES)
      .limit(1)
      .get();

    if (!duplicate.empty) {
      return res
        .status(409)
        .json({ error: "You already have an active booking with this guide." });
    }

    await clearStalePendingBookings(req.uid, guideId);

    // Working hours, blocked dates and slot collisions — checked before any
    // Stripe object exists, so a clash never leaves an authorization behind.
    try {
      await assertGuideIsFree(guideId, guide, parsedDate, parsedHours);
    } catch (conflict) {
      return res.status(409).json({ error: conflict.message });
    }

    const amountUsd = calculateAmountUsd(guide, {
      serviceId,
      hours: parsedHours,
    });

    if (!Number.isFinite(amountUsd) || amountUsd < 1) {
      return res.status(400).json({ error: "Guide pricing is not configured" });
    }

    const amountInCents = Math.round(amountUsd * 100);
    const platformFee = Math.round(amountInCents * PLATFORM_FEE_RATE);

    const tourist = touristDoc.data();

    const bookingRef = db.collection("bookings").doc();

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "usd",
      capture_method: "manual",
      automatic_payment_methods: { enabled: true },
      application_fee_amount: platformFee,
      transfer_data: { destination: guideSecure.stripeAccountId },
      metadata: {
        bookingId: bookingRef.id,
        touristId: req.uid,
        guideId,
        platformFee: String(platformFee),
        guideShare: String(amountInCents - platformFee),
      },
    });

    await bookingRef.set({
      touristId: req.uid,
      touristName: displayName(tourist.fullName),
      profileImageUrl: tourist.profileImageUrl || "",
      guideId,
      guideName: guide.name || "Guide",
      guideImageUrl: guide.profileImageUrl || "",
      city: guide.city || "",
      country: guide.country || "",
      date: admin.firestore.Timestamp.fromDate(parsedDate),
      peopleCount: parsedPeople,
      hours: parsedHours,
      serviceId: serviceId || "",
      pricePerHour: Math.round(amountUsd / parsedHours),
      totalPrice: amountUsd,
      message: typeof notes === "string" ? notes.trim().slice(0, 1000) : "",
      status: "pending_payment",
      paymentStatus: "requires_payment",
      paymentIntentId: paymentIntent.id,
      isReviewed: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      bookingId: bookingRef.id,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: amountUsd,
    });
  } catch (error) {
    console.error("❌ create-booking-intent error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Slots the guide already has taken on a given day, plus their working hours,
 * so the booking screen can grey out impossible times instead of failing at
 * checkout.
 */
app.post("/guide-availability", requireAuth, async (req, res) => {
  try {
    const { guideId, date } = req.body;

    if (!guideId || !date) {
      return res.status(400).json({ error: "Missing guideId or date" });
    }

    const day = new Date(date);

    if (Number.isNaN(day.getTime())) {
      return res.status(400).json({ error: "Invalid date" });
    }

    const guideDoc = await db.collection("guides").doc(guideId).get();

    if (!guideDoc.exists) {
      return res.status(404).json({ error: "Guide not found" });
    }

    const guide = guideDoc.data();

    // Bracket generously: a booking starting the previous evening can still be
    // running into the requested day.
    const dayStart = new Date(day);
    dayStart.setUTCHours(0, 0, 0, 0);

    const from = admin.firestore.Timestamp.fromMillis(
      dayStart.getTime() - MAX_HOURS * 60 * 60 * 1000
    );
    const to = admin.firestore.Timestamp.fromMillis(
      dayStart.getTime() + 48 * 60 * 60 * 1000
    );

    const snapshot = await db
      .collection("bookings")
      .where("guideId", "==", guideId)
      .where("status", "in", HELD_BOOKING_STATUSES)
      .where("date", ">=", from)
      .where("date", "<=", to)
      .get();

    const busy = snapshot.docs
      .filter((doc) => doc.data().date)
      .map((doc) => {
        const booking = doc.data();
        const start = booking.date.toDate();

        return {
          start: start.toISOString(),
          end: new Date(
            start.getTime() + (Number(booking.hours) || 1) * 60 * 60 * 1000
          ).toISOString(),
        };
      });

    res.json({
      busy,
      availability: guide.availability || null,
      blockedDates: Array.isArray(guide.blockedDates) ? guide.blockedDates : [],
      timeZone: guide.timeZone || null,
    });
  } catch (error) {
    console.error("❌ guide-availability error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * The guide marks the trip finished; the tourist then has AUTO_RELEASE_HOURS to
 * confirm or dispute.
 */
app.post("/mark-trip-finished", requireAuth, async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ error: "Missing bookingId" });
    }

    const doc = await db.collection("bookings").doc(bookingId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const booking = doc.data();

    if (booking.guideId !== req.uid) {
      return res.status(403).json({ error: "Not your booking" });
    }

    if (booking.status !== "confirmed") {
      return res.status(409).json({ error: "Booking is not confirmed" });
    }

    await doc.ref.update({
      status: "waiting_tourist_confirmation",
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const token = await getUserToken("tourist", booking.touristId);

    await sendPushNotification({
      token,
      title: "Confirm your trip",
      body: `${booking.guideName || "Your guide"} marked the trip as finished.`,
      data: { type: "booking", bookingId },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("❌ mark-trip-finished error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/capture-payment", requireAuth, async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ error: "Missing bookingId" });
    }

    const doc = await db.collection("bookings").doc(bookingId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const booking = doc.data();

    // Only the tourist who paid may release the money.
    if (booking.touristId !== req.uid) {
      return res.status(403).json({ error: "Not your booking" });
    }

    if (booking.status === "dispute") {
      return res
        .status(409)
        .json({ error: "This booking is under dispute review" });
    }

    if (booking.paymentStatus === "captured") {
      return res.json({ success: true, status: "already_captured" });
    }

    if (!booking.paymentIntentId) {
      return res.status(409).json({ error: "Booking has no payment" });
    }

    const captured = await stripe.paymentIntents.capture(booking.paymentIntentId);

    // The webhook also writes this; doing it here keeps the UI instant.
    await doc.ref.update({
      status: "completed",
      paymentStatus: "captured",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, status: captured.status });
  } catch (error) {
    console.error("❌ capture-payment error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/cancel-payment", requireAuth, async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ error: "Missing bookingId" });
    }

    const doc = await db.collection("bookings").doc(bookingId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const booking = doc.data();

    const isTourist = booking.touristId === req.uid;
    const isGuide = booking.guideId === req.uid;

    if (!isTourist && !isGuide) {
      return res.status(403).json({ error: "Not your booking" });
    }

    if (!["pending_payment", "confirmed"].includes(booking.status)) {
      return res.status(409).json({ error: "This booking cannot be cancelled" });
    }

    // The 24 hour cancellation window is enforced here, not in the app.
    if (isTourist && booking.date) {
      const hoursLeft =
        (booking.date.toDate().getTime() - Date.now()) / (1000 * 60 * 60);

      if (hoursLeft < 24) {
        return res.status(409).json({
          error:
            "Bookings can only be cancelled at least 24 hours before the trip.",
        });
      }
    }

    if (booking.paymentIntentId) {
      await stripe.paymentIntents.cancel(booking.paymentIntentId);
    }

    await doc.ref.update({
      status: "cancelled",
      paymentStatus: "canceled",
      cancelledBy: isTourist ? "tourist" : "guide",
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (error) {
    console.error("❌ cancel-payment error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/report-problem", requireAuth, async (req, res) => {
  try {
    const { bookingId, reason } = req.body;

    if (!bookingId || !reason) {
      return res.status(400).json({ error: "Missing bookingId or reason" });
    }

    const doc = await db.collection("bookings").doc(bookingId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const booking = doc.data();

    if (booking.touristId !== req.uid) {
      return res.status(403).json({ error: "Not your booking" });
    }

    if (booking.paymentStatus === "captured") {
      return res
        .status(409)
        .json({ error: "This booking has already been paid out" });
    }

    await doc.ref.update({
      status: "dispute",
      disputeReason: String(reason).trim().slice(0, 2000),
      disputedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (error) {
    console.error("❌ report-problem error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Reviews are written here so the rating average stays consistent (a client
 * read-modify-write race could corrupt it) and so only a tourist who actually
 * completed the booking can leave one.
 */
app.post("/submit-review", requireAuth, async (req, res) => {
  try {
    const { bookingId, rating, comment } = req.body;

    const parsedRating = Number(rating);

    if (!bookingId || !Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      return res.status(400).json({ error: "Invalid bookingId or rating" });
    }

    const bookingDoc = await db.collection("bookings").doc(bookingId).get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const booking = bookingDoc.data();

    if (booking.touristId !== req.uid) {
      return res.status(403).json({ error: "Not your booking" });
    }

    if (booking.status !== "completed") {
      return res
        .status(409)
        .json({ error: "You can only review a completed booking" });
    }

    if (booking.isReviewed === true) {
      return res.status(409).json({ error: "This booking is already reviewed" });
    }

    const tourist = (
      await db.collection("tourists").doc(req.uid).get()
    ).data() || {};

    const guideRef = db.collection("guides").doc(booking.guideId);
    const reviewRef = db.collection("reviews").doc();

    // A transaction keeps the running average correct under concurrent reviews.
    await db.runTransaction(async (tx) => {
      const guideSnap = await tx.get(guideRef);

      if (!guideSnap.exists) throw new Error("Guide not found");

      const guide = guideSnap.data();
      const oldCount = Number(guide.reviewsCount) || 0;
      const oldRating = Number(guide.rating) || 0;
      const newCount = oldCount + 1;
      const newRating = (oldRating * oldCount + parsedRating) / newCount;

      tx.set(reviewRef, {
        bookingId,
        guideId: booking.guideId,
        touristId: req.uid,
        touristName: displayName(tourist.fullName),
        touristImageUrl: tourist.profileImageUrl || "",
        rating: parsedRating,
        comment:
          typeof comment === "string" ? comment.trim().slice(0, 2000) : "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.update(guideRef, {
        rating: Math.round(newRating * 100) / 100,
        reviewsCount: newCount,
      });

      tx.update(bookingDoc.ref, { isReviewed: true });
    });

    res.json({ success: true });
  } catch (error) {
    console.error("❌ submit-review error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Records a contact-sharing warning. Written server-side so a user cannot
 * clear their own mute by writing to Firestore directly.
 */
app.post("/record-violation", requireAuth, async (req, res) => {
  try {
    const ref = db.collection("chat_violations").doc(req.uid);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = (snap.exists ? Number(snap.data().warningCount) : 0) || 0;
      const newCount = count + 1;

      const payload = {
        warningCount: newCount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (newCount >= 3) {
        payload.warningCount = 0;
        payload.mutedUntil = admin.firestore.Timestamp.fromMillis(
          Date.now() + MUTE_MINUTES * 60 * 1000
        );
      }

      tx.set(ref, payload, { merge: true });

      return { warningCount: newCount, muted: newCount >= 3 };
    });

    res.json({
      success: true,
      muted: result.muted,
      warningCount: result.warningCount,
      muteMinutes: MUTE_MINUTES,
    });
  } catch (error) {
    console.error("❌ record-violation error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

app.post("/resolve-dispute", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { bookingId, action } = req.body;

    if (!bookingId || !["release", "refund"].includes(action)) {
      return res.status(400).json({ error: "Missing bookingId or invalid action" });
    }

    const doc = await db.collection("bookings").doc(bookingId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const booking = doc.data();

    if (!booking.paymentIntentId) {
      return res.status(409).json({ error: "Booking has no payment" });
    }

    const intent = await stripe.paymentIntents.retrieve(booking.paymentIntentId);

    if (action === "release") {
      if (intent.status === "requires_capture") {
        await stripe.paymentIntents.capture(booking.paymentIntentId);
      }

      await doc.ref.update({
        status: "completed",
        paymentStatus: "captured",
        resolvedBy: req.uid,
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.json({ success: true, status: "released" });
    }

    // Refund: an authorized-but-uncaptured intent is cancelled, a captured one
    // has to go through the refund API — cancel() fails on captured intents.
    if (intent.status === "requires_capture") {
      await stripe.paymentIntents.cancel(booking.paymentIntentId);
    } else if (intent.status === "succeeded") {
      await stripe.refunds.create({
        payment_intent: booking.paymentIntentId,
        refund_application_fee: true,
        reverse_transfer: true,
      });
    } else {
      return res
        .status(409)
        .json({ error: `Cannot refund an intent in state ${intent.status}` });
    }

    await doc.ref.update({
      status: "refunded",
      paymentStatus: "refunded",
      resolvedBy: req.uid,
      resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, status: "refunded" });
  } catch (error) {
    console.error("❌ resolve-dispute error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Deletes every trace of a user. Called by the in-app "Delete Account" flow,
 * which App Store guideline 5.1.1(v) requires.
 */
app.post("/delete-account", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;

    const openBookings = await db
      .collection("bookings")
      .where("touristId", "==", uid)
      .where("status", "in", ACTIVE_BOOKING_STATUSES)
      .limit(1)
      .get();

    const openGuideBookings = await db
      .collection("bookings")
      .where("guideId", "==", uid)
      .where("status", "in", ACTIVE_BOOKING_STATUSES)
      .limit(1)
      .get();

    if (!openBookings.empty || !openGuideBookings.empty) {
      return res.status(409).json({
        error:
          "You still have an active booking. Please complete or cancel it before deleting your account.",
      });
    }

    // recursiveDelete handles the messages subcollection and stays under the
    // 500-writes-per-batch limit on its own.
    const [touristChats, guideChats] = await Promise.all([
      db.collection("chats").where("touristId", "==", uid).get(),
      db.collection("chats").where("guideId", "==", uid).get(),
    ]);

    for (const chat of [...touristChats.docs, ...guideChats.docs]) {
      await db.recursiveDelete(chat.ref);
    }

    await Promise.all([
      db.recursiveDelete(db.collection("tourists").doc(uid)),
      db.recursiveDelete(db.collection("guides").doc(uid)),
      db.collection("chat_violations").doc(uid).delete(),
    ]);

    await admin.auth().deleteUser(uid);

    console.log("🗑 Account deleted:", uid);

    res.json({ success: true });
  } catch (error) {
    console.error("❌ delete-account error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

// Release money that the tourist neither confirmed nor disputed in time. The
// clock starts when the guide marked the trip finished, not when the booking
// was created.
cron.schedule("*/10 * * * *", async () => {
  try {
    const cutoff = admin.firestore.Timestamp.fromMillis(
      Date.now() - AUTO_RELEASE_HOURS * 60 * 60 * 1000
    );

    const snapshot = await db
      .collection("bookings")
      .where("status", "==", "waiting_tourist_confirmation")
      .where("paymentStatus", "==", "authorized")
      .where("finishedAt", "<=", cutoff)
      .get();

    for (const doc of snapshot.docs) {
      const data = doc.data();

      if (!data.paymentIntentId) continue;

      try {
        await stripe.paymentIntents.capture(data.paymentIntentId);

        await doc.ref.update({
          status: "completed",
          paymentStatus: "captured",
          autoReleased: true,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log("💰 Auto captured:", doc.id);
      } catch (err) {
        console.error("❌ Auto capture error:", doc.id, err.message);
      }
    }
  } catch (err) {
    console.error("❌ Auto-release cron error:", err.message);
  }
});

// Drop payment intents the tourist abandoned at the payment sheet.
cron.schedule("*/15 * * * *", async () => {
  try {
    const cutoff = admin.firestore.Timestamp.fromMillis(
      Date.now() - PENDING_PAYMENT_TTL_MINUTES * 60 * 1000
    );

    const snapshot = await db
      .collection("bookings")
      .where("status", "==", "pending_payment")
      .where("createdAt", "<=", cutoff)
      .get();

    for (const doc of snapshot.docs) {
      const data = doc.data();

      if (data.paymentIntentId) {
        try {
          await stripe.paymentIntents.cancel(data.paymentIntentId);
        } catch (err) {
          console.warn("⚠️ Stale intent cancel skipped:", err.message);
        }
      }

      await doc.ref.update({
        status: "expired",
        paymentStatus: "canceled",
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    console.error("❌ Pending cleanup cron error:", err.message);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BookLocal backend running on port ${PORT}`);
});
