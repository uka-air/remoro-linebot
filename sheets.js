require("dotenv").config();

const { google } = require("googleapis");
const { getAuthClient } = require("./auth");

function pad2(n) {
  return String(n).padStart(2, "0");
}

function monthFolderNameFromDate(d) {
  return `${d.getFullYear()}_${pad2(d.getMonth() + 1)}`;
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

async function appendExpenseReportRow(receivedAt, uploadedFile, parsedExpense) {
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
}

module.exports = { appendExpenseReportRow };
