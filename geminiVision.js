const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { config } = require("./config");

const apiKey = config?.geminiApiKey || config?.gemini?.apiKey || process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);

const EXTRACTION_INSTRUCTION = `This is a photo of a handwritten ledger page from an Indian brick kiln (bhatta).
Entries are usually in Hindi and/or English. They typically record: customer/party name, brick grade (Awwal, Meetha, Khanjad, Peela, Godiya, Addha Awwal, Addha Peela), quantity of bricks, cash received, and pending amount.
Transcribe everything you can read line by line.`;

async function extractLedgerTextFromImage(filePath, mimeType) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const imageData = fs.readFileSync(filePath).toString("base64");

  const result = await model.generateContent([
    { inlineData: { data: imageData, mimeType } },
    { text: EXTRACTION_INSTRUCTION },
  ]);

  const text = (result.response.text() || "").trim();
  if (!text || text.length < 3) {
    const err = new Error("EMPTY_VISION_EXTRACTION");
    err.userMessage = "Photo saaf nahi padhi ja saki. Kripya achhi roshni mein dobara bhejein.";
    throw err;
  }
  return text;
}

module.exports = { extractLedgerTextFromImage };
