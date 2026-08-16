require('dotenv').config();

/**
 * Central configuration module.
 * Reads and validates all environment variables used across the app.
 */

function parseList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseServiceAccountCredentials(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_CREDENTIALS is not valid JSON. ' +
        'Make sure the entire service account key file content is pasted as a single-line JSON string. ' +
        `Original error: ${err.message}`
    );
  }
}

const config = {
  port: process.env.PORT || 3000,
  timezone: 'Asia/Kolkata',

  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: 'gemini-1.5-flash',
  },

  sheets: {
    sheetId: process.env.GOOGLE_SHEET_ID,
    credentials: parseServiceAccountCredentials(
      process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS
    ),
    tabs: {
      SALES: 'Sales',
      EXPENSES: 'Expenses',
      DAILY_CLOSING: 'Daily_Closing',
    },
  },

  gateway: {
    type: (process.env.WHATSAPP_GATEWAY_TYPE || 'evolution').toLowerCase(), // evolution | wasender | meta
    baseUrl: process.env.WHATSAPP_GATEWAY_BASE_URL,
    apiKey: process.env.WHATSAPP_GATEWAY_KEY,
    evolutionInstanceName: process.env.EVOLUTION_INSTANCE_NAME || 'munshi',
    metaVerifyToken: process.env.META_VERIFY_TOKEN || 'munshi_verify_token',
  },

  access: {
    managerNumbers: parseList(process.env.MANAGER_NUMBERS),
    allowedNumbers: parseList(process.env.ALLOWED_NUMBERS),
  },
};

function validateConfig() {
  const problems = [];

  if (!config.gemini.apiKey) problems.push('GEMINI_API_KEY is missing');
  if (!config.sheets.sheetId) problems.push('GOOGLE_SHEET_ID is missing');
  if (!config.sheets.credentials)
    problems.push('GOOGLE_SERVICE_ACCOUNT_CREDENTIALS is missing or invalid');
  if (!config.gateway.baseUrl)
    problems.push('WHATSAPP_GATEWAY_BASE_URL is missing');
  if (!config.gateway.apiKey)
    problems.push('WHATSAPP_GATEWAY_KEY is missing');

  if (problems.length) {
    console.warn(
      '⚠️  Configuration warnings (server will start, but some features may fail):\n' +
        problems.map((p) => `   - ${p}`).join('\n')
    );
  }
}

validateConfig();


module.exports = { config, assertRequiredConfig };
