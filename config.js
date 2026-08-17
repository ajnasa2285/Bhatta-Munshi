require("dotenv").config();

function parseCreds() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS;
  if (!raw) return null;

  try {
    const trimmed = raw.trim();
    // Check if it is a raw JSON string
    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed);
    }
    // Otherwise decode base64
    const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch (err) {
    console.error("Failed to parse GOOGLE_SERVICE_ACCOUNT_CREDENTIALS:", err.message);
    return null;
  }
}

const geminiKey = process.env.GEMINI_API_KEY || "";

const config = {
  port: process.env.PORT || 3000,
  geminiApiKey: geminiKey,
  gemini: {
    apiKey: geminiKey,
  },
  googleSheetId: process.env.GOOGLE_SHEET_ID,
  googleCredentials: parseCreds(),
  gateway: {
    key: process.env.WHATSAPP_GATEWAY_KEY || "dummy",
    baseUrl: process.env.WHATSAPP_GATEWAY_BASE_URL || "http://localhost",
    type: (process.env.WHATSAPP_GATEWAY_TYPE || "evolution").toLowerCase(),
  },
  managerNumbers: (process.env.MANAGER_NUMBERS || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean),
  allowedNumbers: (process.env.ALLOWED_NUMBERS || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean),
};

function assertRequiredConfig() {
  const missing = [];
  if (!config.geminiApiKey) missing.push("GEMINI_API_KEY");
  if (!config.googleSheetId) missing.push("GOOGLE_SHEET_ID");
  if (!config.googleCredentials) missing.push("GOOGLE_SERVICE_ACCOUNT_CREDENTIALS");

  if (missing.length > 0) {
    console.warn(`⚠️ Warning: Missing required variables: ${missing.join(", ")}`);
  }
}

module.exports = { config, assertRequiredConfig };
