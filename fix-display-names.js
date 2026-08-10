/**
 * One-off repair for profiles, bookings and reviews whose display name is an
 * email address (or the literal "Tourist").
 *
 * Older code fell back to `Auth.currentUser.email` whenever `fullName` was
 * missing, so those addresses were copied into `bookings.touristName` and from
 * there into `reviews.touristName`, where every visitor to a guide's profile
 * could read them.
 *
 *   node fix-display-names.js --key ~/key.json          # report only
 *   node fix-display-names.js --key ~/key.json --apply  # write the fixes
 *
 * See admin-init.js for how to obtain the key file.
 *
 * Profiles are left without a `fullName` rather than being given a fake one:
 * the app then asks the traveller for their name on next sign-in.
 */

const { initAdmin } = require("./admin-init");

const admin = initAdmin();
const db = admin.firestore();

const PLACEHOLDER = "Traveller";
const apply = process.argv.includes("--apply");

function looksLikeEmail(value) {
  return typeof value === "string" && value.includes("@");
}

function isBadName(value) {
  if (typeof value !== "string") return false;

  const trimmed = value.trim();

  return looksLikeEmail(trimmed) || trimmed.toLowerCase() === "tourist";
}

async function fixTourists() {
  const snapshot = await db.collection("tourists").get();
  let fixed = 0;

  for (const doc of snapshot.docs) {
    const name = doc.data().fullName;

    if (!isBadName(name)) continue;

    fixed++;
    console.log(`  tourists/${doc.id}: "${name}" -> (cleared, will be asked)`);

    if (apply) {
      const update = { fullName: admin.firestore.FieldValue.delete() };

      // Preserve the address where it belongs instead of losing it.
      if (looksLikeEmail(name)) {
        await db
          .collection("tourists")
          .doc(doc.id)
          .collection("private")
          .doc("secure")
          .set({ email: name.trim() }, { merge: true });
      }

      await doc.ref.update(update);
    }
  }

  return fixed;
}

async function fixCollection(collection, field) {
  const snapshot = await db.collection(collection).get();
  let fixed = 0;

  for (const doc of snapshot.docs) {
    const value = doc.data()[field];

    if (!isBadName(value)) continue;

    // Prefer the traveller's current real name if they have one by now.
    const touristId = doc.data().touristId;
    let replacement = PLACEHOLDER;

    if (touristId) {
      const tourist = await db.collection("tourists").doc(touristId).get();
      const current = tourist.exists ? tourist.data().fullName : null;

      if (current && !isBadName(current)) replacement = current.trim();
    }

    fixed++;
    console.log(`  ${collection}/${doc.id}: "${value}" -> "${replacement}"`);

    if (apply) {
      await doc.ref.update({ [field]: replacement });
    }
  }

  return fixed;
}

async function main() {
  console.log(apply ? "APPLYING changes\n" : "DRY RUN — nothing will be written\n");

  console.log("tourists.fullName");
  const tourists = await fixTourists();

  console.log("\nbookings.touristName");
  const bookings = await fixCollection("bookings", "touristName");

  console.log("\nreviews.touristName");
  const reviews = await fixCollection("reviews", "touristName");

  console.log(
    `\n${tourists} profiles, ${bookings} bookings, ${reviews} reviews affected.`
  );

  if (!apply) {
    console.log("\nRe-run with --apply to write these changes.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌", error.message);
    process.exit(1);
  });
