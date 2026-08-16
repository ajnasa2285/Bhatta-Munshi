# WhatsApp Munshi Agent 🧱

A free, production-ready WhatsApp bookkeeping assistant for an Indian brick kiln (ईंट भट्ठा).
The munshi (site accountant) sends a **voice note**, **text message**, or a **photo of the
handwritten ledger** on WhatsApp — the agent transcribes it, classifies it, extracts structured
data with **Google Gemini (free tier)**, writes it into a **Google Sheet**, and replies with a
Hindi confirmation.

## Features

- 🎙️ Voice note transcription (Hindi/English/Hinglish) — Gemini 1.5 Flash
- 📸 Handwritten ledger photo OCR — Gemini 1.5 Flash
- 🧠 Multi-intent extraction: **SALE**, **EXPENSE**, **DAILY_CLOSING**, **CORRECTION**
- 📊 Auto-initializing Google Sheet with `Sales`, `Expenses`, `Daily_Closing` tabs
- 💬 Natural Hindi (Devanagari) confirmation replies
- 🔌 Works with **Evolution API**, **Wasender**, or **Meta WhatsApp Cloud API**
- 🕐 All timestamps in IST (Asia/Kolkata)
- 💸 100% free to run — no OpenAI, no paid APIs required

## How it works

```
WhatsApp message (voice / text / photo)
        │
        ▼
  /webhook (Express)
        │
        ▼
normalize.js (Evolution / Wasender / Meta → common format)
        │
        ▼
 geminiAudio.js or geminiVision.js  (transcription / OCR)
        │
        ▼
   geminiExtract.js  (intent classification + JSON extraction)
        │
        ▼
      sheets.js  (write row to correct tab / apply correction)
        │
        ▼
     gateway.js  (send Hindi confirmation back on WhatsApp)
```

## Prerequisites

1. **Node.js 18+**
2. A **free Gemini API key** — https://aistudio.google.com/app/apikey
3. A **Google Cloud Service Account** with the Google Sheets API enabled
   - Create one at https://console.cloud.google.com/iam-admin/serviceaccounts
   - Generate a JSON key, and enable "Google Sheets API" for the project
4. A **Google Sheet** — share it with the service account's `client_email` (Editor access)
5. A WhatsApp gateway account: [Evolution API](https://github.com/EvolutionAPI/evolution-api)
   (self-hosted, free), [Wasender](https://wasenderapi.com/), or a
   [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) app

## Setup

```bash
git clone <this-repo>
cd munshi-agent
cp .env.example .env
# Fill in .env with your real keys (see comments in the file)
npm install
npm start
```

The server starts on `PORT` (default `3000`) and automatically creates the `Sales`,
`Expenses`, and `Daily_Closing` tabs (with header rows) in your Google Sheet on startup.

## Deploying to Render

1. Push this project to a GitHub repo.
2. On [Render](https://render.com), click **New → Web Service** and connect the repo.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
4. Add all variables from `.env.example` under **Environment → Environment Variables**.
   - Paste the full service account JSON as a single-line string for
     `GOOGLE_SERVICE_ACCOUNT_CREDENTIALS`.
5. Deploy. Copy the public URL Render gives you, e.g. `https://munshi-agent.onrender.com`.
6. Set your WhatsApp gateway's webhook URL to `https://munshi-agent.onrender.com/webhook`.

## Deploying to Railway

1. Push this project to a GitHub repo.
2. On [Railway](https://railway.app), click **New Project → Deploy from GitHub repo**.
3. Railway auto-detects Node.js and runs `npm install && npm start`.
4. Add all variables from `.env.example` under the **Variables** tab.
5. Once deployed, go to **Settings → Networking** and generate a public domain.
6. Set your WhatsApp gateway's webhook URL to `https://<your-app>.up.railway.app/webhook`.

## Configuring the WhatsApp Gateway

Set `WHATSAPP_GATEWAY_TYPE` in `.env` to one of `evolution`, `wasender`, or `meta`, then:

| Gateway | `WHATSAPP_GATEWAY_BASE_URL` example | Notes |
|---|---|---|
| Evolution API | `https://your-evolution-instance.com` | Also set `EVOLUTION_INSTANCE_NAME`. Point the instance's webhook to `/webhook`. |
| Wasender | `https://www.wasenderapi.com/api` | Use your Wasender session's Bearer token as `WHATSAPP_GATEWAY_KEY`. |
| Meta Cloud API | `https://graph.facebook.com/v20.0/<PHONE_NUMBER_ID>` | Use a permanent access token as `WHATSAPP_GATEWAY_KEY`. During webhook setup in Meta's dashboard, use `META_VERIFY_TOKEN` as the verify token. |

## Access control

- `ALLOWED_NUMBERS` — comma-separated list of numbers permitted to send ledger entries
  (leave empty to allow anyone who messages the bot).
- `MANAGER_NUMBERS` — comma-separated list of owner/manager numbers that receive the
  Daily_Closing summary and error alerts automatically.

## Example flows

**Sale (voice note in Hindi):**
> "सुरेश ठेकेदार को 3000 अव्वल ईंट दी, कुल 12000 रुपये में से 8000 नकद मिल गया, बाकी उधार है"

Agent extracts: name=Suresh Thekedar, grade=Awwal, quantity=3000, amount_payable=12000,
amount_received=8000, pending_amount=4000, mode_of_payment=Cash — writes to `Sales`, and
replies: *"सुरेश ठेकेदार: 3000 अव्वल ईंट, ₹12,000 में से ₹8,000 नकद मिला, ₹4,000 उधारी दर्ज कर दी गई है।"*

**Correction (text):**
> "Suresh ka 4000 nahi 3000 tha"

Agent finds the most recent Suresh row in `Sales`, updates the pending amount, and appends
an audit note.

**Daily closing (voice note):**
> "Total jama 40000 hua, 5000 kharcha, 30000 maalik ko diya"

Agent writes a row to `Daily_Closing` and notifies all `MANAGER_NUMBERS`.

## Project structure

```
├── package.json
├── .env.example
├── README.md
└── src
    ├── config.js                    # env var loading & validation
    ├── server.js                    # Express app + webhook routes
    ├── webhook/
    │   └── normalize.js             # Evolution/Wasender/Meta → common shape
    ├── services/
    │   ├── geminiAudio.js           # voice note transcription
    │   ├── geminiVision.js          # ledger photo OCR
    │   ├── geminiExtract.js         # intent classification + JSON extraction
    │   ├── sheets.js                # Google Sheets read/write
    │   ├── gateway.js                # WhatsApp send (Evolution/Wasender/Meta)
    │   └── mediaDownload.js         # download voice/image from webhook payload
    └── handlers/
        └── messageHandler.js        # end-to-end pipeline
```

## Troubleshooting

- **"GOOGLE_SERVICE_ACCOUNT_CREDENTIALS is not valid JSON"** — make sure you pasted the
  *entire* service account key file as one line, with `\n` inside `private_key` kept intact.
- **Sheet writes fail with permission errors** — confirm you shared the Google Sheet with the
  service account's `client_email` and gave it Editor access.
- **No reply on WhatsApp** — check `WHATSAPP_GATEWAY_TYPE`, `WHATSAPP_GATEWAY_BASE_URL`, and
  `WHATSAPP_GATEWAY_KEY` are correct for your gateway, and check server logs for the exact
  error returned by the gateway.
