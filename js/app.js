'use strict';

/* ------------------------------------------------------------------
   SplitTrack - bills with independently split items.

   metadata : { userName, currency, participants }
   projects : { id, name, date, payer, categories, attachments, createdAt }
   items    : { id, projectId, order, date, description, category,
                amount, paidBy, splitMethod, splits, settled }
   ------------------------------------------------------------------ */

const DB_NAME = 'SplitTrackDB';
const DB_VERSION = 1;
const STORE_META = 'metadata';
const STORE_PROJECTS = 'projects';
const STORE_ITEMS = 'items';

const AI_BILL_PROMPT = [
  'Extract every line item from the bill/receipt shown and return a plain CSV.',
  'Use exactly these columns: Date, Bill, Item, Category, Amount, Split With',
  '',
  'Rules:',
  '1. Date - bill date as YYYY-MM-DD (use today if the bill has no date).',
  '2. Bill - one short name for the whole bill, repeated on every row (e.g. "Spice Route dinner", "Trek 2026").',
  '3. Item - the clean item name, one row per billed line (e.g. "Paneer Tikka", "Parking").',
  '4. Category - a short label you choose for that item, 1-2 words (e.g. "Starters", "Drinks", "Travel"). No fixed list: name categories freshly and keep them consistent within the bill.',
  '5. Amount - numbers only: no currency symbols and no thousands separators (write 1234.50, not 1,234.50). Put tax, service charge, tip, delivery fee, adjustments and round-off on their own rows so the bill total stays exact. Put discounts as negative rows. Never include subtotal or grand total rows.',
  '6. Split With - fill only if the bill itself says who had an item (e.g. "for Ali"); separate names with semicolons. If it also states per-person quantities, add weights (e.g. Ali:2;Sara:1); if it states per-person percentages, add a percent sign (e.g. Ali:60%;Sara:40%). Otherwise leave it empty - the app lets you tick people and pick equal, weights, percentages, custom amounts or bill-ratio per item.',
  '7. Output only the CSV inside a code fence, no commentary.'
].join('\n');

const ICON = {
  trash: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
  pencil: 'M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z',
  check: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  plus: 'M12 4v16m8-8H4',
  download: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4',
  close: 'M6 18L18 6M6 6l12 12'
};

const state = {
  userName: 'You',
  currency: '₹',
  participants: ['You']
};

let projects = [];
let items = [];
let dbPromise = null;

let expandedProjectIds = new Set();
let editingItem = null;
let itemModalPeople = new Set();
let itemModalMode = 'equal';
let itemModalInputs = {};
let itemModalCache = {};
let editingBillId = null;
let billModalAttachments = [];
let stagedBillAttachments = [];
let draftRowSeq = 0;
let importBills = [];
let importDefaultParticipants = [];
let chartInstances = { date: null, people: null, category: null };
let idSeq = 0;
let pdfReportData = null;
let pdfReturnFocus = null;
let pdfPreviousBodyOverflow = null;

/* ------------------------- small helpers ------------------------- */

function $(id) { return document.getElementById(id); }

function uid() {
  idSeq = (idSeq + 1) % 1000;
  return (Date.now() * 1000) + idSeq;
}

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value) {
  const n = Number(value) || 0;
  return state.currency + n.toFixed(2);
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function toDateOnly(value) {
  if (value === undefined || value === null || value === '') return todayStr();
  const raw = String(value).trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const d = new Date(raw);
  if (isNaN(d.getTime())) return todayStr();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function isoFromDateOnly(dateOnly) {
  const parts = toDateOnly(dateOnly).split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
  return d.toISOString();
}

function dateLabel(iso) {
  const parts = toDateOnly(iso).split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function samePerson(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function canonicalParticipant(name) {
  const wanted = String(name === undefined || name === null ? '' : name).trim();
  if (!wanted) return '';
  const found = state.participants.find(function (p) { return samePerson(p, wanted); });
  return found || wanted;
}

function equalSplits(amount, names) {
  const out = {};
  const unique = [];
  (names || []).forEach(function (n) {
    if (!n) return;
    if (!unique.some(function (u) { return samePerson(u, n); })) unique.push(n);
  });
  if (!unique.length) return out;
  const share = Number(amount) / unique.length;
  unique.forEach(function (n) { out[n] = share; });
  return out;
}


const SPLIT_MODE_NAMES = ['equal', 'weighted', 'percent', 'custom', 'proportional'];
const SPLIT_MODE_LABELS = ['Equal', 'Weights', '%', 'Custom', 'Ratio'];

function splitModeName(index) {
  return SPLIT_MODE_NAMES[index] || 'equal';
}

function splitModeIndex(name) {
  const idx = SPLIT_MODE_NAMES.indexOf(name);
  return idx === -1 ? 0 : idx;
}

function splitModeLabel(method) {
  if (method === 'weighted') return 'weights';
  if (method === 'percent') return '%';
  if (method === 'custom') return 'custom';
  if (method === 'proportional') return 'bill ratio';
  return '';
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function uniquePeople(people) {
  const out = [];
  (people || []).forEach(function (person) {
    if (!person) return;
    if (!out.some(function (existing) { return samePerson(existing, person); })) out.push(person);
  });
  return out;
}

function distributePercent(count) {
  if (!count) return [];
  const base = Math.floor((100 / count) * 100) / 100;
  const values = new Array(count).fill(base);
  const remainder = Math.round((100 - base * count) * 100);
  for (let i = 0; i < Math.abs(remainder) && i < count; i += 1) {
    values[i] = round2(values[i] + (remainder > 0 ? 0.01 : -0.01));
  }
  return values;
}

function distributeAmount(amount, count) {
  if (!count) return [];
  const cents = Math.round((Number(amount) || 0) * 100);
  const base = Math.trunc(cents / count);
  const remainder = cents - base * count;
  const values = new Array(count).fill(base / 100);
  for (let i = 0; i < Math.abs(remainder) && i < count; i += 1) {
    values[i] = round2(values[i] + (remainder > 0 ? 0.01 : -0.01));
  }
  return values;
}

function seedSplitInputs(method, people, amount) {
  const list = uniquePeople(people);
  const out = {};
  if (method === 'weighted') {
    list.forEach(function (person) { out[person] = 1; });
    return out;
  }
  if (method === 'percent') {
    const values = distributePercent(list.length);
    list.forEach(function (person, idx) { out[person] = values[idx]; });
    return out;
  }
  if (method === 'custom') {
    const values = distributeAmount(amount, list.length);
    list.forEach(function (person, idx) { out[person] = values[idx]; });
    return out;
  }
  return out;
}

function computeShares(amount, method, people, inputs) {
  const list = uniquePeople(people);
  const splits = {};
  const total = Number(amount) || 0;

  if (!list.length) return { splits: splits, error: 'Pick at least one person.' };

  if (method === 'equal' || !method) {
    return { splits: equalSplits(total, list), error: null };
  }

  if (method === 'weighted') {
    let sum = 0;
    const weights = {};
    for (const person of list) {
      const weight = Number(inputs[person]);
      if (!isFinite(weight) || weight < 0) {
        return { splits: splits, error: 'Weights must be zero or more.' };
      }
      weights[person] = weight;
      sum += weight;
    }
    if (!(sum > 0)) return { splits: splits, error: 'Give at least one person a weight above zero.' };
    list.forEach(function (person) { splits[person] = total * weights[person] / sum; });
    return { splits: splits, error: null };
  }

  if (method === 'percent') {
    let sum = 0;
    const percents = {};
    for (const person of list) {
      const value = Number(inputs[person]);
      if (!isFinite(value) || value < 0) {
        return { splits: splits, error: 'Percentages must be zero or more.' };
      }
      percents[person] = value;
      sum += value;
    }
    if (!sum || Math.abs(sum - 100) > 0.01) {
      return { splits: splits, error: 'Percentages must add up to 100% (now ' + round2(sum) + '%).' };
    }
    list.forEach(function (person) { splits[person] = total * percents[person] / sum; });
    return { splits: splits, error: null };
  }

  if (method === 'custom') {
    let sum = 0;
    const values = {};
    for (const person of list) {
      const value = Number(inputs[person]);
      if (!isFinite(value)) return { splits: splits, error: 'Enter a number for every person.' };
      values[person] = value;
      sum += value;
    }
    if (Math.abs(sum - total) > 0.01) {
      return { splits: splits, error: 'Amounts must add up to ' + money(total) + ' (now ' + money(sum) + ').' };
    }
    const last = list[list.length - 1];
    values[last] = values[last] + (total - sum);
    list.forEach(function (person) { splits[person] = values[person]; });
    return { splits: splits, error: null };
  }

  return { splits: equalSplits(total, list), error: null };
}

function detectItemKind(description, category) {
  const text = (' ' + String(description || '') + ' ' + String(category || '') + ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = text.split(' ').filter(Boolean);
  function has(word) { return words.indexOf(word) !== -1; }
  function hasPhrase(phrase) { return (' ' + text + ' ').indexOf(' ' + phrase + ' ') !== -1; }

  if (has('discount') || has('discounts') || has('coupon') || has('promo') || has('promocode') ||
      has('voucher') || has('cashback') || has('offer') || has('rebate') || has('complimentary')) {
    return 'discount';
  }
  if (has('tax') || has('taxes') || has('gst') || has('vat') || has('cgst') || has('sgst') ||
      has('igst') || has('cess') || has('surcharge') || has('tip') || has('tips') ||
      has('gratuity') || has('packaging') || has('rounding') || has('roundoff') ||
      has('rounded') || has('adjustment') || has('adjustments')) {
    return 'tax';
  }
  if (hasPhrase('service charge') || hasPhrase('service fee') || hasPhrase('service tax') ||
      hasPhrase('delivery fee') || hasPhrase('delivery charge') || hasPhrase('platform fee') ||
      hasPhrase('convenience fee') || hasPhrase('booking fee') || hasPhrase('handling fee') ||
      hasPhrase('packaging charge') || hasPhrase('round off') || hasPhrase('rounding off') ||
      hasPhrase('bill adjustment') || hasPhrase('amount adjustment')) {
    return 'tax';
  }
  return 'item';
}

function parseSplitToken(token) {
  const raw = String(token === undefined || token === null ? '' : token).trim();
  if (!raw) return null;
  let match = raw.match(/^(.*?)\s*:\s*(-?\d+(?:\.\d+)?)\s*%\s*$/);
  if (match) return { name: match[1].trim(), value: Math.abs(Number(match[2])), kind: 'percent' };
  match = raw.match(/^(.*?)\s*:\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (match) return { name: match[1].trim(), value: Math.abs(Number(match[2])), kind: 'weight' };
  return { name: raw, value: null, kind: 'name' };
}

function proportionalSplitsForAmount(projectItems, amount) {
  const totals = {};
  let baseSum = 0;

  (projectItems || []).forEach(function (item) {
    if (!item || item.splitMethod === 'proportional') return;
    const splits = item.splits || {};
    Object.keys(splits).forEach(function (person) {
      const value = Number(splits[person]) || 0;
      totals[person] = (totals[person] || 0) + value;
      baseSum += value;
    });
  });

  if (Math.abs(baseSum) < 0.000001) {
    return equalSplits(amount, state.participants);
  }

  const splits = {};
  Object.keys(totals).forEach(function (person) {
    const value = Number(amount) * totals[person] / baseSum;
    if (Math.abs(value) > 0.0000001) splits[person] = value;
  });
  return splits;
}


function svgIcon(path, cls) {
  return '<svg class="' + (cls || 'w-4 h-4') + '" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="' + path + '"></path></svg>';
}

function downloadDataUrl(dataUrl, name) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = name || 'download';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function downloadText(text, fileName, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime || 'text/csv;charset=utf-8;' }));
  downloadDataUrl(url, fileName);
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}

/* --------------------------- CSV parsing -------------------------- */

function parseCSVLine(text) {
  let cells = [''];
  let i = 0;
  let prev = '';
  let inQuotes = true;
  for (const ch of text) {
    if (ch === '"') {
      if (inQuotes && ch === prev) cells[i] += ch;
      inQuotes = !inQuotes;
    } else if (ch === ',' && inQuotes) {
      i += 1;
      cells[i] = '';
    } else {
      cells[i] += ch;
    }
    prev = ch;
  }
  return cells.map(function (c) {
    return c.trim().replace(/^"|"$/g, '').replace(/""/g, '"');
  });
}

function stripCodeFences(text) {
  const tick = String.fromCharCode(96);
  const fence = tick + tick + tick;
  let out = String(text).split(fence).join('');
  out = out.replace(/^(?:csv|text|plaintext|tsv)\s*\r?\n/i, '');
  return out.trim();
}

function parseAmount(raw) {
  if (raw === undefined || raw === null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[^0-9.\-]/g, '');
  if (!s || s === '-' || s === '.') return 0;
  let n = parseFloat(s);
  if (isNaN(n)) return 0;
  if (negative && n > 0) n = -n;
  return n;
}

function splitNameList(raw) {
  if (!raw) return [];
  return String(raw).split(/[;|,]/).map(function (n) { return n.trim(); }).filter(Boolean);
}

const HEADER_HINTS = ['date', 'bill', 'project', 'item', 'description', 'title',
  'category', 'amount', 'cost', 'price', 'split', 'participant', 'merchant', 'event', 'total'];

function looksLikeHeader(cells) {
  return cells.some(function (c) {
    return HEADER_HINTS.indexOf(String(c).trim().toLowerCase()) !== -1;
  });
}

function parseBillCSV(text) {
  const result = { bills: [], rows: 0 };
  if (!text || !String(text).trim()) return result;

  const lines = stripCodeFences(text).split(/\r?\n/)
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 0; });
  if (!lines.length) return result;

  const header = parseCSVLine(lines[0]);
  const hasHeader = looksLikeHeader(header);
  const used = {};
  let dateCol = -1;
  let billCol = -1;
  let itemCol = -1;
  let catCol = -1;
  let amtCol = -1;
  let splitCol = -1;
  let start = 0;

  function pick(keys) {
    for (let i = 0; i < header.length; i += 1) {
      if (used[i]) continue;
      const h = String(header[i]).toLowerCase();
      if (keys.some(function (k) { return h.indexOf(k) !== -1; })) {
        used[i] = true;
        return i;
      }
    }
    return -1;
  }

  if (hasHeader) {
    start = 1;
    dateCol = pick(['date', 'when']);
    billCol = pick(['bill', 'project', 'merchant', 'event', 'shop', 'store']);
    itemCol = pick(['item', 'desc', 'title', 'name', 'particular']);
    catCol = pick(['categor', 'cat', 'type', 'group']);
    amtCol = pick(['amount', 'cost', 'price', 'total', 'value']);
    splitCol = pick(['split', 'shared', 'participant', 'who', 'people']);
  } else {
    const probe = parseCSVLine(lines[0]);
    if (probe.length >= 4) {
      dateCol = 0; itemCol = 1; catCol = 2; amtCol = 3;
    } else if (probe.length === 3) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(probe[0])) { dateCol = 0; itemCol = 1; amtCol = 2; }
      else { itemCol = 0; catCol = 1; amtCol = 2; }
    } else if (probe.length === 2) {
      itemCol = 0; amtCol = 1;
    }
  }

  if (itemCol === -1 || amtCol === -1) return result;

  const billMap = new Map();
  for (let i = start; i < lines.length; i += 1) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 2) continue;

    const dateVal = (dateCol !== -1 && cols[dateCol]) ? toDateOnly(cols[dateCol]) : todayStr();
    const billName = (billCol !== -1 && cols[billCol]) ? cols[billCol].trim() : '';
    let desc = (cols[itemCol] || '').trim();
    let category = (catCol !== -1 && cols[catCol]) ? cols[catCol].trim() : '';
    const amount = (amtCol !== -1) ? parseAmount(cols[amtCol]) : 0;
    const splitWith = (splitCol !== -1 && cols[splitCol]) ? splitNameList(cols[splitCol]) : [];

    if (!desc) desc = 'Item';
    if (!category) category = 'Uncategorised';
    if (!amount) continue;

    const key = billName.toLowerCase() + '|' + dateVal;
    let bill = billMap.get(key);
    if (!bill) {
      bill = { name: billName, date: dateVal, items: [] };
      billMap.set(key, bill);
    }
    bill.items.push({ description: desc, category: category, amount: amount, splitWith: splitWith });
    result.rows += 1;
  }

  result.bills = Array.from(billMap.values());
  return result;
}

/* ---------------------------- database ---------------------------- */

function getDB() {
  if (!dbPromise) {
    dbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (event) {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_ITEMS)) db.createObjectStore(STORE_ITEMS, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  return dbPromise;
}

async function dbGetAll(store) {
  const db = await getDB();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = function () { resolve(req.result || []); };
    req.onerror = function () { reject(req.error); };
  });
}

async function dbGet(store, key) {
  const db = await getDB();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

async function dbPut(store, value, key) {
  const db = await getDB();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    if (key === undefined) os.put(value); else os.put(value, key);
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

async function dbDelete(store, key) {
  const db = await getDB();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

async function dbClearEverything() {
  const db = await getDB();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction([STORE_META, STORE_PROJECTS, STORE_ITEMS], 'readwrite');
    tx.objectStore(STORE_META).clear();
    tx.objectStore(STORE_PROJECTS).clear();
    tx.objectStore(STORE_ITEMS).clear();
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

async function saveMeta() {
  await dbPut(STORE_META, {
    userName: state.userName,
    currency: state.currency,
    participants: state.participants.slice()
  }, 'appState');
}

/* ----------------------------- lookup ----------------------------- */

function projectById(id) {
  return projects.find(function (p) { return p.id === id; }) || null;
}

function itemsOfProject(id) {
  return items.filter(function (it) { return it.projectId === id; });
}

/* ------------------------- startup / views ------------------------ */

let eventsBound = false;

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;

  const billForm = $('expense-form');
  if (billForm) billForm.addEventListener('submit', saveBill);
  const itemForm = $('item-form');
  if (itemForm) itemForm.addEventListener('submit', saveItemModal);
  const billModalForm = $('bill-form');
  if (billModalForm) billModalForm.addEventListener('submit', saveBillModal);
  const peopleForm = $('add-person-form');
  if (peopleForm) peopleForm.addEventListener('submit', addPerson);
}

async function init() {
  try {
    const meta = await dbGet(STORE_META, 'appState');
    if (meta) {
      if (meta.userName) state.userName = meta.userName;
      if (meta.currency) state.currency = meta.currency;
      if (Array.isArray(meta.participants) && meta.participants.length) {
        state.participants = meta.participants.slice();
      }
    }
    if (!state.participants.some(function (p) { return samePerson(p, state.userName); })) {
      state.participants.unshift(state.userName);
    }

    projects = await dbGetAll(STORE_PROJECTS);
    items = await dbGetAll(STORE_ITEMS);
    const projectIds = new Set(projects.map(function (p) { return p.id; }));
    items = items.filter(function (it) { return projectIds.has(it.projectId); });

    bindEvents();
    updateCurrencyDisplay();
    switchView('dashboard');
    updateAllViews();
  } catch (err) {
    console.error(err);
    alert('Could not open local storage: ' + err.message);
  }
}

function switchView(viewName) {
  document.querySelectorAll('.view-section').forEach(function (el) { el.classList.add('hide'); });
  const target = $('view-' + viewName);
  if (target) target.classList.remove('hide');

  document.querySelectorAll('.bottom-nav button').forEach(function (el) {
    el.classList.remove('text-indigo-600');
    el.classList.add('text-gray-500');
  });
  if (viewName !== 'settings') {
    const nav = $('nav-' + viewName);
    if (nav) {
      nav.classList.remove('text-gray-500');
      nav.classList.add('text-indigo-600');
    }
  }

  if (viewName === 'dashboard') renderDashboard();
  if (viewName === 'history') renderHistory();
  if (viewName === 'people') renderPeople();
  if (viewName === 'settings') {
    const nameInput = $('setting-user-name');
    if (nameInput) nameInput.value = state.userName;
    const currencyInput = $('setting-currency');
    if (currencyInput) currencyInput.value = state.currency;
  }
}

function updateAllViews() {
  updateFilters();
  renderDashboard();
  renderHistory();
  renderPeople();
  updateCurrencyDisplay();
}

function updateCurrencyDisplay() {
  document.querySelectorAll('.currency-display').forEach(function (el) {
    el.textContent = state.currency;
  });
}

/* ---------------------------- filters ----------------------------- */

function filterState(prefix) {
  function read(id) {
    const el = $(id);
    return el ? el.value : '';
  }
  const f = {
    search: (read(prefix + '-filter-search') || '').toLowerCase().trim(),
    category: read(prefix + '-filter-category') || 'all',
    person: read(prefix + '-filter-person') || 'all',
    payer: read(prefix + '-filter-payer') || 'all',
    month: read(prefix + '-filter-month') || '',
    date: read(prefix + '-filter-date') || '',
    persons: null
  };
  if (prefix === 'hist') {
    const boxes = Array.prototype.slice.call(document.querySelectorAll('.hist-filter-chk'));
    const checked = boxes.filter(function (b) { return b.checked; });
    if (boxes.length && checked.length < boxes.length) {
      f.persons = checked.map(function (b) { return b.dataset.name; });
    }
  }
  return f;
}

function filterItems(prefix) {
  const f = filterState(prefix);
  return items.filter(function (it) {
    const project = projectById(it.projectId);
    const desc = String(it.description || '').toLowerCase();
    const billName = project ? String(project.name || '').toLowerCase() : '';

    if (f.search && desc.indexOf(f.search) === -1 && billName.indexOf(f.search) === -1) return false;
    if (f.category !== 'all' && it.category !== f.category) return false;
    if (f.person !== 'all') {
      const inSplit = it.splits && Object.prototype.hasOwnProperty.call(it.splits, f.person) && it.splits[f.person] !== 0;
      if (it.paidBy !== f.person && !inSplit) return false;
    }
    if (f.payer !== 'all' && it.paidBy !== f.payer) return false;

    const day = toDateOnly(it.date);
    if (f.month && day.slice(0, 7) !== f.month) return false;
    if (f.date && day !== f.date) return false;

    if (f.persons && f.persons.length) {
      const involved = f.persons.some(function (p) {
        return it.paidBy === p || (it.splits && it.splits[p] !== undefined && it.splits[p] !== 0);
      });
      if (!involved) return false;
    }
    return true;
  });
}

function updateFilters() {
  const categories = Array.from(new Set(items.map(function (it) { return it.category; }).filter(Boolean))).sort();

  ['dash', 'hist'].forEach(function (prefix) {
    const catSel = $(prefix + '-filter-category');
    if (catSel) {
      const current = catSel.value;
      catSel.innerHTML = '<option value="all">Category: All</option>' + categories.map(function (c) {
        return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
      }).join('');
      if (current && (current === 'all' || categories.indexOf(current) !== -1)) catSel.value = current;
    }

    const personSel = $(prefix + '-filter-person');
    if (personSel) {
      const current = personSel.value;
      personSel.innerHTML = '<option value="all">Involved: All</option>' + state.participants.map(function (p) {
        return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
      }).join('');
      if (current && (current === 'all' || state.participants.indexOf(current) !== -1)) personSel.value = current;
    }

    const payerSel = $(prefix + '-filter-payer');
    if (payerSel) {
      const current = payerSel.value;
      payerSel.innerHTML = '<option value="all">Paid By: All</option>' + state.participants.map(function (p) {
        return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
      }).join('');
      if (current && (current === 'all' || state.participants.indexOf(current) !== -1)) payerSel.value = current;
    }
  });

  const box = $('hist-filter-participant-checkboxes');
  if (box) {
    const saved = {};
    Array.prototype.forEach.call(box.querySelectorAll('.hist-filter-chk'), function (chk) {
      saved[chk.dataset.name] = chk.checked;
    });
    box.innerHTML = state.participants.map(function (p) {
      const checked = saved[p] !== undefined ? saved[p] : true;
      return '<label class="inline-flex items-center gap-1.5 px-2 py-1 bg-indigo-50/50 border border-indigo-200 rounded-md text-xs font-medium text-indigo-900 cursor-pointer hover:bg-indigo-100 transition-colors select-none">' +
        '<input type="checkbox" data-name="' + esc(p) + '" ' + (checked ? 'checked' : '') +
        ' onchange="renderHistory()" class="hist-filter-chk w-3.5 h-3.5 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500">' +
        '<span>' + esc(p) + (p === state.userName ? ' (You)' : '') + '</span></label>';
    }).join('');
  }
}

function clearFilters(prefix) {
  const search = $(prefix + '-filter-search');
  if (search) search.value = '';
  ['person', 'payer', 'category'].forEach(function (key) {
    const el = $(prefix + '-filter-' + key);
    if (el) el.value = 'all';
  });
  ['month', 'date'].forEach(function (key) {
    const el = $(prefix + '-filter-' + key);
    if (el) el.value = '';
  });
  if (prefix === 'hist') {
    Array.prototype.forEach.call(document.querySelectorAll('.hist-filter-chk'), function (c) { c.checked = true; });
    renderHistory();
  } else {
    renderDashboard();
  }
}

function selectAllHistFilterParticipants(selectAll) {
  Array.prototype.forEach.call(document.querySelectorAll('.hist-filter-chk'), function (c) { c.checked = selectAll; });
  renderHistory();
}

/* -------------------------- attachments --------------------------- */

function stageFiles(files, target, after) {
  const list = Array.from(files || []);
  if (!list.length) return;
  let pending = list.length;
  list.forEach(function (file) {
    const reader = new FileReader();
    reader.onload = function (e) {
      target.push({ name: file.name, type: file.type || 'application/octet-stream', data: e.target.result });
      pending -= 1;
      if (pending === 0) after();
    };
    reader.readAsDataURL(file);
  });
}

function attachmentCards(atts, removeFn) {
  return atts.map(function (att, idx) {
    const isImage = String(att.type || '').indexOf('image/') === 0;
    const preview = isImage
      ? '<img src="' + att.data + '" class="h-8 w-8 object-cover rounded">'
      : '<span class="h-8 w-8 rounded bg-red-50 text-red-500 text-[10px] font-bold flex items-center justify-center">PDF</span>';
    return '<div class="flex items-center justify-between bg-white border border-gray-200 rounded-lg p-2">' +
      '<div class="flex items-center gap-2 min-w-0">' + preview +
        '<span class="text-xs text-gray-600 truncate">' + esc(att.name) + '</span>' +
      '</div>' +
      '<button type="button" onclick="' + removeFn + '(' + idx + ')" class="text-red-400 hover:text-red-600 p-1" title="Remove">' +
        svgIcon(ICON.trash, 'w-4 h-4') + '</button>' +
    '</div>';
  }).join('');
}

function handleDraftFiles(event) {
  const input = event.target;
  stageFiles(input.files, stagedBillAttachments, function () {
    renderDraftAttachments();
    input.value = '';
  });
}

function renderDraftAttachments() {
  const box = $('draft-attachment-previews');
  if (box) box.innerHTML = attachmentCards(stagedBillAttachments, 'removeDraftAttachment');
}

function removeDraftAttachment(index) {
  stagedBillAttachments.splice(index, 1);
  renderDraftAttachments();
}

function handleBillModalFiles(event) {
  const input = event.target;
  stageFiles(input.files, billModalAttachments, function () {
    renderBillModalAttachments();
    input.value = '';
  });
}

function renderBillModalAttachments() {
  const box = $('bill-modal-attachments');
  if (box) box.innerHTML = attachmentCards(billModalAttachments, 'removeBillModalAttachment');
}

function removeBillModalAttachment(index) {
  billModalAttachments.splice(index, 1);
  renderBillModalAttachments();
}

function viewProjectAttachment(projectId, index) {
  const project = projectById(projectId);
  if (!project || !project.attachments || !project.attachments[index]) return;
  const att = project.attachments[index];
  if (String(att.type || '').indexOf('image/') === 0) openImageViewer(att.data, att.name);
  else downloadDataUrl(att.data, att.name);
}

function downloadProjectAttachment(projectId, index) {
  const project = projectById(projectId);
  if (!project || !project.attachments || !project.attachments[index]) return;
  downloadDataUrl(project.attachments[index].data, project.attachments[index].name);
}

function projectAttachmentHtml(project) {
  const atts = project.attachments || [];
  if (!atts.length) return '';
  return '<div class="mt-2 pt-2 border-t border-gray-200">' +
    '<p class="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Receipts</p>' +
    '<div class="flex flex-col gap-1.5">' + atts.map(function (att, idx) {
      const isImage = String(att.type || '').indexOf('image/') === 0;
      return '<div class="flex items-center justify-between bg-white border border-gray-200 rounded-lg p-1.5">' +
        '<button type="button" onclick="viewProjectAttachment(' + project.id + ', ' + idx + ')" class="flex items-center gap-2 min-w-0 text-left">' +
          (isImage ? '<img src="' + att.data + '" class="h-7 w-7 object-cover rounded">' :
            '<span class="h-7 w-7 rounded bg-red-50 text-red-500 text-[9px] font-bold flex items-center justify-center">PDF</span>') +
          '<span class="text-[11px] text-gray-600 truncate">' + esc(att.name) + '</span>' +
        '</button>' +
        '<button type="button" onclick="downloadProjectAttachment(' + project.id + ', ' + idx + ')" class="text-gray-400 hover:text-indigo-600 p-1" title="Save">' +
          svgIcon(ICON.download, 'w-4 h-4') + '</button>' +
      '</div>';
    }).join('') + '</div></div>';
}

function openImageViewer(src, name) {
  const img = $('image-viewer-img');
  const dl = $('image-viewer-download');
  if (!img || !dl) return;
  img.src = src;
  dl.href = src;
  dl.download = name || 'receipt';
  $('image-viewer').classList.remove('hide');
}

function closeImageViewer() {
  const viewer = $('image-viewer');
  if (!viewer) return;
  viewer.classList.add('hide');
  const img = $('image-viewer-img');
  if (img) img.src = '';
}


/* ---------------------- add bill (draft) form -------------------- */

function payerOptionsHtml(selected) {
  let html = '<option value="" disabled' + (selected ? '' : ' selected') + '>Select who paid</option>';
  html += state.participants.map(function (p) {
    return '<option value="' + esc(p) + '"' + (p === selected ? ' selected' : '') + '>' +
      esc(p) + (p === state.userName ? ' (You)' : '') + '</option>';
  }).join('');
  return html;
}

function openAddForm() {
  resetAddForm();
  const title = $('form-title');
  if (title) title.textContent = 'New Bill';
  const submitText = $('submit-text');
  if (submitText) submitText.textContent = 'Save Bill';
  switchView('add');
  const first = document.querySelector('#draft-items .draft-desc');
  if (first) first.focus();
}

function resetAddForm() {
  stagedBillAttachments = [];
  renderDraftAttachments();

  const nameInput = $('bill-name');
  if (nameInput) nameInput.value = '';
  const dateInput = $('bill-date');
  if (dateInput) dateInput.value = todayStr();

  const payerSelect = $('bill-payer');
  if (payerSelect) {
    // No payer is preselected: every bill must make the choice explicit so a
    // forgotten payer never silently lands on the user's name.
    payerSelect.innerHTML = payerOptionsHtml('');
    payerSelect.value = '';
    payerSelect.classList.add('payer-missing');
  }

  const fileInput = $('bill-files');
  if (fileInput) fileInput.value = '';

  const wrap = $('draft-items');
  if (wrap) wrap.innerHTML = '';
  draftRowSeq = 0;
  addDraftItemRow();

  const categoryList = $('draft-category-list');
  if (categoryList) categoryList.innerHTML = '';
}

function addDraftItemRow() {
  const wrap = $('draft-items');
  if (!wrap) return;
  if (!state.participants.length) state.participants = [state.userName];

  draftRowSeq += 1;
  const row = document.createElement('div');
  row.className = 'draft-item border border-gray-200 rounded-xl p-3 space-y-2 bg-gray-50/60';
  row.dataset.row = String(draftRowSeq);

  const peopleChips = state.participants.map(function (p, idx) {
    return '<label class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-gray-200 bg-white text-xs font-medium text-gray-600 cursor-pointer">' +
      '<input type="checkbox" checked class="draft-person w-3.5 h-3.5 text-indigo-600 rounded" data-idx="' + idx + '">' +
      '<span>' + esc(p === state.userName ? p + ' (You)' : p) + '</span></label>';
  }).join('');

  row.innerHTML =
    '<div class="flex items-center justify-between">' +
      '<span class="text-[10px] font-bold uppercase tracking-wider text-gray-400">Item</span>' +
      '<button type="button" onclick="removeDraftRow(this)" class="text-gray-400 hover:text-red-500" title="Remove item">' +
        svgIcon(ICON.close, 'w-4 h-4') + '</button>' +
    '</div>' +
    '<input type="text" class="draft-desc w-full border border-gray-300 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Item name (e.g. Paneer Tikka)">' +
    '<div class="grid grid-cols-2 gap-2">' +
      '<input type="number" step="0.01" class="draft-amount w-full border border-gray-300 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Amount">' +
      '<input type="text" list="draft-category-list" class="draft-category w-full border border-gray-300 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Category">' +
    '</div>' +
    '<div>' +
      '<div class="flex items-center justify-between gap-2 mb-1">' +
        '<span class="text-[10px] font-bold uppercase tracking-wider text-gray-400">Split between</span>' +
        '<div class="flex items-center gap-2">' +
          '<select class="draft-method text-[10px] font-semibold border border-gray-300 rounded-md px-1.5 py-0.5 bg-white text-gray-600 outline-none" title="Split method">' +
            '<option value="equal">Equal</option>' +
            '<option value="proportional">Bill ratio</option>' +
          '</select>' +
          '<div class="space-x-1 text-[10px]">' +
            '<button type="button" onclick="setDraftRowPeople(this, true)" class="text-indigo-600 hover:underline font-semibold">All</button>' +
            '<span class="text-gray-300">|</span>' +
            '<button type="button" onclick="setDraftRowPeople(this, false)" class="text-indigo-600 hover:underline font-semibold">None</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="flex flex-wrap gap-1.5">' + peopleChips + '</div>' +
    '</div>';

  wrap.appendChild(row);
  const desc = row.querySelector('.draft-desc');
  if (desc) desc.focus();

  const methodSelect = row.querySelector('.draft-method');
  if (methodSelect) {
    methodSelect.addEventListener('change', function () {
      row.dataset.methodTouched = '1';
    });
  }
  ['draft-desc', 'draft-category'].forEach(function (cls) {
    const input = row.querySelector('.' + cls);
    if (input) input.addEventListener('input', function () { syncDraftRowMethod(row); });
  });
}

function syncDraftRowMethod(row) {
  if (!row || row.dataset.methodTouched === '1') return;
  const select = row.querySelector('.draft-method');
  if (!select) return;
  const desc = row.querySelector('.draft-desc');
  const category = row.querySelector('.draft-category');
  const kind = detectItemKind(desc ? desc.value : '', category ? category.value : '');
  select.value = kind === 'item' ? 'equal' : 'proportional';
}

function removeDraftRow(button) {
  const row = button.closest('.draft-item');
  if (row) row.remove();
  const wrap = $('draft-items');
  if (wrap && !wrap.querySelector('.draft-item')) addDraftItemRow();
}

function setDraftRowPeople(button, on) {
  const row = button.closest('.draft-item');
  if (!row) return;
  Array.prototype.forEach.call(row.querySelectorAll('.draft-person'), function (chk) {
    chk.checked = on;
  });
}

async function saveBill(event) {
  event.preventDefault();

  const name = ($('bill-name').value || '').trim();
  const date = $('bill-date').value || todayStr();
  const payer = $('bill-payer').value;

  if (!name) return alert('Give the bill a name.');
  if (!payer) {
    const payerEl = $('bill-payer');
    if (payerEl) payerEl.focus();
    return alert('Choose who paid this bill.');
  }

  const rows = Array.prototype.slice.call(document.querySelectorAll('#draft-items .draft-item'));
  if (!rows.length) return alert('Add at least one item.');

  const drafts = [];
  for (const row of rows) {
    const desc = row.querySelector('.draft-desc').value.trim();
    const amount = parseFloat(row.querySelector('.draft-amount').value);
    const category = row.querySelector('.draft-category').value.trim() || 'Uncategorised';
    const people = Array.prototype.slice.call(row.querySelectorAll('.draft-person:checked')).map(function (chk) {
      return state.participants[Number(chk.dataset.idx)];
    });
    const methodSelect = row.querySelector('.draft-method');
    const selectedMethod = methodSelect ? methodSelect.value : '';
    const method = selectedMethod === 'proportional'
      ? 'proportional'
      : (selectedMethod === 'equal'
        ? 'equal'
        : (detectItemKind(desc, category) === 'item' ? 'equal' : 'proportional'));

    if (!desc) return alert('Every item needs a name.');
    if (!isFinite(amount) || amount === 0) return alert('Item "' + desc + '" needs a non-zero amount.');
    if (method === 'equal' && !people.length) return alert('Tick at least one person for "' + desc + '".');
    drafts.push({ description: desc, amount: amount, category: category, people: people, method: method });
  }

  try {
    const projectId = uid();
    const categories = Array.from(new Set(drafts.map(function (d) { return d.category; })));
    const project = {
      id: projectId,
      name: name,
      date: isoFromDateOnly(date),
      payer: payer,
      categories: categories,
      attachments: stagedBillAttachments.slice(),
      createdAt: Date.now()
    };
    await dbPut(STORE_PROJECTS, project);
    projects.push(project);

    for (let i = 0; i < drafts.length; i += 1) {
      const draft = drafts[i];
      const item = {
        id: uid(),
        projectId: projectId,
        order: i,
        date: project.date,
        description: draft.description,
        category: draft.category,
        amount: draft.amount,
        paidBy: payer,
        splitMethod: draft.method,
        splitInputs: {},
        splits: draft.method === 'equal' ? equalSplits(draft.amount, draft.people) : {},
        settled: false,
        attachments: []
      };
      await dbPut(STORE_ITEMS, item);
      items.push(item);
    }

    await recomputeBillProportional(projectId);
    expandedProjectIds.add(projectId);
    resetAddForm();
    switchView('history');
    updateAllViews();
    appToast('Saved "' + name + '" with ' + drafts.length + ' item(s).', 'success');
  } catch (err) {
    alert('Could not save the bill: ' + err.message);
  }
}

/* --------------------------- bill modal -------------------------- */

function openBillModal(projectId) {
  const project = projectById(projectId);
  if (!project) return;
  editingBillId = projectId;
  billModalAttachments = JSON.parse(JSON.stringify(project.attachments || []));

  const title = $('modal-bill-title');
  if (title) title.textContent = project.name;
  $('bill-modal-name').value = project.name;
  $('bill-modal-date').value = toDateOnly(project.date);
  const payer = $('bill-modal-payer');
  payer.innerHTML = payerOptionsHtml(project.payer);
  payer.value = project.payer;

  renderBillModalAttachments();
  $('modal-bill').classList.remove('hide');
}

function closeBillModal() {
  const modal = $('modal-bill');
  if (modal) modal.classList.add('hide');
  editingBillId = null;
  billModalAttachments = [];
}

async function saveBillModal(event) {
  event.preventDefault();
  const project = projectById(editingBillId);
  if (!project) return;

  const name = $('bill-modal-name').value.trim();
  const date = $('bill-modal-date').value || todayStr();
  const payer = $('bill-modal-payer').value;

  if (!name) return alert('Give the bill a name.');
  if (!payer) return alert('Select who paid this bill.');

  project.name = name;
  project.date = isoFromDateOnly(date);
  project.payer = payer;
  project.attachments = billModalAttachments.slice();

  try {
    await dbPut(STORE_PROJECTS, project);
    const own = itemsOfProject(project.id);
    for (const item of own) {
      item.paidBy = payer;
      item.date = project.date;
      await dbPut(STORE_ITEMS, item);
    }
    closeBillModal();
    updateAllViews();
  } catch (err) {
    alert('Could not save the bill: ' + err.message);
  }
}

/* --------------------------- item modal -------------------------- */

function nextOrder(projectId) {
  return itemsOfProject(projectId).reduce(function (max, it) {
    return Math.max(max, Number(it.order) || 0);
  }, -1) + 1;
}

function openItemModal(projectId, itemId) {
  const project = projectById(projectId);
  if (!project) return;

  editingItem = { projectId: projectId, itemId: itemId || null };
  const item = itemId ? items.find(function (i) { return i.id === itemId; }) : null;

  const title = $('modal-item-title');
  if (title) title.textContent = item ? 'Edit item' : 'Add item';
  const subtitle = $('modal-item-subtitle');
  if (subtitle) subtitle.textContent = project.name;

  $('item-modal-desc').value = item ? item.description : '';
  $('item-modal-amount').value = item ? item.amount : '';
  $('item-modal-category').value = item ? item.category : '';

  const categories = Array.from(new Set(
    (project.categories || []).concat(itemsOfProject(projectId).map(function (i) { return i.category; }).filter(Boolean))
  ));
  $('item-category-list').innerHTML = categories.map(function (c) {
    return '<option value="' + esc(c) + '"></option>';
  }).join('');

  const splitKeys = item && item.splits ? Object.keys(item.splits) : [];
  itemModalPeople = new Set(splitKeys.length ? splitKeys : state.participants.slice());

  const detected = item ? detectItemKind(item.description, item.category) : 'item';
  itemModalMode = item && item.splitMethod
    ? item.splitMethod
    : (detected === 'item' ? 'equal' : 'proportional');

  const amount = item ? Number(item.amount) || 0 : 0;
  const people = Array.from(itemModalPeople);
  itemModalCache = {};
  if (item) {
    if (item.splitInputs && Object.keys(item.splitInputs).length) {
      itemModalCache[item.splitMethod] = Object.assign({}, item.splitInputs);
    }
    itemModalCache.weighted = deriveInputs('weighted', people, item.splits || {}, amount);
    itemModalCache.percent = deriveInputs('percent', people, item.splits || {}, amount);
    itemModalCache.custom = deriveInputs('custom', people, item.splits || {}, amount);
  }
  itemModalInputs = Object.assign(
    {},
    itemModalCache[itemModalMode] || seedSplitInputs(itemModalMode, itemModalPeople, amount)
  );

  renderItemSplitEditor();
  $('modal-item').classList.remove('hide');
}

function closeItemModal() {
  const modal = $('modal-item');
  if (modal) modal.classList.add('hide');
  editingItem = null;
  itemModalPeople = new Set();
  itemModalInputs = {};
  itemModalCache = {};
}

function deriveInputs(method, people, shares, amount) {
  const list = uniquePeople(people);
  const out = {};
  if (method === 'weighted') {
    const values = list.map(function (p) { return Math.abs(Number(shares[p]) || 0); });
    const allEqual = values.length > 0 && values.every(function (v) { return Math.abs(v - values[0]) < 0.0001; });
    list.forEach(function (p, idx) { out[p] = allEqual ? 1 : round2(values[idx] || 1); });
    return out;
  }
  if (method === 'percent') {
    const absAmount = Math.abs(Number(amount) || 0);
    list.forEach(function (p) {
      out[p] = absAmount ? round2((Math.abs(Number(shares[p]) || 0) / absAmount) * 100) : 0;
    });
    return out;
  }
  if (method === 'custom') {
    list.forEach(function (p) { out[p] = round2(Number(shares[p]) || 0); });
    return out;
  }
  return out;
}

function pickInputs(inputs, people) {
  const out = {};
  uniquePeople(people).forEach(function (person) {
    out[person] = Number(inputs[person]) || 0;
  });
  return out;
}

function renderItemSplitEditor() {
  const box = $('item-modal-people');
  if (!box || !editingItem) return;

  const amount = parseFloat($('item-modal-amount').value) || 0;
  const people = Array.from(itemModalPeople);

  document.querySelectorAll('#item-split-modes button').forEach(function (btn) {
    const active = Number(btn.dataset.mode) === splitModeIndex(itemModalMode);
    btn.className = 'flex-1 px-1 py-1 rounded-md text-[10px] font-semibold transition-all ' +
      (active ? 'bg-white shadow text-indigo-700' : 'text-gray-500 hover:bg-gray-200');
  });

  let result;
  if (itemModalMode === 'proportional') {
    result = {
      splits: proportionalSplitsForAmount(
        itemsOfProject(editingItem.projectId).filter(function (i) { return i.id !== editingItem.itemId; }),
        amount
      ),
      error: null
    };
  } else {
    result = computeShares(amount, itemModalMode, people, itemModalInputs);
  }

  const shareFor = function (person) {
    return result.error ? 0 : (result.splits[person] || 0);
  };

  if (itemModalMode === 'proportional') {
    const names = Object.keys(result.splits);
    box.innerHTML = names.length
      ? names.map(function (person) {
          return '<span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg border bg-indigo-50 border-indigo-200 text-[11px] text-indigo-900">' +
            esc(person === state.userName ? 'You' : person) +
            ' <b>' + money(shareFor(person)) + '</b></span>';
        }).join('')
      : '<span class="text-[10px] text-gray-400">Add a normal item to this bill first.</span>';
  } else {
    box.innerHTML = state.participants.map(function (person, idx) {
      const on = itemModalPeople.has(person);
      return '<label class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs font-medium cursor-pointer select-none ' +
        (on ? 'bg-indigo-50 border-indigo-300 text-indigo-900' : 'bg-white border-gray-200 text-gray-500') + '">' +
        '<input type="checkbox" ' + (on ? 'checked' : '') + ' onchange="toggleItemPerson(' + idx + ', this.checked)" class="w-3.5 h-3.5 text-indigo-600 rounded border-gray-300">' +
        '<span>' + esc(person) + '</span>' +
        (on ? '<span class="text-[10px] text-indigo-600 font-bold">' + money(shareFor(person)) + '</span>' : '') +
      '</label>';
    }).join('');
  }

  const inputsBox = $('item-split-inputs');
  if (inputsBox) {
    if (itemModalMode === 'equal') {
      inputsBox.innerHTML = '';
    } else if (itemModalMode === 'proportional') {
      inputsBox.innerHTML = '<p class="text-[10px] text-gray-500">Each person pays the same proportion of this row as their share of the bill&apos;s normal items. Switch mode to override.</p>';
    } else {
      const unit = itemModalMode === 'percent' ? '%' : (itemModalMode === 'custom' ? state.currency : '×');
      inputsBox.innerHTML = people.map(function (person) {
        const idx = state.participants.indexOf(person);
        const raw = itemModalInputs[person];
        const value = raw === undefined || raw === '' ? '' : round2(raw);
        return '<div class="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-2 py-1">' +
          '<span class="text-[11px] text-gray-600 flex-1 min-w-0 truncate">' + esc(person) + '</span>' +
          '<input type="number" step="0.01" inputmode="decimal" value="' + value + '" onchange="updateItemSplitInput(' + idx + ', this.value)" class="w-20 border border-gray-300 rounded px-1.5 py-0.5 text-xs text-right outline-none focus:border-indigo-400">' +
          '<span class="text-[10px] text-gray-400 w-4">' + unit + '</span>' +
          '<span class="text-[10px] font-semibold text-indigo-600 w-16 text-right">' + money(shareFor(person)) + '</span>' +
        '</div>';
      }).join('');
    }
  }

  const errorBox = $('item-split-error');
  if (errorBox) {
    errorBox.textContent = result.error || '';
    errorBox.classList.toggle('hide', !result.error);
  }
}

function toggleItemPerson(index, checked) {
  const person = state.participants[index];
  if (!person) return;
  if (checked) {
    itemModalPeople.add(person);
    if (itemModalMode !== 'equal' && itemModalMode !== 'proportional' && itemModalInputs[person] === undefined) {
      itemModalInputs[person] = itemModalMode === 'weighted' ? 1 : 0;
    }
  } else {
    itemModalPeople.delete(person);
  }
  renderItemSplitEditor();
}

function setItemModalPeople(on) {
  const amount = parseFloat($('item-modal-amount').value) || 0;
  if (on) {
    itemModalPeople = new Set(state.participants);
    if (itemModalMode !== 'equal' && itemModalMode !== 'proportional') {
      itemModalInputs = seedSplitInputs(itemModalMode, itemModalPeople, amount);
    }
  } else {
    itemModalPeople = new Set();
  }
  renderItemSplitEditor();
}

function setItemSplitMode(index) {
  const next = splitModeName(index);
  if (!editingItem || next === itemModalMode) return;

  const amount = parseFloat($('item-modal-amount').value) || 0;
  const people = Array.from(itemModalPeople);

  let currentSplits = {};
  if (itemModalMode === 'proportional') {
    currentSplits = proportionalSplitsForAmount(
      itemsOfProject(editingItem.projectId).filter(function (i) { return i.id !== editingItem.itemId; }),
      amount
    );
  } else {
    const current = computeShares(amount, itemModalMode, people, itemModalInputs);
    if (!current.error) currentSplits = current.splits;
  }

  itemModalCache[itemModalMode] = Object.assign({}, itemModalInputs);
  itemModalMode = next;

  if (next === 'equal' || next === 'proportional') {
    itemModalInputs = {};
  } else if (itemModalCache[next] && Object.keys(itemModalCache[next]).length) {
    itemModalInputs = Object.assign({}, itemModalCache[next]);
  } else {
    itemModalInputs = deriveInputs(next, people, currentSplits, amount);
  }

  renderItemSplitEditor();
}

function updateItemSplitInput(index, value) {
  const person = state.participants[index];
  if (!person) return;
  itemModalInputs[person] = value === '' ? '' : Number(value);
  renderItemSplitEditor();
}

async function recomputeBillProportional(projectId) {
  const own = itemsOfProject(projectId);
  for (const item of own) {
    if (item.splitMethod !== 'proportional') continue;
    item.splits = proportionalSplitsForAmount(own, item.amount);
    await dbPut(STORE_ITEMS, item);
  }
}

async function saveItemModal(event) {
  event.preventDefault();
  if (!editingItem) return;

  const project = projectById(editingItem.projectId);
  if (!project) return;

  const desc = $('item-modal-desc').value.trim();
  const amount = parseFloat($('item-modal-amount').value);
  const category = $('item-modal-category').value.trim() || 'Uncategorised';
  const people = Array.from(itemModalPeople);

  if (!desc) return alert('Give the item a name.');
  if (!isFinite(amount) || amount === 0) return alert('Enter a non-zero amount.');

  let result;
  if (itemModalMode === 'proportional') {
    result = {
      splits: proportionalSplitsForAmount(
        itemsOfProject(project.id).filter(function (i) { return i.id !== editingItem.itemId; }),
        amount
      ),
      error: null
    };
  } else {
    result = computeShares(amount, itemModalMode, people, itemModalInputs);
  }
  if (result.error) return alert(result.error);

  try {
    project.categories = project.categories || [];
    if (project.categories.indexOf(category) === -1) {
      project.categories.push(category);
      await dbPut(STORE_PROJECTS, project);
    }

    let item = editingItem.itemId
      ? items.find(function (i) { return i.id === editingItem.itemId; })
      : null;

    const splitInputs = (itemModalMode === 'equal' || itemModalMode === 'proportional')
      ? {}
      : pickInputs(itemModalInputs, people);

    if (item) {
      item.description = desc;
      item.amount = amount;
      item.category = category;
      item.splitMethod = itemModalMode;
      item.splitInputs = splitInputs;
      item.splits = result.splits;
      await dbPut(STORE_ITEMS, item);
    } else {
      item = {
        id: uid(),
        projectId: project.id,
        order: nextOrder(project.id),
        date: project.date,
        description: desc,
        category: category,
        amount: amount,
        paidBy: project.payer,
        splitMethod: itemModalMode,
        splitInputs: splitInputs,
        splits: result.splits,
        settled: false,
        attachments: []
      };
      await dbPut(STORE_ITEMS, item);
      items.push(item);
    }

    await recomputeBillProportional(project.id);
    closeItemModal();
    updateAllViews();
  } catch (err) {
    alert('Could not save the item: ' + err.message);
  }
}


/* --------------------------- timeline ---------------------------- */

function billSplitChipsHtml(projectItems, displayTotal, filtered) {
  const totals = {};
  (projectItems || []).forEach(function (item) {
    const splits = item.splits || {};
    Object.keys(splits).forEach(function (person) {
      const value = Number(splits[person]) || 0;
      if (!Object.prototype.hasOwnProperty.call(totals, person)) totals[person] = 0;
      totals[person] += value;
    });
  });

  const names = [];
  state.participants.forEach(function (person) {
    if (Object.prototype.hasOwnProperty.call(totals, person)) names.push(person);
  });
  Object.keys(totals).forEach(function (person) {
    if (!names.some(function (existing) { return samePerson(existing, person); })) names.push(person);
  });

  const rows = names.filter(function (person) { return Math.abs(totals[person]) > 0.004; });
  if (!rows.length) {
    return '<p class="text-[10px] text-gray-400 mt-2">No splits set for this bill.</p>';
  }

  const shareTotal = Object.keys(totals).reduce(function (sum, person) { return sum + totals[person]; }, 0);
  const gap = (Number(displayTotal) || 0) - shareTotal;

  let html = '<div class="mt-2">' +
    '<p class="text-[9px] font-bold uppercase tracking-wider text-gray-400 mb-1">Bill split' +
      (filtered ? ' <span class="normal-case font-medium tracking-normal text-gray-400">(shown items)</span>' : '') +
    '</p>' +
    '<div class="flex flex-wrap gap-1">';

  rows.forEach(function (person) {
    const amount = totals[person];
    html += '<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-indigo-50 border border-indigo-100 text-[10px] text-indigo-800">' +
      esc(person === state.userName ? 'You' : person) +
      ' <b class="' + (amount < 0 ? 'text-emerald-700' : 'text-indigo-900') + '">' + money(amount) + '</b></span>';
  });

  if (Math.abs(gap) > 0.01) {
    html += '<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-[10px] font-semibold text-amber-700">' +
      (gap > 0 ? 'Unallocated ' : 'Overallocated ') + money(Math.abs(gap)) + '</span>';
  }

  html += '</div></div>';
  return html;
}

function renderHistory() {
  const list = $('history-list');
  if (!list) return;

  const filtered = filterItems('hist');
  if (!filtered.length) {
    list.innerHTML = '<div class="text-center py-10 bg-white rounded-xl border border-gray-200 shadow-sm mt-4">' +
      '<p class="text-gray-500">No bills match the filters.</p></div>';
    return;
  }

  const grouped = new Map();
  filtered.forEach(function (item) {
    if (!grouped.has(item.projectId)) grouped.set(item.projectId, []);
    grouped.get(item.projectId).push(item);
  });

  const cards = [];
  grouped.forEach(function (matchedItems, projectId) {
    const project = projectById(projectId);
    if (project) cards.push({ project: project, items: matchedItems });
  });

  cards.sort(function (a, b) {
    const dateA = new Date(a.project.date).getTime();
    const dateB = new Date(b.project.date).getTime();
    if (dateA !== dateB) return dateB - dateA;
    return (b.project.createdAt || 0) - (a.project.createdAt || 0);
  });

  let html = '';
  let lastLabel = '';
  cards.forEach(function (card) {
    const label = dateLabel(card.project.date);
    if (label !== lastLabel) {
      html += '<div class="sticky top-0 z-10 bg-gray-100/90 backdrop-blur pt-4 pb-2 mt-2">' +
        '<h3 class="text-xs font-bold text-indigo-800 uppercase tracking-wider">' + esc(label) + '</h3></div>';
      lastLabel = label;
    }
    html += billCardHtml(card.project, card.items);
  });

  list.innerHTML = html;
}

function billCardHtml(project, matchedItems) {
  const allItems = itemsOfProject(project.id);
  const isSubset = matchedItems.length !== allItems.length;
  const total = matchedItems.reduce(function (sum, it) { return sum + (Number(it.amount) || 0); }, 0);
  const allTotal = allItems.reduce(function (sum, it) { return sum + (Number(it.amount) || 0); }, 0);
  const allSettled = allItems.length > 0 && allItems.every(function (it) { return !!it.settled; });
  const someSettled = !allSettled && allItems.some(function (it) { return !!it.settled; });
  const expanded = expandedProjectIds.has(project.id);
  const sortedItems = matchedItems.slice().sort(function (a, b) {
    return (Number(a.order) || 0) - (Number(b.order) || 0);
  });

  let badge = '';
  if (allSettled) {
    badge = '<span class="bg-emerald-100 text-emerald-700 text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wider font-bold">Settled</span>';
  } else if (someSettled) {
    badge = '<span class="bg-amber-100 text-amber-700 text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wider font-bold">Partly settled</span>';
  }

  const metaLine = 'Paid by <span class="font-semibold text-gray-700">' +
    esc(project.payer === state.userName ? 'You' : project.payer) + '</span>' +
    ' &middot; ' + allItems.length + ' item' + (allItems.length === 1 ? '' : 's') +
    (isSubset ? ' &middot; showing ' + matchedItems.length : '');

  let html = '<div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">' +
    '<div role="button" tabindex="0" onclick="toggleProjectExpand(' + project.id + ')" class="w-full text-left p-4 flex items-start gap-3 cursor-pointer">' +
      '<div class="flex-1 min-w-0">' +
        '<div class="flex items-center gap-2 flex-wrap">' +
          '<h4 class="font-bold text-gray-800 text-base break-words">' + esc(project.name) + '</h4>' + badge +
        '</div>' +
        '<p class="text-[11px] text-gray-500 mt-1">' + metaLine + '</p>' +
        billSplitChipsHtml(sortedItems, isSubset ? total : allTotal, isSubset) +
      '</div>' +
      '<div class="text-right flex-shrink-0 pl-1">' +
        '<p class="font-bold text-indigo-600 text-base">' + money(isSubset ? total : allTotal) + '</p>' +
        '<p class="text-[10px] text-gray-400 mt-1">' + (expanded ? '&#9652;' : '&#9662;') + '</p>' +
      '</div>' +
    '</div>';

  if (expanded) {
    html += '<div class="border-t border-gray-100 bg-gray-50/70 px-3 py-3">';
    html += sortedItems.map(itemRowHtml).join('');
    if (isSubset) {
      html += '<p class="text-[10px] text-gray-400 mt-2">Showing ' + matchedItems.length +
        ' of ' + allItems.length + ' items because filters are active.</p>';
    }
    html += '<div class="flex flex-wrap gap-1.5 mt-3">' +
      '<button type="button" onclick="openItemModal(' + project.id + ')" class="text-[11px] font-semibold bg-indigo-600 text-white px-2.5 py-1.5 rounded-lg hover:bg-indigo-700">+ Add item</button>' +
      '<button type="button" onclick="openBillModal(' + project.id + ')" class="text-[11px] font-semibold bg-white border border-gray-300 text-gray-700 px-2.5 py-1.5 rounded-lg hover:bg-gray-100">Edit bill</button>' +
      '<button type="button" onclick="toggleProjectSettled(' + project.id + ')" class="text-[11px] font-semibold bg-white border border-gray-300 text-gray-700 px-2.5 py-1.5 rounded-lg hover:bg-gray-100">' +
        (allSettled ? 'Unsettle all' : 'Settle all') + '</button>' +
      '<button type="button" onclick="deleteProject(' + project.id + ')" class="text-[11px] font-semibold bg-white border border-red-200 text-red-600 px-2.5 py-1.5 rounded-lg hover:bg-red-50">Delete</button>' +
    '</div>';
    html += projectAttachmentHtml(project);
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function itemRowHtml(item) {
  const splits = Object.entries(item.splits || {});
  const settled = !!item.settled;
  const shareChips = splits.length
    ? splits.map(function (entry) {
        return '<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-50 border border-indigo-100 text-[10px] text-indigo-800">' +
          esc(entry[0] === state.userName ? 'You' : entry[0]) +
          ' <b>' + money(entry[1]) + '</b></span>';
      }).join('')
    : '<span class="text-[10px] text-gray-400">No people set</span>';

  const amountClass = Number(item.amount) < 0 ? 'text-emerald-600' : 'text-gray-800';

  return '<div class="bg-white border border-gray-200 rounded-lg p-2.5 mb-2 ' + (settled ? 'opacity-60' : '') + '">' +
    '<div class="flex items-start justify-between gap-2">' +
      '<div class="min-w-0">' +
        '<p class="text-sm font-semibold text-gray-800 break-words ' + (settled ? 'line-through decoration-gray-300' : '') + '">' +
          esc(item.description) + '</p>' +
        '<p class="mt-0.5"><span class="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-[10px]">' + esc(item.category) + '</span>' +
          (splitModeLabel(item.splitMethod) ? '<span class="ml-1 text-[9px] uppercase tracking-wide text-indigo-500 font-semibold">' + splitModeLabel(item.splitMethod) + '</span>' : '') +
        '</p>' +
      '</div>' +
      '<p class="font-mono text-sm font-bold flex-shrink-0 ' + amountClass + '">' + money(item.amount) + '</p>' +
    '</div>' +
    '<div class="flex flex-wrap gap-1 mt-1.5">' + shareChips + '</div>' +
    '<div class="flex items-center justify-end gap-1 mt-1">' +
      '<button type="button" onclick="toggleItemSettled(' + item.id + ')" class="p-1 ' + (settled ? 'text-emerald-500' : 'text-gray-300 hover:text-emerald-500') + '" title="' + (settled ? 'Mark unsettled' : 'Mark settled') + '">' +
        svgIcon(ICON.check, 'w-5 h-5') + '</button>' +
      '<button type="button" onclick="openItemModal(' + item.projectId + ', ' + item.id + ')" class="p-1 text-gray-400 hover:text-indigo-600" title="Edit item">' +
        svgIcon(ICON.pencil, 'w-4 h-4') + '</button>' +
      '<button type="button" onclick="deleteItem(' + item.id + ')" class="p-1 text-gray-400 hover:text-red-500" title="Delete item">' +
        svgIcon(ICON.trash, 'w-4 h-4') + '</button>' +
    '</div>' +
  '</div>';
}

function toggleProjectExpand(projectId) {
  if (expandedProjectIds.has(projectId)) expandedProjectIds.delete(projectId);
  else expandedProjectIds.add(projectId);
  renderHistory();
}

async function toggleItemSettled(itemId) {
  const item = items.find(function (i) { return i.id === itemId; });
  if (!item) return;
  item.settled = !item.settled;
  await dbPut(STORE_ITEMS, item);
  updateAllViews();
}

async function toggleProjectSettled(projectId) {
  const own = itemsOfProject(projectId);
  if (!own.length) return;
  const allSettled = own.every(function (it) { return !!it.settled; });
  for (const item of own) {
    item.settled = !allSettled;
    await dbPut(STORE_ITEMS, item);
  }
  updateAllViews();
}

async function deleteItem(itemId) {
  const item = items.find(function (i) { return i.id === itemId; });
  if (!item) return;
  if (!(await appConfirm('Delete item "' + item.description + '"?', {
    title: 'Delete item?',
    confirmLabel: 'Delete',
    danger: true
  }))) return;

  await dbDelete(STORE_ITEMS, item.id);
  items = items.filter(function (i) { return i.id !== item.id; });

  const remaining = itemsOfProject(item.projectId);
  if (!remaining.length) {
    await dbDelete(STORE_PROJECTS, item.projectId);
    projects = projects.filter(function (p) { return p.id !== item.projectId; });
    expandedProjectIds.delete(item.projectId);
  } else {
    await recomputeBillProportional(item.projectId);
  }
  updateAllViews();
}

async function deleteProject(projectId) {
  const project = projectById(projectId);
  if (!project) return;
  const own = itemsOfProject(projectId);
  if (!(await appConfirm('Delete bill "' + project.name + '" and its ' + own.length + ' item(s)?', {
    title: 'Delete bill?',
    confirmLabel: 'Delete',
    danger: true
  }))) return;

  for (const item of own) await dbDelete(STORE_ITEMS, item.id);
  await dbDelete(STORE_PROJECTS, projectId);

  items = items.filter(function (i) { return i.projectId !== projectId; });
  projects = projects.filter(function (p) { return p.id !== projectId; });
  expandedProjectIds.delete(projectId);
  updateAllViews();
}

/* ----------------------------- people ---------------------------- */

function renderPeople() {
  const list = $('people-list');
  if (!list) return;
  list.innerHTML = state.participants.map(function (person, index) {
    const isUser = person === state.userName;
    return '<li class="flex justify-between items-center p-3 hover:bg-gray-50">' +
      '<span class="font-medium text-gray-700">' + esc(person) +
        (isUser ? '<span class="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full ml-2">You</span>' : '') +
      '</span>' +
      '<button onclick="removePerson(' + index + ')" class="text-red-500 hover:text-red-700 p-1" ' +
        (isUser ? 'disabled style="opacity:0.2"' : '') + '>' + svgIcon(ICON.trash, 'w-5 h-5') + '</button>' +
    '</li>';
  }).join('');
}

async function addPerson(event) {
  event.preventDefault();
  const input = $('new-person-name');
  const name = (input.value || '').trim();
  if (!name) return;
  if (state.participants.some(function (p) { return samePerson(p, name); })) {
    return alert('That person is already in the list.');
  }
  state.participants.push(name);
  input.value = '';
  await saveMeta();
  updateAllViews();
}

async function removePerson(index) {
  const name = state.participants[index];
  if (!name || name === state.userName) return;
  const involved = items.some(function (item) {
    return item.paidBy === name || (item.splits && item.splits[name] !== undefined);
  });
  if (involved) return alert('Cannot remove ' + name + ' - they appear in existing bills.');
  state.participants.splice(index, 1);
  await saveMeta();
  updateAllViews();
}


/* ---------------------------- analytics -------------------------- */

function renderDashboard() {
  const filtered = filterItems('dash');

  const total = filtered.reduce(function (sum, it) { return sum + (Number(it.amount) || 0); }, 0);
  const personal = filtered.reduce(function (sum, it) {
    return sum + (it.splits && Number(it.splits[state.userName]) ? Number(it.splits[state.userName]) : 0);
  }, 0);

  const totalEl = $('dash-total');
  if (totalEl) totalEl.textContent = money(total);
  const personalEl = $('dash-personal');
  if (personalEl) personalEl.textContent = money(personal);

  const unsettled = filtered.filter(function (it) { return !it.settled; });
  const balances = {};
  state.participants.forEach(function (p) { balances[p] = 0; });
  unsettled.forEach(function (it) {
    if (balances[it.paidBy] !== undefined) balances[it.paidBy] += Number(it.amount) || 0;
    Object.keys(it.splits || {}).forEach(function (person) {
      if (balances[person] !== undefined) balances[person] -= Number(it.splits[person]) || 0;
    });
  });

  const box = $('transparency-box');
  if (box) {
    let html = '<div class="space-y-2"><div class="flex items-center gap-2 border-b border-gray-200 pb-2">' +
      '<strong>Net Balance = Total Paid - Total Share</strong></div>';
    let hasData = false;
    state.participants.forEach(function (p) {
      const paid = unsettled.filter(function (it) { return it.paidBy === p; })
        .reduce(function (sum, it) { return sum + (Number(it.amount) || 0); }, 0);
      const share = unsettled.reduce(function (sum, it) {
        return sum + ((it.splits && Number(it.splits[p])) || 0);
      }, 0);
      const bal = paid - share;
      if (paid !== 0 || share !== 0) {
        hasData = true;
        const balColor = bal > 0.01 ? 'text-emerald-600' : (bal < -0.01 ? 'text-red-500' : 'text-gray-500');
        const balSign = bal > 0.01 ? '+' : '';
        html += '<div class="flex justify-between items-center py-1 border-b border-gray-100 last:border-0">' +
          '<span class="font-medium text-gray-700">' + esc(p) + '</span>' +
          '<span class="text-gray-500 text-[11px] sm:text-xs">Paid ' + money(paid) +
            ' &minus; Share ' + money(share) + ' = ' +
            '<span class="font-bold ' + balColor + ' text-sm">' + balSign + money(bal) + '</span></span>' +
        '</div>';
      }
    });
    if (!hasData) html += '<p class="text-gray-500 italic py-1">No active unsettled expenses.</p>';
    html += '</div>';
    box.innerHTML = html;
  }

  const debtors = [];
  const creditors = [];
  Object.keys(balances).forEach(function (person) {
    const balance = balances[person];
    if (balance < -0.01) debtors.push({ person: person, amount: Math.abs(balance) });
    else if (balance > 0.01) creditors.push({ person: person, amount: balance });
  });
  debtors.sort(function (a, b) { return b.amount - a.amount; });
  creditors.sort(function (a, b) { return b.amount - a.amount; });

  const settlements = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const amount = Math.min(debtor.amount, creditor.amount);
    if (amount > 0.004) {
      const dName = debtor.person === state.userName ? 'You' : debtor.person;
      const cName = creditor.person === state.userName ? 'You' : creditor.person;
      settlements.push(dName + ' owe' + (dName === 'You' ? '' : 's') + ' ' + cName +
        ' <span class="font-bold text-gray-800">' + money(amount) + '</span>');
    }
    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount < 0.01) i += 1;
    if (creditor.amount < 0.01) j += 1;
  }

  const balanceList = $('balances-list');
  if (balanceList) {
    balanceList.innerHTML = settlements.length === 0
      ? '<p class="text-emerald-600 text-sm font-medium flex items-center gap-1">' +
          svgIcon(ICON.check, 'w-4 h-4') + ' All balances are settled up!</p>'
      : settlements.map(function (line) {
          return '<div class="flex items-center gap-2 border-l-4 border-orange-400 pl-3 py-1 bg-orange-50 rounded-r">' +
            '<span class="text-orange-700">&#10132;</span> <span>' + line + '</span></div>';
        }).join('');
  }

  renderDateChart(filtered);
  renderPeopleChart(filtered);
  renderCategoryChart(filtered);
}

function renderDateChart(data) {
  const canvas = $('dateCategoryChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const ctx = canvas.getContext('2d');

  const dateMap = {};
  data.forEach(function (it) {
    const iso = toDateOnly(it.date);
    if (!dateMap[iso]) dateMap[iso] = {};
    dateMap[iso][it.category] = (dateMap[iso][it.category] || 0) + (Number(it.amount) || 0);
  });

  const dates = Object.keys(dateMap).sort();
  const labels = dates.map(function (d) {
    const p = d.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12)
      .toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });

  const categories = Array.from(new Set(data.map(function (it) { return it.category; })));
  const palette = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#64748b', '#14b8a6', '#f43f5e'];
  const datasets = categories.map(function (cat, idx) {
    return {
      label: cat,
      data: dates.map(function (d) { return dateMap[d][cat] || 0; }),
      backgroundColor: palette[idx % palette.length]
    };
  }).filter(function (ds) {
    return ds.data.some(function (v) { return v !== 0; });
  });

  if (chartInstances.date) chartInstances.date.destroy();

  if (!labels.length) {
    chartInstances.date = new Chart(ctx, {
      type: 'bar',
      data: { labels: ['No Data'], datasets: [{ data: [1], backgroundColor: ['#e5e7eb'] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { enabled: false }, legend: { display: false } } }
    });
    return;
  }

  chartInstances.date = new Chart(ctx, {
    type: 'bar',
    data: { labels: labels, datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true } },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: function (context) {
              if (context.raw) return ' ' + context.dataset.label + ': ' + money(context.raw);
              return undefined;
            },
            footer: function (tooltipItems) {
              const sum = tooltipItems.reduce(function (s, item) { return s + item.raw; }, 0);
              return 'Total: ' + money(sum);
            }
          }
        }
      }
    }
  });
}

function renderPeopleChart(data) {
  const canvas = $('peopleChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const ctx = canvas.getContext('2d');

  const totals = {};
  data.forEach(function (it) {
    Object.keys(it.splits || {}).forEach(function (person) {
      totals[person] = (totals[person] || 0) + (Number(it.splits[person]) || 0);
    });
  });

  const labels = Object.keys(totals);
  const values = Object.values(totals);
  const palette = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#64748b'];

  if (chartInstances.people) chartInstances.people.destroy();
  if (!labels.length) {
    chartInstances.people = new Chart(ctx, {
      type: 'pie',
      data: { labels: ['No Data'], datasets: [{ data: [1], backgroundColor: ['#e5e7eb'] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { enabled: false }, legend: { display: false } } }
    });
    return;
  }

  chartInstances.people = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: labels.map(function (l) { return l === state.userName ? 'You' : l; }),
      datasets: [{ data: values, backgroundColor: palette.slice(0, labels.length), borderWidth: 1 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: function (context) { return ' ' + money(context.raw); } } }
      }
    }
  });
}

function renderCategoryChart(data) {
  const canvas = $('categoryChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const ctx = canvas.getContext('2d');

  const totals = {};
  data.forEach(function (it) {
    totals[it.category] = (totals[it.category] || 0) + (Number(it.amount) || 0);
  });

  const labels = Object.keys(totals);
  const values = Object.values(totals);
  const palette = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'];

  if (chartInstances.category) chartInstances.category.destroy();
  if (!labels.length) {
    chartInstances.category = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: ['No Data'], datasets: [{ data: [1], backgroundColor: ['#e5e7eb'] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { tooltip: { enabled: false }, legend: { display: false } } }
    });
    return;
  }

  chartInstances.category = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{ data: values, backgroundColor: palette.slice(0, labels.length), borderWidth: 1 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: function (context) { return ' ' + money(context.raw); } } }
      }
    }
  });
}

/* ---------------------------- settings --------------------------- */

async function saveUserName() {
  const input = $('setting-user-name');
  const newName = (input.value || '').trim();
  if (!newName) return alert('Name cannot be empty.');
  const oldName = state.userName;
  if (newName === oldName) return;

  const taken = state.participants.some(function (p) {
    return p !== oldName && samePerson(p, newName);
  });
  if (taken) return alert('That name is already a participant.');

  const idx = state.participants.indexOf(oldName);
  if (idx !== -1) state.participants[idx] = newName;
  else if (!state.participants.some(function (p) { return samePerson(p, newName); })) state.participants.unshift(newName);

  for (const project of projects) {
    if (project.payer === oldName) {
      project.payer = newName;
      await dbPut(STORE_PROJECTS, project);
    }
  }

  for (const item of items) {
    let changed = false;
    if (item.paidBy === oldName) { item.paidBy = newName; changed = true; }
    if (item.splits && item.splits[oldName] !== undefined) {
      const amount = item.splits[oldName];
      delete item.splits[oldName];
      item.splits[newName] = amount;
      changed = true;
    }
    if (changed) await dbPut(STORE_ITEMS, item);
  }

  state.userName = newName;
  await saveMeta();
  updateAllViews();
  appToast('Name updated.', 'success');
}

async function saveCurrency() {
  const input = $('setting-currency');
  const next = (input.value || '').trim();
  if (!next) return alert('Enter a currency symbol.');
  state.currency = next;
  await saveMeta();
  updateAllViews();
  appToast('Currency updated.', 'success');
}

function csvCell(value) {
  const s = String(value === undefined || value === null ? '' : value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportToCSV() {
  if (!items.length) return alert('No bills to export yet.');

  const header = ['Bill', 'Date', 'Item', 'Category', 'Amount', 'Paid By', 'Split', 'Settled']
    .concat(state.participants.map(function (p) { return p + ' Share'; }));

  const rows = [header.map(csvCell).join(',')];
  const sorted = items.slice().sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
  sorted.forEach(function (item) {
    const project = projectById(item.projectId);
    const row = [
      project ? project.name : '',
      toDateOnly(item.date),
      item.description,
      item.category,
      (Number(item.amount) || 0).toFixed(2),
      item.paidBy,
      item.splitMethod || 'equal',
      item.settled ? 'Yes' : 'No'
    ].concat(state.participants.map(function (p) {
      return ((item.splits && Number(item.splits[p])) || 0).toFixed(2);
    }));
    rows.push(row.map(csvCell).join(','));
  });

  downloadText(rows.join('\n'), 'SplitTrack_' + todayStr() + '.csv');
}

function exportFullBackup() {
  if (!projects.length) return alert('There is nothing to back up yet.');
  const backup = {
    appName: 'SplitTrack_Backup',
    version: 3,
    exportedAt: new Date().toISOString(),
    meta: {
      userName: state.userName,
      currency: state.currency,
      participants: state.participants
    },
    projects: projects,
    items: items
  };
  downloadText(JSON.stringify(backup), 'SplitTrack_Backup_' + todayStr() + '.json', 'application/json');
}

/* -------------------------- PDF statement ------------------------ */

function getPdfReportApi() {
  if (typeof window === 'undefined') return null;
  const api = window.SplitTrackPdfReport;
  if (!api) return null;
  if (typeof api.renderInto === 'function') return api;
  if (typeof api.buildStandaloneHtml === 'function') return api;
  return null;
}

function pdfErrorMessage(err) {
  return err && err.message ? err.message : 'unknown error';
}

function pdfContainerHasReport(container) {
  return !!(container && (container.querySelector('.pdf-report') || container.children.length));
}

function renderPdfReportInto(container, data, api) {
  if (!container) throw new Error('Missing PDF container.');

  container.innerHTML = '';
  if (typeof api.renderInto === 'function') {
    api.renderInto(container, data);
  } else if (typeof api.buildStandaloneHtml === 'function') {
    // Optional fallback for a PDF module that only exposes standalone HTML.
    const standalone = api.buildStandaloneHtml(data);
    if (typeof standalone !== 'string' || !standalone.trim()) {
      throw new Error('The PDF report module returned no standalone HTML.');
    }
    container.innerHTML = standalone;
  } else {
    throw new Error('The PDF report module has no renderer.');
  }

  if (!container.children.length && !container.textContent.trim()) {
    throw new Error('The PDF report module returned no content.');
  }
}

function exportPdfReport() {
  if (!projects.length) {
    return alert('Add at least one bill before exporting a PDF statement.');
  }

  const api = getPdfReportApi();
  if (!api) {
    return alert('PDF export is unavailable because the PDF report module (js/pdf-report.js) did not load correctly. Reload the app and try again.');
  }

  const preview = $('pdf-preview-container');
  const printRoot = $('pdf-print-root');
  const modal = $('modal-pdf');
  if (!preview || !printRoot || !modal) {
    return alert('The PDF preview could not open because the page is missing its PDF containers.');
  }

  const data = {
    projects: projects,
    items: items.map(function (item) {
      return Object.assign({}, item, { kind: detectItemKind(item.description, item.category) });
    }),
    participants: state.participants.slice(),
    userName: state.userName,
    currency: state.currency,
    generatedAt: new Date().toISOString()
  };

  try {
    renderPdfReportInto(preview, data, api);
    renderPdfReportInto(printRoot, data, api);
  } catch (err) {
    preview.innerHTML = '';
    printRoot.innerHTML = '';
    pdfReportData = null;
    console.error('PDF statement render failed:', err);
    return alert('Could not build the PDF statement: ' + pdfErrorMessage(err));
  }

  pdfReportData = data;

  if (modal.classList.contains('hide')) {
    const activeElement = document.activeElement;
    pdfReturnFocus = activeElement && activeElement !== document.body && activeElement !== document.documentElement
      ? activeElement
      : null;
  }
  modal.classList.remove('hide');
  document.body.classList.add('pdf-printing');

  if (pdfPreviousBodyOverflow === null) {
    pdfPreviousBodyOverflow = document.body.style.overflow;
  }
  document.body.style.overflow = 'hidden';

  const scrollArea = $('pdf-preview-scroll');
  if (scrollArea) scrollArea.scrollTop = 0;

  const closeButton = $('pdf-modal-close-btn');
  if (closeButton) {
    try {
      closeButton.focus({ preventScroll: true });
    } catch (err) {
      closeButton.focus();
    }
  }
}

function closePdfPreview() {
  const modal = $('modal-pdf');
  if (modal) modal.classList.add('hide');

  document.body.classList.remove('pdf-printing');

  const preview = $('pdf-preview-container');
  if (preview) preview.innerHTML = '';

  const printRoot = $('pdf-print-root');
  if (printRoot) printRoot.innerHTML = '';

  const scrollArea = $('pdf-preview-scroll');
  if (scrollArea) scrollArea.scrollTop = 0;

  pdfReportData = null;

  if (pdfPreviousBodyOverflow !== null) {
    document.body.style.overflow = pdfPreviousBodyOverflow;
    pdfPreviousBodyOverflow = null;
  }

  const returnTarget = pdfReturnFocus;
  pdfReturnFocus = null;
  if (returnTarget && typeof returnTarget.focus === 'function' && document.contains(returnTarget)) {
    try {
      returnTarget.focus({ preventScroll: true });
    } catch (err) {
      returnTarget.focus();
    }
    return;
  }

  // No trigger to return to (the preview was opened programmatically): drop
  // focus from the now-hidden dialog so keyboard/screen-reader focus is not
  // stranded on an invisible Close button.
  const activeElement = document.activeElement;
  if (activeElement && activeElement !== document.body && activeElement !== document.documentElement &&
      typeof activeElement.blur === 'function' && activeElement.closest && activeElement.closest('#modal-pdf')) {
    activeElement.blur();
  }
}

function ensurePdfPrintRoot() {
  if (!pdfReportData) return false;

  const printRoot = $('pdf-print-root');
  if (!printRoot) {
    alert('The printable PDF area is missing from the page.');
    return false;
  }
  if (pdfContainerHasReport(printRoot)) return true;

  const api = getPdfReportApi();
  if (!api) {
    alert('PDF export is unavailable because the PDF report module (js/pdf-report.js) did not load correctly. Reload the app and try again.');
    return false;
  }

  try {
    renderPdfReportInto(printRoot, pdfReportData, api);
    return true;
  } catch (err) {
    printRoot.innerHTML = '';
    console.error('PDF print-root render failed:', err);
    alert('Could not rebuild the PDF statement for printing: ' + pdfErrorMessage(err));
    return false;
  }
}

function printPdfReport() {
  if (!pdfReportData) return;
  if (!ensurePdfPrintRoot()) return;
  document.body.classList.add('pdf-printing');
  window.print();
}

function handlePdfBeforePrint() {
  if (pdfReportData) {
    document.body.classList.add('pdf-printing');
    ensurePdfPrintRoot();
  } else {
    document.body.classList.remove('pdf-printing');
  }
}

function trapPdfModalFocus(event) {
  if (event.key !== 'Tab') return;

  const modal = $('modal-pdf');
  if (!modal || modal.classList.contains('hide')) return;

  const focusable = modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (!modal.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function bindPdfPreviewEvents() {
  const modal = $('modal-pdf');
  if (modal) {
    modal.addEventListener('click', function (event) {
      if (event.target === modal) closePdfPreview();
    });
    modal.addEventListener('keydown', trapPdfModalFocus);
  }

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' && event.key !== 'Esc') return;
    const openModal = $('modal-pdf');
    if (openModal && !openModal.classList.contains('hide')) {
      event.preventDefault();
      closePdfPreview();
    }
  });

  window.addEventListener('beforeprint', handlePdfBeforePrint);
  window.addEventListener('afterprint', function () {
    const openModal = $('modal-pdf');
    if (!openModal || openModal.classList.contains('hide')) {
      document.body.classList.remove('pdf-printing');
    }
  });
}

async function clearAllData() {
  if (!(await appConfirm('Erase every bill, item and attachment? This cannot be undone.', {
    title: 'Erase all data?',
    confirmLabel: 'Erase everything',
    danger: true
  }))) return;
  await dbClearEverything();
  projects = [];
  items = [];
  expandedProjectIds = new Set();
  state.participants = [state.userName];
  await saveMeta();
  updateAllViews();
  appToast('All data erased.', 'success');
}

async function importData(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;

  let text = '';
  try {
    text = await file.text();
  } catch (err) {
    alert('Could not read the file.');
    return;
  }
  input.value = '';

  const trimmed = text.trim();
  const looksJson = /\.json$/i.test(file.name) || trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[';
  if (!looksJson) {
    openImportModal(text);
    return;
  }

  let data = null;
  try { data = JSON.parse(text); } catch (err) { data = null; }
  if (!data) return alert('That file is not valid JSON.');
  if (!Array.isArray(data.projects) || !Array.isArray(data.items)) {
    return alert('That backup was made by an older version and is not supported. Send it over and it can be ported.');
  }

  if (!(await appConfirm('Replace everything with this backup? Current bills will be erased.', {
    title: 'Replace current data?',
    confirmLabel: 'Replace',
    danger: true
  }))) return;

  try {
    await dbClearEverything();
    projects = data.projects.slice();
    items = data.items.slice();

    if (data.meta) {
      if (data.meta.userName) state.userName = data.meta.userName;
      if (data.meta.currency) state.currency = data.meta.currency;
      if (Array.isArray(data.meta.participants) && data.meta.participants.length) {
        state.participants = data.meta.participants.slice();
      }
    }
    if (!state.participants.some(function (p) { return samePerson(p, state.userName); })) {
      state.participants.unshift(state.userName);
    }

    for (const project of projects) await dbPut(STORE_PROJECTS, project);
    for (const item of items) await dbPut(STORE_ITEMS, item);
    await saveMeta();

    expandedProjectIds = new Set();
    switchView('history');
    updateAllViews();
    appToast('Restored ' + projects.length + ' bill(s) and ' + items.length + ' item(s).', 'success');
  } catch (err) {
    alert('Restore failed: ' + err.message);
  }
}

/* ------------------------- AI bill importer ---------------------- */

function openImportModal(initialText) {
  const modal = $('modal-csv-import');
  if (!modal) return;

  importBills = [];
  importDefaultParticipants = state.participants.slice();

  const payer = $('modal-csv-payer');
  if (payer) {
    // Keep every participant in the list, but start with no payer selected.
    payer.innerHTML = payerOptionsHtml('');
    payer.value = '';
  }

  updateImportPayerState();

  const textarea = $('csv-paste-input');
  // Always start from a clean paste box. initialText is only used when a CSV
  // file was picked from Settings, which still wants its contents loaded.
  if (textarea) textarea.value = typeof initialText === 'string' ? initialText : '';

  const promptBox = $('prompt-preview-box');
  if (promptBox) promptBox.textContent = AI_BILL_PROMPT;
  const toggle = $('btn-toggle-prompt');
  if (toggle) toggle.textContent = 'Show';
  if (promptBox) promptBox.classList.add('hide');
  const fileInput = $('modal-csv-file');
  if (fileInput) fileInput.value = '';

  renderImportDefaultChips();
  modal.classList.remove('hide');
  parseImportText();
}

function closeImportModal() {
  const modal = $('modal-csv-import');
  if (modal) modal.classList.add('hide');
  importBills = [];
  importDefaultParticipants = [];
}

function importPayer() {
  const payerEl = $('modal-csv-payer');
  return payerEl ? payerEl.value : '';
}

function updateImportSubmitState() {
  const submit = $('btn-import-bill-submit');
  if (!submit) return;
  submit.disabled = !importBills.length || !importPayer();
}

function updateImportPayerState() {
  const payerEl = $('modal-csv-payer');
  const hint = $('import-payer-hint');
  const chosen = !!(payerEl && payerEl.value);

  if (payerEl) {
    payerEl.classList.toggle('payer-missing', !chosen);
  }

  if (hint) {
    hint.textContent = chosen
      ? 'Applies to every bill in this paste. Import separately if different people paid.'
      : 'Choose who paid before importing. This applies to every bill in this paste.';
    hint.className = 'text-[10px] mt-1 ' + (chosen ? 'text-gray-400' : 'text-amber-600 font-medium');
  }

  updateImportSubmitState();
}

function copyAIBillPrompt() {
  const copied = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(AI_BILL_PROMPT)
    : Promise.reject(new Error('clipboard unavailable'));

  copied.then(function () {
    const btn = $('btn-copy-prompt');
    if (!btn) return;
    const original = btn.innerHTML;
    btn.textContent = 'Copied!';
    setTimeout(function () { btn.innerHTML = original; }, 1600);
  }).catch(function () {
    alert('Could not copy. Select the prompt text in the box below.');
  });
}

function togglePromptPreview() {
  const box = $('prompt-preview-box');
  const btn = $('btn-toggle-prompt');
  if (!box) return;
  if (box.classList.contains('hide')) {
    box.classList.remove('hide');
    if (btn) btn.textContent = 'Hide';
  } else {
    box.classList.add('hide');
    if (btn) btn.textContent = 'Show';
  }
}

function handleModalCSVFileUpload(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    const textarea = $('csv-paste-input');
    if (textarea) textarea.value = e.target.result;
    input.value = '';
    parseImportText();
  };
  reader.readAsText(file);
}

function parseImportText() {
  const textarea = $('csv-paste-input');
  const parsed = parseBillCSV(textarea ? textarea.value : '');

  importBills = parsed.bills.map(function (bill) {
    return {
      name: (bill.name || '').trim() || ('Bill ' + bill.date),
      date: bill.date,
      items: bill.items.map(function (it) {
        const tokens = (it.splitWith || []).map(parseSplitToken).filter(Boolean);
        const names = [];
        tokens.forEach(function (token) {
          const name = canonicalParticipant(token.name);
          if (name && !names.some(function (existing) { return samePerson(existing, name); })) names.push(name);
        });

        const splitInputs = {};
        let splitMethod = 'equal';
        if (tokens.some(function (token) { return token.kind === 'percent'; })) {
          splitMethod = 'percent';
          tokens.forEach(function (token) {
            const name = canonicalParticipant(token.name);
            if (name) splitInputs[name] = token.kind === 'percent' && token.value !== null ? token.value : 0;
          });
        } else if (tokens.some(function (token) { return token.kind === 'weight'; })) {
          splitMethod = 'weighted';
          tokens.forEach(function (token) {
            const name = canonicalParticipant(token.name);
            if (name) splitInputs[name] = token.value === null ? 1 : token.value;
          });
        }

        if (!tokens.length && detectItemKind(it.description, it.category) !== 'item') {
          splitMethod = 'proportional';
        }

        return {
          description: it.description,
          category: it.category,
          amount: it.amount,
          peopleMode: names.length ? 'custom' : 'default',
          people: names,
          splitMethod: splitMethod,
          splitInputs: splitInputs,
          inputsTouched: Object.keys(splitInputs).length > 0
        };
      })
    };
  });

  renderImportPreview();
}

function effectiveImportPeople(item) {
  return item.peopleMode === 'default' ? importDefaultParticipants.slice() : item.people.slice();
}

function refreshImportInputs(item) {
  if (item.splitMethod === 'equal' || item.splitMethod === 'proportional') {
    item.splitInputs = {};
    item.inputsTouched = false;
    return;
  }

  const people = uniquePeople(effectiveImportPeople(item));
  if (!item.splitInputs) item.splitInputs = {};

  if (!item.inputsTouched) {
    item.splitInputs = seedSplitInputs(item.splitMethod, people, item.amount);
    return;
  }

  people.forEach(function (person) {
    if (item.splitInputs[person] === undefined) {
      item.splitInputs[person] = item.splitMethod === 'weighted' ? 1 : 0;
    }
  });
}

function updateImportBillName(index, value) {
  if (!importBills[index]) return;
  importBills[index].name = value;
}

function toggleImportPerson(billIndex, itemIndex, personIndex, checked) {
  const bill = importBills[billIndex];
  const item = bill && bill.items[itemIndex];
  const person = state.participants[personIndex];
  if (!item || !person) return;

  if (item.peopleMode === 'default') {
    item.people = importDefaultParticipants.slice();
    item.peopleMode = 'custom';
  }
  if (checked) {
    if (!item.people.some(function (p) { return samePerson(p, person); })) item.people.push(person);
  } else {
    item.people = item.people.filter(function (p) { return !samePerson(p, person); });
  }
  refreshImportInputs(item);
  renderImportPreview();
}

function setImportBillPeople(billIndex, on) {
  const bill = importBills[billIndex];
  if (!bill) return;
  bill.items.forEach(function (item) {
    item.peopleMode = 'custom';
    item.people = on ? state.participants.slice() : [];
    refreshImportInputs(item);
  });
  renderImportPreview();
}

function setImportSplitMode(billIndex, itemIndex, modeIndex) {
  const bill = importBills[billIndex];
  const item = bill && bill.items[itemIndex];
  if (!item) return;

  const method = splitModeName(modeIndex);
  if (item.splitMethod === method) return;

  item.splitMethod = method;
  item.inputsTouched = false;
  item.splitInputs = (method === 'equal' || method === 'proportional')
    ? {}
    : seedSplitInputs(method, effectiveImportPeople(item), item.amount);
  renderImportPreview();
}

function setImportSplitInput(billIndex, itemIndex, personIndex, value) {
  const bill = importBills[billIndex];
  const item = bill && bill.items[itemIndex];
  if (!item) return;

  const person = effectiveImportPeople(item)[personIndex];
  if (!person) return;

  item.splitInputs = item.splitInputs || {};
  item.splitInputs[person] = value === '' ? 0 : Number(value);
  item.inputsTouched = true;
  renderImportPreview();
}

function renderImportDefaultChips() {
  const box = $('import-default-people');
  if (!box) return;
  box.innerHTML = state.participants.map(function (person, idx) {
    const on = importDefaultParticipants.some(function (p) { return samePerson(p, person); });
    return '<label class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-medium cursor-pointer select-none ' +
      (on ? 'bg-indigo-50 border-indigo-200 text-indigo-800' : 'bg-white border-gray-200 text-gray-500') + '">' +
      '<input type="checkbox" ' + (on ? 'checked' : '') + ' onchange="toggleImportDefault(' + idx + ', this.checked)" class="w-3.5 h-3.5 text-indigo-600 rounded border-gray-300">' +
      '<span>' + esc(person === state.userName ? person + ' (You)' : person) + '</span></label>';
  }).join('');
}

function refreshDefaultPeopleInputs() {
  importBills.forEach(function (bill) {
    bill.items.forEach(function (item) {
      if (item.peopleMode === 'default') refreshImportInputs(item);
    });
  });
}

function toggleImportDefault(personIndex, checked) {
  const person = state.participants[personIndex];
  if (!person) return;
  if (checked) {
    if (!importDefaultParticipants.some(function (p) { return samePerson(p, person); })) {
      importDefaultParticipants.push(person);
    }
  } else {
    importDefaultParticipants = importDefaultParticipants.filter(function (p) { return !samePerson(p, person); });
  }
  refreshDefaultPeopleInputs();
  renderImportDefaultChips();
  renderImportPreview();
}

function setImportDefaultPeople(on) {
  importDefaultParticipants = on ? state.participants.slice() : [];
  refreshDefaultPeopleInputs();
  renderImportDefaultChips();
  renderImportPreview();
}

function sharesForImportItems(canonicalItems) {
  const results = canonicalItems.map(function (item) {
    if (item.splitMethod === 'proportional') return null;
    return computeShares(item.amount, item.splitMethod, item.people, item.splitInputs);
  });

  const base = [];
  canonicalItems.forEach(function (item, idx) {
    if (item.splitMethod === 'proportional') return;
    const result = results[idx];
    if (!result || result.error) return;
    base.push({ amount: item.amount, splits: Object.assign({}, result.splits) });
  });

  canonicalItems.forEach(function (item, idx) {
    if (item.splitMethod !== 'proportional') return;
    results[idx] = { splits: proportionalSplitsForAmount(base, item.amount), error: null };
  });

  return results;
}

function canonicalImportItems(bill, known) {
  return bill.items.map(function (source) {
    const people = effectiveImportPeople(source).map(function (raw) {
      const key = String(raw).toLowerCase();
      return known ? (known.get(key) || String(raw)) : String(raw);
    });

    const inputs = {};
    Object.keys(source.splitInputs || {}).forEach(function (key) {
      const mapped = known ? (known.get(String(key).toLowerCase()) || String(key)) : String(key);
      inputs[mapped] = source.splitInputs[key];
    });

    return {
      description: source.description,
      category: source.category,
      amount: source.amount,
      splitMethod: source.splitMethod,
      splitInputs: inputs,
      people: people
    };
  });
}

function importModeButtons(billIndex, itemIndex, method) {
  return '<div class="flex bg-gray-100 rounded-md p-0.5 gap-0.5 mt-1.5 w-fit">' +
    SPLIT_MODE_NAMES.map(function (name, idx) {
      const on = name === method;
      return '<button type="button" onclick="setImportSplitMode(' + billIndex + ', ' + itemIndex + ', ' + idx + ')" ' +
        'class="px-1.5 py-0.5 rounded text-[9px] font-semibold ' +
        (on ? 'bg-white shadow text-indigo-700' : 'text-gray-500') + '">' + SPLIT_MODE_LABELS[idx] + '</button>';
    }).join('') + '</div>';
}

function renderImportPreview() {
  const container = $('modal-csv-preview-container');
  const totalsBox = $('import-person-totals');
  const totalLabel = $('modal-csv-total');
  if (!container) return;

  if (!importBills.length) {
    container.innerHTML = '<p class="text-xs text-gray-400 p-4 text-center">Paste the CSV (or upload the file) to preview items.</p>';
    if (totalsBox) totalsBox.innerHTML = '';
    if (totalLabel) totalLabel.textContent = 'Total: ' + money(0);
    updateImportSubmitState();
    return;
  }

  let itemCount = 0;
  let grandTotal = 0;
  const personTotals = {};
  let html = '';

  importBills.forEach(function (bill, billIndex) {
    const canonical = bill.items.map(function (item) {
      return {
        amount: item.amount,
        splitMethod: item.splitMethod,
        splitInputs: item.splitInputs || {},
        people: effectiveImportPeople(item),
        description: item.description,
        category: item.category
      };
    });
    const results = sharesForImportItems(canonical);

    html += '<div class="border border-gray-200 rounded-xl bg-white overflow-hidden mb-2">' +
      '<div class="p-2.5 bg-gray-50 border-b border-gray-200 space-y-1.5">' +
        '<div class="flex items-center justify-between gap-2">' +
          '<span class="text-[10px] font-bold uppercase tracking-wider text-gray-500">Bill name</span>' +
          '<div class="flex items-center gap-2 text-[10px] whitespace-nowrap">' +
            '<span class="text-gray-400">' + esc(bill.date) + '</span>' +
            '<div class="flex gap-1">' +
              '<button type="button" onclick="setImportBillPeople(' + billIndex + ', true)" class="text-indigo-600 font-semibold hover:underline">All</button>' +
              '<span class="text-gray-300">|</span>' +
              '<button type="button" onclick="setImportBillPeople(' + billIndex + ', false)" class="text-indigo-600 font-semibold hover:underline">None</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="relative">' +
          '<input value="' + esc(bill.name) + '" oninput="updateImportBillName(' + billIndex + ', this.value)" placeholder="Bill name" aria-label="Bill name" title="Edit bill name" ' +
            'class="w-full bg-white border border-gray-300 rounded-lg pl-2.5 pr-8 py-1.5 text-sm font-bold text-gray-800 outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500">' +
          '<span class="absolute inset-y-0 right-2 flex items-center pointer-events-none text-gray-400">' + svgIcon(ICON.pencil, 'w-4 h-4') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="divide-y divide-gray-100">';

    bill.items.forEach(function (item, itemIndex) {
      const people = canonical[itemIndex].people;
      const result = results[itemIndex];
      const splits = result.splits || {};
      const isValid = !result.error;
      const kind = detectItemKind(item.description, item.category);
      const kindTag = kind === 'tax'
        ? '<span class="ml-1 bg-amber-50 text-amber-700 border border-amber-200 px-1 py-0.5 rounded text-[9px] font-bold uppercase">Tax</span>'
        : (kind === 'discount'
          ? '<span class="ml-1 bg-emerald-50 text-emerald-700 border border-emerald-200 px-1 py-0.5 rounded text-[9px] font-bold uppercase">Discount</span>'
          : '');

      itemCount += 1;
      grandTotal += item.amount;
      if (isValid) {
        Object.keys(splits).forEach(function (person) {
          personTotals[person] = (personTotals[person] || 0) + (Number(splits[person]) || 0);
        });
      }

      const shareFor = function (person) {
        return isValid ? (Number(splits[person]) || 0) : 0;
      };

      let chips = '';
      if (item.splitMethod === 'proportional') {
        const names = Object.keys(splits);
        chips = names.length
          ? names.map(function (person) {
              return '<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border bg-indigo-50 border-indigo-200 text-[10px] text-indigo-800">' +
                esc(person === state.userName ? 'You' : person) + ' <b>' + money(shareFor(person)) + '</b></span>';
            }).join('')
          : '<span class="text-[10px] text-gray-400">No normal items yet - this will split equally.</span>';
      } else {
        chips = state.participants.map(function (person, personIndex) {
          const on = people.some(function (p) { return samePerson(p, person); });
          return '<label class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-medium cursor-pointer select-none ' +
            (on ? 'bg-indigo-50 border-indigo-200 text-indigo-800' : 'bg-white border-gray-200 text-gray-400') + '">' +
            '<input type="checkbox" ' + (on ? 'checked' : '') +
              ' onchange="toggleImportPerson(' + billIndex + ', ' + itemIndex + ', ' + personIndex + ', this.checked)" ' +
              'class="w-3 h-3 text-indigo-600 rounded border-gray-300">' +
            '<span>' + esc(person === state.userName ? 'You' : person) + '</span>' +
            (on ? '<b>' + money(shareFor(person)) + '</b>' : '') +
          '</label>';
        }).join('');
      }

      let inputRows = '';
      if (item.splitMethod === 'weighted' || item.splitMethod === 'percent' || item.splitMethod === 'custom') {
        const unit = item.splitMethod === 'percent' ? '%' : (item.splitMethod === 'custom' ? state.currency : '×');
        inputRows = people.map(function (person, personIndex) {
          const raw = item.splitInputs ? item.splitInputs[person] : undefined;
          const fallback = item.splitMethod === 'weighted' ? 1 : 0;
          const value = raw === undefined || raw === '' ? fallback : round2(raw);
          return '<div class="flex items-center gap-1.5 mt-1">' +
            '<span class="text-[10px] text-gray-600 flex-1 min-w-0 truncate">' + esc(person === state.userName ? 'You' : person) + '</span>' +
            '<input type="number" step="0.01" inputmode="decimal" value="' + value + '" ' +
              'onchange="setImportSplitInput(' + billIndex + ', ' + itemIndex + ', ' + personIndex + ', this.value)" ' +
              'class="w-16 border border-gray-300 rounded px-1 py-0.5 text-[10px] text-right outline-none focus:border-indigo-400">' +
            '<span class="text-[9px] text-gray-400 w-3">' + unit + '</span>' +
            '<span class="text-[9px] font-semibold text-indigo-600 w-14 text-right">' + (isValid ? money(shareFor(person)) : '-') + '</span>' +
          '</div>';
        }).join('');
      }

      const extraPeople = (item.splitMethod === 'proportional' ? Object.keys(splits) : people)
        .filter(function (person) {
          return !state.participants.some(function (p) { return samePerson(p, person); });
        });

      const modeNote = item.splitMethod === 'proportional'
        ? '<p class="text-[9px] text-indigo-700 bg-indigo-50/70 rounded px-1.5 py-1 mt-1">Bill ratio: each person pays the same proportion as their share of the other items. Switch mode to override.</p>'
        : '';

      html += '<div class="p-2.5">' +
        '<div class="flex items-start justify-between gap-2">' +
          '<div class="min-w-0">' +
            '<p class="text-sm font-semibold text-gray-800 break-words">' + esc(item.description) + kindTag + '</p>' +
            '<p class="text-[10px] text-gray-500">' + esc(item.category) + '</p>' +
          '</div>' +
          '<p class="font-mono text-sm font-bold text-indigo-600 whitespace-nowrap">' + money(item.amount) + '</p>' +
        '</div>' +
        importModeButtons(billIndex, itemIndex, item.splitMethod) +
        '<div class="flex flex-wrap gap-1 mt-1.5">' + chips + '</div>' +
        inputRows +
        modeNote +
        (result.error ? '<p class="text-[10px] text-red-500 mt-1">' + esc(result.error) + '</p>' : '') +
        (extraPeople.length
          ? '<p class="text-[10px] text-amber-600 mt-1">Will add new participant(s): ' + extraPeople.map(esc).join(', ') + '</p>'
          : '') +
        (item.splitMethod !== 'proportional' && !people.length
          ? '<p class="text-[10px] text-red-500 mt-1">Nobody selected - this item cannot import.</p>'
          : '') +
      '</div>';
    });

    html += '</div></div>';
  });

  container.innerHTML = html;
  if (totalLabel) totalLabel.textContent = 'Total: ' + money(grandTotal) + ' (' + itemCount + ' items)';
  if (totalsBox) {
    const entries = Object.keys(personTotals).filter(function (person) {
      return state.participants.some(function (p) { return samePerson(p, person); });
    });
    totalsBox.innerHTML = entries.length
      ? entries.map(function (person) {
          return '<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white border border-gray-200 text-[10px] text-gray-600">' +
            esc(person === state.userName ? 'You' : person) +
            ' <b class="text-gray-800">' + money(personTotals[person]) + '</b></span>';
        }).join('')
      : '<span class="text-[10px] text-gray-400">No shares yet.</span>';
  }
  updateImportSubmitState();
}

async function executeImport() {
  const payerEl = $('modal-csv-payer');
  const payer = payerEl ? payerEl.value : '';
  if (!payer) {
    if (payerEl) payerEl.focus();
    updateImportPayerState();
    return alert('Choose who paid before importing.');
  }
  if (!importBills.length) return alert('Nothing to import yet.');

  for (let billIndex = 0; billIndex < importBills.length; billIndex += 1) {
    const bill = importBills[billIndex];
    if (!String(bill.name || '').trim()) return alert('Bill ' + (billIndex + 1) + ' needs a name.');
    for (const item of bill.items) {
      if (item.splitMethod !== 'proportional' && !effectiveImportPeople(item).length) {
        return alert('Pick at least one person for "' + item.description + '".');
      }
    }
  }

  try {
    const known = new Map();
    state.participants.forEach(function (p) { known.set(p.toLowerCase(), p); });
    const additions = [];
    importBills.forEach(function (bill) {
      bill.items.forEach(function (item) {
        const names = item.splitMethod === 'proportional'
          ? state.participants.slice()
          : effectiveImportPeople(item);
        names.forEach(function (raw) {
          const name = String(raw).trim();
          if (!name) return;
          const key = name.toLowerCase();
          if (!known.has(key)) {
            known.set(key, name);
            additions.push(name);
          }
        });
      });
    });
    additions.forEach(function (name) {
      if (!state.participants.some(function (p) { return samePerson(p, name); })) {
        state.participants.push(name);
      }
    });
    if (additions.length) await saveMeta();

    const newProjectIds = [];
    let imported = 0;

    const prepared = importBills.map(function (bill) {
      const canonical = canonicalImportItems(bill, known);
      return { bill: bill, canonical: canonical, results: sharesForImportItems(canonical) };
    });

    for (const entry of prepared) {
      for (let i = 0; i < entry.canonical.length; i += 1) {
        if (entry.results[i].error) {
          return alert('"' + entry.canonical[i].description + '": ' + entry.results[i].error);
        }
      }
    }

    for (const entry of prepared) {
      const bill = entry.bill;
      const canonical = entry.canonical;
      const results = entry.results;

      const projectId = uid();
      const categories = Array.from(new Set(canonical.map(function (it) { return it.category; }).filter(Boolean)));
      if (!categories.length) categories.push('Uncategorised');

      const project = {
        id: projectId,
        name: String(bill.name).trim(),
        date: isoFromDateOnly(bill.date),
        payer: payer,
        categories: categories,
        attachments: [],
        createdAt: Date.now()
      };
      await dbPut(STORE_PROJECTS, project);
      projects.push(project);
      newProjectIds.push(projectId);

      for (let i = 0; i < canonical.length; i += 1) {
        const source = canonical[i];
        const item = {
          id: uid(),
          projectId: projectId,
          order: i,
          date: project.date,
          description: source.description,
          category: source.category,
          amount: source.amount,
          paidBy: payer,
          splitMethod: source.splitMethod,
          splitInputs: source.splitMethod === 'equal' || source.splitMethod === 'proportional' ? {} : source.splitInputs,
          splits: results[i].splits,
          settled: false,
          attachments: []
        };
        await dbPut(STORE_ITEMS, item);
        items.push(item);
        imported += 1;
      }
    }

    newProjectIds.forEach(function (id) { expandedProjectIds.add(id); });
    closeImportModal();
    switchView('history');
    updateAllViews();
    appToast('Imported ' + imported + ' item(s) across ' + newProjectIds.length + ' bill(s).', 'success');
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
}


function toggleTransparency() {
  const box = $('transparency-box');
  const btn = $('btn-transparency');
  if (!box) return;
  if (box.classList.contains('hide')) {
    box.classList.remove('hide');
    if (btn) btn.textContent = 'Hide Math';
  } else {
    box.classList.add('hide');
    if (btn) btn.textContent = 'Show Math';
  }
}

/* ----------------------------- boot ------------------------------ */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseCSVLine: parseCSVLine,
    parseBillCSV: parseBillCSV,
    parseAmount: parseAmount,
    splitNameList: splitNameList,
    equalSplits: equalSplits,
    computeShares: computeShares,
    parseSplitToken: parseSplitToken,
    detectItemKind: detectItemKind,
    proportionalSplitsForAmount: proportionalSplitsForAmount,
    distributePercent: distributePercent,
    distributeAmount: distributeAmount,
    toDateOnly: toDateOnly
  };
}

if (typeof document !== 'undefined') {
  bindPdfPreviewEvents();
}

if (typeof window !== 'undefined') {
  window.onload = init;
}

