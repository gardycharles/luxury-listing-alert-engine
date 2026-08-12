/**
 * Code.gs
 * Entry points (doGet, onOpen) and UI bridge functions only.
 * All backend logic lives in Service.gs.
 */

// =====================================================================
//   ENTRY POINTS
// =====================================================================

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏠 Luxury Listings')
    .addItem('Open Dashboard',           'openDashboard_')
    .addSeparator()
    .addItem('Setup / Repair Sheets',    'setupSheets')
    .addItem('Run Scan Now',             'runScanNow')
    .addSeparator()
    .addItem('Refresh Sent Alerts',      'refreshSentAlertsTab')
    .addItem('Send Test Assignment Email', 'sendTestAssignmentEmailFromSelectedRow')
    .addSeparator()
    .addItem('Install 1-Minute Trigger', 'installScanTrigger')
    .addItem('Remove Trigger',           'removeScanTriggers')
    .addSeparator()
    .addItem('Install Tab Refresh (5min)', 'installManagedTabRefreshTrigger')  // NEW
    .addItem('Remove Tab Refresh',         'removeManagedTabRefreshTrigger')   // NEW
    .addToUi();
}

function openDashboard_() {
  const html = HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(CONFIG.APP_NAME)
    .setWidth(1280)
    .setHeight(840);
  SpreadsheetApp.getUi().showModalDialog(html, CONFIG.APP_NAME);
}

// =====================================================================
//   SETUP
// =====================================================================

function setupSheets() {
  try {
    ensureAllSheets_();
    return { ok: true, message: 'Sheets created or repaired successfully.' };
  } catch (err) {
    logError_('setupSheets', err.message, err.stack);
    return { ok: false, message: err.message };
  }
}

// =====================================================================
//   BOOT DATA  — single round-trip that loads everything the UI needs
// =====================================================================

/**
 * Read a sheet by name and return all data rows.
 * Returns [] silently if the sheet doesn't exist yet (e.g. before Setup is run).
 * This prevents any single missing tab from crashing the entire boot.
 */
function safeReadSheetRows_(name) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return [];
    const sheet = ss.getSheetByName(name);
    if (!sheet) return [];
    return readAllRows_(sheet);
  } catch (e) {
    Logger.log('safeReadSheetRows_ failed for ' + name + ': ' + e.message);
    return [];
  }
}


/**
 * Deep-sanitises values before returning them to HtmlService/google.script.run.
 * Apps Script can choke on Date objects nested inside returned objects.
 */
function makeClientSafe_(value) {
  if (value instanceof Date) return formatDateString_(value);
  if (value === null || value === undefined) return '';

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.map(function(item) { return makeClientSafe_(item); });
  }

  if (t === 'object') {
    const out = {};
    Object.keys(value).forEach(function(k) {
      const v = value[k];
      if (typeof v !== 'function') out[k] = makeClientSafe_(v);
    });
    return out;
  }

  return String(value);
}

function getBootData() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (!ss) {
      return {
        ok: false,
        message: 'No spreadsheet found. Open the dashboard from the Google Sheet menu: 🏠 Luxury Listings → Open Dashboard. Do not open the /exec web app URL directly.'
      };
    }

    const rawSettings = safeReadSheetRows_(CONFIG.SHEETS.SETTINGS);
    const allListings = safeReadSheetRows_(CONFIG.SHEETS.LISTINGS_LOG);
    const recipients  = safeReadSheetRows_(CONFIG.SHEETS.RECIPIENTS);
    const outreach    = safeReadSheetRows_(CONFIG.SHEETS.OUTREACH_LOG);
    const errors      = safeReadSheetRows_(CONFIG.SHEETS.ERROR_LOG);

    // Not using saved searches for V1
    const savedSearches = [];

    const settings = {};
    rawSettings.forEach(function(r) {
      if (r.key) settings[r.key] = r.value;
    });

    allListings.sort(function(a, b) {
      return String(b.detected_at || '').localeCompare(String(a.detected_at || ''));
    });

    const today = todayDateString_();

    const newToday = allListings.filter(function(l) {
      return l.detected_at && String(l.detected_at).indexOf(today) === 0;
    }).length;

    const alertsSent = allListings.filter(function(l) {
      return String(l.alert_sent).toUpperCase() === 'TRUE';
    }).length;

    const activeR = recipients.filter(function(r) {
      return parseBool_(r.active);
    }).length;

    const BOOT_LISTING_LIMIT = 50;

    const LISTING_BOOT_FIELDS = [
      'listing_id',
      'source',
      'source_namespace',
      'title',
      'address',
      'area',
      'neighborhood',
      'price',
      'bedrooms',
      'bathrooms',
      'property_type',
      'sale_status',
      'created_date',
      'detected_at',
      'listing_url',
      'alert_sent',
      'alert_sent_at',
      'assigned_to',
      'outreach_status',
      'marketing_plan_status',
      'notes',
      'broker_name',
      'broker_phone'
    ];

    const listings = allListings.slice(0, BOOT_LISTING_LIMIT).map(function(l) {
      const slim = {};
      const sentActiveListings = allListings.filter(function(l) {
  var isSent =
    String(l.alert_sent || '').toUpperCase() === 'TRUE' ||
    String(l.alert_sent_at || '').trim() !== '' ||
    isSentTimestamp_(l.alert_sent);

  var status = normalizeSalesStatus_(l.outreach_status);
  var isActive = getLeadTabForStatus_(status) === MANAGED_LEAD_TABS.ACTIVE;

  return isSent && isActive;
});

const boroughViews = getDashboardBoroughViewsFromRows_(sentActiveListings);

      LISTING_BOOT_FIELDS.forEach(function(h) {
        let v = l[h];

        if (h === 'listing_url') {
          v = String(v == null ? '' : v).trim();
          if (v.indexOf('data:') === 0) v = '';
          if (v.length > 1000) v = v.slice(0, 1000);
        }

        if (h === 'title' || h === 'notes') {
          v = String(v == null ? '' : v).slice(0, 250);
        }

        slim[h] = v == null ? '' : v;
      });

      return slim;
    });

        const sentActiveListings = allListings.filter(function(l) {
      var isSent =
        String(l.alert_sent || '').toUpperCase() === 'TRUE' ||
        String(l.alert_sent_at || '').trim() !== '' ||
        isSentTimestamp_(l.alert_sent);

      var status = normalizeSalesStatus_(l.outreach_status);
      var isActive = getLeadTabForStatus_(status) === MANAGED_LEAD_TABS.ACTIVE;

      return isSent && isActive;
    });

    const boroughViews = getDashboardBoroughViewsFromRows_(sentActiveListings);

    errors.sort(function(a, b) {
      return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
    });

    const payload = {
      ok: true,
      app: { name: CONFIG.APP_NAME },
      settings: settings,
      listings: listings,
      boroughViews: boroughViews,
      recipients: recipients,
      outreach: outreach,
      savedSearches: savedSearches,
      errors: errors.slice(0, 50),
      outreachStatuses: CONFIG.OUTREACH_STATUSES,
      alertTimingOptions: CONFIG.ALERT_TIMING_OPTIONS,
      stats: {
        total_listings: allListings.length,
        alerts_sent: alertsSent,
        new_today: newToday,
        active_recipients: activeR,
        active_searches: 0,
        borough_alerts: {
        brooklyn: boroughViews.brooklyn.length,
        queens: boroughViews.queens.length,
        bronx: boroughViews.bronx.length,
        manhattan: boroughViews.manhattan.length,
        staten_island: boroughViews.staten_island.length
},
last_scan_time: settings.last_scan_time || '',
        last_error: errors.length ? errors[0] : null,
        system_enabled: parseBool_(settings.system_enabled),
        trigger_installed: isListingTriggerInstalled_()
      }
    };

    return typeof makeClientSafe_ === 'function' ? makeClientSafe_(payload) : payload;

  } catch (err) {
    const msg = err && err.message ? err.message : String(err);

    try {
      logError_('getBootData', msg, err && err.stack ? err.stack : '');
    } catch (_) {}

    return {
      ok: false,
      message: 'getBootData failed: ' + msg
    };
  }
}

// =====================================================================
//   UI BRIDGE — Settings
// =====================================================================

function uiSaveSettings(payload) {
  try {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid settings payload.');
    if (payload.min_price !== undefined && !isValidPrice_(payload.min_price)) throw new Error('min_price must be a non-negative number.');
    if (payload.max_price !== undefined && !isValidPrice_(payload.max_price)) throw new Error('max_price must be a non-negative number.');
    if (payload.min_price !== undefined && payload.max_price !== undefined &&
        Number(payload.min_price) > Number(payload.max_price)) throw new Error('min_price cannot exceed max_price.');

    const allowed = ['system_enabled','min_price','max_price','rows_per_scan','page','namespace','area','neighborhood','email_mode'];
    for (let i = 0; i < allowed.length; i++) {
      const k = allowed[i];
      if (Object.prototype.hasOwnProperty.call(payload, k)) {
        let v = payload[k];
        if (k === 'system_enabled') v = parseBool_(v) ? 'TRUE' : 'FALSE';
        setSetting_(k, v);
      }
    }
    return { ok: true, message: 'Settings saved.' };
  } catch (err) {
    logError_('uiSaveSettings', err.message, err.stack);
    return { ok: false, message: err.message };
  }
}

function uiToggleSystem() {
  try {
    const settings = getSettings_();
    const next = parseBool_(settings.system_enabled) ? 'FALSE' : 'TRUE';
    setSetting_('system_enabled', next);
    return { ok: true, system_enabled: next === 'TRUE' };
  } catch (err) {
    logError_('uiToggleSystem', err.message, err.stack);
    return { ok: false, message: err.message };
  }
}

// =====================================================================
//   UI BRIDGE — Recipients
// =====================================================================

function uiAddRecipient(payload) {
  try {
    if (!payload || !payload.email) throw new Error('Email is required.');
    if (!isValidEmail_(payload.email)) throw new Error('Invalid email address.');
    if (payload.min_price !== undefined && payload.min_price !== '' && !isValidPrice_(payload.min_price))
      throw new Error('min_price must be a non-negative number.');
    const recipient = {
      recipient_id: 'r_' + Utilities.getUuid().slice(0,8),
      name:         String(payload.name||'').trim(),
      email:        String(payload.email).trim(),
      min_price:    payload.min_price ? Number(payload.min_price) : '',
      area_filter:          String(payload.area_filter||'').trim(),
      neighborhood_filter:  String(payload.neighborhood_filter||'').trim(),
      active:               parseBool_(payload.active === undefined ? true : payload.active) ? 'TRUE' : 'FALSE',
      created_at:   nowIso_()
    };
    appendRecipient_(recipient);
    return { ok: true, recipient: recipient };
  } catch (err) {
    logError_('uiAddRecipient', err.message, err.stack);
    return { ok: false, message: err.message };
  }
}

function uiUpdateRecipient(payload) {
  try {
    if (!payload || !payload.recipient_id) throw new Error('recipient_id is required.');
    if (payload.email && !isValidEmail_(payload.email)) throw new Error('Invalid email.');
    if (payload.min_price !== undefined && payload.min_price !== '' && !isValidPrice_(payload.min_price))
      throw new Error('min_price must be a non-negative number.');
    const updated = updateRecipient_(payload.recipient_id, {
      name:        payload.name,
      email:       payload.email,
      min_price:   payload.min_price === '' ? '' : (payload.min_price !== undefined ? Number(payload.min_price) : undefined),
      area_filter:         payload.area_filter,
      neighborhood_filter: payload.neighborhood_filter,
      active:              payload.active === undefined ? undefined : (parseBool_(payload.active) ? 'TRUE' : 'FALSE')
    });
    return { ok: true, recipient: updated };
  } catch (err) {
    logError_('uiUpdateRecipient', err.message, err.stack);
    return { ok: false, message: err.message };
  }
}

function uiDeleteRecipient(recipientId) {
  try {
    if (!recipientId) throw new Error('recipient_id is required.');
    deleteRecipient_(recipientId);
    return { ok: true };
  } catch (err) {
    logError_('uiDeleteRecipient', err.message, err.stack);
    return { ok: false, message: err.message };
  }
}

// =====================================================================
//   UI BRIDGE — Listing outreach
// =====================================================================

function uiUpdateListingOutreach(payload) {
  try {
    if (!payload || !payload.listing_id) throw new Error('listing_id is required.');
    if (payload.outreach_status && CONFIG.OUTREACH_STATUSES.indexOf(payload.outreach_status) === -1)
      throw new Error('Unknown outreach_status: ' + payload.outreach_status);

    const updated = updateListingFields_(payload.listing_id, {
      assigned_to:           payload.assigned_to,
      outreach_status:       payload.outreach_status,
      marketing_plan_status: payload.marketing_plan_status,
      notes:                 payload.notes
    });

    if (payload.outreach_status || payload.assigned_to || payload.marketing_angle || payload.follow_up_date) {
      upsertOutreachEntry_({
        listing_id:      payload.listing_id,
        assigned_to:     payload.assigned_to || '',
        outreach_status: payload.outreach_status || '',
        marketing_angle: payload.marketing_angle || '',
        follow_up_date:  payload.follow_up_date || '',
        notes:           payload.notes || ''
      });
    }
    return { ok: true, listing: updated };
  } catch (err) {
    logError_('uiUpdateListingOutreach', err.message, err.stack);
    return { ok: false, message: err.message };
  }
}

// =====================================================================
//   UI BRIDGE — Saved Searches
// =====================================================================

function uiAddSavedSearch(payload) {
  try {
    if (!payload || !payload.search_name) throw new Error('Search name is required.');
    if (payload.min_price && !isValidPrice_(payload.min_price)) throw new Error('min_price must be a non-negative number.');
    if (payload.max_price && !isValidPrice_(payload.max_price)) throw new Error('max_price must be a non-negative number.');
    const search = {
      search_id:         's_' + Utilities.getUuid().slice(0,8),
      search_name:       String(payload.search_name).trim(),
      min_price:         payload.min_price ? Number(payload.min_price) : '',
      max_price:         payload.max_price ? Number(payload.max_price) : '',
      area:              String(payload.area||'').trim(),
      namespace:         String(payload.namespace||'').trim(),
      property_category: String(payload.property_category||'residential').trim(),
      listing_type:      String(payload.listing_type||'sale').trim(),
      sale_status:       String(payload.sale_status||'active').trim(),
      alert_timing:      String(payload.alert_timing||'instant').trim(),
      active:            parseBool_(payload.active === undefined ? true : payload.active) ? 'TRUE' : 'FALSE',
      created_at:        nowIso_()
    };
    appendSavedSearch_(search);
    return { ok: true, search: search };
  } catch (err) {
    logError_('uiAddSavedSearch', err.message, err.stack);
    return { ok: false, message: err.message };
  }
}

function uiUpdateSavedSearch(payload) {
  try {
    if (!payload || !payload.search_id) throw new Error('search_id is required.');
    const updated = updateSavedSearch_(payload.search_id, {
      search_name:       payload.search_name,
      min_price:         payload.min_price === '' ? '' : (payload.min_price !== undefined ? Number(payload.min_price) : undefined),
      max_price:         payload.max_price === '' ? '' : (payload.max_price !== undefined ? Number(payload.max_price) : undefined),
      area:              payload.area,
      namespace:         payload.namespace,
      property_category: payload.property_category,
      listing_type:      payload.listing_type,
      sale_status:       payload.sale_status,
      alert_timing:      payload.alert_timing,
      active:            payload.active === undefined ? undefined : (parseBool_(payload.active) ? 'TRUE' : 'FALSE')
    });
    return { ok: true, search: updated };
  } catch (err) {
    logError_('uiUpdateSavedSearch', err.message, err.stack);
    return { ok: false, message: err.message };
  }
}

function uiDeleteSavedSearch(searchId) {
  try {
    if (!searchId) throw new Error('search_id is required.');
    deleteSavedSearch_(searchId);
    return { ok: true };
  } catch (err) {
    logError_('uiDeleteSavedSearch', err.message, err.stack);
    return { ok: false, message: err.message };
  }
}

// =====================================================================
//   UI BRIDGE — Triggers / scan
// =====================================================================

function uiInstallTrigger() {
  try {
    installScanTrigger();
    // Re-read actual trigger state from ScriptApp; never assume
    return { ok: true, installed: isListingTriggerInstalled_() };
  } catch (err) {
    logError_('uiInstallTrigger', err.message, err.stack);
    return { ok: false, message: err.message };
  }
}

function uiRemoveTrigger() {
  try {
    removeScanTriggers();
    return { ok: true, installed: isListingTriggerInstalled_() };
  } catch (err) {
    logError_('uiRemoveTrigger', err.message, err.stack);
    return { ok: false, message: err.message };
  }
}

function uiRunScanNow() {
  return runScanNow();
}

function installManagedTabRefreshTrigger() {
  // Remove any existing refresh triggers first
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'refreshManagedLeadTabs') {
      ScriptApp.deleteTrigger(t);
    }
  });
  
  // Install new 5-minute refresh trigger
  ScriptApp.newTrigger('refreshManagedLeadTabs')
    .timeBased()
    .everyMinutes(5)
    .create();
    
  return { ok: true, message: 'Managed tab refresh trigger installed (every 5 minutes)' };
}

function removeManagedTabRefreshTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'refreshManagedLeadTabs') {
      ScriptApp.deleteTrigger(t);
    }
  });
  return { ok: true, message: 'Managed tab refresh trigger removed' };
}

function getDashboardRowsByBorough_(borough) {
  borough = normalizeBorough_(borough);

  return readAllListings_().filter(function(l) {
    var isSent =
      String(l.alert_sent || '').toUpperCase() === 'TRUE' ||
      String(l.alert_sent_at || '').trim() !== '' ||
      isSentTimestamp_(l.alert_sent);

    var isActive =
      getLeadTabForStatus_(l.outreach_status) === MANAGED_LEAD_TABS.ACTIVE;

    var matchesBorough =
      !borough || normalizeBorough_(l.area) === borough;

    return isSent && isActive && matchesBorough;
  });
}

function getDashboardBoroughViewsFromRows_(rows) {
  var views = {
    brooklyn: [],
    queens: [],
    bronx: [],
    manhattan: [],
    staten_island: []
  };

  rows.forEach(function(l) {
    var borough = normalizeBorough_(l.area);

    if (borough === 'Brooklyn') views.brooklyn.push(l);
    if (borough === 'Queens') views.queens.push(l);
    if (borough === 'Bronx') views.bronx.push(l);
    if (borough === 'Manhattan') views.manhattan.push(l);
    if (borough === 'Staten Island') views.staten_island.push(l);
  });

  return views;
}