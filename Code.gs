/**
 * Wishpond Churn Forecast - Google Sheets bridge.
 *
 * Public reads are allowed so GitHub Pages can load the dashboard. AM/CSM writes
 * require the password stored in the Apps Script property WRITE_SECRET.
 *
 * Deploy as a Web app:
 *   Execute as: Me
 *   Who has access: Anyone
 */

var FORECAST_SHEET_PATTERN = / Forecast$/i;
var WRITE_SECRET_PROPERTY = 'WRITE_SECRET';
var MAX_HEADER_SCAN_ROWS = 20;
var MAX_UPDATES_PER_REQUEST = 100;

var HEADER_ALIASES = {
  client: ['client name', 'client', 'account'],
  am: ['am', 'account manager'],
  csm: ['csm', 'customer success manager'],
  mrr: ['mrr'],
  brand: ['brand'],
  startDate: ['start date'],
  churnDate: ['churn date'],
  tenureMonths: ['tenure months', 'tenure'],
  risk: ['risk', 'status'],
  mainReasonForChurn: ['main reason for churn', 'reason for churn', 'primary reason'],
  preventable: ['preventable'],
  commentsFromCsm: ['comments from csm', 'csm comments', 'comments']
};

function doGet(e) {
  var callback = e && e.parameter ? clean_(e.parameter.callback) : '';
  var response;

  try {
    response = {
      ok: true,
      data: readAllForecasts_(),
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    response = { ok: false, error: error.message || String(error) };
  }

  var payload = JSON.stringify(response);
  if (callback && isSafeCallback_(callback)) {
    return ContentService.createTextOutput(callback + '(' + payload + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return jsonOutput_(response);
}

function doPost(e) {
  var lock;

  try {
    var body = parsePostBody_(e);
    verifyWriteSecret_(body.writeSecret);

    if (!Array.isArray(body.updates) || !body.updates.length) {
      throw new Error('No assignment changes were supplied.');
    }
    if (body.updates.length > MAX_UPDATES_PER_REQUEST) {
      throw new Error('Too many changes in one request. Save 100 or fewer rows at a time.');
    }

    lock = LockService.getScriptLock();
    lock.waitLock(10000);
    var updated = applyAssignmentUpdates_(body.updates);
    SpreadsheetApp.flush();

    return jsonOutput_({ ok: true, updated: updated });
  } catch (error) {
    return jsonOutput_({ ok: false, error: error.message || String(error) });
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

function readAllForecasts_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var timezone = spreadsheet.getSpreadsheetTimeZone();
  var sheets = getForecastSheets_(spreadsheet);

  if (!sheets.length) {
    throw new Error('No sheet whose name ends in "Forecast" was found.');
  }

  var months = sheets.map(function(sheet) {
    return readForecastSheet_(sheet, timezone);
  });

  var ams = [];
  var csms = [];
  months.forEach(function(month) {
    month.clients.forEach(function(client) {
      if (client.am) ams.push(client.am);
      if (client.csm) csms.push(client.csm);
    });
  });

  return {
    months: months,
    assignees: {
      ams: sortedUnique_(ams),
      csms: sortedUnique_(csms)
    }
  };
}

function getForecastSheets_(spreadsheet) {
  return spreadsheet.getSheets().filter(function(sheet) {
    return FORECAST_SHEET_PATTERN.test(sheet.getName());
  });
}

function readForecastSheet_(sheet, timezone) {
  var header = findHeaderMap_(sheet);
  var lastAccountRow = findLastAccountRow_(sheet, header);
  var clients = [];

  if (lastAccountRow > header.rowNumber) {
    var rowCount = lastAccountRow - header.rowNumber;
    var values = sheet.getRange(header.rowNumber + 1, 1, rowCount, sheet.getLastColumn()).getValues();

    values.forEach(function(row, index) {
      var clientName = clean_(cell_(row, header.columns, 'client'));
      if (!clientName || !hasAccountData_(row, header.columns)) return;

      clients.push({
        rowNumber: header.rowNumber + index + 1,
        client: clientName,
        am: clean_(cell_(row, header.columns, 'am')),
        csm: clean_(cell_(row, header.columns, 'csm')),
        mrr: number_(cell_(row, header.columns, 'mrr')),
        brand: clean_(cell_(row, header.columns, 'brand')),
        startDate: date_(cell_(row, header.columns, 'startDate'), timezone),
        churnDate: date_(cell_(row, header.columns, 'churnDate'), timezone),
        tenureMonths: numberOrBlank_(cell_(row, header.columns, 'tenureMonths')),
        risk: clean_(cell_(row, header.columns, 'risk')),
        mainReasonForChurn: clean_(cell_(row, header.columns, 'mainReasonForChurn')),
        preventable: clean_(cell_(row, header.columns, 'preventable')),
        commentsFromCsm: clean_(cell_(row, header.columns, 'commentsFromCsm'))
      });
    });
  }

  return {
    name: clean_(sheet.getName().replace(FORECAST_SHEET_PATTERN, '')),
    sheetName: sheet.getName(),
    clients: clients
  };
}

function findHeaderMap_(sheet) {
  var scanRows = Math.min(Math.max(sheet.getLastRow(), 1), MAX_HEADER_SCAN_ROWS);
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var display = sheet.getRange(1, 1, scanRows, lastColumn).getDisplayValues();

  for (var rowIndex = 0; rowIndex < display.length; rowIndex++) {
    var columns = buildHeaderMap_(display[rowIndex]);
    if (columns.client >= 0 && columns.am >= 0 && columns.csm >= 0 && columns.mrr >= 0 && columns.brand >= 0) {
      return { rowNumber: rowIndex + 1, columns: columns };
    }
  }

  throw new Error('Could not find the forecast column headers in "' + sheet.getName() + '".');
}

function buildHeaderMap_(row) {
  var normalizedCells = row.map(normalizeHeader_);
  var columns = {};

  Object.keys(HEADER_ALIASES).forEach(function(field) {
    columns[field] = -1;
    var aliases = HEADER_ALIASES[field].map(normalizeHeader_);
    for (var index = 0; index < normalizedCells.length; index++) {
      if (aliases.indexOf(normalizedCells[index]) !== -1) {
        columns[field] = index;
        break;
      }
    }
  });

  return columns;
}

function findLastAccountRow_(sheet, header) {
  var firstDataRow = header.rowNumber + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < firstDataRow) return header.rowNumber;

  var values = sheet.getRange(firstDataRow, header.columns.client + 1, lastRow - firstDataRow + 1, 1).getDisplayValues();
  for (var index = values.length - 1; index >= 0; index--) {
    if (clean_(values[index][0])) return firstDataRow + index;
  }
  return header.rowNumber;
}

function hasAccountData_(row, columns) {
  return ['am', 'csm', 'mrr', 'brand', 'startDate', 'churnDate', 'risk', 'mainReasonForChurn']
    .some(function(field) { return clean_(cell_(row, columns, field)) !== ''; });
}

function cell_(row, columns, field) {
  var index = columns[field];
  return index >= 0 && index < row.length ? row[index] : '';
}

function applyAssignmentUpdates_(updates) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var allowedSheets = {};
  var allowedAms = {};
  var allowedCsms = {};
  var operations = [];
  var seen = {};

  getForecastSheets_(spreadsheet).forEach(function(sheet) {
    allowedSheets[sheet.getName()] = sheet;
    var header = findHeaderMap_(sheet);
    var lastAccountRow = findLastAccountRow_(sheet, header);
    if (lastAccountRow <= header.rowNumber) return;

    var values = sheet.getRange(header.rowNumber + 1, 1, lastAccountRow - header.rowNumber, sheet.getLastColumn()).getValues();
    values.forEach(function(row) {
      var am = clean_(cell_(row, header.columns, 'am'));
      var csm = clean_(cell_(row, header.columns, 'csm'));
      if (am) allowedAms[am] = true;
      if (csm) allowedCsms[csm] = true;
    });
  });

  updates.forEach(function(update) {
    if (!update || typeof update !== 'object') throw new Error('One assignment change is invalid.');

    var sheetName = clean_(update.sheetName);
    var client = clean_(update.client);
    var am = clean_(update.am);
    var csm = clean_(update.csm);
    var rowNumber = Number(update.rowNumber);
    var sheet = allowedSheets[sheetName];

    if (!sheet) throw new Error('The forecast tab "' + sheetName + '" is not available.');
    if (!Number.isInteger(rowNumber) || rowNumber < 1) throw new Error('The row number for "' + client + '" is invalid.');
    if (!client || client.length > 200) throw new Error('One account name is invalid.');
    if (am && !allowedAms[am]) throw new Error('AM "' + am + '" is not in the current forecast assignments.');
    if (csm && !allowedCsms[csm]) throw new Error('CSM "' + csm + '" is not in the current forecast assignments.');

    var key = sheetName + ':' + rowNumber;
    if (seen[key]) throw new Error('The same account was included more than once.');
    seen[key] = true;

    var header = findHeaderMap_(sheet);
    if (rowNumber <= header.rowNumber || rowNumber > sheet.getLastRow()) {
      throw new Error('The saved row for "' + client + '" is no longer valid. Refresh the dashboard and try again.');
    }

    var currentClient = clean_(sheet.getRange(rowNumber, header.columns.client + 1).getDisplayValue());
    if (currentClient !== client) {
      throw new Error('The row for "' + client + '" changed in Google Sheets. Refresh the dashboard and try again.');
    }

    operations.push({
      sheet: sheet,
      rowNumber: rowNumber,
      amColumn: header.columns.am + 1,
      csmColumn: header.columns.csm + 1,
      am: am,
      csm: csm
    });
  });

  operations.forEach(function(operation) {
    operation.sheet.getRange(operation.rowNumber, operation.amColumn).setValue(operation.am);
    operation.sheet.getRange(operation.rowNumber, operation.csmColumn).setValue(operation.csm);
  });

  return operations.length;
}

function parsePostBody_(e) {
  var contents = e && e.postData ? clean_(e.postData.contents) : '';
  if (!contents) throw new Error('The save request was empty.');
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error('The save request was not valid JSON.');
  }
}

function verifyWriteSecret_(candidate) {
  var configured = clean_(PropertiesService.getScriptProperties().getProperty(WRITE_SECRET_PROPERTY));
  if (!configured) throw new Error('The Apps Script property WRITE_SECRET has not been configured.');
  if (!safeEqual_(configured, clean_(candidate))) throw new Error('The dashboard edit password is incorrect.');
}

function safeEqual_(left, right) {
  if (left.length !== right.length) return false;
  var mismatch = 0;
  for (var index = 0; index < left.length; index++) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
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
  if (value === '' || value === null || value === undefined) return '';
  return number_(value);
}

function sortedUnique_(values) {
  var seen = {};
  return values.filter(function(value) {
    var key = clean_(value);
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  }).map(clean_).sort(function(left, right) {
    return left.localeCompare(right);
  });
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function clean_(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function normalizeHeader_(value) {
  return clean_(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function isSafeCallback_(callback) {
  return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback);
}
