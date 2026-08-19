const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");
const { config } = require("./config");

const ORDERS_TAB = "Orders";
const DISPATCH_TAB = "Supply_Dispatch";
const EXPENSES_TAB = "Expenses";
const CLOSING_TAB = "Daily_Closing";

// Tab schema columns map
const TAB_COLUMNS = {
  [ORDERS_TAB]: {
    range: "A:I",
    colMap: { customer_name: 1, village: 2, grade: 3, quantity: 4, amount_payable: 5, amount_received: 6, pending_amount: 7, mode: 8 }
  },
  [DISPATCH_TAB]: {
    range: "A:F",
    colMap: { customer_name: 1, village: 2, grade: 3, dispatched_quantity: 4, quantity: 4, driver_name: 5 }
  },
  [EXPENSES_TAB]: {
    range: "A:D",
    colMap: { paid_to: 1, category: 1, amount: 2, remarks: 3 }
  },
  [CLOSING_TAB]: {
    range: "A:I",
    colMap: { date: 1, opening_balance: 2, total_jama: 3, total_cash: 4, total_kharcha: 5, subtotal: 6, maalik_ko_diya: 7, closing_balance: 8 }
  }
};

async function getSheetsClient() {
  const localCredsPath = path.join(__dirname, "credentials.json");
  const secretCredsPath = "/etc/secrets/google-credentials.json";
  let keyFileToUse = fs.existsSync(localCredsPath) ? localCredsPath : (fs.existsSync(secretCredsPath) ? secretCredsPath : null);

  if (!keyFileToUse) throw new Error("Credentials file not found.");

  const auth = new google.auth.GoogleAuth({
    keyFile: keyFileToUse,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// ----------------------------------------------------
// 1. UNIVERSAL CORRECTION FUNCTION ACROSS ALL 4 TABS
// ----------------------------------------------------
async function applyUniversalCorrection(correction) {
  const sheets = await getSheetsClient();
  const target = (correction?.target_name || correction?.target_customer || correction?.target_keyword || "").toLowerCase().trim();
  const fieldToUpdate = (correction?.field_to_update || "").toLowerCase().trim();
  const correctedValue = correction?.corrected_value;

  // Determine tabs to search (target specific tab or search all)
  const tabPriority = correction?.target_tab ? [correction.target_tab] : [DISPATCH_TAB, ORDERS_TAB, EXPENSES_TAB, CLOSING_TAB];

  for (const tabName of tabPriority) {
    const configData = TAB_COLUMNS[tabName];
    if (!configData) continue;

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.googleSheetId,
      range: `${tabName}!${configData.range}`,
    });
    const rows = res.data.values || [];

    for (let i = rows.length - 1; i >= 1; i--) {
      const row = rows[i];
      const matchKey = (row[1] || "").toLowerCase().trim(); // Column B (Name / Paid To / Date)
      const secondaryKey = (row[2] || "").toLowerCase().trim(); // Column C (Village / Remarks)

      // Match target identifier or latest entry for Daily_Closing
      if (tabName === CLOSING_TAB || matchKey.includes(target) || target.includes(matchKey) || secondaryKey.includes(target)) {
        const rowIndex = i + 1;

        // Find which column index to update
        let targetColIndex = -1;
        for (const [colName, idx] of Object.entries(configData.colMap)) {
          if (fieldToUpdate.includes(colName) || colName.includes(fieldToUpdate)) {
            targetColIndex = idx;
            break;
          }
        }

        // Fallback column defaults if AI sends generic names
        if (targetColIndex === -1) {
          if (fieldToUpdate.includes("मात्रा") || fieldToUpdate.includes("quantity") || fieldToUpdate.includes("qty")) {
            targetColIndex = (tabName === ORDERS_TAB || tabName === DISPATCH_TAB) ? 4 : -1;
          } else if (fieldToUpdate.includes("रुपए") || fieldToUpdate.includes("amount") || fieldToUpdate.includes("rate")) {
            targetColIndex = tabName === EXPENSES_TAB ? 2 : (tabName === ORDERS_TAB ? 5 : -1);
          } else if (fieldToUpdate.includes("ड्राइवर") || fieldToUpdate.includes("driver")) {
            targetColIndex = tabName === DISPATCH_TAB ? 5 : -1;
          } else if (fieldToUpdate.includes("ग्रेड") || fieldToUpdate.includes("grade")) {
            targetColIndex = 3;
          }
        }

        if (targetColIndex !== -1) {
          row[targetColIndex] = correctedValue;

          // Auto-recalculate Pending Amount if updating Orders Amount
          if (tabName === ORDERS_TAB && (targetColIndex === 5 || targetColIndex === 6)) {
            const payable = parseFloat(row[5]) || 0;
            const received = parseFloat(row[6]) || 0;
            row[7] = Math.max(0, payable - received);
          }

          // Append correction audit stamp in Column B
          if (tabName !== CLOSING_TAB && !row[1].includes("[संशोधित]")) {
            row[1] = `${row[1]} [संशोधित]`;
          }

          await sheets.spreadsheets.values.update({
            spreadsheetId: config.googleSheetId,
            range: `${tabName}!A${rowIndex}:${String.fromCharCode(65 + row.length)}${rowIndex}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [row] },
          });

          return { success: true, tab: tabName, row: rowIndex, message: `${tabName} में ${fieldToUpdate} को बदल कर ${correctedValue} कर दिया गया है।` };
        }
      }
    }
  }
  return { success: false, message: "सुधार के लिए संबंधित रिकॉर्ड नहीं मिला।" };
}

// ----------------------------------------------------
// 2. UNIVERSAL DELETION FUNCTION ACROSS ALL 4 TABS
// ----------------------------------------------------
async function applyUniversalDeletion(deletion) {
  const sheets = await getSheetsClient();
  const target = (deletion?.target_name || deletion?.target_keyword || "").toLowerCase().trim();
  const isDeleteLast = deletion?.delete_last === true || target.includes("last") || target.includes("पिछली");

  const tabPriority = deletion?.target_tab ? [deletion.target_tab] : [DISPATCH_TAB, ORDERS_TAB, EXPENSES_TAB, CLOSING_TAB];

  for (const tabName of tabPriority) {
    const configData = TAB_COLUMNS[tabName];
    if (!configData) continue;

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.googleSheetId,
      range: `${tabName}!${configData.range}`,
    });
    const rows = res.data.values || [];
    if (rows.length <= 1) continue; // Skip if only headers exist

    for (let i = rows.length - 1; i >= 1; i--) {
      const matchKey = (rows[i][1] || "").toLowerCase().trim();
      const secondaryKey = (rows[i][2] || "").toLowerCase().trim();

      if (isDeleteLast || matchKey.includes(target) || target.includes(matchKey) || secondaryKey.includes(target)) {
        const rowIndex = i + 1;

        // Clear the row content
        await sheets.spreadsheets.values.clear({
          spreadsheetId: config.googleSheetId,
          range: `${tabName}!A${rowIndex}:${String.fromCharCode(65 + rows[i].length)}${rowIndex}`,
        });

        return { success: true, tab: tabName, row: rowIndex, message: `${tabName} से "${rows[i][1] || 'अंतिम प्रविष्टि'}" को हटा (डिलीट) दिया गया है।` };
      }
    }
  }
  return { success: false, message: "डिलीट करने के लिए कोई संबंधित एंट्री नहीं मिली।" };
}

module.exports = {
  // ... other exports ...
  applyUniversalCorrection,
  applyUniversalDeletion,
  applyCorrection: applyUniversalCorrection // Backward compatibility alias
};
