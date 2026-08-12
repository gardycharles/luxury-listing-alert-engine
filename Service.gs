/**
 * Service.gs
 * CONFIG and all backend services. No duplicates — every name appears exactly once.
 * 
 * FIXES APPLIED:
 * - Added markedSentCount tracking in performScan_()
 * - Increment markedSentCount after each successful markAlertSent_()
 * - Call refreshManagedLeadTabs() ONCE at end of performScan_() if markedSentCount > 0
 * - This moves refresh from onEdit (which caused lock contention) to scan completion
 */

// =====================================================================
//   CONFIG
// =====================================================================

const CONFIG = Object.freeze({
  APP_NAME: 'Luxury Listing Alert Engine',
  API_BASE_URL: PropertiesService.getScriptProperties().getProperty('LISTING_API_BASE_URL') || 'https://api.example.com/listings',

  SHEETS: {
    SETTINGS:       'Settings',
    RECIPIENTS:     'Recipients',
    LISTINGS_LOG:   'Listings_Log',
    OUTREACH_LOG:   'Outreach_Log',
    ERROR_LOG:      'Error_Log',
    SAVED_SEARCHES: 'Saved_Searches'
  },

  HEADERS: {
    SETTINGS: ['key', 'value', 'notes'],

    RECIPIENTS: [
      'recipient_id','name','email',
      'min_price','area_filter','neighborhood_filter','active','created_at'
    ],

    LISTINGS_LOG: [
      'listing_id','source','source_namespace',
      'title','address','area','neighborhood',
      'price','bedrooms','bathrooms',
      'property_type','sale_status',
      'created_date','detected_at',
      'listing_url','image_url',
      'alert_sent','alert_sent_at',
      'assigned_to','outreach_status','marketing_plan_status',
      'notes','broker_name','broker_phone','broker_email','broker_details','raw_json'
    ],

    OUTREACH_LOG: [
      'outreach_id','listing_id','assigned_to',
      'first_contacted_at','outreach_status','marketing_angle',
      'follow_up_date','notes','created_at','updated_at'
    ],

    ERROR_LOG: ['timestamp','function','message','details'],

    SAVED_SEARCHES: [
      'search_id','search_name','min_price','max_price',
      'area','neighborhood','namespace','property_category','listing_type',
      'sale_status','alert_timing','active','created_at'
    ]
  },

  DEFAULT_SETTINGS: [
    { key: 'system_enabled',  value: 'TRUE',                              notes: 'Master switch: TRUE/FALSE.' },
    { key: 'min_price',       value: '1000000',                           notes: 'Minimum listing price (USD).' },
    { key: 'max_price',       value: '9999999999',                        notes: 'Maximum listing price (USD).' },
    { key: 'rows_per_scan',   value: '20',                                notes: 'Listings fetched per scan.' },
    { key: 'page',            value: '1',                                 notes: 'API page number.' },
    { key: 'namespace',       value: '(PRIMARY_FEED OR PARTNER_FEED_A OR PARTNER_FEED_B)', notes: 'Source namespace.' },
    { key: 'area',            value: '',                                  notes: 'Optional area filter.' },
    { key: 'neighborhood', value: '', notes: 'Optional neighborhood filter.' },
    { key: 'email_mode',      value: 'instant',                           notes: 'instant | batch_15 | batch_30 | hourly' },
    { key: 'last_scan_time',  value: '',                                  notes: 'Last successful scan.' }
  ],

  OUTREACH_STATUSES: ['Unassigned','Assigned','Prospecting','Contact made','Non-responsive','Won','Lost','Skipped','Bounced'],

  ALERT_TIMING_OPTIONS: [
    { value: 'instant',  label: 'Instant alert for every new listing' },
    { value: 'batch_15', label: 'Batch alerts every 15 minutes' },
    { value: 'batch_30', label: 'Batch alerts every 30 minutes' },
    { value: 'hourly',   label: 'Hourly digest' }
  ],

  ACTIVE_SALE_STATUSES:   ['active','available'],
  SCAN_TRIGGER_FUNCTION:  'runScanNow',
  SCAN_TRIGGER_MINUTES:   1,
  MAX_ERROR_DETAILS_LEN:  5000,
  LOCK_TIMEOUT_MS:        30000
});

// =====================================================================
//   GENERAL UTILITIES
// =====================================================================

function nowIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}
function todayDateString_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
function parseBool_(v) {
  if (v === true) return true;
  if (v === false || v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}
function isValidEmail_(s) {
  if (!s) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
}
function isValidPrice_(v) {
  if (v === '' || v === null || v === undefined) return false;
  const n = Number(v);
  return !isNaN(n) && isFinite(n) && n >= 0;
}
function numeric_(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}
function formatPrice_(n) {
  const num = numeric_(n);
  if (!num) return '$—';
  return '$' + Math.round(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function safeStringify_(obj) {
  try { return JSON.stringify(obj); }
  catch (e) {
    try {
      const seen = [];
      return JSON.stringify(obj, function(_k, v) {
        if (typeof v === 'object' && v !== null) {
          if (seen.indexOf(v) !== -1) return '[Circular]';
          seen.push(v);
        }
        return v;
      });
    } catch (e2) { return ''; }
  }
}
function truncate_(s, n) { s = String(s||''); return s.length > n ? s.slice(0,n) : s; }
function pickFirst_(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}
function isArrayOfObjects_(v) {
  return Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null;
}
function fallbackListingId_(parts) {
  const seed = parts.map(function(p){ return String(p==null?'':p); }).join('|');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    let h = (bytes[i] & 0xFF).toString(16);
    if (h.length < 2) h = '0' + h;
    hex += h;
  }
  return 'fbk_' + hex.slice(0,16);
}
function formatDateString_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  return String(v).trim();
}

// =====================================================================
//   SHEET SERVICE
// =====================================================================

function ensureAllSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No active spreadsheet.');
  ensureSheet_(ss, CONFIG.SHEETS.SETTINGS,       CONFIG.HEADERS.SETTINGS);
  ensureSheet_(ss, CONFIG.SHEETS.RECIPIENTS,     CONFIG.HEADERS.RECIPIENTS);
  ensureSheet_(ss, CONFIG.SHEETS.LISTINGS_LOG,   CONFIG.HEADERS.LISTINGS_LOG);
  ensureSheet_(ss, CONFIG.SHEETS.OUTREACH_LOG,   CONFIG.HEADERS.OUTREACH_LOG);
  ensureSheet_(ss, CONFIG.SHEETS.ERROR_LOG,      CONFIG.HEADERS.ERROR_LOG);
  ensureSheet_(ss, CONFIG.SHEETS.SAVED_SEARCHES, CONFIG.HEADERS.SAVED_SEARCHES);
  seedDefaultSettings_();
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const lastCol = sheet.getLastColumn();
  if (lastCol < headers.length || sheet.getLastRow() === 0) {
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
  } else {
    const current = sheet.getRange(1,1,1,headers.length).getValues()[0];
    let mismatch = false;
    for (let i = 0; i < headers.length; i++) {
      if (current[i] !== headers[i]) { mismatch = true; break; }
    }
    if (mismatch) sheet.getRange(1,1,1,headers.length).setValues([headers]);
  }
  sheet.setFrozenRows(1);
  sheet.getRange(1,1,1,headers.length).setFontWeight('bold');
  return sheet;
}

function seedDefaultSettings_() {
  const sheet = getSheet_(CONFIG.SHEETS.SETTINGS);
  const existing = readAllRows_(sheet);
  const existingKeys = {};
  for (let i = 0; i < existing.length; i++) existingKeys[existing[i].key] = true;
  const toAppend = [];
  for (let i = 0; i < CONFIG.DEFAULT_SETTINGS.length; i++) {
    const def = CONFIG.DEFAULT_SETTINGS[i];
    if (!existingKeys[def.key]) toAppend.push([def.key, def.value, def.notes]);
  }
  if (toAppend.length) sheet.getRange(sheet.getLastRow()+1,1,toAppend.length,3).setValues(toAppend);
}

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name + '. Run Setup.');
  return sheet;
}
function readAllRows_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  const headers = sheet.getRange(1,1,1,lastCol).getValues()[0].map(function(h) {
    return String(h == null ? '' : h).trim();
  });
  const values = sheet.getRange(2,1,lastRow-1,lastCol).getValues();

  return values
    .map(function(row) { return rowToObject_(headers, row); })
    .filter(function(obj) {
      return Object.keys(obj).some(function(k) {
        return obj[k] !== '' && obj[k] !== null && obj[k] !== undefined;
      });
    });
}

function rowToObject_(headers, row) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h) continue;
    obj[h] = cellToClientValue_(row[i]);
  }
  return obj;
}

function cellToClientValue_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  if (v === undefined || v === null) return '';

  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v;

  return String(v);
}

function objectToRow_(headers, obj) {
  const row = [];
  for (let i = 0; i < headers.length; i++) {
    let v = obj[headers[i]];
    if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    row.push(v === undefined || v === null ? '' : v);
  }
  return row;
}
function appendObjectRow_(sheet, headers, obj) { sheet.appendRow(objectToRow_(headers, obj)); }

// ---- Settings -------------------------------------------------------
function getSettings_() {
  const rows = readAllRows_(getSheet_(CONFIG.SHEETS.SETTINGS));
  const out = {};
  for (let i = 0; i < rows.length; i++) out[rows[i].key] = rows[i].value;
  return out;
}
function setSetting_(key, value) {
  const sheet = getSheet_(CONFIG.SHEETS.SETTINGS);
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const range = sheet.getRange(2,1,lastRow-1,1).getValues();
    for (let i = 0; i < range.length; i++) {
      if (range[i][0] === key) { sheet.getRange(i+2,2).setValue(value); return; }
    }
  }
  sheet.appendRow([key, value, '']);
}

// ---- Listings -------------------------------------------------------
function readAllListings_() { return readAllRows_(getSheet_(CONFIG.SHEETS.LISTINGS_LOG)); }

function appendListing_(listing) {
  const sheet = getSheet_(CONFIG.SHEETS.LISTINGS_LOG);
  appendObjectRow_(sheet, CONFIG.HEADERS.LISTINGS_LOG, {
    listing_id:             listing.listing_id || '',
    source:                 listing.source || '',
    source_namespace:       listing.source_namespace || '',
    title:                  listing.title || '',
    address:                listing.address || '',
    area:                   listing.area || '',
    neighborhood:           listing.neighborhood || '',
    price:                  listing.price || 0,
    bedrooms:               listing.bedrooms || 0,
    bathrooms:              listing.bathrooms || 0,
    property_type:          listing.property_type || '',
    sale_status:            listing.sale_status || '',
    created_date:           listing.created_date || '',
    detected_at:            listing.detected_at || nowIso_(),
    listing_url:            listing.listing_url || '',
    image_url:              '',
    alert_sent:             'FALSE',
    alert_sent_at:          '',
    assigned_to:            '',
    outreach_status:        'Unassigned',
    marketing_plan_status:  '',
    notes:                  '',
    broker_name:            listing.broker_name || '',
    broker_phone:           listing.broker_phone || '',
    broker_email:           listing.broker_email || '',
    broker_details:         listing.broker_details || '',
    raw_json:               ''
  });

  try {
    applyListingSheetLinks_(sheet, sheet.getLastRow(), listing);
  } catch (e) {
    Logger.log('applyListingSheetLinks_ failed (non-critical): ' + e.message);
  }
}

function applyListingSheetLinks_(sheet, rowNum, listing) {
  const headers = CONFIG.HEADERS.LISTINGS_LOG;

  try {
    const urlColIdx = headers.indexOf('listing_url') + 1;
    if (urlColIdx > 0) {
      sheet.getRange(rowNum, urlColIdx).setValue(String(listing.listing_url || '').trim());
    }
  } catch (e) {
    Logger.log('listing_url write skipped: ' + e.message);
  }

  try {
    const addrColIdx = headers.indexOf('address') + 1;
    if (addrColIdx > 0) {
      sheet.getRange(rowNum, addrColIdx).setValue(String(listing.address || '').trim());
    }
  } catch (e) {
    Logger.log('address write skipped: ' + e.message);
  }

  try {
    const phoneColIdx = headers.indexOf('broker_phone') + 1;
    if (phoneColIdx > 0) {
      sheet.getRange(rowNum, phoneColIdx).setValue(String(listing.broker_phone || '').trim());
    }
  } catch (e) {
    Logger.log('broker_phone write skipped: ' + e.message);
  }
}

function findListingRowIndex_(sheet, listingId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2,1,lastRow-1,1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(listingId)) return i+2;
  }
  return -1;
}
function updateListingFields_(listingId, fields) {
  const sheet = getSheet_(CONFIG.SHEETS.LISTINGS_LOG);
  const rowIdx = findListingRowIndex_(sheet, listingId);
  if (rowIdx === -1) throw new Error('Listing not found: ' + listingId);
  const headers = CONFIG.HEADERS.LISTINGS_LOG;
  const current = sheet.getRange(rowIdx,1,1,headers.length).getValues()[0];
  const obj = rowToObject_(headers, current);
  Object.keys(fields).forEach(function(k) {
    if (fields[k] !== undefined && headers.indexOf(k) !== -1) obj[k] = fields[k];
  });
  sheet.getRange(rowIdx,1,1,headers.length).setValues([objectToRow_(headers, obj)]);
  return obj;
}
function markAlertSent_(listingId) {
  return updateListingFields_(listingId, { alert_sent:'TRUE', alert_sent_at: nowIso_() });
}

// ---- Recipients -----------------------------------------------------
function readAllRecipients_() { return readAllRows_(getSheet_(CONFIG.SHEETS.RECIPIENTS)); }
function appendRecipient_(recipient) {
  appendObjectRow_(getSheet_(CONFIG.SHEETS.RECIPIENTS), CONFIG.HEADERS.RECIPIENTS, recipient);
}
function updateRecipient_(recipientId, fields) {
  const sheet = getSheet_(CONFIG.SHEETS.RECIPIENTS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('No recipients found.');
  const headers = CONFIG.HEADERS.RECIPIENTS;
  const all = sheet.getRange(2,1,lastRow-1,headers.length).getValues();
  for (let i = 0; i < all.length; i++) {
    if (String(all[i][0]) === String(recipientId)) {
      const obj = rowToObject_(headers, all[i]);
      Object.keys(fields).forEach(function(k) {
        if (fields[k] !== undefined && headers.indexOf(k) !== -1) obj[k] = fields[k];
      });
      sheet.getRange(i+2,1,1,headers.length).setValues([objectToRow_(headers, obj)]);
      return obj;
    }
  }
  throw new Error('Recipient not found: ' + recipientId);
}
function deleteRecipient_(recipientId) {
  const sheet = getSheet_(CONFIG.SHEETS.RECIPIENTS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('No recipients found.');
  const ids = sheet.getRange(2,1,lastRow-1,1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(recipientId)) { sheet.deleteRow(i+2); return true; }
  }
  throw new Error('Recipient not found: ' + recipientId);
}

// ---- Outreach -------------------------------------------------------
function readAllOutreach_() { return readAllRows_(getSheet_(CONFIG.SHEETS.OUTREACH_LOG)); }
function findLatestOutreachByListingId_(listingId) {
  const all = readAllOutreach_();
  let latest = null;
  for (let i = 0; i < all.length; i++) {
    if (String(all[i].listing_id) !== String(listingId)) continue;
    if (!latest || String(all[i].updated_at||'') > String(latest.updated_at||'')) latest = all[i];
  }
  return latest;
}
function upsertOutreachEntry_(entry) {
  const sheet = getSheet_(CONFIG.SHEETS.OUTREACH_LOG);
  const headers = CONFIG.HEADERS.OUTREACH_LOG;
  const lastRow = sheet.getLastRow();
  let existingRow = -1;
  if (lastRow >= 2) {
    const all = sheet.getRange(2,1,lastRow-1,headers.length).getValues();
    for (let i = all.length-1; i >= 0; i--) {
      if (String(all[i][headers.indexOf('listing_id')]) === String(entry.listing_id)) {
        existingRow = i+2; break;
      }
    }
  }
  const now = nowIso_();
  if (existingRow === -1) {
    const newEntry = {
      outreach_id:        'o_' + Utilities.getUuid().slice(0,8),
      listing_id:         entry.listing_id,
      assigned_to:        entry.assigned_to || '',
      first_contacted_at: entry.outreach_status === 'Prospecting' || entry.outreach_status === 'Contact made' ? now : '',
      outreach_status:    entry.outreach_status || 'Unassigned',
      marketing_angle:    entry.marketing_angle || '',
      follow_up_date:     entry.follow_up_date || '',
      notes:              entry.notes || '',
      created_at:         now,
      updated_at:         now
    };
    appendObjectRow_(sheet, headers, newEntry);
    return newEntry;
  }
  const current = sheet.getRange(existingRow,1,1,headers.length).getValues()[0];
  const obj = rowToObject_(headers, current);
  if (entry.assigned_to     !== undefined && entry.assigned_to     !== '') obj.assigned_to     = entry.assigned_to;
  if (entry.outreach_status !== undefined && entry.outreach_status !== '') obj.outreach_status = entry.outreach_status;
  if (entry.marketing_angle !== undefined && entry.marketing_angle !== '') obj.marketing_angle = entry.marketing_angle;
  if (entry.follow_up_date  !== undefined && entry.follow_up_date  !== '') obj.follow_up_date  = entry.follow_up_date;
  if (entry.notes           !== undefined && entry.notes           !== '') obj.notes           = entry.notes;
  if (
    (entry.outreach_status === 'Prospecting' || entry.outreach_status === 'Contact made') &&
    !obj.first_contacted_at
  ) {
    obj.first_contacted_at = now;
  }
  obj.updated_at = now;
  sheet.getRange(existingRow,1,1,headers.length).setValues([objectToRow_(headers, obj)]);
  return obj;
}

// ---- Saved Searches -------------------------------------------------
function readAllSavedSearches_() { return readAllRows_(getSheet_(CONFIG.SHEETS.SAVED_SEARCHES)); }
function appendSavedSearch_(search) {
  appendObjectRow_(getSheet_(CONFIG.SHEETS.SAVED_SEARCHES), CONFIG.HEADERS.SAVED_SEARCHES, search);
}
function updateSavedSearch_(searchId, fields) {
  const sheet = getSheet_(CONFIG.SHEETS.SAVED_SEARCHES);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('No saved searches found.');
  const headers = CONFIG.HEADERS.SAVED_SEARCHES;
  const all = sheet.getRange(2,1,lastRow-1,headers.length).getValues();
  for (let i = 0; i < all.length; i++) {
    if (String(all[i][0]) === String(searchId)) {
      const obj = rowToObject_(headers, all[i]);
      Object.keys(fields).forEach(function(k) {
        if (fields[k] !== undefined && headers.indexOf(k) !== -1) obj[k] = fields[k];
      });
      sheet.getRange(i+2,1,1,headers.length).setValues([objectToRow_(headers, obj)]);
      return obj;
    }
  }
  throw new Error('Saved search not found: ' + searchId);
}
function deleteSavedSearch_(searchId) {
  const sheet = getSheet_(CONFIG.SHEETS.SAVED_SEARCHES);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('No saved searches found.');
  const ids = sheet.getRange(2,1,lastRow-1,1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(searchId)) { sheet.deleteRow(i+2); return true; }
  }
  throw new Error('Saved search not found: ' + searchId);
}

// ---- Errors ---------------------------------------------------------
function readRecentErrors_(limit) {
  const all = readAllRows_(getSheet_(CONFIG.SHEETS.ERROR_LOG));
  all.sort(function(a,b){ return String(b.timestamp||'').localeCompare(String(a.timestamp||'')); });
  return all.slice(0, limit||50);
}

// =====================================================================
//   SOURCE SERVICE
// =====================================================================

function fetchListings_(settings) {
  const url = buildListingApiUrl_(settings);
  let response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'get', muteHttpExceptions: true,
      followRedirects: true, headers: { 'Accept': 'application/json' }
    });
  } catch (err) {
    logError_('fetchListings_.UrlFetchApp', err.message, url);
    throw new Error('API request failed: ' + err.message);
  }
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code < 200 || code >= 300) {
    logError_('fetchListings_.badStatus', 'HTTP ' + code, url + '\n\n' + (body||'').slice(0, CONFIG.MAX_ERROR_DETAILS_LEN));
    throw new Error('API returned HTTP ' + code);
  }
  let json;
  try { json = JSON.parse(body); }
  catch (err) {
    logError_('fetchListings_.parseJson', err.message, (body||'').slice(0, CONFIG.MAX_ERROR_DETAILS_LEN));
    throw new Error('API returned non-JSON response.');
  }
  const listings = extractListingsArray_(json);
  return Array.isArray(listings) ? listings : [];
}

function buildListingApiUrl_(settings) {
  const base      = CONFIG.API_BASE_URL;
  const rows      = numeric_(settings.rows_per_scan) || 20;
  const page      = numeric_(settings.page) || 1;
  const minPrice  = numeric_(settings.min_price) || 1000000;
  const maxPrice  = numeric_(settings.max_price) || 9999999999;
  const namespace = settings.namespace || '(PRIMARY_FEED OR PARTNER_FEED_A OR PARTNER_FEED_B)';
  const area      = (settings.area||'').toString().trim();
  const params    = [];
  params.push('rows=' + encodeURIComponent(rows));
  params.push('page=' + encodeURIComponent(page));
  params.push('namespace=' + encodeURIComponent(namespace));
  params.push('query[listing_type]=sale');
  params.push('query[price][]=' + encodeURIComponent(minPrice));
  params.push('query[price][]=' + encodeURIComponent(maxPrice));
  params.push('query[search_string]=');
  params.push('query[pg]=' + encodeURIComponent(page));
  params.push('query[rp]=' + encodeURIComponent(rows));
  params.push('query[sort_by]=' + encodeURIComponent('created_date desc'));
  params.push('query[property_category]=residential');
  params.push('query[source_namespace]=' + encodeURIComponent(namespace));
  params.push('query[sale_status][]=active');
  params.push('query[sale_status][]=available');
  if (area) params.push('query[area]=' + encodeURIComponent(area));
  return base + '?' + params.join('&');
}

function extractListingsArray_(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  const candidates = [
    json.listings, json.data && json.data.listings, json.data && json.data.results,
    json.data && json.data.items, json.data && json.data.rows,
    Array.isArray(json.data) ? json.data : null,
    json.results, json.items, json.rows,
    json.response && json.response.listings, json.response && json.response.results,
    json.response && json.response.data
  ];
  for (let i = 0; i < candidates.length; i++) {
    if (isArrayOfObjects_(candidates[i])) return candidates[i];
  }
  return findFirstArrayOfObjects_(json, 0) || [];
}

function findFirstArrayOfObjects_(node, depth) {
  if (depth > 10 || !node || typeof node !== 'object') return null;
  if (isArrayOfObjects_(node)) return node;
  if (Array.isArray(node)) return null;
  for (const k in node) {
    if (Object.prototype.hasOwnProperty.call(node, k)) {
      const found = findFirstArrayOfObjects_(node[k], depth+1);
      if (found) return found;
    }
  }
  return null;
}

// =====================================================================
//   LISTING NORMALIZER
// =====================================================================

function resolveListingUrl_(raw) {
  var primarySourceUrl = findPrimarySourceUrl_(raw);
  if (primarySourceUrl) return primarySourceUrl;

  var fallbackAddress = cleanText_(pickFirst_(raw, [
    'full_street_address',
    'primary_full_street_address',
    'display_full_street_address',
    'full_address',
    'display_address',
    'street_address',
    'unparsed_address',
    'addr',
    'address'
  ]));

  if (fallbackAddress) {
    return 'https://example.com/real-estate/sale/';
  }

  var displayName = cleanText_(pickFirst_(raw, [
    'display_name',
    'title',
    'name'
  ]));

  if (displayName) {
    return 'https://example.com/real-estate/sale/?s=' + encodeURIComponent(displayName);
  }

  return 'https://example.com/real-estate/sale/';
}

function findPrimarySourceUrl_(raw) {
  var urls = [];

  [
    'website',
    'source_url',
    'property_url',
    'listing_url',
    'url',
    'permalink',
    'web_url',
    'detail_url',
    'link',
    'source_data_json',
    'sources_json',
    'source_providers_json'
  ].forEach(function(k) {
    collectUrlsFromValue_(raw[k], urls, 0);
  });

  for (var i = 0; i < urls.length; i++) {
    var u = normalizeHttpUrl_(urls[i]);
    var lower = String(u || '').toLowerCase();

    if (
      u &&
      isGoodListingUrl_(u) &&
      lower.indexOf('example.com/listing/') !== -1
    ) {
      return u;
    }
  }

  for (var j = 0; j < urls.length; j++) {
    var mp = normalizeHttpUrl_(urls[j]);
    var match = String(mp || '').match(/listingprovider\.com\/listing\/([^?#]+)/i);

    if (match && match[1]) {
      var path = String(match[1]).replace(/^\/+|\/+$/g, '');
      return 'https://example.com/listing/' + path + '/';
    }
  }

  var listingKey = cleanText_(pickFirst_(raw, [
    'listing_key',
    'source_listing_key',
    'source_key',
    'listing_source_key',
    'external_listing_key',
    'external_id',
    'source_id',
    'source_listing_id',
    'provider_listing_id',
    'mls_id',
    'mlsId'
  ]));

  if (!listingKey) {
    var rawText = safeStringify_(raw);
    var keyMatch = rawText.match(/\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-\d{5,}\b/);
    if (keyMatch) {
      listingKey = keyMatch[0];
    }
  }

  var address = cleanText_(pickFirst_(raw, [
    'full_street_address',
    'primary_full_street_address',
    'display_full_street_address',
    'full_address',
    'display_address',
    'street_address',
    'unparsed_address',
    'addr',
    'address'
  ]));

  var area = cleanText_(pickFirst_(raw, [
    'neighborhood',
    'area',
    'sub_locality',
    'locality',
    'borough'
  ]));

  var city = cleanText_(pickFirst_(raw, [
    'city',
    'locality'
  ])) || 'brooklyn';

  var zip = cleanText_(pickFirst_(raw, [
    'zip',
    'zipcode',
    'postal_code'
  ]));

  var slugSeed = [address, area, city, zip].filter(Boolean).join(' ');
  var slug = slugSeed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (listingKey && slug) {
    return 'https://example.com/listing/' + encodeURIComponent(listingKey) + '/' + slug + '/';
  }

  return '';
}

function collectUrlsFromValue_(value, out, depth) {
  if (!value || depth > 5) return;

  if (typeof value === 'string') {
    var s = value.trim();

    if (
      (s.charAt(0) === '{' && s.charAt(s.length - 1) === '}') ||
      (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']')
    ) {
      try {
        collectUrlsFromValue_(JSON.parse(s), out, depth + 1);
        return;
      } catch (e) {}
    }

    var matches = s.match(/https?:\/\/[^\s"'<>)]+/gi);

    if (matches && matches.length) {
      matches.forEach(function(u) {
        out.push(u);
      });
    }

    return;
  }

  if (Array.isArray(value)) {
    value.forEach(function(item) {
      collectUrlsFromValue_(item, out, depth + 1);
    });
    return;
  }

  if (typeof value === 'object') {
    Object.keys(value).forEach(function(k) {
      if (/image|photo|thumbnail|picture|logo|floorplan/i.test(k)) return;
      collectUrlsFromValue_(value[k], out, depth + 1);
    });
  }
}

function isGoodListingUrl_(url) {
  var s = String(url || '').toLowerCase();

  if (!s) return false;
  if (!/^https?:\/\//i.test(s)) return false;
  if (/\.(jpg|jpeg|png|gif|webp|svg|pdf)(\?|$)/i.test(s)) return false;

  return true;
}

function normalizeHttpUrl_(url) {
  if (!url) return '';

  var s = String(url).trim();

  if (!s) return '';
  if (s.indexOf('mailto:') === 0 || s.indexOf('tel:') === 0) return '';
  if (s.indexOf('//') === 0) return 'https:' + s;
  if (s.indexOf('http://') === 0 || s.indexOf('https://') === 0) return s;

  if (s.indexOf('.') === -1) return '';

  return 'https://' + s;
}

function cleanText_(v) {
  if (v === null || v === undefined) return '';

  if (typeof v === 'string') {
    var s = v.trim();

    if (s.charAt(0) === '{') {
      try {
        var obj = JSON.parse(s);
        return cleanText_(
          extractAddressFromObject_(obj) ||
          obj.full_street_address ||
          obj.display_address ||
          obj.street_address ||
          ''
        );
      } catch (e) {
        return '';
      }
    }

    return s;
  }

  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }

  if (typeof v === 'object') {
    return extractAddressFromObject_(v) || '';
  }

  return String(v);
}

function extractAddressFromObject_(obj) {
  if (!obj || typeof obj !== 'object') return '';

  var direct = pickFirst_(obj, [
    'full_street_address',
    'primary_full_street_address',
    'display_full_street_address',
    'display_address',
    'street_address',
    'address_line_1',
    'address_1',
    'line1',
    'formatted_address',
    'unparsed_address'
  ]);

  if (direct) return String(direct).trim();

  var streetNumber = pickFirst_(obj, ['street_number', 'number']);
  var streetName   = pickFirst_(obj, ['street_name', 'street']);
  var city         = pickFirst_(obj, ['city', 'locality']);
  var state        = pickFirst_(obj, ['state', 'region']);
  var zip          = pickFirst_(obj, ['zip', 'postal_code']);

  var street = [streetNumber, streetName].filter(Boolean).join(' ').trim();

  return [street, city, state, zip]
    .filter(Boolean)
    .join(', ');
}

function extractAreaFromObject_(obj) {
  if (!obj || typeof obj !== 'object') return '';

  return cleanText_(pickFirst_(obj, [
    'neighborhood',
    'borough',
    'city',
    'sub_locality',
    'locality',
    'area'
  ]));
}
function pickPath_(obj, path) {
  if (!obj || !path) return null;

  var parts = String(path).split('.');
  var cur = obj;

  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return null;
    cur = cur[parts[i]];
  }

  return cur === undefined || cur === null || cur === '' ? null : cur;
}

function pickFirstDeep_(obj, paths) {
  for (var i = 0; i < paths.length; i++) {
    var v = pickPath_(obj, paths[i]);
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function cleanPhone_(v) {
  if (!v) return '';

  var s = String(v).trim();
  var digits = s.replace(/\D/g, '');

  if (digits.length < 7) return '';

  return s;
}

function cleanBrokerText_(v) {
  if (!v) return '';

  if (typeof v === 'string' || typeof v === 'number') {
    return String(v).trim();
  }

  if (typeof v === 'object') {
    return String(
      pickFirst_(v, [
        'full_name',
        'name',
        'display_name',
        'agent_name',
        'broker_name',
        'office_name',
        'company',
        'brokerage_name'
      ]) || ''
    ).trim();
  }

  return '';
}

function parseContactsJson_(raw) {
  if (!raw || !raw.contacts_json) return [];

  try {
    var parsed = raw.contacts_json;

    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }

    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function extractBrokerName_(raw) {
  var contacts = parseContactsJson_(raw);

  if (contacts.length) {
    var names = [];

    for (var i = 0; i < contacts.length; i++) {
      var name = cleanBrokerText_(contacts[i].name);
      if (name && names.indexOf(name) === -1) {
        names.push(name);
      }
    }

    var brokerDisplay = cleanBrokerText_(
      raw.broker_display_name ||
      raw.list_office_name ||
      raw.listing_office_name ||
      raw.brokerage_name ||
      raw.brokerage
    );

    if (names.length) {
      return [names.join(' / '), brokerDisplay].filter(Boolean).join(' · ');
    }
  }

  var direct = cleanBrokerText_(pickFirstDeep_(raw, [
    'list_agent_full_name',
    'list_agent_name',
    'agent_full_name',
    'agent_name',
    'listing_agent_name',
    'co_list_agent_full_name',
    'buyer_agent_name',
    'seller_agent_name',
    'listingAgentName',
    'listing_agent.full_name',
    'listing_agent.name',
    'listingAgent.fullName',
    'listingAgent.name',
    'list_agent.full_name',
    'list_agent.name',
    'agent.full_name',
    'agent.name',
    'broker.full_name',
    'broker.name',
    'contact.name',
    'contacts.0.name',
    'agents.0.name',
    'listing_agents.0.name',
    'list_agents.0.name'
  ]));

  if (!direct) {
    var first = cleanBrokerText_(pickFirstDeep_(raw, [
      'list_agent_first_name',
      'agent_first_name',
      'listing_agent.first_name',
      'listingAgent.firstName',
      'agent.first_name',
      'agents.0.first_name',
      'contacts.0.first_name'
    ]));

    var last = cleanBrokerText_(pickFirstDeep_(raw, [
      'list_agent_last_name',
      'agent_last_name',
      'listing_agent.last_name',
      'listingAgent.lastName',
      'agent.last_name',
      'agents.0.last_name',
      'contacts.0.last_name'
    ]));

    direct = [first, last].filter(Boolean).join(' ');
  }

  if (!direct) {
    direct = findFirstBrokerNameRecursive_(raw, '');
  }

  var office = cleanBrokerText_(pickFirstDeep_(raw, [
    'broker_display_name',
    'list_office_name',
    'listing_office_name',
    'brokerage_name',
    'brokerage',
    'agency_name',
    'list_broker_name',
    'office.name',
    'office.office_name',
    'list_office.name',
    'listing_office.name',
    'brokerage.name',
    'company.name',
    'agents.0.office_name',
    'contacts.0.office_name'
  ]));

  if (!office) {
    office = findFirstOfficeNameRecursive_(raw, '');
  }

  return [direct, office].filter(Boolean).join(' · ');
}

function extractBrokerPhone_(raw) {
  var contacts = parseContactsJson_(raw);

  for (var i = 0; i < contacts.length; i++) {
    var c = contacts[i];

    var mobile = cleanPhone_(c.phone_mobile || c.mobile_phone || c.cell_phone);
    if (mobile) return mobile;

    var direct = cleanPhone_(c.phone || c.direct_phone);
    if (direct) return direct;

    var office = cleanPhone_(c.office_phone || c.phone_office);
    if (office) return office;
  }

  var directPhone = cleanPhone_(pickFirstDeep_(raw, [
    'list_agent_phone',
    'agent_phone',
    'list_agent_direct_phone',
    'agent_direct_phone',
    'list_agent_office_phone',
    'agent_mobile_phone',
    'list_office_phone',
    'phone',
    'mobile_phone',
    'office_phone',

    'listingAgentPhone',
    'listing_agent.phone',
    'listing_agent.mobile_phone',
    'listingAgent.phone',
    'listingAgent.mobilePhone',
    'agent.phone',
    'agent.mobile_phone',
    'agent.office_phone',
    'list_agent.phone',
    'list_agent.mobile_phone',
    'broker.phone',
    'contact.phone',
    'office.phone',
    'list_office.phone',
    'listing_office.phone'
  ]));

  if (directPhone) return directPhone;

  return findFirstPhoneRecursive_(raw, '');
}

function extractBrokerDetails_(raw) {
  var contacts = parseContactsJson_(raw);
  var lines = [];

  for (var i = 0; i < contacts.length; i++) {
    var c = contacts[i];

    var name  = cleanBrokerText_(c.name);
    var phone = cleanPhone_(c.phone_mobile || c.mobile_phone || c.cell_phone || c.phone || c.direct_phone || c.office_phone);
    var email = cleanEmail_(c.email);
    var role  = cleanBrokerText_(c.role || c.title || c.type);

    var line = [name, role, phone, email].filter(Boolean).join(' · ');

    if (line) lines.push(line);
  }

  return lines.join(' | ');
}

function cleanEmail_(v) {
  if (!v) return '';

  if (Array.isArray(v)) {
    for (var i = 0; i < v.length; i++) {
      var found = cleanEmail_(v[i]);
      if (found) return found;
    }
    return '';
  }

  if (typeof v === 'object') {
    return cleanEmail_(
      pickFirst_(v, ['email', 'email_address', 'mail', 'contact_email'])
    );
  }

  var s = String(v).trim();
  var match = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  return match ? match[0] : '';
}

function parseArrayLike_(v) {
  if (!v) return [];

  if (Array.isArray(v)) return v;

  if (typeof v === 'string') {
    try {
      var parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return v.split(',').map(function(x) {
        return String(x || '').trim();
      }).filter(Boolean);
    }
  }

  return [];
}

function extractBrokerEmail_(raw) {
  var contacts = parseContactsJson_(raw);

  for (var i = 0; i < contacts.length; i++) {
    var email = cleanEmail_(contacts[i].email);
    if (email) return email;
  }

  var contactEmails = parseArrayLike_(raw.contact_emails);

  for (var j = 0; j < contactEmails.length; j++) {
    var e = cleanEmail_(contactEmails[j]);
    if (e) return e;
  }

  var direct = cleanEmail_(pickFirstDeep_(raw, [
    'email',
    'agent_email',
    'list_agent_email',
    'listing_agent_email',
    'broker_email',
    'contact_email',
    'agent.email',
    'list_agent.email',
    'listing_agent.email',
    'broker.email',
    'contact.email',
    'office.email',
    'contacts.0.email',
    'agents.0.email',
    'listing_agents.0.email',
    'list_agents.0.email'
  ]));

  if (direct) return direct;

  return findFirstEmailRecursive_(raw, '');
}

function findFirstEmailRecursive_(obj, path) {
  if (!obj || typeof obj !== 'object') return '';

  var keys = Object.keys(obj);

  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = obj[k];
    var key = String(k).toLowerCase();

    if (
      key.indexOf('email') !== -1 ||
      key === 'mail'
    ) {
      var email = cleanEmail_(v);
      if (email) return email;
    }

    if (v && typeof v === 'object') {
      var found = findFirstEmailRecursive_(v, path ? path + '.' + k : k);
      if (found) return found;
    }
  }

  return '';
}

function findFirstBrokerNameRecursive_(obj, path) {
  if (!obj || typeof obj !== 'object') return '';

  var keys = Object.keys(obj);

  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = obj[k];
    var key = String(k).toLowerCase();

    if (
      (
        key.indexOf('agent') !== -1 ||
        key.indexOf('broker') !== -1 ||
        key.indexOf('contact') !== -1
      ) &&
      (
        key.indexOf('name') !== -1 ||
        key.indexOf('fullname') !== -1 ||
        key.indexOf('full_name') !== -1
      )
    ) {
      var name = cleanBrokerText_(v);
      if (name) return name;
    }

    if (v && typeof v === 'object') {
      var found = findFirstBrokerNameRecursive_(v, path ? path + '.' + k : k);
      if (found) return found;
    }
  }

  return '';
}

function findFirstOfficeNameRecursive_(obj, path) {
  if (!obj || typeof obj !== 'object') return '';

  var keys = Object.keys(obj);

  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = obj[k];
    var key = String(k).toLowerCase();

    if (
      (
        key.indexOf('office') !== -1 ||
        key.indexOf('brokerage') !== -1 ||
        key.indexOf('company') !== -1
      ) &&
      key.indexOf('name') !== -1
    ) {
      var name = cleanBrokerText_(v);
      if (name) return name;
    }

    if (v && typeof v === 'object') {
      var found = findFirstOfficeNameRecursive_(v, path ? path + '.' + k : k);
      if (found) return found;
    }
  }

  return '';
}

function findFirstPhoneRecursive_(obj, path) {
  if (!obj || typeof obj !== 'object') return '';

  var keys = Object.keys(obj);

  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = obj[k];
    var key = String(k).toLowerCase();

    if (
      key.indexOf('phone') !== -1 ||
      key.indexOf('mobile') !== -1 ||
      key.indexOf('cell') !== -1 ||
      key.indexOf('tel') !== -1
    ) {
      var phone = cleanPhone_(v);
      if (phone) return phone;
    }

    if (v && typeof v === 'object') {
      var found = findFirstPhoneRecursive_(v, path ? path + '.' + k : k);
      if (found) return found;
    }
  }

  return '';
}

function extractListingArea_(raw) {
  if (!raw || typeof raw !== 'object') return '';

  var blob = buildLocationBlobFromRaw_(raw);
  var borough = inferBoroughFromText_(blob);

  if (borough) return borough;

  var directArea = cleanText_(pickFirstDeep_(raw, [
    'neighborhood',
    'subdivision_name',
    'sub_locality',
    'locality',
    'borough',
    'area',
    'address.neighborhood',
    'address.subdivision_name',
    'address.sub_locality',
    'address.locality',
    'address.borough',
    'location.neighborhood',
    'location.subdivision_name',
    'location.sub_locality',
    'location.borough',
    'building.neighborhood',
    'building.area'
  ]));

  return normalizeAreaName_(directArea);
}

function buildLocationBlobFromRaw_(raw) {
  var parts = [];

  var fields = [
    'area',
    'neighborhood',
    'borough',
    'city',
    'sub_locality',
    'subdivision_name',
    'locality',
    'full_address',
    'display_address',
    'street_address',
    'unparsed_address',
    'addr'
  ];

  fields.forEach(function(k) {
    var v = raw[k];
    if (v) parts.push(cleanText_(v));
  });

  ['address', 'location', 'building'].forEach(function(k) {
    if (raw[k] && typeof raw[k] === 'object') {
      parts.push(cleanText_(raw[k].neighborhood));
      parts.push(cleanText_(raw[k].borough));
      parts.push(cleanText_(raw[k].sub_locality));
      parts.push(cleanText_(raw[k].locality));
      parts.push(cleanText_(raw[k].city));
      parts.push(cleanText_(raw[k].area));
      parts.push(cleanText_(raw[k].full_street_address));
      parts.push(cleanText_(raw[k].display_address));
      parts.push(cleanText_(raw[k].street_address));
    }
  });

  return parts.filter(Boolean).join(' ').toLowerCase();
}

function inferBoroughFromText_(text) {
  var s = String(text || '').toLowerCase();

  if (/\bbrooklyn\b|\bkings county\b/.test(s)) return 'Brooklyn';
  if (/\bqueens\b|\bqueens county\b/.test(s)) return 'Queens';
  if (/\bbronx\b|\bthe bronx\b|\bbronx county\b/.test(s)) return 'Bronx';
  if (/\bstaten island\b|\brichmond county\b/.test(s)) return 'Staten Island';

  if (/\bmanhattan\b|\bnew york county\b|\bupper west side\b|\bupper east side\b|\bharlem\b|\bchelsea\b|\btribeca\b|\bsoho\b|\bmidtown\b|\bgramercy\b|\bgreenwich village\b|\beast village\b|\blower east side\b|\bfinancial district\b|\bwashington heights\b|\binwood\b/.test(s)) {
    return 'Manhattan';
  }

  if (/\bpark slope\b|\bwilliamsburg\b|\bbedford[- ]stuyvesant\b|\bbed stuy\b|\bbushwick\b|\bcrown heights\b|\bfort greene\b|\bclinton hill\b|\bprospect heights\b|\bcarroll gardens\b|\bcobble hill\b|\bboerum hill\b|\bdumbo\b|\bgreenpoint\b|\bbay ridge\b|\bsunset park\b|\bflatbush\b|\bmidwood\b|\bsheepshead bay\b|\bbensonhurst\b|\bred hook\b|\bcanarsie\b|\bbrownsville\b|\beast new york\b|\bbrighton beach\b|\bconey island\b/.test(s)) {
    return 'Brooklyn';
  }

  if (/\bastoria\b|\blic\b|\blong island city\b|\bflushing\b|\bforest hills\b|\bjackson heights\b|\bsunnyside\b|\bwoodside\b|\brego park\b|\bjamaica\b|\bbayside\b|\bridgewood\b/.test(s)) {
    return 'Queens';
  }

  return '';
}

function normalizeAreaName_(v) {
  var s = String(v || '').trim();
  if (!s) return '';

  var lower = s.toLowerCase();

  if (lower === 'brooklyn' || lower === 'bk' || lower === 'kings county') return 'Brooklyn';
  if (lower === 'manhattan' || lower === 'new york county') return 'Manhattan';
  if (lower === 'queens' || lower === 'queens county') return 'Queens';
  if (lower === 'bronx' || lower === 'the bronx' || lower === 'bronx county') return 'Bronx';
  if (lower === 'staten island' || lower === 'richmond county') return 'Staten Island';

  if (lower === 'nyc' || lower === 'new york city' || lower === 'new york, ny') return 'NYC';

  return s;
}

function isGenericNycArea_(v) {
  var s = String(v || '').trim().toLowerCase();
  return s === 'nyc' || s === 'new york city' || s === 'new york' || s === 'new york, ny';
}

function extractListingNeighborhood_(raw, address, title) {
  var direct = cleanText_(pickFirst_(raw, [
    'neighborhood',
    'sub_neighborhood',
    'sub_locality',
    'locality',
    'area_name',
    'market_area'
  ]));

  if (direct && !isGenericNycArea_(direct)) return direct;

  var blob = [
    address,
    title,
    raw && raw.area,
    raw && raw.display_name,
    raw && raw.full_address,
    raw && raw.source_data_json
  ].filter(Boolean).join(' ').toLowerCase();

  var neighborhoods = [
    'Brooklyn Heights',
    'Park Slope',
    'Williamsburg',
    'Bedford-Stuyvesant',
    'Bed-Stuy',
    'Bushwick',
    'Crown Heights',
    'Fort Greene',
    'Clinton Hill',
    'Prospect Heights',
    'Carroll Gardens',
    'Cobble Hill',
    'Boerum Hill',
    'Dumbo',
    'Greenpoint',
    'Bay Ridge',
    'Sunset Park',
    'Flatbush',
    'Midwood',
    'Sheepshead Bay',
    'Bensonhurst',
    'Red Hook',
    'Canarsie',
    'Brownsville',
    'East New York',
    'Brighton Beach',
    'Coney Island',
    'Astoria',
    'Long Island City',
    'Flushing',
    'Forest Hills',
    'Jackson Heights',
    'Sunnyside',
    'Woodside',
    'Rego Park',
    'Jamaica',
    'Bayside',
    'Ridgewood'
  ];

  for (var i = 0; i < neighborhoods.length; i++) {
    var n = neighborhoods[i];
    var needle = n.toLowerCase();
    if (blob.indexOf(needle) !== -1) return n;
  }

  return '';
}

function normalizeListing_(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const id        = pickFirst_(raw, ['listing_id','id','_id','listingId','mlsId','mls_id','uid']);
  const source    = pickFirst_(raw, ['source','source_name','provider']);
  const namespace = pickFirst_(raw, ['source_namespace','namespace']);
  const rawAddress = pickFirst_(raw, [
    'full_street_address',
    'primary_full_street_address',
    'display_full_street_address',
    'full_address',
    'display_address',
    'street_address',
    'unparsed_address',
    'addr',
    'address'
  ]);

  const address = cleanText_(rawAddress);

  const title = cleanText_(pickFirst_(raw, [
    'title',
    'display_address',
    'headline',
    'street_address',
    'name'
  ])) || address || 'Untitled Listing';

  const area = extractListingArea_(raw);
  const neighborhood = extractListingNeighborhood_(raw, address, title);
  const price = numeric_(pickFirst_(raw, [
    'price',
    'list_price',
    'listing_price',
    'asking_price',
    'current_price',
    'sale_price'
  ]));
  const bedrooms  = numeric_(pickFirst_(raw, ['bedrooms','beds','bed_count','bedrooms_total']));
  const bathrooms = numeric_(pickFirst_(raw, ['bathrooms','baths','bath_count','bathrooms_total','bathrooms_full']));
  const propType  = pickFirst_(raw, ['property_type','property_category','type','sub_property_type']);
  const status    = pickFirst_(raw, ['sale_status','status','listing_status','standard_status']);
  const created   = pickFirst_(raw, ['created_date','created_at','listed_date','list_date','on_market_date','date_listed','first_seen_at']);
  const brokerDetails = extractBrokerDetails_(raw);

  const brokerName  = extractBrokerName_(raw);
  const brokerPhone = extractBrokerPhone_(raw);
  const brokerEmail = extractBrokerEmail_(raw);

  const url   = resolveListingUrl_(raw);
  const image = sanitizeEmailImageUrl_(resolveImageUrl_(raw));

  let listingId = String(id == null ? '' : id);
  if (!listingId) {
    listingId = fallbackListingId_([source||'', address||'', numeric_(price)||'', formatDateString_(created)||'']);
  }

  return {
    listing_id:       listingId,
    source:           String(source || ''),
    source_namespace: String(namespace || ''),
    title:            String(title || address || ''),
    address:          String(address || ''),
    area:             String(area || ''),
    neighborhood:     String(neighborhood || ''),
    price:            price || 0,
    bedrooms:         bedrooms || 0,
    bathrooms:        bathrooms || 0,
    property_type:    String(propType || ''),
    sale_status:      String(status || '').toLowerCase(),
    created_date:     formatDateString_(created),
    detected_at:      nowIso_(),
    listing_url:      url,
    image_url:        image,
    broker_name:      brokerName,
    broker_phone:     brokerPhone,
    broker_email:     brokerEmail,
    broker_details:   brokerDetails,
    raw_json:         ''
  };
}

function resolveImageUrl_(raw) {
  const direct = pickFirst_(raw, ['image_url','photo_url','primary_photo','image','thumbnail']);
  if (typeof direct === 'string' && direct) return direct;
  if (direct && typeof direct === 'object' && direct.url) return String(direct.url);
  const arrays = ['images','photos','media','pictures'];
  for (let i = 0; i < arrays.length; i++) {
    const arr = raw[arrays[i]];
    if (Array.isArray(arr) && arr.length) {
      const first = arr[0];
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object') {
        if (first.url) return String(first.url);
        if (first.src) return String(first.src);
        if (first.href) return String(first.href);
      }
    }
  }
  return '';
}

function sanitizeEmailImageUrl_(url) {
  if (!url) return '';

  var s = String(url).trim();

  if (s.indexOf('data:') === 0) return '';

  if (s.indexOf('http://') !== 0 && s.indexOf('https://') !== 0) return '';

  if (s.length > 1000) return '';

  return s;
}

// =====================================================================
//   FILTER & RECIPIENT MATCHING
// =====================================================================

function filterListings_(listings, settings) {
  const minPrice = numeric_(settings.min_price) || 1000000;
  const maxPrice = numeric_(settings.max_price) || 9999999999;
  const area     = (settings.area||'').toString().trim().toLowerCase();
  const out = [];
  for (let i = 0; i < listings.length; i++) {
    const l = listings[i];
    if (!l) continue;
    if (!passesPrice_(l, minPrice, maxPrice)) continue;
    if (!passesStatus_(l)) continue;
    if (!passesArea_(l, area)) continue;
    if (!passesResidential_(l)) continue;
    out.push(l);
  }
  return out;
}
function passesPrice_(l, min, max) {
  const p = numeric_(l.price);
  return p >= min && p <= max;
}
function passesStatus_(l) {
  const s = String(l.sale_status||'').toLowerCase();
  if (!s) return true;
  return CONFIG.ACTIVE_SALE_STATUSES.indexOf(s) !== -1;
}

function isBrooklynListing_(listing) {
  if (!listing) return false;

  var blob = [
    listing.area,
    listing.address,
    listing.title,
    listing.listing_url,
    listing.source_namespace
  ].filter(Boolean).join(' ').toLowerCase();

  if (
    /\bupper west side\b|\bupper east side\b|\bmanhattan\b|\bnew york county\b|\bqueens\b|\bbronx\b|\bstaten island\b|\brichmond county\b/.test(blob)
  ) {
    return false;
  }

  if (/\bbrooklyn\b|\bkings county\b/.test(blob)) {
    return true;
  }

  if (
    /\bpark slope\b|\bwilliamsburg\b|\bbedford[- ]stuyvesant\b|\bbed stuy\b|\bbushwick\b|\bcrown heights\b|\bfort greene\b|\bclinton hill\b|\bprospect heights\b|\bcarroll gardens\b|\bcobble hill\b|\bboerum hill\b|\bdumbo\b|\bgreenpoint\b|\bbay ridge\b|\bsunset park\b|\bflatbush\b|\bmidwood\b|\bsheepshead bay\b|\bbensonhurst\b|\bred hook\b|\bcanarsie\b|\bbrownsville\b|\beast new york\b|\bbrighton beach\b|\bconey island\b/.test(blob)
  ) {
    return true;
  }

  return false;
}

function passesArea_(l, areaFilterLower) {
  var requested = normalizeAreaName_(areaFilterLower);
  if (!requested) return true;

  var target = requested.toLowerCase();

  var blob = [
  l.area,
  l.neighborhood,
  l.address,
  l.title,
  l.listing_url
].filter(Boolean).join(' ').toLowerCase();

  var detected = inferBoroughFromText_(blob) || normalizeAreaName_(l.area);
  var detectedLower = String(detected || '').toLowerCase();

  if (target === 'brooklyn') return detectedLower === 'brooklyn';
  if (target === 'manhattan') return detectedLower === 'manhattan';
  if (target === 'queens') return detectedLower === 'queens';
  if (target === 'bronx') return detectedLower === 'bronx';
  if (target === 'staten island') return detectedLower === 'staten island';

  return blob.indexOf(target) !== -1;
}

function passesNeighborhood_(l, neighborhoodFilterLower) {
  var filter = String(neighborhoodFilterLower || '').trim().toLowerCase();
  if (!filter) return true;

  var terms = filter.split(',').map(function(t) {
    return t.trim();
  }).filter(Boolean);

  if (!terms.length) return true;

  var blob = [
    l.neighborhood,
    l.area,
    l.address,
    l.title,
    l.listing_url
  ].filter(Boolean).join(' ').toLowerCase();

  return terms.some(function(term) {
    return blob.indexOf(term) !== -1;
  });
}

function passesResidential_(l) {
  const t = String(l.property_type||'').toLowerCase();
  if (!t) return true;
  return t.indexOf('commercial') === -1 && t.indexOf('land') === -1;
}
function recipientMatchesListing_(recipient, listing) {
  if (!recipient || !listing) return false;
  if (!parseBool_(recipient.active)) return false;
  if (!isValidEmail_(recipient.email)) return false;
  const minPrice = numeric_(recipient.min_price);
  if (minPrice && numeric_(listing.price) < minPrice) return false;
  const areaFilter = String(recipient.area_filter||'').trim().toLowerCase();
  if (areaFilter && !passesArea_(listing, areaFilter)) {
    return false;
  }

  const neighborhoodFilter = String(recipient.neighborhood_filter||'').trim().toLowerCase();
  if (neighborhoodFilter && !passesNeighborhood_(listing, neighborhoodFilter)) {
    return false;
  }

  return true;
}

// =====================================================================
//   DEDUPE
// =====================================================================

function buildDedupeMap_(existingListings) {
  const map = { byId:{}, byKey:{} };
  for (let i = 0; i < existingListings.length; i++) {
    const l = existingListings[i];
    if (!l) continue;
    if (l.listing_id) map.byId[String(l.listing_id)] = true;
    map.byKey[buildDedupeKey_(l)] = true;
  }
  return map;
}
function isDuplicate_(listing, map) {
  if (!listing || !map) return false;
  if (listing.listing_id && map.byId[String(listing.listing_id)]) return true;
  if (map.byKey[buildDedupeKey_(listing)]) return true;
  return false;
}
function buildDedupeKey_(l) {
  return [
    String(l.source||'').toLowerCase(),
    String(l.address||'').toLowerCase().replace(/\s+/g,' ').trim(),
    String(numeric_(l.price)||''),
    String(l.created_date||'')
  ].join('|');
}
function rememberListingInMap_(map, l) {
  if (!map || !l) return;
  if (l.listing_id) map.byId[String(l.listing_id)] = true;
  map.byKey[buildDedupeKey_(l)] = true;
}

// =====================================================================
//   EMAIL
// =====================================================================

function sendListingAlert_(listing, recipient) {
  if (!isValidEmail_(recipient.email)) throw new Error('Invalid recipient email: ' + recipient.email);
  MailApp.sendEmail({
    to: recipient.email,
    subject: buildSubject_(listing),
    htmlBody: buildEmailHtml_(listing, recipient),
    body: buildEmailPlainText_(listing),
    name: CONFIG.APP_NAME
  });
}

function buildSubject_(l) {
  return 'New $1M+ Listing: ' + formatPrice_(l.price) + ' — ' + (l.area || l.address || 'New listing');
}

function buildEmailPlainText_(l) {
  const lines = [
    'NEW LUXURY LISTING', '',
    'Price: ' + formatPrice_(l.price),
    'Address: ' + (l.address || '—'),
    'Area: ' + (l.area || '—'),
    'Beds/Baths: ' + (l.bedrooms||0) + ' bd / ' + (l.bathrooms||0) + ' ba',
  ];
  if (l.broker_details) lines.push('Broker Details: ' + l.broker_details);
  if (l.broker_name)  lines.push('Agent/Broker: ' + l.broker_name);
  if (l.broker_phone) lines.push('Phone: ' + l.broker_phone);
  if (l.broker_email) lines.push('Email: ' + l.broker_email);
  lines.push(
    'Source: ' + (l.source_namespace || l.source || '—'),
    'Listed: ' + (l.created_date || '—'),
    'Detected: ' + (l.detected_at || '—'),
    '',
    'View Listing: ' + (l.listing_url || '—'),
    '',
    '— ' + CONFIG.APP_NAME
  );
  return lines.join('\n');
}

function buildEmailHtml_(l, recipient) {
  const safeName = escapeHtml_(recipient.name || 'there');
  const price    = escapeHtml_(formatPrice_(l.price));
  const title    = escapeHtml_(l.title || l.address || 'New Listing');
  const address  = escapeHtml_(l.address || '—');
  const area     = escapeHtml_(l.area || '—');
  const neighborhood = escapeHtml_(l.neighborhood || '—');
  const beds     = escapeHtml_(String(l.bedrooms || 0));
  const baths    = escapeHtml_(String(l.bathrooms || 0));
  const source   = escapeHtml_(l.source_namespace || l.source || '—');
  const created  = escapeHtml_(l.created_date || '—');
  const detected = escapeHtml_(l.detected_at || '—');
  const url      = l.listing_url ? escapeHtml_(l.listing_url) : '';
  const img      = l.image_url ? escapeHtml_(l.image_url) : '';

  let brokerRows = '';
  if (l.broker_name)  brokerRows += emailStatRow_('Agent / Broker', escapeHtml_(l.broker_name));
  if (l.broker_phone) {
    const digits  = l.broker_phone.replace(/\D/g,'');
    const telHref = 'tel:' + (digits.length === 10 ? '+1' + digits : '+' + digits);
    const display = escapeHtml_(l.broker_phone);
    brokerRows += emailStatRow_('Phone', '<a href="' + telHref + '" style="color:#c9a961;text-decoration:none;font-weight:600;">' + display + '</a>');
  }
  if (l.broker_email) {
    const email = escapeHtml_(l.broker_email);
    brokerRows += emailStatRow_(
      'Email',
      '<a href="mailto:' + email + '" style="color:#c9a961;text-decoration:none;font-weight:600;">' + email + '</a>'
    );
  }
  if (l.broker_details) {
    brokerRows += emailStatRow_(
      'Broker Details',
      escapeHtml_(l.broker_details)
    );
  }

  const imgBlock = img
    ? '<img src="' + img + '" alt="Listing photo" style="display:block;width:100%;max-width:600px;height:240px;object-fit:cover;" />'
    : '';

  const viewCta = url
    ? '<a href="' + url + '" style="display:inline-block;background:#0a1628;color:#faf6ee;text-decoration:none;padding:13px 26px;border-radius:4px;font-weight:600;font-size:13px;letter-spacing:1.2px;text-transform:uppercase;margin-right:10px;">View Listing →</a>'
    : '';

  let phoneCta = '';
  if (l.broker_phone) {
    const digits  = l.broker_phone.replace(/\D/g,'');
    const telHref = 'tel:' + (digits.length === 10 ? '+1' + digits : '+' + digits);
    phoneCta = '<a href="' + telHref + '" style="display:inline-block;background:#c9a961;color:#0a1628;text-decoration:none;padding:13px 22px;border-radius:4px;font-weight:600;font-size:13px;letter-spacing:0.6px;text-transform:uppercase;">📞 ' + escapeHtml_(l.broker_phone) + '</a>';
  }

  return '<!doctype html><html><body style="margin:0;padding:0;background:#faf6ee;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#1a1f2c;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf6ee;padding:24px 12px;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 8px 30px rgba(10,22,40,0.12);">' +

    '<tr><td style="background:linear-gradient(135deg,#0a1628 0%,#1c2a44 100%);padding:22px 28px;border-bottom:2px solid #c9a961;">' +
    '<div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#c9a961;font-weight:600;">' + escapeHtml_(CONFIG.APP_NAME) + '</div>' +
    '<div style="font-size:20px;font-weight:600;margin-top:6px;color:#faf6ee;font-family:Georgia,serif;letter-spacing:0.2px;">New Luxury Listing</div>' +
    '</td></tr>' +

    (imgBlock ? '<tr><td>' + imgBlock + '</td></tr>' : '') +

    '<tr><td style="padding:26px 28px 8px 28px;">' +
    '<div style="font-size:34px;font-weight:700;color:#96761f;line-height:1;font-family:Georgia,serif;">' + price + '</div>' +
    '<div style="font-size:16px;font-weight:500;color:#1a1f2c;margin-top:10px;">' + title + '</div>' +
    '<div style="font-size:13px;color:#6c7689;margin-top:3px;">' + address + '</div>' +
    '</td></tr>' +

    '<tr><td style="padding:4px 28px 0 28px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border-top:1px solid #ece4d4;">' +
    emailStatRow_('Area', area) +
    emailStatRow_('Neighborhood', neighborhood) +
    emailStatRow_('Beds / Baths', beds + ' bd &nbsp;·&nbsp; ' + baths + ' ba') +
    brokerRows +
    emailStatRow_('Source', source) +
    emailStatRow_('Listed', created) +
    emailStatRow_('Detected', detected) +
    '</table>' +
    '</td></tr>' +

    '<tr><td style="padding:22px 28px;">' + viewCta + phoneCta + '</td></tr>' +

    '<tr><td style="padding:14px 28px 20px 28px;border-top:1px solid #ece4d4;font-size:12px;color:#8a93a4;">' +
    'Hi ' + safeName + ' — this listing was detected by ' + escapeHtml_(CONFIG.APP_NAME) + '.<br/>Reach out quickly: the best opportunities go fast.' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

function emailStatRow_(label, value) {
  return '<tr>' +
    '<td style="padding:8px 0;font-size:11px;color:#8a93a4;width:140px;text-transform:uppercase;letter-spacing:1.2px;font-weight:500;">' + escapeHtml_(label) + '</td>' +
    '<td style="padding:8px 0;font-size:14px;color:#1a1f2c;">' + value + '</td>' +
    '</tr>';
}

// =====================================================================
//   TRIGGER & SCAN PIPELINE
// =====================================================================

function installScanTrigger() {
  removeScanTriggers();
  ScriptApp.newTrigger(CONFIG.SCAN_TRIGGER_FUNCTION).timeBased()
    .everyMinutes(CONFIG.SCAN_TRIGGER_MINUTES).create();
}
function removeScanTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    const fn = t.getHandlerFunction();
    if (fn === CONFIG.SCAN_TRIGGER_FUNCTION || fn === 'runScheduledScan') ScriptApp.deleteTrigger(t);
  });
}

function isListingTriggerInstalled_() {
  return ScriptApp.getProjectTriggers().some(function(t) {
    const fn = t.getHandlerFunction();
    return fn === CONFIG.SCAN_TRIGGER_FUNCTION || fn === 'runScanNow' || fn === 'runScheduledScan';
  });
}

function runScanNow() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    logError_('runScanNow', 'Could not acquire lock — another scan is in progress.', '');
    return { ok: false, message: 'Another scan is already running.' };
  }
  try { return performScan_(); }
  finally { try { lock.releaseLock(); } catch(e) {} }
}

function performScan_() {
  const result = { ok:true, fetched:0, filtered:0, new:0, alerts:0, errors:[], started_at: nowIso_(), finished_at:'' };
  try {
    ensureAllSheets_();
    const settings = getSettings_();

    if (!parseBool_(settings.system_enabled)) {
      result.ok = false;
      result.message = 'System is disabled. Toggle it on to run scans.';
      result.finished_at = nowIso_();
      return result;
    }

    let raw;
    try { raw = fetchListings_(settings) || []; }
    catch (err) {
      result.ok = false; result.message = 'API failure: ' + err.message;
      result.errors.push(err.message); result.finished_at = nowIso_(); return result;
    }
    result.fetched = raw.length;

    const normalized = [];
    for (let i = 0; i < raw.length; i++) {
      try { const n = normalizeListing_(raw[i]); if (n) normalized.push(n); }
      catch (err) { logError_('performScan.normalize', err.message, safeStringify_(raw[i]).slice(0, CONFIG.MAX_ERROR_DETAILS_LEN)); }
    }

    const filteredAll = filterListings_(normalized, settings);
    const requestedArea = String(settings.area || '').trim().toLowerCase();

    const filtered = requestedArea === 'brooklyn'
      ? filteredAll.filter(function(l) {
          return isBrooklynListing_(l);
        })
      : filteredAll;

    result.filtered = filtered.length;

    const existing  = readAllListings_();
    const dedupeMap = buildDedupeMap_(existing);
    const fresh     = [];
    for (let i = 0; i < filtered.length; i++) {
      if (!isDuplicate_(filtered[i], dedupeMap)) { fresh.push(filtered[i]); rememberListingInMap_(dedupeMap, filtered[i]); }
    }

    for (let i = 0; i < fresh.length; i++) {
      try { appendListing_(fresh[i]); }
      catch (err) { logError_('performScan.append', err.message, safeStringify_(fresh[i]).slice(0, CONFIG.MAX_ERROR_DETAILS_LEN)); result.errors.push(err.message); }
    }
    result.new = fresh.length;

    // ===== FIX #2A: Initialize markedSentCount tracker =====
    let markedSentCount = 0;

    // Send alerts — instant mode only; batch modes scaffolded, not yet built
        // Send alerts — instant mode only; batch modes scaffolded, not yet built
    const emailMode = String(settings.email_mode || 'instant').toLowerCase();

    if (emailMode === 'instant' && fresh.length > 0) {
      const recipients = readAllRecipients_().filter(function(r) {
        return parseBool_(r.active);
      });

      let totalAlerts = 0;

      for (let i = 0; i < fresh.length; i++) {
        const listing = fresh[i];
        let sentCount = 0;

        for (let j = 0; j < recipients.length; j++) {
          if (!recipientMatchesListing_(recipients[j], listing)) continue;

          try {
            sendListingAlert_(listing, recipients[j]);
            sentCount++;
            totalAlerts++;
          } catch (err) {
            logError_(
              'performScan.email',
              err.message,
              'listing_id=' + listing.listing_id + ' r=' + recipients[j].email
            );
            result.errors.push(err.message);
          }
        }

        if (sentCount > 0) {
          try {
            markAlertSent_(listing.listing_id);
            markedSentCount++;
          } catch (err) {
            logError_('performScan.markAlertSent', err.message, listing.listing_id);
          }
        }
      }

            result.alerts = totalAlerts;
    }

    setSetting_('last_scan_time', nowIso_());

    // Refresh managed tabs once if listings were marked sent.
    if (markedSentCount > 0) {
      try {
        refreshManagedLeadTabs();
        Logger.log(
          'refreshManagedLeadTabs() completed after scan. Updated ' +
          markedSentCount +
          ' listings.'
        );
      } catch (refreshErr) {
        logError_(
          'performScan.refreshManagedLeadTabs',
          refreshErr.message,
          refreshErr.stack || ''
        );
      }
    }

  } catch (err) {
    logError_('performScan', err.message, err.stack || '');
    result.ok = false;
    result.message = err.message;
  }

  result.finished_at = nowIso_();
  return result;
}

// =====================================================================
//   ERROR LOG
// =====================================================================
// =====================================================================
//   ERROR LOG
// =====================================================================

function logError_(funcName, message, details) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) { Logger.log('[' + funcName + '] ' + message); return; }
    let sheet = ss.getSheetByName(CONFIG.SHEETS.ERROR_LOG);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.SHEETS.ERROR_LOG);
      sheet.getRange(1,1,1,CONFIG.HEADERS.ERROR_LOG.length).setValues([CONFIG.HEADERS.ERROR_LOG]);
      sheet.setFrozenRows(1);
      sheet.getRange(1,1,1,CONFIG.HEADERS.ERROR_LOG.length).setFontWeight('bold');
    }
    const d = String(details==null?'':details);
    sheet.appendRow([
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'),
      String(funcName||''), String(message||''),
      d.length > CONFIG.MAX_ERROR_DETAILS_LEN ? d.slice(0, CONFIG.MAX_ERROR_DETAILS_LEN) + '…' : d
    ]);
  } catch(e) { try { Logger.log('logError_ failed: ' + e.message); } catch(_){} }
}

function cleanHeavyListingFields() {
  const sheet = getSheet_(CONFIG.SHEETS.LISTINGS_LOG);
  const headers = CONFIG.HEADERS.LISTINGS_LOG;

  const imageCol = headers.indexOf('image_url') + 1;
  const rawCol   = headers.indexOf('raw_json') + 1;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, cleaned: 0 };

  let cleaned = 0;

  if (imageCol > 0) {
    const range = sheet.getRange(2, imageCol, lastRow - 1, 1);
    const values = range.getValues();

    const cleanedValues = values.map(function(row) {
      let v = String(row[0] || '').trim();

      if (v.indexOf('data:') === 0) {
        cleaned++;
        return [''];
      }

      if (v.length > 600) {
        cleaned++;
        return [v.slice(0, 600)];
      }

      return [v];
    });

    range.setValues(cleanedValues);
  }

  if (rawCol > 0) {
    const range = sheet.getRange(2, rawCol, lastRow - 1, 1);
    const values = range.getValues();

    const cleanedValues = values.map(function(row) {
      let v = String(row[0] || '');

      if (v.length > 5000) {
        cleaned++;
        return [v.slice(0, 5000)];
      }

      return [v];
    });

    range.setValues(cleanedValues);
  }

  return {
    ok: true,
    cleaned: cleaned,
    message: 'Heavy listing fields cleaned.'
  };
}

function cleanPayloadBloatNow() {
  const sheet = getSheet_(CONFIG.SHEETS.LISTINGS_LOG);
  const headers = CONFIG.HEADERS.LISTINGS_LOG;

  const imageCol = headers.indexOf('image_url') + 1;
  const rawCol   = headers.indexOf('raw_json') + 1;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, cleaned: 0 };

  let cleaned = 0;

  if (imageCol > 0) {
    const range = sheet.getRange(2, imageCol, lastRow - 1, 1);
    const values = range.getValues().map(function() {
      cleaned++;
      return [''];
    });
    range.setValues(values);
  }

  if (rawCol > 0) {
    const range = sheet.getRange(2, rawCol, lastRow - 1, 1);
    const values = range.getValues().map(function() {
      cleaned++;
      return [''];
    });
    range.setValues(values);
  }

  return {
    ok: true,
    cleaned: cleaned,
    message: 'image_url and raw_json cleared from Listings_Log.'
  };
}