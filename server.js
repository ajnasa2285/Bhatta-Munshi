const express = require('express');
const bodyParser = require('body-parser');
const config = require('./config');
const { normalizeIncomingMessage } = require("./src/webhook/normalize");
const { handleIncomingMessage, initSheets } = require("./src/handlers/messageHandler");
const { initializeSheet } = require('./services/sheets');

const app = express();

app.use(bodyParser.json({ limit: '25mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '25mb' }));

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'WhatsApp Munshi Agent',
    gateway: config.gateway.type,
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Meta WhatsApp Cloud API webhook verification (GET request with challenge)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.gateway.metaVerifyToken) {
    console.log('✅ Meta webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Main webhook endpoint — receives events from Evolution API, Wasender, or Meta.
app.post('/webhook', async (req, res) => {
  // Always ack immediately so the gateway doesn't retry/timeout; process async.
  res.status(200).json({ received: true });

  try {
    const normalized = normalizeWebhookPayload(req.body);
    if (!normalized) {
      // Not a message we care about (status update, own message, etc.)
      return;
    }
    if (normalized.messageType === 'unsupported') {
      console.log(`ℹ️ Unsupported message type from ${normalized.from}, ignoring.`);
      return;
    }

    console.log(
      `📩 Incoming ${normalized.messageType} message from ${normalized.from} via ${normalized.gatewayType}`
    );

    await handleIncomingMessage(normalized);
  } catch (err) {
    console.error('❌ Error processing webhook:', err);
  }
});

async function start() {
  try {
    await initializeSheet();
    console.log('✅ Google Sheet initialized (Sales, Expenses, Daily_Closing tabs ready)');
  } catch (err) {
    console.error(
      '⚠️  Could not initialize Google Sheet at startup. Check GOOGLE_SHEET_ID and service account access.',
      err.message
    );
  }

  app.listen(config.port, () => {
    console.log(`🚀 Munshi Agent listening on port ${config.port}`);
    console.log(`   Gateway: ${config.gateway.type}`);
    console.log(`   Webhook URL: POST /webhook`);
  });
}

start();

module.exports = app;
