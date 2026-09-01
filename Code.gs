/**
 * Wishpond September Forecast - read-only Apps Script bridge.
 *
 * Deploy as a Web app:
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * This deliberately exposes no write endpoint. A public GitHub Pages site cannot
 * keep a write password secret, so edits should remain in the Google Sheet.
 */

var SHEET_NAME = 'September Forecast';
var HEADER_ROW = 2;
var DATA_START_ROW = 4;
var COLUMN_COUNT = 12;
var EXPECTED_HEADERS = [
  'Client Name', 'AM', 'CSM', 'MRR', 'Brand', 'Start date',
  'Churn Date', 'Tenure (Months)', 'Risk', 'Main Reason for Churn',
  'Preventable?', 'Comments from CSM'
];

function doGet(e) {
  var callback = e && e.parameter ? String(e.parameter.callback || '') : '';
  var response;
  try {
    response = { ok: true, data: readForecast_(), generatedAt: new Date().toISOString() };
  } catch (error) {
    response = { ok: false, error: error.message };
  }

  var payload = JSON.stringify(response);
  if (callback && isSafeCallback_(callback)) {
    return ContentService.createTextOutput(callback + '(' + payload + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
}

function readForecast_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" was not found.');

  validateHeaders_(sheet);
  var lastRow = findLastClientRow_(sheet);
  if (lastRow < DATA_START_ROW) {
    return { sheetName: SHEET_NAME, month: 'September', clients: [] };
  }

  var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, COLUMN_COUNT).getValues();
  var timezone = spreadsheet.getSpreadsheetTimeZone();
  var clients = values
    .filter(function(row) { return clean_(row[0]) !== ''; })
    .map(function(row) {
      return {
        client: clean_(row[0]),
        am: clean_(row[1]),
        csm: clean_(row[2]),
        mrr: number_(row[3]),
        brand: clean_(row[4]),
        startDate: date_(row[5], timezone),
        churnDate: date_(row[6], timezone),
        tenureMonths: numberOrBlank_(row[7]),
        risk: clean_(row[8]),
        mainReasonForChurn: clean_(row[9]),
        preventable: clean_(row[10]),
        commentsFromCsm: clean_(row[11])
      };
    });

  return { sheetName: SHEET_NAME, month: 'September', clients: clients };
}

function validateHeaders_(sheet) {
  var actual = sheet.getRange(HEADER_ROW, 1, 1, COLUMN_COUNT).getDisplayValues()[0];
  var mismatches = [];
  EXPECTED_HEADERS.forEach(function(expected, index) {
    if (normalize_(actual[index]) !== normalize_(expected)) {
      mismatches.push('column ' + (index + 1) + ': expected "' + expected + '", found "' + actual[index] + '"');
    }
  });
  if (mismatches.length) throw new Error('Header mismatch - ' + mismatches.join('; '));
}

function findLastClientRow_(sheet) {
  var maxRow = Math.max(sheet.getLastRow(), DATA_START_ROW);
  var names = sheet.getRange(DATA_START_ROW, 1, maxRow - DATA_START_ROW + 1, 1).getDisplayValues();
  for (var index = names.length - 1; index >= 0; index--) {
    if (clean_(names[index][0])) return DATA_START_ROW + index;
  }
  return DATA_START_ROW - 1;
}

function date_(value, timezone) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, timezone, 'yyyy-MM-dd');
  }
  return clean_(value);
}

function number_(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  var parsed = Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return isFinite(parsed) ? parsed : 0;
}

function numberOrBlank_(value) {
  if (value === '' || value === null) return '';
  return number_(value);
}

function clean_(value) { return String(value === null || value === undefined ? '' : value).trim(); }
function normalize_(value) { return clean_(value).toLowerCase().replace(/\s+/g, ' '); }
function isSafeCallback_(callback) { return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback); }
