
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const cron = require("node-cron");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());

const stripeKey = process.env.STRIPE_SECRET_KEY;

if (!stripeKey) {
  console.error("❌ STRIPE_SECRET_KEY is missing");
  process.exit(1);
}

const stripe = Stripe(stripeKey);

// Firebase init
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

const db = admin.firestore();

app.get("/", (req, res) => {
  res.send("BookLocal Stripe backend is running");
});

app.post("/create-connect-account", async (req, res) => {
  try {
    const { guideId, email } = req.body;

    if (!guideId || !email) {
      return res.status(400).json({ error: "Missing guideId or email" });
    }

    const account = await stripe.accounts.create({
      type: "express",
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: { guideId },
    });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: "https://booklocalguide.com/stripe-refresh",
      return_url: "https://booklocalguide.com/stripe-return",
      type: "account_onboarding",
    });

    res.json({
      stripeAccountId: account.id,
      onboardingUrl: accountLink.url,
    });
  } catch (error) {
    console.error("❌ create-connect-account error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, bookingId, guideStripeAccountId } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    if (!guideStripeAccountId) {
      return res.status(400).json({ error: "Missing guide Stripe account ID" });
    }

    const amountInCents = Math.round(Number(amount) * 100);
    const platformFee = Math.round(amountInCents * 0.2);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "usd",
      capture_method: "manual",
      automatic_payment_methods: {
        enabled: true,
      },
      application_fee_amount: platformFee,
      transfer_data: {
        destination: guideStripeAccountId,
      },
      metadata: {
        bookingId: bookingId || "",
        guideStripeAccountId,
        platformFee: String(platformFee),
        guideShare: String(amountInCents - platformFee),
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("❌ create-payment-intent error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/capture-payment", async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "Missing paymentIntentId" });
    }

    const captured = await stripe.paymentIntents.capture(paymentIntentId);

    res.json({
      success: true,
      status: captured.status,
      paymentIntentId: captured.id,
    });
  } catch (error) {
    console.error("❌ capture-payment error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/cancel-payment", async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "Missing paymentIntentId" });
    }

    const canceled = await stripe.paymentIntents.cancel(paymentIntentId);

    res.json({
      success: true,
      status: canceled.status,
      paymentIntentId: canceled.id,
    });
  } catch (error) {
    console.error("❌ cancel-payment error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/resolve-dispute", async (req, res) => {
  try {
    const { paymentIntentId, action } = req.body;

    if (!paymentIntentId || !action) {
      return res.status(400).json({ error: "Missing fields" });
    }

    if (action === "release") {
      const captured = await stripe.paymentIntents.capture(paymentIntentId);

      return res.json({
        success: true,
        status: "released",
        paymentIntentId: captured.id,
      });
    }

    if (action === "refund") {
      const canceled = await stripe.paymentIntents.cancel(paymentIntentId);

      return res.json({
        success: true,
        status: "canceled",
        paymentIntentId: canceled.id,
      });
    }

    res.status(400).json({ error: "Invalid action" });
  } catch (error) {
    console.error("❌ resolve dispute error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Auto release every 10 minutes
cron.schedule("*/10 * * * *", async () => {
  console.log("⏱ Checking auto-release payments...");

  try {
    const snapshot = await db
      .collection("bookings")
      .where("status", "==", "waiting_tourist_confirmation")
      .where("paymentStatus", "==", "authorized")
      .get();

    const now = Date.now();

    for (const doc of snapshot.docs) {
      const data = doc.data();

      if (!data.paymentIntentId || !data.createdAt) continue;

      const createdAt = data.createdAt.toDate().getTime();
      const hoursPassed = (now - createdAt) / (1000 * 60 * 60);

      if (hoursPassed >= 24) {
        console.log("💰 Auto capturing:", doc.id);

        try {
          await stripe.paymentIntents.capture(data.paymentIntentId);

          await db.collection("bookings").doc(doc.id).update({
            status: "completed",
            paymentStatus: "captured",
            autoReleased: true,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          console.log("✅ Captured:", doc.id);
        } catch (err) {
          console.error("❌ Capture error:", err.message);
        }
      }
    }
  } catch (err) {
    console.error("❌ Cron error:", err.message);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BookLocal backend running on port ${PORT}`);
});