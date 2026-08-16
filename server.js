const express = require("express");
const bodyParser = require("body-parser");
const { config, assertRequiredConfig } = require("./config");
const { normalizeIncomingMessage } = require("./normalize");
const { handleIncomingMessage, initSheets } = require("./messageHandler");

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: false }));

app.get("/", (req, res) => res.send("Munshi multimodal agent is running."));

app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN && VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const normalized = normalizeIncomingMessage(req.body);
    if (normalized.type === "unknown" && !normalized.from) return;
    await handleIncomingMessage(normalized);
  } catch (err) {
    console.error("Unhandled webhook error:", err);
  }
});

async function start() {
  assertRequiredConfig();
  await initSheets();
  app.listen(config.port, () => console.log(`Munshi agent listening on port ${config.port}`));
}

start();
