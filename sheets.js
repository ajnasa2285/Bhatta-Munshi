const { google } = require("googleapis");
const { config } = require("./config");

const SALES_TAB = "Sales";
const EXPENSES_TAB = "Expenses";
const CLOSING_TAB = "Daily_Closing";

const SALES_HEADERS = [
  "Date",
  "Name",
  "Grade",
  "Quantity",
  "Amount Payable",
  "Amount Received",
  "Pending Amount",
  "Mode of Payment"
];

const EXPENSES_HEADERS = [
  "Date",
  "Category",
  "Paid To",
  "Amount",
  "Mode of Payment",
  "Remarks"
];

const CLOSING_HEADERS = [
  "Date",
  "Total Jama",
  "Total Kharcha",
  "Maalik Ko Diya",
  "Munshi Cash In Hand",
  "Notes"
];

function formatPrivateKey(key) {
  if (!key) return "";
  let cleanKey = key.trim();
  if (
    (cleanKey.startsWith('"') && cleanKey.endsWith('"')) ||
    (cleanKey.startsWith("'") && cleanKey.endsWith("'"))
  ) {
    cleanKey = cleanKey.slice(1, -1);
  }
  return cleanKey.replace(/\\n/g, "\n").replace(/\r/g, "");
}

function getAuth() {
  const creds = config.googleCredentials;
  if (!creds || !creds.client_email || !creds.private_key) {
    throw new Error("Missing or invalid GOOGLE_SERVICE_ACCOUNT_CREDENTIALS configuration.");
  }

  const formattedKey = formatPrivateKey(creds.private_key);

  return new google.auth.JWT(
    creds.client_email,
    null,
    formattedKey,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
}

async function getSheetsClient() {
  const auth = getAuth();
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

async function ensureTab(sheets, tabName, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.googleSheetId });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.googleSheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.googleSheetId,
      range: `${tabName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });
  }
}

async function ensureAllTabs() {
  const sheets = await getSheetsClient();
  await ensureTab(sheets, SALES_TAB, SALES_HEADERS);
  await ensureTab(sheets, EXPENSES_TAB, EXPENSES_HEADERS);
  await ensureTab(sheets, CLOSING_TAB, CLOSING_HEADERS);
}

function getISTDateString() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

async function logSale(sale) {
  const sheets = await getSheetsClient();
  const row = [
    getISTDateString(),
    sale?.name || "",
    sale?.grade || "Other",
    sale?.quantity || 0,
    sale?.amount_payable || 0,
    sale?.amount_received || 0,
    sale?.pending_amount || 0,
    sale?.mode_of_payment || "Cash"
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.googleSheetId,
    range: `${SALES_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function logExpense(expense) {
  const sheets = await getSheetsClient();
  const row = [
    getISTDateString(),
    expense?.category || "General",
    expense?.paid_to || "",
    expense?.amount || 0,
    expense?.mode_of_payment || "Cash",
    expense?.remarks || ""
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.googleSheetId,
    range: `${EXPENSES_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function logDailyClosing(closing) {
  const sheets = await getSheetsClient();
  const row = [
    getISTDateString(),
    closing?.total_jama || 0,
    closing?.total_kharcha || 0,
    closing?.maalik_ko_diya || 0,
    closing?.munshi_cash_in_hand || 0,
    closing?.notes || ""
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.googleSheetId,
    range: `${CLOSING_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function applyCorrection(correction) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.googleSheetId,
    range: `${SALES_TAB}!A:H`,
  });
  const rows = res.data.values || [];
  const targetName = (correction?.target_customer || "").toLowerCase().trim();

  for (let i = rows.length - 1; i >= 1; i--) {
    const rowName = (rows[i][1] || "").toLowerCase().trim();
    if (rowName.includes(targetName) || targetName.includes(rowName)) {
      const rowIndex = i + 1;
      const note = ` [संशोधन: ${correction.field_to_update} -> ${correction.corrected_value}]`;
      rows[i][1] = rows[i][1] + note;
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.googleSheetId,
        range: `${SALES_TAB}!A${rowIndex}:H${rowIndex}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rows[i]] },
      });
      return true;
    }
  }
  return false;
}

module.exports = {
  ensureAllTabs,
  logSale,
  logExpense,
  logDailyClosing,
  applyCorrection
};
