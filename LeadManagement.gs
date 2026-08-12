/**
 * LeadManagement.gs
 * Managed sales-lead state, status-based sheet views, borough views,
 * assignment notifications, and revenue tracking.
 *
 * Portfolio-safe copy: production recipients and organization-specific
 * identifiers have been removed/generalized.
 */

const LEAD_STATE_SHEET_NAME = 'Lead_State';


const MANAGED_LEAD_TABS = {
  ACTIVE: 'Sent_Alerts',
  CONTACT: 'Contact_Made',
  ARCHIVE: 'Skipped'
};


const MANAGED_LEAD_HEADERS = [
  'Alert Sent At',
  'Assigned Rep',
  'Last Contact',
  'Sales Status',
  'Lead Rating',
  'Price',
  'Address',
  'Area',
  'Neighborhood',
  'Broker',
  'Phone',
  'Email',
  'Listing URL',
  'Detected At',
  'Listing ID',
  'Projected Revenue',
  'Sold Revenue'
];


const MANAGED_STATUS_OPTIONS = [
  'Unassigned',
  'Assigned',
  'Prospecting',
  'Contact made',
  'Non-responsive',
  'Won',
  'Lost',
  'Skipped',
  'Bounced'
];


const LEAD_RATING_OPTIONS = [
  '',
  'A - Hot',
  'B - Warm',
  'C - Low',
  'No Fit',
  'Closed Deal'
];


const LEAD_STATE_HEADERS = [
  'listing_id',
  'assigned_rep',
  'last_contact',
  'sales_status',
  'lead_rating',
  'updated_at',
  'projected_revenue',
  'sold_revenue'
];

const BOROUGH_VIEW_TABS = {
  Brooklyn: 'BK_Alert',
  Queens: 'QNS_Alert',
  Bronx: 'BX_Alert',
  Manhattan: 'MHTN_Alert',
  'Staten Island': 'SI_Alert'
};

function getManagedLeadAllowedTabs_() {
  return [
    MANAGED_LEAD_TABS.ACTIVE,
    MANAGED_LEAD_TABS.CONTACT,
    MANAGED_LEAD_TABS.ARCHIVE
  ].concat(Object.keys(BOROUGH_VIEW_TABS).map(function(borough) {
    return BOROUGH_VIEW_TABS[borough];
  }));
}

function normalizeBorough_(value) {
  var s = String(value || '').trim().toLowerCase();

  if (!s) return '';

  if (s === 'brooklyn' || s === 'bk') return 'Brooklyn';
  if (s === 'queens' || s === 'qns') return 'Queens';
  if (s === 'bronx' || s === 'bx') return 'Bronx';
  if (s === 'manhattan' || s === 'mhtn') return 'Manhattan';
  if (s === 'staten island' || s === 'staten_island' || s === 'si') return 'Staten Island';

  // Generic NYC is not a borough. Let getListingBoroughForTabs_ infer from
  // neighborhood/address/title instead of forcing it into Manhattan.
  if (
    s === 'nyc' ||
    s === 'new york city' ||
    s === 'new york' ||
    s === 'new york, ny'
  ) {
    return '';
  }

  return String(value || '').trim();
}

function getListingBoroughForTabs_(listing) {
  if (!listing) return '';

  var fromArea = normalizeBorough_(listing.area);

  if (BOROUGH_VIEW_TABS[fromArea]) {
    return fromArea;
  }

  if (typeof inferBoroughFromText_ === 'function') {
    var blob = [
      listing.area,
      listing.neighborhood,
      listing.address,
      listing.title,
      listing.listing_url
    ].filter(Boolean).join(' ');

    var inferred = inferBoroughFromText_(blob);

    if (BOROUGH_VIEW_TABS[inferred]) {
      return inferred;
    }
  }

  var fromNeighborhood = normalizeBorough_(listing.neighborhood);

  if (BOROUGH_VIEW_TABS[fromNeighborhood]) {
    return fromNeighborhood;
  }

  return '';
}

function normalizeSalesStatus_(value) {
  var s = String(value || '').trim();


  if (!s) return 'Unassigned';


  var lower = s.toLowerCase();


  if (lower === 'not started') return 'Unassigned';
  if (lower === 'contacted') return 'Prospecting';
  if (lower === 'contact') return 'Prospecting';
  if (lower === 'contact made') return 'Contact made';
  if (lower === 'non responsive') return 'Non-responsive';
  if (lower === 'non-responsive') return 'Non-responsive';
  if (lower === 'bounce' || lower === 'bounced email') return 'Bounced';
  if (lower === 'skip') return 'Skipped';


  if (MANAGED_STATUS_OPTIONS.indexOf(s) !== -1) return s;


  return 'Unassigned';
}


function getLeadTabForStatus_(status) {
  status = normalizeSalesStatus_(status);


  if (status === 'Contact made' || status === 'Won') {
    return MANAGED_LEAD_TABS.CONTACT;
  }


  if (status === 'Skipped' || status === 'Bounced' || status === 'Lost') {
    return MANAGED_LEAD_TABS.ARCHIVE;
  }


  return MANAGED_LEAD_TABS.ACTIVE;
}


function cleanRevenueValue_(value) {
  if (value === '' || value === null || value === undefined) return '';

  var cleaned = String(value).replace(/[^0-9.\-]/g, '').trim();

  if (cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '-.') {
    return '';
  }

  var n = Number(cleaned);

  return isNaN(n) ? '' : n;
}


function ensureLeadStateSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LEAD_STATE_SHEET_NAME);


  if (!sheet) {
    sheet = ss.insertSheet(LEAD_STATE_SHEET_NAME);
  }


  if (sheet.getMaxColumns() < LEAD_STATE_HEADERS.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      LEAD_STATE_HEADERS.length - sheet.getMaxColumns()
    );
  }


  sheet
    .getRange(1, 1, 1, LEAD_STATE_HEADERS.length)
    .setValues([LEAD_STATE_HEADERS])
    .setFontWeight('bold');


  sheet.setFrozenRows(1);


  try {
    sheet.hideSheet();
  } catch (e) {}


  return sheet;
}


function readLeadStateMap_() {
  var sheet = ensureLeadStateSheet_();
  var lastRow = sheet.getLastRow();
  var map = {};


  if (lastRow < 2) return map;


  var rows = sheet
    .getRange(2, 1, lastRow - 1, LEAD_STATE_HEADERS.length)
    .getValues();


  rows.forEach(function(r, idx) {
    var id = String(r[0] || '').trim();
    if (!id) return;


    map[id] = {
      rowNum: idx + 2,
      assigned_rep: String(r[1] || '').trim(),
      last_contact: String(r[2] || '').trim(),
      sales_status: normalizeSalesStatus_(r[3]),
      lead_rating: String(r[4] || '').trim(),
      updated_at: String(r[5] || '').trim(),
      projected_revenue: cleanRevenueValue_(r[6]),
      sold_revenue: cleanRevenueValue_(r[7])
    };
  });


  return map;
}


function saveLeadState_(
  listingId,
  assignedRep,
  lastContact,
  salesStatus,
  leadRating,
  projectedRevenue,
  soldRevenue
) {
  if (!listingId) return;


  listingId = String(listingId).trim();


  var sheet = ensureLeadStateSheet_();
  var map = readLeadStateMap_();
  var existing = map[listingId] || {};


  var cleanAssignedRep = String(assignedRep || '').trim();
  var cleanLastContact = formatLeadDate_(lastContact);
  var cleanStatus = normalizeSalesStatus_(salesStatus || existing.sales_status || 'Unassigned');
  var cleanRating = String(leadRating || '').trim();


  var cleanProjectedRevenue =
    projectedRevenue !== undefined
      ? cleanRevenueValue_(projectedRevenue)
      : cleanRevenueValue_(existing.projected_revenue);


  var cleanSoldRevenue =
    soldRevenue !== undefined
      ? cleanRevenueValue_(soldRevenue)
      : cleanRevenueValue_(existing.sold_revenue);


  if (!cleanAssignedRep && existing.assigned_rep) {
    cleanAssignedRep = existing.assigned_rep;
  }


  if (!cleanLastContact && existing.last_contact) {
    cleanLastContact = existing.last_contact;
  }


  if (!cleanRating && existing.lead_rating) {
    cleanRating = existing.lead_rating;
  }


  var row = [
    listingId,
    cleanAssignedRep,
    cleanLastContact,
    cleanStatus,
    cleanRating,
    nowIso_(),
    cleanProjectedRevenue,
    cleanSoldRevenue
  ];


  if (existing.rowNum) {
    sheet
      .getRange(existing.rowNum, 1, 1, LEAD_STATE_HEADERS.length)
      .setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}


// Keep this wrapper because Service.gs may already call refreshSentAlertsTab().
function refreshSentAlertsTab() {
  refreshManagedLeadTabs();
}


function refreshManagedLeadTabs() {
  var lock = LockService.getDocumentLock();


  try {
    lock.waitLock(30000);


    ensureAllSheets_();
    ensureLeadStateSheet_();


    var stateMap = readLeadStateMap_();


    var tabRows = {};
    tabRows[MANAGED_LEAD_TABS.ACTIVE] = [];
    tabRows[MANAGED_LEAD_TABS.CONTACT] = [];
    tabRows[MANAGED_LEAD_TABS.ARCHIVE] = [];
    Object.keys(BOROUGH_VIEW_TABS).forEach(function(borough) {
    tabRows[BOROUGH_VIEW_TABS[borough]] = [];
     });


    readAllListings_()
      .filter(function(l) {
        return (
          String(l.alert_sent || '').toUpperCase() === 'TRUE' ||
          String(l.alert_sent_at || '').trim() !== '' ||
          isSentTimestamp_(l.alert_sent)
        );
      })
      .sort(function(a, b) {
        return String(b.alert_sent_at || b.detected_at || '').localeCompare(
          String(a.alert_sent_at || a.detected_at || '')
        );
      })
      .forEach(function(l) {
        var listingId = String(l.listing_id || '').trim();
        if (!listingId) return;


        var saved = stateMap[listingId] || {};


        var assignedRep = saved.assigned_rep || l.assigned_to || '';
        var lastContact = saved.last_contact || '';
        var status = normalizeSalesStatus_(saved.sales_status || l.outreach_status);
        var rating = saved.lead_rating || l.marketing_plan_status || '';


        if (LEAD_RATING_OPTIONS.indexOf(rating) === -1) rating = '';


       var projectedRevenue = cleanRevenueValue_(saved.projected_revenue);
       var soldRevenue = cleanRevenueValue_(saved.sold_revenue);



        var row = [
          l.alert_sent_at || '',
          assignedRep,
          lastContact,
          status,
          rating,
          l.price || '',
          l.address || '',
          l.area || '',
          l.neighborhood || '',
          l.broker_name || '',
          l.broker_phone || '',
          l.broker_email || '',
          l.listing_url || '',
          l.detected_at || '',
          listingId,
          projectedRevenue,
          soldRevenue
        ];


        var tabName = getLeadTabForStatus_(status);
        tabRows[tabName].push(row);
        if (tabName === MANAGED_LEAD_TABS.ACTIVE) {
    var borough = getListingBoroughForTabs_(l);

    if (BOROUGH_VIEW_TABS[borough]) {
    tabRows[BOROUGH_VIEW_TABS[borough]].push(row);
    }
     }
      });


    [
  MANAGED_LEAD_TABS.ACTIVE,
  MANAGED_LEAD_TABS.CONTACT,
  MANAGED_LEAD_TABS.ARCHIVE,
  BOROUGH_VIEW_TABS.Brooklyn,
  BOROUGH_VIEW_TABS.Queens,
  BOROUGH_VIEW_TABS.Manhattan,
  BOROUGH_VIEW_TABS.Bronx,
  BOROUGH_VIEW_TABS['Staten Island']
].forEach(function(tabName) {
  refreshOneManagedLeadTab_(tabName, tabRows[tabName] || []);
});

SpreadsheetApp.flush();


  } finally {
    try {
      lock.releaseLock();
    } catch (e) {}
  }
}


function refreshOneManagedLeadTab_(tabName, rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
  }

  var width = MANAGED_LEAD_HEADERS.length;

  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }

  var maxRows = Math.max(sheet.getLastRow() - 1, 1);

sheet.getRange(2, 4, maxRows, 1).clearDataValidations(); // D
sheet.getRange(2, 5, maxRows, 1).clearDataValidations(); // E

  sheet
    .getRange(1, 1, 1, width)
    .setValues([MANAGED_LEAD_HEADERS])
    .setFontWeight('bold');

  sheet.setFrozenRows(1);

  var existingLastRow = sheet.getLastRow();

  if (existingLastRow > 1) {
    sheet.getRange(2, 1, existingLastRow - 1, width).clearContent();
  }

  if (rows.length) {
    var neededRows = rows.length + 2;

    if (sheet.getMaxRows() < neededRows) {
      sheet.insertRowsAfter(sheet.getMaxRows(), neededRows - sheet.getMaxRows());
    }

    sheet.getRange(2, 1, rows.length, width).setValues(rows);

    

    sheet.getRange(2, 16, rows.length, 2).setNumberFormat('$#,##0');
  }

    applyManagedLeadDropdowns_(sheet);

}

function applyManagedLeadDropdowns_(sheet) {
  var lastRow = sheet.getLastRow();

  // Covers current rows and leaves room for manual edits below current data.
  var dropdownRows = Math.max(lastRow - 1, 500);

  var statusValidationRange = sheet.getRange(2, 4, dropdownRows, 1); // D = Sales Status
  var ratingValidationRange = sheet.getRange(2, 5, dropdownRows, 1); // E = Lead Rating

  statusValidationRange.clearDataValidations();
  ratingValidationRange.clearDataValidations();

  var dataRows = Math.max(lastRow - 1, 0);

  if (dataRows > 0) {
    var statusRange = sheet.getRange(2, 4, dataRows, 1);
    var ratingRange = sheet.getRange(2, 5, dataRows, 1);

    var statusValues = statusRange.getValues().map(function(row) {
      var raw = String(row[0] || '').trim();
      return [raw ? normalizeSalesStatus_(raw) : 'Unassigned'];
    });

    statusRange.setValues(statusValues);

    var ratingValues = ratingRange.getValues().map(function(row) {
      var v = String(row[0] || '').trim();
      if (LEAD_RATING_OPTIONS.indexOf(v) === -1) v = '';
      return [v];
    });

    ratingRange.setValues(ratingValues);
  }

  var statusRule = SpreadsheetApp
    .newDataValidation()
    .requireValueInList(MANAGED_STATUS_OPTIONS, true)
    .setAllowInvalid(false)
    .build();

  var ratingRule = SpreadsheetApp
    .newDataValidation()
    .requireValueInList(LEAD_RATING_OPTIONS, true)
    .setAllowInvalid(false)
    .build();

  statusValidationRange.setDataValidation(statusRule);
  ratingValidationRange.setDataValidation(ratingRule);

  var rules = [
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Unassigned').setBackground('#fde2e2').setRanges([statusValidationRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Assigned').setBackground('#fff2cc').setRanges([statusValidationRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Prospecting').setBackground('#d9eaf7').setRanges([statusValidationRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Contact made').setBackground('#d9ead3').setRanges([statusValidationRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Non-responsive').setBackground('#fce5cd').setRanges([statusValidationRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Won').setBackground('#b6d7a8').setRanges([statusValidationRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Lost').setBackground('#e6e6e6').setRanges([statusValidationRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Skipped').setBackground('#eeeeee').setRanges([statusValidationRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Bounced').setBackground('#d9d2e9').setRanges([statusValidationRange]).build()
  ];

  sheet.setConditionalFormatRules(rules);
}


function onEdit(e) {
  try {
    syncManagedLeadEdit_(e);
  } catch (err) {
    Logger.log('syncManagedLeadEdit_ failed: ' + err.message);
  }
}


function syncManagedLeadEdit_(e) {
  if (!e || !e.range) return;


  var sheet = e.range.getSheet();
  var sheetName = sheet.getName();


  var allowedTabs = getManagedLeadAllowedTabs_();


  if (allowedTabs.indexOf(sheetName) === -1) return;


  var row = e.range.getRow();
  var col = e.range.getColumn();


  if (row < 2) return;


  // B = Assigned Rep, C = Last Contact, D = Sales Status, E = Lead Rating,
  // P = Projected Revenue, Q = Sold Revenue
  if ([2, 3, 4, 5, 16, 17].indexOf(col) === -1) return;


  var values = sheet
    .getRange(row, 1, 1, MANAGED_LEAD_HEADERS.length)
    .getValues()[0];


  var listingId = String(values[14] || '').trim();       // O
  var assignedRep = String(values[1] || '').trim();      // B
  var lastContact = formatLeadDate_(values[2]);          // C
  var status = normalizeSalesStatus_(values[3]);         // D
  var rating = String(values[4] || '').trim();           // E
  var projectedRevenue = cleanRevenueValue_(values[15]); // P
  var soldRevenue = cleanRevenueValue_(values[16]);      // Q


  if (!listingId) return;


  saveLeadState_(
    listingId,
    assignedRep,
    lastContact,
    status,
    rating,
    projectedRevenue,
    soldRevenue
  );


  try {
    syncListingLogLeadFields_(listingId, assignedRep, status, rating);
  } catch (err) {
    Logger.log('syncListingLogLeadFields_ failed: ' + err.message);
  }


  try {
    notifyAssignedLeadFromValues_(values);
  } catch (err2) {
    Logger.log('notifyAssignedLeadFromValues_ failed: ' + err2.message);
  }
}


function syncListingLogLeadFields_(listingId, assignedRep, status, rating) {
  var listingsSheet = getSheet_(CONFIG.SHEETS.LISTINGS_LOG);
  var listingRow = findListingRowIndex_(listingsSheet, listingId);


  if (listingRow === -1) return;


  var headers = CONFIG.HEADERS.LISTINGS_LOG;


  var assignedCol = headers.indexOf('assigned_to') + 1;
  var statusCol = headers.indexOf('outreach_status') + 1;
  var ratingCol = headers.indexOf('marketing_plan_status') + 1;


  if (assignedCol > 0) listingsSheet.getRange(listingRow, assignedCol).setValue(assignedRep || '');
  if (statusCol > 0) listingsSheet.getRange(listingRow, statusCol).setValue(normalizeSalesStatus_(status));
  if (ratingCol > 0) listingsSheet.getRange(listingRow, ratingCol).setValue(rating || '');
}


function notifyAssignedLeadFromValues_(values) {
  var assignedRep = String(values[1] || '').trim();
  var status = String(values[3] || '').trim();
  var price = values[5];
  var address = values[6];
  var area = values[7];
  var neighborhood = values[8];
  var broker = values[9];
  var phone = values[10];
  var email = values[11];
  var url = values[12];
  var listingId = String(values[14] || '').trim();


  if (status !== 'Assigned') return;
  if (!listingId) return;
  if (!isValidEmail_(assignedRep)) return;


  var props = PropertiesService.getScriptProperties();
  var key = 'assigned_notice_' + listingId + '_' + assignedRep;


  if (props.getProperty(key)) return;


  var body = [
    'A listing has been assigned to you.',
    '',
    'Price: ' + price,
    'Address: ' + address,
    'Area: ' + area,
    'Neighborhood: ' + neighborhood,
    'Broker: ' + broker,
    'Phone: ' + phone,
    'Email: ' + email,
    '',
    'View Listing:',
    url,
    '',
    'Listing ID: ' + listingId
  ].join('\n');


  MailApp.sendEmail({
    to: assignedRep,
    subject: 'Assigned Listing: ' + address,
    body: body,
    name: CONFIG.APP_NAME
  });


  props.setProperty(key, nowIso_());
}


function sendTestAssignmentEmailFromSelectedRow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  var sheetName = sheet.getName();


  var allowedTabs = getManagedLeadAllowedTabs_();

  if (allowedTabs.indexOf(sheetName) === -1) {
    throw new Error('Go to a managed alert tab and select a listing row first.');
  }


  var row = sheet.getActiveRange().getRow();


  if (row < 2) {
    throw new Error('Select a listing row, not the header.');
  }


  var values = sheet
    .getRange(row, 1, 1, MANAGED_LEAD_HEADERS.length)
    .getValues()[0];


  notifyAssignedLeadFromValues_(values);


  ss.toast('Assignment email test ran. Check the assigned email inbox.', 'Luxury Listings', 5);
}


function formatLeadDate_(value) {
  if (!value) return '';


  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }


  return String(value || '').trim();
}


function captureLeadStateFromManagedTabs_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();


  var tabs = getManagedLeadAllowedTabs_();


  tabs.forEach(function(tabName) {
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) return;


    if (sheet.getMaxColumns() < MANAGED_LEAD_HEADERS.length) {
      sheet.insertColumnsAfter(
        sheet.getMaxColumns(),
        MANAGED_LEAD_HEADERS.length - sheet.getMaxColumns()
      );
    }


    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;


    var rows = sheet
      .getRange(2, 1, lastRow - 1, MANAGED_LEAD_HEADERS.length)
      .getValues();


    rows.forEach(function(values) {
      var listingId = String(values[14] || '').trim();       // O
      var assignedRep = String(values[1] || '').trim();      // B
      var lastContact = formatLeadDate_(values[2]);          // C
      var status = normalizeSalesStatus_(values[3]);         // D
      var rating = String(values[4] || '').trim();           // E
      var projectedRevenue = cleanRevenueValue_(values[15]); // P
      var soldRevenue = cleanRevenueValue_(values[16]);      // Q


      if (!listingId) return;


      saveLeadState_(
        listingId,
        assignedRep,
        lastContact,
        status,
        rating,
        projectedRevenue,
        soldRevenue
      );
    });
  });
}


function isSentTimestamp_(value) {
  var s = String(value || '').trim();


  if (!s) return false;
  if (s.toUpperCase() === 'FALSE') return false;
  if (s.toUpperCase() === 'TRUE') return true;


  return /^\d{4}-\d{2}-\d{2}/.test(s) || /\d{1,2}:\d{2}/.test(s);
}


/**
 * TEST — revenue setup only.
 * Run after replacing this file:
 * testRevenueColumns_NoWrite()
 */
function testRevenueColumns_NoWrite() {
  Logger.log('=== Revenue Columns Test — No Writes ===');


  var ss = SpreadsheetApp.getActiveSpreadsheet();


  var tabs = [
    MANAGED_LEAD_TABS.ACTIVE,
    MANAGED_LEAD_TABS.CONTACT,
    MANAGED_LEAD_TABS.ARCHIVE
  ];


  tabs.forEach(function(tabName) {
    var sheet = ss.getSheetByName(tabName);


    if (!sheet) {
      Logger.log('MISSING TAB: ' + tabName);
      return;
    }


    var headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0];


    Logger.log('');
    Logger.log('Tab: ' + tabName);
    Logger.log('Projected Revenue column: ' + (headers.indexOf('Projected Revenue') + 1));
    Logger.log('Sold Revenue column: ' + (headers.indexOf('Sold Revenue') + 1));


    if (headers.indexOf('Projected Revenue') === -1) {
      throw new Error(tabName + ' missing Projected Revenue header');
    }


    if (headers.indexOf('Sold Revenue') === -1) {
      throw new Error(tabName + ' missing Sold Revenue header');
    }
  });


  var leadState = ss.getSheetByName(LEAD_STATE_SHEET_NAME);


  if (!leadState) {
    throw new Error('Lead_State missing');
  }


  var leadHeaders = leadState
    .getRange(1, 1, 1, leadState.getLastColumn())
    .getValues()[0];


  if (leadHeaders.indexOf('projected_revenue') === -1) {
    throw new Error('Lead_State missing projected_revenue');
  }


  if (leadHeaders.indexOf('sold_revenue') === -1) {
    throw new Error('Lead_State missing sold_revenue');
  }


  Logger.log('');
  Logger.log('PASS: Revenue headers exist on managed tabs and Lead_State.');
}


/**
 * TEST — revenue cleaner.
 * Run:
 * testCleanRevenueValue_()
 */
function testCleanRevenueValue_() {
  Logger.log('=== cleanRevenueValue_ Test ===');


  var cases = [
    { input: '', expected: '' },
    { input: null, expected: '' },
    { input: '$5,000', expected: 5000 },
    { input: '5000', expected: 5000 },
    { input: '5,000.50', expected: 5000.5 },
    { input: 'abc', expected: '' }
  ];


  cases.forEach(function(c) {
    var actual = cleanRevenueValue_(c.input);


    if (actual !== c.expected) {
      throw new Error(
        'Failed for input "' + c.input + '". Expected "' +
        c.expected + '", got "' + actual + '"'
      );
    }


    Logger.log('PASS: ' + c.input + ' → ' + actual);
  });


  Logger.log('PASS: cleanRevenueValue_ works.');
}

function testBoroughAlertTabs_ConfigOnly() {
  Logger.log('=== Borough Alert Tabs Config Test ===');

  var expected = {
    Brooklyn: 'BK_Alert',
    Queens: 'QNS_Alert',
    Bronx: 'BX_Alert',
    Manhattan: 'MHTN_Alert',
    'Staten Island': 'SI_Alert'
  };

  Object.keys(expected).forEach(function(borough) {
    if (BOROUGH_VIEW_TABS[borough] !== expected[borough]) {
      throw new Error(
        'Wrong tab for ' + borough +
        '. Expected ' + expected[borough] +
        ', got ' + BOROUGH_VIEW_TABS[borough]
      );
    }

    Logger.log('PASS: ' + borough + ' → ' + expected[borough]);
  });

  var allowedTabs = getManagedLeadAllowedTabs_();

  Object.keys(expected).forEach(function(borough) {
    var tabName = expected[borough];

    if (allowedTabs.indexOf(tabName) === -1) {
      throw new Error(tabName + ' missing from managed editable tabs.');
    }

    Logger.log('PASS: ' + tabName + ' is editable.');
  });

  Logger.log('PASS: Borough alert tab config is valid.');
}

function repairListingsLogOutreachStatusColorsOnly() {
  var sheet = getSheet_(CONFIG.SHEETS.LISTINGS_LOG);
  var headers = CONFIG.HEADERS.LISTINGS_LOG;

  var statusCol = headers.indexOf('outreach_status') + 1;

  if (statusCol <= 0) {
    throw new Error('Listings_Log missing outreach_status column.');
  }

  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    Logger.log('Listings_Log has no data rows.');
    return;
  }

  var statusRange = sheet.getRange(2, statusCol, lastRow - 1, 1);

  var existingRules = sheet.getConditionalFormatRules();

  var keptRules = existingRules.filter(function(rule) {
    return !rule.getRanges().some(function(range) {
      return (
        range.getSheet().getName() === sheet.getName() &&
        range.getColumn() === statusCol
      );
    });
  });

  var newRules = [
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Unassigned').setBackground('#fde2e2').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Assigned').setBackground('#fff2cc').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Prospecting').setBackground('#d9eaf7').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Contact made').setBackground('#d9ead3').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Non-responsive').setBackground('#fce5cd').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Won').setBackground('#b6d7a8').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Lost').setBackground('#e6e6e6').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Skipped').setBackground('#eeeeee').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Bounced').setBackground('#d9d2e9').setRanges([statusRange]).build()
  ];

  sheet.setConditionalFormatRules(keptRules.concat(newRules));
  SpreadsheetApp.flush();

  Logger.log(
    'DONE: Listings_Log outreach_status colors applied. Column: ' +
    statusCol +
    ', rows: ' +
    (lastRow - 1)
  );
}