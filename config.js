require("dotenv").config();

function parseCreds() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS) return null;
  try {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
  } catch (err) {
    console.error("GOOGLE_SERVICE_ACCOUNT_CREDENTIALS is not valid JSON:", err.message);
    return null;
  }
}

const config = {
  port: process.env.PORT || 3000,
  geminiApiKey: process.env.GEMINI_API_KEY,
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
