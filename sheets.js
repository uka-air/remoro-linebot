require("dotenv").config();

const { google } = require("googleapis");
const { getAuthClient } = require("./auth");

function pad2(n) {
  return String(n).padStart(2, "0");
}

function monthFolderNameFromDate(d) {
  return `${d.getFullYear()}_${pad2(d.getMonth() + 1)}`;
}

function extractFirstUrl(text = "") {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
}

function isSheetsApiDisabledError(err) {
  const message = `${err?.message || ""} ${err?.cause?.message || ""}`;
  const has403 = Number(err?.code) === 403 || Number(err?.status) === 403;
  return has403 && /google sheets api has not been used|disabled|sheets.googleapis.com/i.test(message);
}

function toFriendlySheetsError(err) {
  if (!isSheetsApiDisabledError(err)) return err;

  const fullMessage = err?.cause?.message || err?.message || "Google Sheets API is disabled.";
  const enableUrl = extractFirstUrl(fullMessage);
  const friendly = new Error(
    `Google Sheets API is disabled for this Google Cloud project.${enableUrl ? ` Enable it here: ${enableUrl}` : ""}`
  );
  friendly.code = "SHEETS_API_DISABLED";
  friendly.enableUrl = enableUrl;
  friendly.originalMessage = fullMessage;
  return friendly;
}

async function getClients() {
  const auth = await getAuthClient();
  return {
    drive: google.drive({ version: "v3", auth }),
    sheets: google.sheets({ version: "v4", auth }),
  };
}

async function findFolder(drive, parentId, name) {
  const safeName = name.replace(/'/g, "\\'");
  const q = [
    `'${parentId}' in parents`,
    `name='${safeName}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`,
  ].join(" and ");

  const res = await drive.files.list({
    q,
    fields: "files(id,name)",
    spaces: "drive",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return res.data.files?.[0] || null;
}

async function getOrCreateFolder(drive, parentId, name) {
  const existing = await findFolder(drive, parentId, name);
  if (existing) return existing.id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });

  return created.data.id;
}

async function findSpreadsheetInFolder(drive, parentId, name) {
  const safeName = name.replace(/'/g, "\\'");
  const q = [
    `'${parentId}' in parents`,
    `name='${safeName}'`,
    `mimeType='application/vnd.google-apps.spreadsheet'`,
    `trashed=false`,
  ].join(" and ");

  const res = await drive.files.list({
    q,
    fields: "files(id,name)",
    spaces: "drive",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return res.data.files?.[0] || null;
}

async function ensureHeaderRow(sheets, spreadsheetId) {
  const headers = [[
    "receivedAt",
    "fileName",
    "fileUrl",
    "documentType",
    "merchant",
    "expenseDate",
    "totalAmount",
    "currency",
    "taxAmount",
    "summary",
    "readStatus",
    "readReason",
  ]];

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "expense_report!A1:L1",
  }).catch(() => null);

  if (!existing?.data?.values?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "expense_report!A1:L1",
      valueInputOption: "RAW",
      requestBody: { values: headers },
    });
  }
}

async function getOrCreateMonthlyExpenseSpreadsheet(drive, sheets, rootFolderId, receivedAt) {
  const monthName = monthFolderNameFromDate(receivedAt);
  const monthFolderId = await getOrCreateFolder(drive, rootFolderId, monthName);
  const sheetFileName = `expense_report_${monthName}`;

  const existing = await findSpreadsheetInFolder(drive, monthFolderId, sheetFileName);
  if (existing) {
    await ensureHeaderRow(sheets, existing.id);
    return existing.id;
  }

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: sheetFileName },
      sheets: [{ properties: { title: "expense_report" } }],
    },
    fields: "spreadsheetId",
  });

  const spreadsheetId = created.data.spreadsheetId;

  await drive.files.update({
    fileId: spreadsheetId,
    addParents: monthFolderId,
    removeParents: "root",
    fields: "id, parents",
    supportsAllDrives: true,
  });

  await ensureHeaderRow(sheets, spreadsheetId);
  return spreadsheetId;
}

async function ensureMonthlyExpenseSheet(receivedAt = new Date()) {
  try {
    const rootId = process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootId) throw new Error("Missing DRIVE_ROOT_FOLDER_ID in .env");

    const { drive, sheets } = await getClients();
    const spreadsheetId = await getOrCreateMonthlyExpenseSpreadsheet(drive, sheets, rootId, receivedAt);
    return { spreadsheetId };
  } catch (err) {
    throw toFriendlySheetsError(err);
  }
}

async function appendExpenseReportRow(receivedAt, uploadedFile, parsedExpense) {
  try {
    const rootId = process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootId) throw new Error("Missing DRIVE_ROOT_FOLDER_ID in .env");

    const { drive, sheets } = await getClients();
    const spreadsheetId = await getOrCreateMonthlyExpenseSpreadsheet(drive, sheets, rootId, receivedAt);

    const data = parsedExpense?.data || {};

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "expense_report!A:L",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          receivedAt.toISOString(),
          uploadedFile?.name || "",
          uploadedFile?.webViewLink || "",
          data.documentType ?? null,
          data.merchant ?? null,
          data.date ?? null,
          data.totalAmount ?? null,
          data.currency ?? null,
          data.taxAmount ?? null,
          data.summary ?? null,
          parsedExpense?.status || "unknown",
          parsedExpense?.reason || "",
        ]],
      },
    });

    return { spreadsheetId };
  } catch (err) {
    throw toFriendlySheetsError(err);
  }
}

module.exports = {
  appendExpenseReportRow,
  ensureMonthlyExpenseSheet,
  isSheetsApiDisabledError,
};
