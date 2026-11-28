/**
 * PT. Pridhana Eka — Internal Application API (Google Apps Script Web App)
 * Dipasangkan dengan github/index.html (frontend).
 *
 * Protokol:
 *   POST  { action, token?, ...data }  ->  { status:'OK', data } | { status:'ERROR', message, code? }
 *   - 'login' mengembalikan { token, username, fullName, role }.
 *   - Semua action lain WAJIB membawa token. User & role diambil dari sesi di server
 *     (nilai user/role kiriman browser diabaikan), sehingga hak akses tidak bisa dipalsukan.
 */

const SPREADSHEET_ID = '1vYYJRAyV3UU8-TSnCKv17fcPpT5elVoeQKGF0-IgEdY';
const ROOT_DRIVE_FOLDER_ID = '182dvrVDmU3hzhfcjdwcHihuA8Ij5jgcl';

const TZ = 'Asia/Jakarta';
const SESSION_TTL_SEC = 6 * 60 * 60;   // batas maksimum CacheService = 6 jam
const LOGIN_MAX_FAIL = 5;
const LOGIN_LOCK_SEC = 5 * 60;

// ---------------------------------------------------------------------------
// Konstanta alur
// ---------------------------------------------------------------------------
const ST = {
  MISMATCH: 'PO_QUOT_MISMATCH',
  WAIT_SCHEDULE: 'WAITING_LEADER_SCHEDULE',
  IN_PROGRESS: 'IN_PROGRESS_TECH',
  WAIT_ADMIN_DOC: 'WAITING_ADMIN_DOC',
  READY_ACC_SHIP: 'READY_FOR_ACC_AND_SHIPPING',
  WAIT_SHIP: 'WAITING_SHIPPING_RECEIPT',
  READY_PURCHASING: 'READY_FOR_PURCHASING_BILLING',
  REVISION_HOLD: 'REVISION_HOLD',
  HOLD_INCOMPLETE: 'HOLD_INCOMPLETE',
  CLOSED: 'CLOSED'
};

const DOC = {
  UNSCHEDULED: 'UNSCHEDULED',
  SCHEDULED: 'SCHEDULED',
  SUBMITTED: 'SUBMITTED_TO_ADMIN_DOC',
  APPROVED: 'APPROVED_BY_DOC',
  REVISION: 'REVISION_REQUIRED'
};

const ROLE_ADMIN = 'Administrator';

// action -> role yang boleh menjalankan (Administrator selalu boleh)
const ACTION_ROLES = {
  getDashboardData: null,                 // semua user yang sudah login
  logout: null,
  createOrder: ['Admin/Sales'],
  verifyQuotPO: ['Admin/Sales'],
  assignSchedule: ['Leader'],
  uploadTechDocs: ['Teknisi'],
  verifyTechDocs: ['Admin-Dokumen'],
  uploadAccountingDocs: ['Accounting'],
  uploadShippingDocs: ['Admin-Pengiriman'],
  purchasingAction: ['Finance'],
  adminEditOrder: [],
  adminDeleteOrder: []
};
const READ_ONLY_ACTIONS = { getDashboardData: true, logout: true };

// BillingMode: FULL = dokumen, invoice & bayar sekaligus | PARTIAL = dokumen, invoice & bayar parsial per batch unit
//              DOC_PARTIAL = dokumen dikirim parsial (tanda terima per kiriman), invoice keseluruhan & bayar lunas
const BILLING_MODES = ['FULL', 'PARTIAL', 'DOC_PARTIAL'];
const BILLING_PHASE = [ST.READY_ACC_SHIP, ST.WAIT_SHIP, ST.READY_PURCHASING];
const VALID_SERVICE_TYPES = ['Instalasi', 'Kalibrasi', 'Service Kontrak', 'Service'];
const ALL_STATUSES = Object.keys(ST).map(k => ST[k]);

// Kolom yang harus berformat teks agar "00123" / "2026-12-01" tidak diubah Sheets
const TEXT_COLUMNS = {
  Orders: ['QuotNo', 'PONo', 'DriveFolderId'],
  Schedules: ['SerialNo', 'ScheduledDate', 'AssignmentNo'],
  Billings: ['InvoiceNo', 'Units']
};

const SCHEMAS = {
  Users: ['Username', 'Password', 'FullName', 'Role', 'Active'],
  Orders: [
    'OrderID', 'ServiceType', 'CustomerName', 'QuotNo', 'QuotDesc', 'QuotTotalQty', 'QuotFileUrl',
    'PONo', 'PODesc', 'POTotalQty', 'POFileUrl', 'BillingMode', 'Status', 'RevisionReason',
    'DriveFolderId', 'CreatedBy', 'CreatedAt', 'TotalValue',
    'Subtotal', 'DiscountType', 'DiscountValue', 'DiscountAmount', 'TaxType', 'TaxValue', 'TaxAmount'
  ],
  Schedules: [
    'ScheduleID', 'OrderID', 'ServiceType', 'InstrumentName', 'SerialNo', 'VisitType',
    'ScheduledDate', 'Technicians', 'DocStatus', 'RevisionCount', 'Notes',
    'JobReportUrl', 'IQOQ_PQ_Url', 'UpdatedAt', 'UnitPrice', 'AssignmentNo', 'AssignedBy', 'AssignedAt'
  ],
  Billings: [
    'BillingID', 'OrderID', 'InvoiceNo', 'InvoiceUrl', 'TaxInvoiceUrl', 'TaxReceiptUrl',
    'DeliveryNoteUrl', 'BillingReceiptUrl', 'DocDeliveryReceiptUrl', 'PaymentStatus', 'UpdatedAt',
    'Kind', 'Units', 'Amount', 'CreatedBy', 'PaymentProofUrl', 'PaymentNote', 'PaidAt',
    'Subtotal', 'DiscountType', 'DiscountValue', 'DiscountAmount', 'TaxType', 'TaxValue', 'TaxAmount'
  ],
  AuditLogs: ['LogID', 'OrderID', 'User', 'Role', 'Action', 'Details', 'Timestamp']
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function doGet(e) {
  return jsonResponse({
    status: 'OK',
    app: 'PT. Pridhana Eka Internal Application API',
    mode: 'WEB_APP_API',
    timestamp: new Date().toISOString()
  });
}

function doPost(e) {
  let lock = null;
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ status: 'ERROR', message: 'Payload kosong.' });
    }
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;

    if (action !== 'login' && !Object.prototype.hasOwnProperty.call(ACTION_ROLES, action)) {
      throw new Error('Action tidak dikenali: ' + action);
    }

    // Sesi & hak akses (di server, bukan dari kiriman browser)
    let session = null;
    if (action !== 'login') {
      session = getSession(payload.token);
      if (!session) {
        return jsonResponse({ status: 'ERROR', code: 'SESSION_EXPIRED', message: 'Sesi berakhir. Silakan login kembali.' });
      }
      assertRole(session, action);
      payload.user = session.fullName;
      payload.role = session.role = normRole(session.role);
    }

    if (!READ_ONLY_ACTIONS[action]) {
      lock = LockService.getScriptLock();
      lock.waitLock(20000);
    }
    initSheetsIfNeeded();

    let result;
    switch (action) {
      case 'login': result = handleLogin(payload); break;
      case 'logout': result = handleLogout(payload); break;
      case 'getDashboardData': result = handleGetDashboardData(); break;
      case 'createOrder': result = handleCreateOrder(payload); break;
      case 'verifyQuotPO': result = handleVerifyQuotPO(payload); break;
      case 'assignSchedule': result = handleAssignSchedule(payload); break;
      case 'uploadTechDocs': result = handleUploadTechDocs(payload); break;
      case 'verifyTechDocs': result = handleVerifyTechDocs(payload); break;
      case 'uploadAccountingDocs': result = handleUploadAccountingDocs(payload); break;
      case 'uploadShippingDocs': result = handleUploadShippingDocs(payload); break;
      case 'purchasingAction': result = handlePurchasingAction(payload); break;
      case 'adminEditOrder': result = handleAdminEditOrder(payload); break;
      case 'adminDeleteOrder': result = handleAdminDeleteOrder(payload); break;
    }
    return jsonResponse({ status: 'OK', data: result });
  } catch (err) {
    return jsonResponse({ status: 'ERROR', message: (err && err.message) || String(err) });
  } finally {
    if (lock) lock.releaseLock();
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Sesi & keamanan
// ---------------------------------------------------------------------------
function getSession(token) {
  if (!token) return null;
  const raw = CacheService.getScriptCache().get('sess_' + token);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function assertRole(session, action) {
  const allowed = ACTION_ROLES[action];
  if (allowed === null) return;                       // semua role
  if (session.role === ROLE_ADMIN) return;            // super admin
  if (allowed.indexOf(session.role) === -1) {
    throw new Error('Akses ditolak: role "' + session.role + '" tidak berwenang untuk aksi ini.');
  }
}

// Peran lama 'Purchasing' kini bernama 'Finance' (sheet Users lama tetap bisa dipakai)
function normRole(r) { r = String(r || '').trim(); return r === 'Purchasing' ? 'Finance' : r; }

function handleLogin(payload) {
  const uname = String(payload.username || '').trim().toLowerCase();
  const pass = String(payload.password || '').trim();
  if (!uname || !pass) throw new Error('Username dan password wajib diisi.');

  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + uname;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= LOGIN_MAX_FAIL) {
    throw new Error('Terlalu banyak percobaan gagal. Coba lagi dalam beberapa menit.');
  }

  const users = sheetToObjects(getSs().getSheetByName('Users'));
  const found = users.find(u =>
    String(u.Username).trim().toLowerCase() === uname &&
    String(u.Password).trim() === pass &&
    String(u.Active).toUpperCase() === 'TRUE'
  );
  if (!found) {
    cache.put(failKey, String(fails + 1), LOGIN_LOCK_SEC);
    throw new Error('Username atau password tidak valid.');
  }
  cache.remove(failKey);

  const user = {
    username: String(found.Username),
    fullName: String(found.FullName),
    role: normRole(found.Role)
  };
  const token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  cache.put('sess_' + token, JSON.stringify(user), SESSION_TTL_SEC);
  return Object.assign({ token: token }, user);
}

function handleLogout(payload) {
  if (payload.token) CacheService.getScriptCache().remove('sess_' + payload.token);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helper Spreadsheet / Drive
// ---------------------------------------------------------------------------
function getSs() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID.indexOf('GANTI_') === 0) {
    return SpreadsheetApp.getActiveSpreadsheet();
  }
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getRootFolder() {
  if (!ROOT_DRIVE_FOLDER_ID || ROOT_DRIVE_FOLDER_ID.indexOf('GANTI_') === 0) {
    const folders = DriveApp.getFoldersByName('PT_Pridhana_Eka_Service_Archive');
    if (folders.hasNext()) return folders.next();
    return DriveApp.createFolder('PT_Pridhana_Eka_Service_Archive');
  }
  return DriveApp.getFolderById(ROOT_DRIVE_FOLDER_ID);
}

// Daftar akun awal (dipakai saat sheet Users masih kosong, atau lewat resetUsersToDefault()).
const DEFAULT_USERS = [
  ['admi', 'admin123', 'Administrator Utama', 'Administrator', 'TRUE'],
  ['ridwan', 'sales123', 'Mohammad Ridwan', 'Admin/Sales', 'TRUE'],
  ['nunuy', 'sales123', 'Nursadiyah', 'Admin/Sales', 'TRUE'],
  ['ecep', 'sales123', 'Ecep Dian Rohimat', 'Admin/Sales', 'TRUE'],
  ['wawan', 'sales123', 'Wawan Darmawan', 'Admin/Sales', 'TRUE'],
  ['jeni', 'sales123', 'Jeni Pratama', 'Admin/Sales', 'TRUE'],
  ['octa', 'sales123', 'M Octa Nasrullah', 'Admin/Sales', 'TRUE'],
  ['robby', 'leader123', 'Robby Iskandar', 'Leader', 'TRUE'],
  ['robby-tek', 'tek123', 'Robby Iskandar', 'Teknisi', 'TRUE'],
  ['jeni-tek', 'tek123', 'Jeni Pratama', 'Teknisi', 'TRUE'],
  ['octa-tek', 'tek123', 'M Octa Nasrullah', 'Teknisi', 'TRUE'],
  ['nebil', 'tek123', 'Nebil Ramadhan Hasmi', 'Teknisi', 'TRUE'],
  ['ary', 'tek123', 'Ary Pranajaya', 'Teknisi', 'TRUE'],
  ['marsella', 'tek123', 'Marsella Puteri Nuranggraeni', 'Teknisi', 'TRUE'],
  ['luthfi', 'tek123', 'M Luthfi Fathurrahman', 'Teknisi', 'TRUE'],
  ['maghfira', 'tek123', 'MAGHFIRA', 'Teknisi', 'TRUE'],
  ['naufal', 'tek123', 'Moch.Naufal Nuurfadly', 'Teknisi', 'TRUE'],
  ['abi', 'tek123', 'Muhammad Abi Malaikah', 'Teknisi', 'TRUE'],
  ['thomas', 'tek123', 'Thomas Alamsyah Gumelar', 'Teknisi', 'TRUE'],
  ['yuda', 'doc123', 'Yuda Maulid Nur', 'Admin-Dokumen', 'TRUE'],
  ['ade', 'ship123', 'Ade Suryadi', 'Admin-Pengiriman', 'TRUE'],
  ['kintan', 'acc123', 'Kintan Inckany Ramadhian Thamaswara', 'Accounting', 'TRUE'],
  ['sri', 'pur123', 'Sri Haryati', 'Finance', 'TRUE'],
  ['gunawan', 'mgmt123', 'Gunawan', 'Management', 'TRUE'],
  ['handoko', 'mgmt123', 'Handoko Purnomo', 'Management', 'TRUE']
];

/** Jalankan MANUAL dari editor Apps Script (pilih fungsi ini lalu Run) untuk mengganti seluruh isi sheet Users
 *  dengan DEFAULT_USERS. Semua sesi login lama dibatalkan otomatis karena akun lama tidak ada lagi. */
function resetUsersToDefault() {
  const ss = getSs();
  initSheetsIfNeeded();
  const sh = ss.getSheetByName('Users');
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), 5)).clearContent();
  sh.getRange(2, 1, DEFAULT_USERS.length, 5).setValues(DEFAULT_USERS);
  return DEFAULT_USERS.length + ' akun ditulis ke sheet Users.';
}

function initSheetsIfNeeded() {
  const cache = CacheService.getScriptCache();
  // kunci cache ikut berubah bila skema (daftar kolom) berubah, sehingga kolom baru otomatis dimigrasi
  const initKey = 'init_ok_' + Object.keys(SCHEMAS).map(k => SCHEMAS[k].join('|')).join('#').length;
  if (cache.get(initKey)) return;

  const ss = getSs();
  Object.keys(SCHEMAS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.appendRow(SCHEMAS[name]);
      sh.setFrozenRows(1);
    }
    // migrasi: tambahkan kolom baru di ujung kanan pada sheet lama
    const have = sh.getLastColumn() > 0 ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
    SCHEMAS[name].forEach(h => {
      if (have.indexOf(h) === -1) { sh.getRange(1, have.length + 1).setValue(h); have.push(h); }
    });
    (TEXT_COLUMNS[name] || []).forEach(col => {
      const idx = have.indexOf(col) + 1;
      if (idx > 0) sh.getRange(1, idx, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  });

  const usersSheet = ss.getSheetByName('Users');
  if (usersSheet.getLastRow() <= 1) {
    usersSheet.getRange(2, 1, DEFAULT_USERS.length, 5).setValues(DEFAULT_USERS);
  }
  cache.put(initKey, '1', 3600);
}

/** Baca sheet -> array objek. Date dikembalikan sebagai string yang konsisten dengan frontend. */
function sheetToObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0];
  return values.slice(1).map((row, idx) => {
    const obj = { _rowIndex: idx + 2 };
    headers.forEach((h, i) => {
      let v = row[i];
      if (v instanceof Date) {
        v = (h === 'ScheduledDate')
          ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd')
          : v.toISOString();
      }
      obj[h] = v;
    });
    return obj;
  });
}

/** Update beberapa kolom pada satu baris berdasarkan NAMA kolom (bukan nomor kolom). */
function updateRow(sheet, rowIndex, fields) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  Object.keys(fields).forEach(key => {
    const col = headers.indexOf(key) + 1;
    if (col < 1) throw new Error('Kolom tidak ditemukan: ' + key);
    const cell = sheet.getRange(rowIndex, col);
    if ((TEXT_COLUMNS[sheet.getName()] || []).indexOf(key) > -1) cell.setNumberFormat('@');
    cell.setValue(fields[key]);
  });
}

/** Tambah baris berdasarkan NAMA kolom (aman walau urutan kolom di sheet berbeda). */
function appendObjects(sheet, objs) {
  if (!objs.length) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const textCols = TEXT_COLUMNS[sheet.getName()] || [];
  const rows = objs.map(o => headers.map(h => (o[h] === undefined ? '' : o[h])));
  const range = sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length);
  range.setNumberFormats(rows.map(() => headers.map(h => (textCols.indexOf(h) > -1 ? '@' : 'General'))));
  range.setValues(rows);
}

function findOrder(orderId) {
  const sh = getSs().getSheetByName('Orders');
  const row = sheetToObjects(sh).find(o => o.OrderID === orderId);
  if (!row) throw new Error('Order tidak ditemukan.');
  return { sheet: sh, row: row };
}

function safeName(s) {
  return String(s || '').replace(/[\\\/:*?"<>|#%]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'x';
}

function saveBase64Pdf(folder, base64Data, fileName) {
  if (!base64Data) return '';
  const idx = base64Data.indexOf(',');
  const clean = idx > -1 ? base64Data.slice(idx + 1) : base64Data;
  const bytes = Utilities.base64Decode(clean);
  const blob = Utilities.newBlob(bytes, 'application/pdf', safeName(fileName));
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

function writeLog(orderId, user, role, action, details) {
  const sh = getSs().getSheetByName('AuditLogs');
  const logId = 'LOG-' + Utilities.getUuid().slice(0, 8).toUpperCase();
  sh.appendRow([logId, orderId || '-', user || 'System', role || '-', action, details, new Date().toISOString()]);
}

function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function handleGetDashboardData() {
  const ss = getSs();
  const orders = sheetToObjects(ss.getSheetByName('Orders')).reverse();
  const schedules = sheetToObjects(ss.getSheetByName('Schedules'));
  const billings = sheetToObjects(ss.getSheetByName('Billings'));
  const logs = sheetToObjects(ss.getSheetByName('AuditLogs')).reverse().slice(0, 300);
  const techniciansList = sheetToObjects(ss.getSheetByName('Users'))
    .filter(u => String(u.Role).trim() === 'Teknisi' && String(u.Active).toUpperCase() === 'TRUE')
    .map(u => u.FullName);
  return { orders, schedules, billings, logs, techniciansList, serverTime: nowIso() };
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------
function handleCreateOrder(payload) {
  const ss = getSs();
  const ordersSheet = ss.getSheetByName('Orders');
  const schedSheet = ss.getSheetByName('Schedules');
  const customerName = String(payload.customerName || '').trim();
  const quotNo = String(payload.quotNo || '').trim();
  const poNo = String(payload.poNo || '').trim();
  if (VALID_SERVICE_TYPES.indexOf(payload.serviceType) === -1) throw new Error('Jenis pekerjaan tidak valid.');
  if (!customerName) throw new Error('Nama customer wajib diisi.');
  if (!quotNo) throw new Error('Nomor Quotation wajib diisi.');
  if (!poNo) throw new Error('Nomor PO wajib diisi.');
  if (!payload.quotFileBase64 || !payload.poFileBase64) throw new Error('PDF Quotation dan PDF PO wajib diunggah.');

  const existingOrders = sheetToObjects(ordersSheet);
  const duplicate = existingOrders.find(o => String(o.PONo).trim().toLowerCase() === poNo.toLowerCase());
  if (duplicate) {
    throw new Error('Nomor PO "' + poNo + '" sudah terdaftar pada Order ID ' + duplicate.OrderID + ' (Anti-Double PO).');
  }

  // ID unik: stempel waktu + angka acak, diulang bila (jarang) bentrok dengan order lain.
  const usedIds = {};
  existingOrders.forEach(o => { usedIds[o.OrderID] = true; });
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
  let orderId;
  do {
    orderId = 'ORD-' + stamp + '-' + Math.floor(Math.random() * 900 + 100);
  } while (usedIds[orderId]);
  const orderFolder = getRootFolder().createFolder(safeName(orderId + '_' + customerName + '_' + poNo));
  orderFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const quotUrl = saveBase64Pdf(orderFolder, payload.quotFileBase64, orderId + '_Quotation_' + quotNo + '.pdf');
  const poUrl = saveBase64Pdf(orderFolder, payload.poFileBase64, orderId + '_PO_' + poNo + '.pdf');

  const qQty = Number(payload.quotTotalQty || 0);
  const pQty = Number(payload.poTotalQty || 0);
  const isMismatch = qQty !== pQty;
  const status = isMismatch ? ST.MISMATCH : ST.WAIT_SCHEDULE;
  const reason = isMismatch ? ('Qty Quotation (' + qQty + ') != Qty PO (' + pQty + ')') : '';
  const ts = nowIso();

  const rawInst = Array.isArray(payload.instruments) && payload.instruments.length > 0
    ? payload.instruments
    : [{ name: payload.poDesc || 'Instrument', serialNo: '-', price: 0 }];
  const instruments = rawInst.map((inst, idx) => ({
    name: String(inst.name || '').trim() || ('Unit #' + (idx + 1)),
    serialNo: String(inst.serialNo || '').trim() || '-',
    price: Math.max(0, Number(inst.price || 0)) || 0
  }));
  const subtotalInst = instruments.reduce((sum, i) => sum + i.price, 0);
  const pricing = calcPricing(subtotalInst, payload.discountType, payload.discountValue, payload.taxType, payload.taxValue);

  // Opsi penagihan parsial hanya untuk Instalasi / Kalibrasi dengan lebih dari 1 unit
  const canPartial = ['Instalasi', 'Kalibrasi'].indexOf(payload.serviceType) > -1 && instruments.length > 1;
  const billingMode = (canPartial && BILLING_MODES.indexOf(payload.billingMode) > -1) ? payload.billingMode : 'FULL';

  appendObjects(ordersSheet, [{
    OrderID: orderId, ServiceType: payload.serviceType, CustomerName: customerName, QuotNo: quotNo,
    QuotDesc: String(payload.quotDesc || ''), QuotTotalQty: qQty, QuotFileUrl: quotUrl,
    PONo: poNo, PODesc: String(payload.poDesc || ''), POTotalQty: pQty, POFileUrl: poUrl,
    BillingMode: billingMode, Status: status, RevisionReason: reason,
    DriveFolderId: orderFolder.getId(), CreatedBy: payload.user, CreatedAt: ts, TotalValue: pricing.Total,
    Subtotal: pricing.Subtotal, DiscountType: pricing.DiscountType, DiscountValue: pricing.DiscountValue,
    DiscountAmount: pricing.DiscountAmount, TaxType: pricing.TaxType, TaxValue: pricing.TaxValue, TaxAmount: pricing.TaxAmount
  }]);

  const schedObjs = [];
  instruments.forEach((inst, idx) => {
    if (payload.serviceType === 'Service Kontrak') {
      [1, 2, 3].forEach(visitNo => {
        schedObjs.push({
          ScheduleID: orderId + '-U' + (idx + 1) + '-K' + visitNo, OrderID: orderId, ServiceType: payload.serviceType,
          InstrumentName: inst.name, SerialNo: inst.serialNo, VisitType: 'Kunjungan ' + visitNo + ' / 3 (Tahunan)',
          ScheduledDate: '', Technicians: '', DocStatus: DOC.UNSCHEDULED, RevisionCount: 0, Notes: '',
          JobReportUrl: '', IQOQ_PQ_Url: '', UpdatedAt: ts, UnitPrice: inst.price
        });
      });
    } else {
      schedObjs.push({
        ScheduleID: orderId + '-U' + (idx + 1), OrderID: orderId, ServiceType: payload.serviceType,
        InstrumentName: inst.name, SerialNo: inst.serialNo, VisitType: payload.serviceType,
        ScheduledDate: '', Technicians: '', DocStatus: DOC.UNSCHEDULED, RevisionCount: 0, Notes: '',
        JobReportUrl: '', IQOQ_PQ_Url: '', UpdatedAt: ts, UnitPrice: inst.price
      });
    }
  });
  appendObjects(schedSheet, schedObjs);


  writeLog(orderId, payload.user, payload.role, 'CREATE_ORDER',
    'Input ' + payload.serviceType + ' | PO: ' + poNo + ' | ' + instruments.length + ' instrumen | Status: ' + status);
  return { orderId: orderId, status: status };
}

function handleVerifyQuotPO(payload) {
  const o = findOrder(payload.orderId);
  if (o.row.Status !== ST.MISMATCH) throw new Error('Order tidak berstatus mismatch Qty.');
  updateRow(o.sheet, o.row._rowIndex, {
    Status: ST.WAIT_SCHEDULE,
    RevisionReason: 'Diverifikasi manual oleh ' + payload.user
  });
  writeLog(payload.orderId, payload.user, payload.role, 'VERIFY_QUOT_PO', 'Qty Quot vs PO dikonfirmasi sesuai.');
  return { orderId: payload.orderId, status: ST.WAIT_SCHEDULE };
}

// ---------------------------------------------------------------------------
// Jadwal & dokumen teknisi
// ---------------------------------------------------------------------------
function handleAssignSchedule(payload) {
  const ss = getSs();
  const schedSheet = ss.getSheetByName('Schedules');
  const o = findOrder(payload.orderId);
  if (o.row.Status === ST.MISMATCH) throw new Error('Qty Quotation & PO belum sesuai. Minta Sales memverifikasi terlebih dulu.');
  if (o.row.Status === ST.CLOSED) throw new Error('Order sudah CLOSED.');

  const allScheds = sheetToObjects(schedSheet).filter(s => s.OrderID === payload.orderId);
  const validTechs = sheetToObjects(ss.getSheetByName('Users'))
    .filter(u => String(u.Role).trim() === 'Teknisi' && String(u.Active).toUpperCase() === 'TRUE')
    .map(u => String(u.FullName).trim().toLowerCase());
  const ts = nowIso();
  let count = 0;
  const numbers = [];
  // nomor surat tugas berurutan per bulan: ST/PE/2026/11/0001 (nomor tetap bila jadwal/teknisi diubah)
  const ym = Utilities.formatDate(new Date(), TZ, 'yyyy/MM');
  const prefix = 'ST/PE/' + ym + '/';
  let seq = 0;
  sheetToObjects(schedSheet).forEach(r => {
    const a = String(r.AssignmentNo || '');
    if (a.indexOf(prefix) === 0) seq = Math.max(seq, parseInt(a.slice(prefix.length), 10) || 0);
  });

  (payload.schedules || []).forEach(item => {
    const found = allScheds.find(s => s.ScheduleID === item.scheduleId);
    if (!found) return;
    const techs = (item.technicians || []).map(t => String(t).trim()).filter(Boolean);
    if (!item.scheduledDate || techs.length === 0) throw new Error('Tanggal dan teknisi wajib diisi.');
    const already = splitUnits(found.Technicians).map(t => t.toLowerCase());
    techs.forEach(t => {
      if (already.indexOf(t.toLowerCase()) === -1 && validTechs.indexOf(t.toLowerCase()) === -1) {
        throw new Error('"' + t + '" bukan teknisi aktif pada daftar pengguna.');
      }
    });
    const fields = { ScheduledDate: String(item.scheduledDate), Technicians: techs.join(', '), UpdatedAt: ts, AssignedBy: payload.user, AssignedAt: ts };
    if (!found.AssignmentNo) { seq++; fields.AssignmentNo = prefix + ('0000' + seq).slice(-4); }
    numbers.push(found.AssignmentNo || fields.AssignmentNo);
    // jangan menurunkan status unit yang sudah berjalan / selesai
    if ([DOC.UNSCHEDULED, DOC.SCHEDULED].indexOf(found.DocStatus) > -1) fields.DocStatus = DOC.SCHEDULED;
    updateRow(schedSheet, found._rowIndex, fields);
    count++;
  });
  if (count === 0) throw new Error('Tidak ada jadwal yang valid untuk disimpan.');

  if (o.row.Status === ST.WAIT_SCHEDULE) updateRow(o.sheet, o.row._rowIndex, { Status: ST.IN_PROGRESS });
  writeLog(payload.orderId, payload.user, payload.role, 'ASSIGN_SCHEDULE', 'Surat tugas ' + numbers.join(', ') + ' disimpan (' + count + ' jadwal).');
  return { ok: true, updated: count, assignmentNos: numbers };
}

/**
 * Hitung ulang status order pada fase teknis berdasarkan seluruh unit/kunjungan.
 * (Memperbaiki masalah: order lompat ke tahap berikutnya padahal unit lain belum selesai.)
 */
function recomputeTechStatus(orderId) {
  const ss = getSs();
  const o = findOrder(orderId);
  const techPhase = [ST.IN_PROGRESS, ST.WAIT_ADMIN_DOC, ST.HOLD_INCOMPLETE, ST.REVISION_HOLD];
  if (techPhase.indexOf(o.row.Status) === -1) return o.row.Status;

  const scheds = sheetToObjects(ss.getSheetByName('Schedules')).filter(s => s.OrderID === orderId);
  const n = scheds.length;
  const cnt = st => scheds.filter(s => s.DocStatus === st).length;
  const approved = cnt(DOC.APPROVED), revision = cnt(DOC.REVISION), submitted = cnt(DOC.SUBMITTED);
  const partial = o.row.BillingMode === 'PARTIAL' || o.row.BillingMode === 'DOC_PARTIAL';

  let next;
  if (n > 0 && approved === n) next = ST.READY_ACC_SHIP;
  else if (partial && approved > 0) next = ST.READY_ACC_SHIP;
  else if (revision > 0) next = ST.HOLD_INCOMPLETE;
  else if (submitted > 0) next = ST.WAIT_ADMIN_DOC;
  else next = ST.IN_PROGRESS;

  const fields = { Status: next };
  if (next === ST.READY_ACC_SHIP || next === ST.WAIT_ADMIN_DOC || next === ST.IN_PROGRESS) fields.RevisionReason = '';
  updateRow(o.sheet, o.row._rowIndex, fields);
  return next;
}

function handleUploadTechDocs(payload) {
  const schedSheet = getSs().getSheetByName('Schedules');
  const o = findOrder(payload.orderId);
  const schedRow = sheetToObjects(schedSheet).find(s => s.ScheduleID === payload.scheduleId && s.OrderID === payload.orderId);
  if (!schedRow) throw new Error('Data jadwal tidak ditemukan.');
  if ([DOC.SCHEDULED, DOC.REVISION].indexOf(schedRow.DocStatus) === -1) {
    throw new Error('Unit ini belum dijadwalkan atau dokumennya sudah diserahkan.');
  }
  // Hanya teknisi yang ditunjuk Leader untuk unit/kunjungan ini yang boleh menyerahkan dokumen (Administrator dikecualikan).
  if (payload.role !== ROLE_ADMIN) {
    const assigned = splitUnits(schedRow.Technicians).map(t => t.toLowerCase());
    if (assigned.indexOf(String(payload.user).trim().toLowerCase()) === -1) {
      throw new Error('Akses ditolak: unit ini ditugaskan kepada ' + (splitUnits(schedRow.Technicians).join(', ') || 'teknisi lain') +
        '. Hanya teknisi yang ditunjuk Leader yang dapat menyerahkan dokumen.');
    }
  }
  if (!payload.jobReportBase64) throw new Error('Job Report PDF wajib diunggah.');
  const needCert = schedRow.ServiceType !== 'Service';
  if (needCert && !payload.certBase64 && !schedRow.IQOQ_PQ_Url) throw new Error('Dokumen IQOQ / PQ PDF wajib diunggah.');

  const folder = DriveApp.getFolderById(o.row.DriveFolderId);
  const rev = Number(schedRow.RevisionCount || 0);
  const suffix = rev > 0 ? '_rev' + rev : '';
  const jrUrl = saveBase64Pdf(folder, payload.jobReportBase64, payload.scheduleId + '_JobReport' + suffix + '.pdf');
  const certUrl = payload.certBase64
    ? saveBase64Pdf(folder, payload.certBase64, payload.scheduleId + '_IQOQ_PQ' + suffix + '.pdf')
    : schedRow.IQOQ_PQ_Url;

  updateRow(schedSheet, schedRow._rowIndex, {
    DocStatus: DOC.SUBMITTED,
    JobReportUrl: jrUrl,
    IQOQ_PQ_Url: certUrl || '',
    UpdatedAt: nowIso()
  });
  recomputeTechStatus(payload.orderId);
  writeLog(payload.orderId, payload.user, payload.role, 'UPLOAD_TECH_DOCS', 'Serah terima dokumen via QR untuk ' + payload.scheduleId);
  return { ok: true };
}

function handleVerifyTechDocs(payload) {
  const schedSheet = getSs().getSheetByName('Schedules');
  findOrder(payload.orderId);
  const schedRow = sheetToObjects(schedSheet).find(s => s.ScheduleID === payload.scheduleId && s.OrderID === payload.orderId);
  if (!schedRow) throw new Error('Data jadwal tidak ditemukan.');
  if (schedRow.DocStatus !== DOC.SUBMITTED) throw new Error('Dokumen unit ini tidak sedang menunggu verifikasi.');

  if (payload.approved) {
    updateRow(schedSheet, schedRow._rowIndex, { DocStatus: DOC.APPROVED, Notes: '', UpdatedAt: nowIso() });
    const next = recomputeTechStatus(payload.orderId);
    writeLog(payload.orderId, payload.user, payload.role, 'APPROVE_TECH_DOC',
      'Dokumen ' + payload.scheduleId + ' diterima Admin-Dokumen. Status order: ' + next);
  } else {
    const notes = String(payload.notes || '').trim();
    if (!notes) throw new Error('Catatan revisi wajib diisi.');
    const revCount = Number(schedRow.RevisionCount || 0) + 1;
    updateRow(schedSheet, schedRow._rowIndex, {
      DocStatus: DOC.REVISION, RevisionCount: revCount, Notes: notes, UpdatedAt: nowIso()
    });
    // revisi selalu menahan order (kecuali sudah lanjut ke tahap penagihan pada mode PARTIAL)
    const o = findOrder(payload.orderId);
    if ([ST.IN_PROGRESS, ST.WAIT_ADMIN_DOC, ST.HOLD_INCOMPLETE].indexOf(o.row.Status) > -1) {
      updateRow(o.sheet, o.row._rowIndex, { Status: ST.HOLD_INCOMPLETE, RevisionReason: 'Revisi #' + revCount + ': ' + notes });
    }
    writeLog(payload.orderId, payload.user, payload.role, 'REJECT_TECH_DOC',
      'Revisi #' + revCount + ' untuk ' + payload.scheduleId + ': ' + notes);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Accounting, Pengiriman, Finance
// ---------------------------------------------------------------------------
/**
 * Hitung rincian nilai: Sub total - Diskon + PPN = Total.
 * Diskon & PPN dapat berupa persen (PERCENT) atau nilai manual (AMOUNT).
 * PPN dihitung dari (Sub total - Diskon).
 */
function calcPricing(subtotal, discType, discValue, taxType, taxValue) {
  const r2 = n => Math.round(n * 100) / 100;
  const sub = Math.max(0, Number(subtotal) || 0);
  const dType = discType === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';
  const tType = taxType === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';
  const dVal = Math.max(0, Number(discValue) || 0);
  const tVal = Math.max(0, Number(taxValue) || 0);
  if (dType === 'PERCENT' && dVal > 100) throw new Error('Diskon persen tidak boleh lebih dari 100%.');
  const disc = r2(Math.min(dType === 'PERCENT' ? sub * dVal / 100 : dVal, sub));
  const base = sub - disc;
  const tax = r2(tType === 'PERCENT' ? base * tVal / 100 : tVal);
  return {
    Subtotal: r2(sub), DiscountType: dType, DiscountValue: dVal, DiscountAmount: disc,
    TaxType: tType, TaxValue: tVal, TaxAmount: tax, Total: r2(base + tax)
  };
}

function splitUnits(v) { return String(v || '').split(',').map(x => x.trim()).filter(Boolean); }
function isInvRow(b) { return !b.Kind || b.Kind === 'INVOICE'; }
function isDelRow(b) { return !b.Kind || b.Kind === 'DELIVERY'; }
function invoiceDone(b) { return isInvRow(b) && !!b.InvoiceUrl && !!b.TaxInvoiceUrl && !!b.TaxReceiptUrl; }
function deliveryDone(b) { return isDelRow(b) && !!b.DeliveryNoteUrl && !!b.DocDeliveryReceiptUrl; }
function isPaid(b) { return b.PaymentStatus === 'PAID_CLOSED'; }

/**
 * Keadaan penagihan sebuah order. Satu baris Billings = satu invoice (Kind INVOICE) atau satu
 * pengiriman dokumen ke customer (Kind DELIVERY). Baris lama tanpa Kind dianggap mencakup keduanya & semua unit.
 */
function billingState(orderId) {
  const ss = getSs();
  const scheds = sheetToObjects(ss.getSheetByName('Schedules')).filter(s => s.OrderID === orderId);
  const ids = scheds.map(s => s.ScheduleID);
  const rows = sheetToObjects(ss.getSheetByName('Billings')).filter(b => b.OrderID === orderId);
  const unitsOf = b => { const u = splitUnits(b.Units); return u.length ? u : ids; };
  const cover = pred => {
    const set = {};
    rows.filter(pred).forEach(r => unitsOf(r).forEach(u => { set[u] = true; }));
    return set;
  };
  const invoiced = cover(invoiceDone);
  const delivered = cover(deliveryDone);
  const paid = cover(b => invoiceDone(b) && isPaid(b));
  const ready = rows.filter(b => invoiceDone(b) && !isPaid(b) && unitsOf(b).every(u => delivered[u]));
  return {
    scheds: scheds, ids: ids, rows: rows, unitsOf: unitsOf,
    approved: scheds.filter(s => s.DocStatus === DOC.APPROVED).map(s => s.ScheduleID),
    invoiced: invoiced, delivered: delivered, paid: paid, ready: ready
  };
}

/** Status order pada fase penagihan: diturunkan dari invoice / pengiriman / pembayaran yang sudah ada. */
function recomputeBillingStatus(orderId) {
  const o = findOrder(orderId);
  if (BILLING_PHASE.indexOf(o.row.Status) === -1) return o.row.Status;
  const st = billingState(orderId);
  let next;
  if (st.ids.length && st.ids.every(u => st.paid[u] && st.delivered[u])) next = ST.CLOSED;
  else if (st.ready.length) next = ST.READY_PURCHASING;
  else if (st.rows.some(b => invoiceDone(b) && !isPaid(b))) next = ST.WAIT_SHIP;
  else next = ST.READY_ACC_SHIP;
  const fields = { Status: next };
  if (next === ST.CLOSED) fields.RevisionReason = '';
  updateRow(o.sheet, o.row._rowIndex, fields);
  return next;
}

/** Validasi pilihan unit untuk satu invoice / pengiriman sesuai mode penagihan. */
function pickUnits(o, st, requested, alreadyCovered, wholeOrderModes, label) {
  const mode = o.row.BillingMode || 'FULL';
  if (wholeOrderModes.indexOf(mode) > -1) {
    if (st.approved.length !== st.ids.length) {
      throw new Error(label + ' keseluruhan baru bisa dibuat setelah SEMUA unit disetujui (' + st.approved.length + '/' + st.ids.length + ').');
    }
    if (st.ids.some(u => alreadyCovered[u])) throw new Error(label + ' keseluruhan sudah dibuat.');
    return st.ids.slice();
  }
  const units = (Array.isArray(requested) ? requested : splitUnits(requested)).map(String);
  if (!units.length) throw new Error('Pilih minimal satu unit.');
  units.forEach(u => {
    if (st.ids.indexOf(u) === -1) throw new Error('Unit tidak dikenal: ' + u);
    if (st.approved.indexOf(u) === -1) throw new Error('Unit ' + u + ' belum disetujui Admin-Dokumen.');
    if (alreadyCovered[u]) throw new Error('Unit ' + u + ' sudah tercakup pada ' + label.toLowerCase() + ' sebelumnya.');
  });
  return units;
}

function handleUploadAccountingDocs(payload) {
  const o = findOrder(payload.orderId);
  if (BILLING_PHASE.indexOf(o.row.Status) === -1) throw new Error('Order belum berada pada tahap Invoice & Pengiriman.');
  const st = billingState(payload.orderId);
  const units = pickUnits(o, st, payload.units, st.invoiced, ['FULL', 'DOC_PARTIAL'], 'Invoice');

  const invoiceNo = String(payload.invoiceNo || '').trim();
  if (!invoiceNo || !payload.invoiceBase64 || !payload.taxBase64 || !payload.receiptBase64) {
    throw new Error('Lengkapi nomor invoice dan seluruh PDF Accounting.');
  }
  // Sub total: dari kiriman Accounting; bila kosong dihitung dari harga unit terpilih (seluruh order -> sub total order)
  let subtotal = payload.subtotal;
  if (subtotal === undefined || subtotal === null || subtotal === '') {
    const allUnits = units.length === st.ids.length;
    subtotal = allUnits && Number(o.row.Subtotal) ? Number(o.row.Subtotal)
      : st.scheds.filter(s => units.indexOf(s.ScheduleID) > -1).reduce((sum, s) => sum + (Number(s.UnitPrice) || 0), 0);
  }
  const pricing = calcPricing(subtotal, payload.discountType, payload.discountValue, payload.taxType, payload.taxValue);
  const amount = pricing.Total;
  const folder = DriveApp.getFolderById(o.row.DriveFolderId);
  const tag = Utilities.getUuid().slice(0, 4).toUpperCase();
  const invUrl = saveBase64Pdf(folder, payload.invoiceBase64, payload.orderId + '_Invoice_' + invoiceNo + '.pdf');
  const taxUrl = saveBase64Pdf(folder, payload.taxBase64, payload.orderId + '_FakturPajak_' + invoiceNo + '.pdf');
  const recUrl = saveBase64Pdf(folder, payload.receiptBase64, payload.orderId + '_TandaTerima_' + invoiceNo + '.pdf');

  appendObjects(getSs().getSheetByName('Billings'), [{
    BillingID: 'INV-' + payload.orderId + '-' + tag, OrderID: payload.orderId, Kind: 'INVOICE', Units: units.join(', '),
    InvoiceNo: invoiceNo, InvoiceUrl: invUrl, TaxInvoiceUrl: taxUrl, TaxReceiptUrl: recUrl,
    PaymentStatus: 'UNPAID', Amount: amount, CreatedBy: payload.user, UpdatedAt: nowIso(),
    Subtotal: pricing.Subtotal, DiscountType: pricing.DiscountType, DiscountValue: pricing.DiscountValue,
    DiscountAmount: pricing.DiscountAmount, TaxType: pricing.TaxType, TaxValue: pricing.TaxValue, TaxAmount: pricing.TaxAmount
  }]);
  const next = recomputeBillingStatus(payload.orderId);
  writeLog(payload.orderId, payload.user, payload.role, 'UPLOAD_ACCOUNTING_DOCS',
    'Invoice ' + invoiceNo + ' (' + units.length + ' unit' + (amount ? ', Rp ' + amount : '') + '), Faktur Pajak & Tanda Terima diunggah.');
  return { ok: true, status: next };
}

function handleUploadShippingDocs(payload) {
  const o = findOrder(payload.orderId);
  if (BILLING_PHASE.indexOf(o.row.Status) === -1) throw new Error('Order belum berada pada tahap Invoice & Pengiriman.');
  const st = billingState(payload.orderId);
  const mode = o.row.BillingMode || 'FULL';
  const units = pickUnits(o, st, payload.units, st.delivered, ['FULL'], 'Pengiriman dokumen');

  if (!payload.sjBase64 || !payload.ttDocBase64) {
    throw new Error('Surat Jalan dokumen dan Tanda Terima dokumen dari customer wajib diunggah (PDF).');
  }
  if (mode === 'FULL' && !payload.ttBillBase64) throw new Error('Bukti tanda terima penagihan wajib diunggah (PDF).');

  const folder = DriveApp.getFolderById(o.row.DriveFolderId);
  const tag = Utilities.getUuid().slice(0, 4).toUpperCase();
  const sjUrl = saveBase64Pdf(folder, payload.sjBase64, payload.orderId + '_SuratJalanDokumen_' + tag + '.pdf');
  const ttDocUrl = saveBase64Pdf(folder, payload.ttDocBase64, payload.orderId + '_TandaTerimaCustomer_SJDokumen_' + tag + '.pdf');
  const ttBillUrl = saveBase64Pdf(folder, payload.ttBillBase64, payload.orderId + '_BuktiTT_Penagihan_' + tag + '.pdf');

  appendObjects(getSs().getSheetByName('Billings'), [{
    BillingID: 'DEL-' + payload.orderId + '-' + tag, OrderID: payload.orderId, Kind: 'DELIVERY', Units: units.join(', '),
    InvoiceNo: '-', DeliveryNoteUrl: sjUrl, BillingReceiptUrl: ttBillUrl, DocDeliveryReceiptUrl: ttDocUrl,
    PaymentStatus: '', CreatedBy: payload.user, UpdatedAt: nowIso()
  }]);
  const next = recomputeBillingStatus(payload.orderId);
  writeLog(payload.orderId, payload.user, payload.role, 'UPLOAD_SHIPPING_DOCS',
    'Dokumen dikirim ke customer (' + units.length + ' unit) + tanda terima customer diunggah.');
  return { ok: true, status: next };
}

function handlePurchasingAction(payload) {
  const schedSheet = getSs().getSheetByName('Schedules');
  const billSheet = getSs().getSheetByName('Billings');
  const o = findOrder(payload.orderId);
  if (BILLING_PHASE.indexOf(o.row.Status) === -1) throw new Error('Order belum berada pada tahap Penagihan (Finance).');
  const st = billingState(payload.orderId);

  let target = null;
  if (payload.billingId) target = st.ready.find(b => b.BillingID === payload.billingId);
  else if (st.ready.length === 1) target = st.ready[0];
  if (!target) throw new Error('Invoice tidak ditemukan atau belum siap ditagih (dokumen belum diterima customer).');
  const targetUnits = st.unitsOf(target);

  if (payload.decision === 'PAID_CLOSE') {
    // Customer no issue + sudah bayar: bukti bayar PDF wajib, status pembayaran complete.
    if (!payload.paymentProofBase64) throw new Error('Bukti pembayaran (PDF) wajib diunggah.');
    const note = String(payload.note || '').trim();
    const folder = DriveApp.getFolderById(o.row.DriveFolderId);
    const proofUrl = saveBase64Pdf(folder, payload.paymentProofBase64,
      payload.orderId + '_BuktiBayar_' + safeName(target.InvoiceNo) + '.pdf');
    updateRow(billSheet, target._rowIndex, {
      PaymentStatus: 'PAID_CLOSED', PaymentProofUrl: proofUrl, PaymentNote: note, PaidAt: nowIso(), UpdatedAt: nowIso()
    });
    const next = recomputeBillingStatus(payload.orderId);
    writeLog(payload.orderId, payload.user, payload.role, 'PURCHASING_CLOSE',
      'Invoice ' + target.InvoiceNo + ' (' + targetUnits.length + ' unit) no issue, bukti bayar diunggah, pembayaran COMPLETE.' +
      (next === ST.CLOSED ? ' Order CLOSED.' : ' Order masih berjalan (parsial).'));
    return { ok: true, status: next };
  }

  if (payload.decision === 'WAIT_PAYMENT') {
    // Belum bayar: simpan catatan (mis. menunggu konfirmasi customer); invoice tetap terbuka.
    const note = String(payload.note || '').trim();
    if (!note) throw new Error('Catatan wajib diisi (mis. menunggu konfirmasi customer).');
    updateRow(billSheet, target._rowIndex, { PaymentStatus: 'WAITING_PAYMENT', PaymentNote: note, UpdatedAt: nowIso() });
    writeLog(payload.orderId, payload.user, payload.role, 'PURCHASING_WAIT_PAYMENT',
      'Invoice ' + target.InvoiceNo + ' belum dibayar: ' + note);
    return { ok: true, status: o.row.Status };
  }

  if (payload.decision !== 'HOLD_REVISION') throw new Error('Keputusan tidak valid.');
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('Alasan revisi wajib diisi.');

  // unit pada invoice ini kembali ke teknisi
  st.scheds.filter(s => targetUnits.indexOf(s.ScheduleID) > -1).forEach(s => {
    updateRow(schedSheet, s._rowIndex, { DocStatus: DOC.REVISION, Notes: reason, RevisionCount: Number(s.RevisionCount || 0) + 1, UpdatedAt: nowIso() });
  });
  // hapus invoice ini; keluarkan unit tsb dari pengiriman dokumen (file lama tetap aman di Drive)
  const toDelete = [target._rowIndex];
  st.rows.forEach(r => {
    if (r._rowIndex === target._rowIndex || !isDelRow(r) || !(r.DeliveryNoteUrl || r.DocDeliveryReceiptUrl)) return;
    const ru = st.unitsOf(r);
    const keep = ru.filter(u => targetUnits.indexOf(u) === -1);
    if (keep.length === ru.length) return;
    if (!keep.length) toDelete.push(r._rowIndex);
    else if (r.Kind === 'DELIVERY') updateRow(billSheet, r._rowIndex, { Units: keep.join(', '), UpdatedAt: nowIso() });
    else updateRow(billSheet, r._rowIndex, { Kind: 'DELIVERY', Units: keep.join(', '), UpdatedAt: nowIso() });
  });
  toDelete.sort((a, b) => b - a).forEach(i => billSheet.deleteRow(i));

  updateRow(o.sheet, o.row._rowIndex, { Status: ST.REVISION_HOLD, RevisionReason: reason });
  writeLog(payload.orderId, payload.user, payload.role, 'PURCHASING_HOLD_REVISION',
    'Invoice ' + target.InvoiceNo + ' di-HOLD & ' + targetUnits.length + ' unit dikembalikan ke teknisi: ' + reason);
  return { ok: true, status: ST.REVISION_HOLD };
}

// ---------------------------------------------------------------------------
// Super Admin
// ---------------------------------------------------------------------------
function handleAdminEditOrder(payload) {
  const o = findOrder(payload.orderId);
  const fields = {};

  if (payload.customerName !== undefined) {
    const c = String(payload.customerName).trim();
    if (!c) throw new Error('Nama customer tidak boleh kosong.');
    fields.CustomerName = c;
  }
  if (payload.poNo !== undefined) {
    const po = String(payload.poNo).trim();
    if (!po) throw new Error('Nomor PO tidak boleh kosong.');
    const dup = sheetToObjects(o.sheet).find(x =>
      x.OrderID !== payload.orderId && String(x.PONo).trim().toLowerCase() === po.toLowerCase());
    if (dup) throw new Error('Nomor PO "' + po + '" sudah dipakai Order ' + dup.OrderID + '.');
    fields.PONo = po;
  }
  if (payload.quotTotalQty !== undefined) fields.QuotTotalQty = Number(payload.quotTotalQty);
  if (payload.poTotalQty !== undefined) fields.POTotalQty = Number(payload.poTotalQty);
  if (payload.status !== undefined) {
    if (ALL_STATUSES.indexOf(payload.status) === -1) throw new Error('Status tidak valid.');
    fields.Status = payload.status;
  }
  if (payload.revisionReason !== undefined) fields.RevisionReason = String(payload.revisionReason);

  updateRow(o.sheet, o.row._rowIndex, fields);
  writeLog(payload.orderId, payload.user, payload.role, 'ADMIN_EDIT_ORDER', 'Super Admin mengubah data/status job.');
  return { ok: true };
}

function handleAdminDeleteOrder(payload) {
  const ss = getSs();
  const schedSheet = ss.getSheetByName('Schedules');
  const billSheet = ss.getSheetByName('Billings');
  const o = findOrder(payload.orderId);
  const folderId = o.row.DriveFolderId;

  o.sheet.deleteRow(o.row._rowIndex);
  [
    [schedSheet, sheetToObjects(schedSheet).filter(s => s.OrderID === payload.orderId)],
    [billSheet, sheetToObjects(billSheet).filter(b => b.OrderID === payload.orderId)]
  ].forEach(pair => {
    pair[1].sort((a, b) => b._rowIndex - a._rowIndex).forEach(r => pair[0].deleteRow(r._rowIndex));
  });

  if (payload.moveFolderToTrash && folderId) {
    try { DriveApp.getFolderById(folderId).setTrashed(true); } catch (e) { /* folder sudah tidak ada */ }
  }
  writeLog(payload.orderId, payload.user, payload.role, 'ADMIN_DELETE_ORDER', 'Super Admin menghapus job beserta jadwal & billing.');
  return { ok: true };
}
