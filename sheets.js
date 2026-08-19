const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");
const { config } = require("./config");

// Tab Names matching your Google Sheet exactly
const ORDERS_TAB = "Orders";
const DISPATCH_TAB = "Supply_Dispatch";
const EXPENSES_TAB = "Expenses";
const CLOSING_TAB = "Daily_Closing";

const ORDERS_HEADERS = [
  "Date",
  "Customer Name",
  "Village / Location",
  "Grade",
  "Quantity",
  "Amount Payable",
  "Amount Received",
  "Pending Amount",
  "Mode of Payment"
];

const DISPATCH_HEADERS = [
  "Date",
  "Customer Name",
  "Village / Location",
  "Grade",
  "Dispatched Quantity",
  "Driver Name"
];

const EXPENSES_HEADERS = [
  "Date",
  "Paid To",
  "Amount",
  "Remarks"
];

const CLOSING_HEADERS = [
  "Entry Date",
  "Date on Register",
  "Opening Balance (पिछली बचत)",
  "Total Jama (आज की वसूली)",
  "Total Cash In Hand",
  "Total Kharcha (खर्चा)",
  "Subtotal (शेष)",
  "Maalik Ko Diya (साहब को दिया)",
  "Munshi Closing Balance (अंतिम बचत)"
];

async function getSheetsClient() {
  const localCredsPath = path.join(__dirname, "credentials.json");
  const secretCredsPath = "/etc/secrets/google-credentials.json";

  let keyFileToUse = null;

  if (fs.existsSync(localCredsPath)) {
    keyFileToUse = localCredsPath;
  } else if (fs.existsSync(secretCredsPath)) {
    keyFileToUse = secretCredsPath;
  }

  if (!keyFileToUse) {
    throw new Error("Credentials file not found. Ensure credentials.json is in the project root.");
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: keyFileToUse,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

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
  await ensureTab(sheets, ORDERS_TAB, ORDERS_HEADERS);
  await ensureTab(sheets, DISPATCH_TAB, DISPATCH_HEADERS);
  await ensureTab(sheets, EXPENSES_TAB, EXPENSES_HEADERS);
  await ensureTab(sheets, CLOSING_TAB, CLOSING_HEADERS);
}

function getISTDateString() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// Main Batch Function to route parsed geminiVision data across all 4 tabs
async function routeParsedVisionData(parsedData) {
  const sheets = await getSheetsClient();
  const timestamp = getISTDateString();

  // 1. Append Orders
  if (parsedData.orders && parsedData.orders.length > 0) {
    const orderRows = parsedData.orders.map((o) => [
      timestamp,
      o.customer_name || "",
      o.village || "",
      o.grade || "",
      o.quantity || 0,
      o.amount_payable || 0,
      o.amount_received || 0,
      Math.max(0, (o.amount_payable || 0) - (o.amount_received || 0)),
      o.mode_of_payment || "Cash"
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: config.googleSheetId,
      range: `${ORDERS_TAB}!A:I`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: orderRows },
    });
  }

  // 2. Append Supply_Dispatch
  if (parsedData.supply_dispatch && parsedData.supply_dispatch.length > 0) {
    const dispatchRows = parsedData.supply_dispatch.map((d) => [
      timestamp,
      d.customer_name || "",
      d.village_or_site || "",
      d.grade || "",
      d.dispatched_quantity || "",
      d.driver_name || ""
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: config.googleSheetId,
      range: `${DISPATCH_TAB}!A:F`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: dispatchRows },
    });
  }

  // 3. Append Expenses
  if (parsedData.expenses && parsedData.expenses.length > 0) {
    const expenseRows = parsedData.expenses.map((e) => [
      timestamp,
      e.paid_to || "",
      e.amount || 0,
      e.remarks || ""
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: config.googleSheetId,
      range: `${EXPENSES_TAB}!A:D`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: expenseRows },
    });
  }

  // 4. Append Daily_Closing
  if (parsedData.daily_closing) {
    const c = parsedData.daily_closing;
    const closingRow = [[
      timestamp,
      parsedData.date || "",
      c.opening_balance || 0,
      c.total_jama || 0,
      c.total_cash_in_hand || 0,
      c.total_kharcha || 0,
      c.subtotal || 0,
      c.given_to_owner || 0,
      c.closing_balance || 0
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: config.googleSheetId,
      range: `${CLOSING_TAB}!A:I`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: closingRow },
    });
  }
}

// Single Entry Helpers (for audio/text voice commands)
async function logOrder(order) {
  const sheets = await getSheetsClient();
  const payable = order?.amount_payable || 0;
  const received = order?.amount_received || 0;
  const row = [
    getISTDateString(),
    order?.customer_name || order?.name || "",
    order?.village || "",
    order?.grade || "अव्वल",
    order?.quantity || 0,
    payable,
    received,
    Math.max(0, payable - received),
    order?.mode_of_payment || "Cash"
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.googleSheetId,
    range: `${ORDERS_TAB}!A:I`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function logDispatch(dispatch) {
  const sheets = await getSheetsClient();
  const row = [
    getISTDateString(),
    dispatch?.customer_name || dispatch?.name || "",
    dispatch?.village_or_site || dispatch?.village || "",
    dispatch?.grade || "अव्वल",
    dispatch?.dispatched_quantity || dispatch?.quantity || 0,
    dispatch?.driver_name || ""
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.googleSheetId,
    range: `${DISPATCH_TAB}!A:F`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function logExpense(expense) {
  const sheets = await getSheetsClient();
  const row = [
    getISTDateString(),
    expense?.paid_to || expense?.category || "General",
    expense?.amount || 0,
    expense?.remarks || ""
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.googleSheetId,
    range: `${EXPENSES_TAB}!A:D`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function logDailyClosing(closing) {
  const sheets = await getSheetsClient();
  const row = [
    getISTDateString(),
    closing?.date || "",
    closing?.opening_balance || 0,
    closing?.total_jama || 0,
    closing?.total_cash_in_hand || 0,
    closing?.total_kharcha || 0,
    closing?.subtotal || 0,
    closing?.given_to_owner || closing?.maalik_ko_diya || 0,
    closing?.closing_balance || closing?.munshi_cash_in_hand || 0
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.googleSheetId,
    range: `${CLOSING_TAB}!A:I`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function applyCorrection(correction) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.googleSheetId,
    range: `${ORDERS_TAB}!A:I`,
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
        range: `${ORDERS_TAB}!A${rowIndex}:I${rowIndex}`,
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
  routeParsedVisionData,
  logOrder,
  logSale: logOrder, // Alias for backward compatibility with audio/extract scripts
  logDispatch,
  logExpense,
  logDailyClosing,
  applyCorrection
};
