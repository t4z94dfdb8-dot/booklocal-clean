/**
 * Firebase Admin bootstrap for the one-off CLI scripts.
 *
 * On Railway the credentials arrive as `FIREBASE_SERVICE_ACCOUNT_JSON`, a
 * single-line JSON blob. Pasting that into a local `.env` is miserable, so a
 * downloaded key file works too:
 *
 *   node <script>.js --key ~/Downloads/booklocalguide-firebase-adminsdk.json
 *   GOOGLE_APPLICATION_CREDENTIALS=~/path/key.json node <script>.js
 *
 * Get a key file from: Firebase Console -> Project settings -> Service
 * accounts -> Generate new private key.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function resolveCredential() {
  // 1. --key <path>
  const keyFlagIndex = process.argv.indexOf("--key");

  if (keyFlagIndex !== -1) {
    const keyPath = process.argv[keyFlagIndex + 1];

    if (!keyPath) {
      throw new Error("--key needs a path to the service account JSON file");
    }

    return readKeyFile(keyPath);
  }

  // 2. GOOGLE_APPLICATION_CREDENTIALS=<path>
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return readKeyFile(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }

  // 3. FIREBASE_SERVICE_ACCOUNT_JSON=<inline json>  (how Railway does it)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON"
      );
    }
  }

  throw new Error(
    [
      "No Firebase credentials found. Pick one:",
      "",
      "  1. Download a key:  Firebase Console -> Project settings ->",
      "     Service accounts -> Generate new private key",
      "     then run:  node <script>.js --key /path/to/key.json",
      "",
      "  2. Or copy FIREBASE_SERVICE_ACCOUNT_JSON out of the Railway",
      "     service variables into this folder's .env (single line).",
      "",
      "Keep the key file out of the repo — it grants full database access.",
    ].join("\n")
  );
}

function readKeyFile(keyPath) {
  const expanded = keyPath.startsWith("~")
    ? path.join(process.env.HOME || "", keyPath.slice(1))
    : keyPath;

  if (!fs.existsSync(expanded)) {
    throw new Error(`Service account file not found: ${expanded}`);
  }

  return JSON.parse(fs.readFileSync(expanded, "utf8"));
}

function initAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(resolveCredential()),
    });
  }

  return admin;
}

module.exports = { initAdmin };
