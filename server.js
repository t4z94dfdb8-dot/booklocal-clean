require("dotenv").config();

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT_JSON is missing");
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    ),
  });
}

const db = admin.firestore();

const MAX_HOURS = 12;
const MAX_PEOPLE = 20;

// How long a user is muted after three contact-sharing warnings.
const MUTE_MINUTES = 30;

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

// No money moves through the platform. A booking is a request the guide
// accepts or declines; the traveller pays the guide directly on the day.
const ACTIVE_BOOKING_STATUSES = ["pending", "confirmed"];

// Statuses that occupy a slot in the guide's calendar. A pending request holds
// the slot so two travellers cannot be promised the same hours.
const HELD_BOOKING_STATUSES = ACTIVE_BOOKING_STATUSES;

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
 * Contact details (email, phone, fcmToken) live in a private subdocument so
 * browsing profiles never exposes them — see firestore.rules.
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

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.send("BookLocal Guide backend is running");
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
// Booking + payment
// ---------------------------------------------------------------------------

/**
 * Creates the booking document AND the payment intent in one server-side step.
 * The client never sends an amount and never creates booking documents, so the
 * price and the duplicate check cannot be bypassed.
 */
app.post("/create-booking", requireAuth, async (req, res) => {
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

    // Blocking works both ways: neither side can book the other after a block.
    const blocked = await db
      .collection("blocks")
      .where("pair", "in", [`${req.uid}_${guideId}`, `${guideId}_${req.uid}`])
      .limit(1)
      .get();

    if (!blocked.empty) {
      return res.status(403).json({ error: "This booking is not available." });
    }

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

    // Working hours, blocked dates and slot collisions.
    try {
      await assertGuideIsFree(guideId, guide, parsedDate, parsedHours);
    } catch (conflict) {
      return res.status(409).json({ error: conflict.message });
    }

    // The price is still read from the guide's own profile so the traveller
    // sees a real figure — but no money moves through the platform. They pay
    // the guide directly on the day.
    const amountUsd = calculateAmountUsd(guide, {
      serviceId,
      hours: parsedHours,
    });

    const tourist = touristDoc.data();
    const bookingRef = db.collection("bookings").doc();

    await bookingRef.set({
      touristId: req.uid,
      touristName: displayName(tourist.fullName),
      profileImageUrl: tourist.profileImageUrl || "",
      guideId,
      guideName: displayName(guide.name, "Guide"),
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
      status: "pending",
      isReviewed: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const token = await getUserToken("guide", guideId);

    await sendPushNotification({
      token,
      title: "New booking request",
      body: `${displayName(tourist.fullName, "A traveller")} wants to book you`,
      data: { type: "booking", bookingId: bookingRef.id },
    });

    res.json({ bookingId: bookingRef.id, amount: amountUsd });
  } catch (error) {
    console.error("❌ create-booking error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * The guide accepts or declines a request. Only they can, and only while it is
 * still pending.
 */
app.post("/respond-booking", requireAuth, async (req, res) => {
  try {
    const { bookingId, accept } = req.body;

    if (!bookingId || typeof accept !== "boolean") {
      return res.status(400).json({ error: "Missing bookingId or accept" });
    }

    const doc = await db.collection("bookings").doc(bookingId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const booking = doc.data();

    if (booking.guideId !== req.uid) {
      return res.status(403).json({ error: "Not your booking" });
    }

    if (booking.status !== "pending") {
      return res.status(409).json({ error: "This request was already answered" });
    }

    await doc.ref.update({
      status: accept ? "confirmed" : "declined",
      respondedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const token = await getUserToken("tourist", booking.touristId);

    await sendPushNotification({
      token,
      title: accept ? "Booking confirmed" : "Booking declined",
      body: accept
        ? `${displayName(booking.guideName, "Your guide")} accepted your request`
        : `${displayName(booking.guideName, "The guide")} can't make that time`,
      data: { type: "booking", bookingId },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("❌ respond-booking error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Either side can call off a booking that has not happened yet.
 */
app.post("/cancel-booking", requireAuth, async (req, res) => {
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

    if (!ACTIVE_BOOKING_STATUSES.includes(booking.status)) {
      return res.status(409).json({ error: "This booking cannot be cancelled" });
    }

    await doc.ref.update({
      status: "cancelled",
      cancelledBy: isTourist ? "tourist" : "guide",
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const token = await getUserToken(
      isTourist ? "guide" : "tourist",
      isTourist ? booking.guideId : booking.touristId
    );

    await sendPushNotification({
      token,
      title: "Booking cancelled",
      body: "A booking on your calendar was cancelled.",
      data: { type: "booking", bookingId },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("❌ cancel-booking error:", error.message);
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
 * The guide marks the trip done. With no money held there is nothing to
 * release — this just closes the booking and unlocks the review.
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
      status: "completed",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const token = await getUserToken("tourist", booking.touristId);

    await sendPushNotification({
      token,
      title: "How was your trip?",
      body: `${displayName(booking.guideName, "Your guide")} marked the trip complete. Leave a review.`,
      data: { type: "booking", bookingId },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("❌ mark-trip-finished error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

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

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BookLocal backend running on port ${PORT}`);
});
