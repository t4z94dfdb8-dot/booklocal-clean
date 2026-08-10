/**
 * Grants (or revokes) the admin custom claim used by /resolve-dispute.
 *
 *   node set-admin.js <email> --key ~/key.json            -> grant
 *   node set-admin.js <email> --key ~/key.json --revoke   -> revoke
 *
 * See admin-init.js for how to obtain the key file.
 *
 * The user must sign out and back in for the new claim to appear in their
 * ID token.
 */

const { initAdmin } = require("./admin-init");

const admin = initAdmin();

async function main() {
  const email = process.argv[2];
  const revoke = process.argv.includes("--revoke");

  if (!email) {
    console.error("Usage: node set-admin.js <email> [--revoke]");
    process.exit(1);
  }

  const user = await admin.auth().getUserByEmail(email);

  await admin.auth().setCustomUserClaims(user.uid, { admin: !revoke });

  console.log(
    `${revoke ? "🔓 Revoked" : "🔐 Granted"} admin for ${email} (${user.uid})`
  );
  console.log("The user must sign out and sign in again.");
}

main().catch((error) => {
  console.error("❌", error.message);
  process.exit(1);
});
