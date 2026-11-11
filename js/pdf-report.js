/* ------------------------------------------------------------------
   SplitTrack - print-ready expense statement.

   Browser-only, dependency-free. The app owns the preview modal and the
   print button; this module only renders the document and its scoped CSS.

   Public API (window.SplitTrackPdfReport):
     renderInto(container, data)  -> injects report body + stylesheet once
     buildStandaloneHtml(data)    -> complete fallback HTML document

   data = {
     projects: [{ id, name, date, payer, categories, createdAt }],
     items: [{ id, projectId, order, date, description, category, amount,
               paidBy, splitMethod, splits: { person: amount }, settled,
               kind: 'item' | 'tax' | 'discount' }],
     participants: [names],
     userName,
     currency,
     generatedAt (ISO string, optional)
   }
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  var STYLE_ID = 'split-track-pdf-styles';
  var CSS_VERSION = '1';
  var TOLERANCE = 0.01;
  var DEFAULT_CURRENCY = '\u20B9';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* --------------------------- helpers --------------------------- */

  function text(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function cleanText(value) {
    return text(value).replace(/\s+/g, ' ').trim();
  }

  function toNumber(value) {
    var number = typeof value === 'number' ? value : Number(value);
    return isFinite(number) ? number : 0;
  }

  function round2(value) {
    return Math.round(toNumber(value) * 100) / 100;
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function escapeHtml(value) {
    return text(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function groupDigits(value) {
    var parts = String(value).split('.');
    var whole = parts[0];
    var grouped = '';
    while (whole.length > 3) {
      grouped = ',' + whole.slice(-3) + grouped;
      whole = whole.slice(0, -3);
    }
    return whole + grouped + (parts[1] ? '.' + parts[1] : '');
  }

  function currencyPrefix(currency) {
    var value = cleanText(currency) || DEFAULT_CURRENCY;
    if (/^[A-Za-z]{2,}$/.test(value)) return value + ' ';
    return value;
  }

  /* Returns an HTML-safe money string. The minus sign precedes the currency. */
  function formatMoney(value, currency, options) {
    var opts = options || {};
    var number = round2(value);
    var sign = number < 0 ? '-' : (opts.plus && number > 0 ? '+' : '');
    var amount = groupDigits(Math.abs(number).toFixed(2));
    return escapeHtml(sign + currencyPrefix(currency) + amount);
  }

  function validDateParts(year, month, day) {
    if (!isFinite(year) || !isFinite(month) || !isFinite(day)) return false;
    var check = new Date(year, month - 1, day);
    return check.getFullYear() === year &&
      check.getMonth() === month - 1 &&
      check.getDate() === day;
  }

  function dateParts(value) {
    if (value && typeof value === 'object' && typeof value.getFullYear === 'function') {
      var dateYear = value.getFullYear();
      var dateMonth = value.getMonth() + 1;
      var dateDay = value.getDate();
      return validDateParts(dateYear, dateMonth, dateDay)
        ? { year: dateYear, month: dateMonth, day: dateDay }
        : null;
    }
    var raw = text(value).trim();
    if (!raw) return null;
    var match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/);
    if (match) {
      var year = Number(match[1]);
      var month = Number(match[2]);
      var day = Number(match[3]);
      return validDateParts(year, month, day)
        ? { year: year, month: month, day: day }
        : null;
    }
    var parsed = new Date(raw);
    if (isNaN(parsed.getTime())) return null;
    return {
      year: parsed.getFullYear(),
      month: parsed.getMonth() + 1,
      day: parsed.getDate()
    };
  }

  function formatDate(value) {
    var parts = dateParts(value);
    if (!parts) return '&mdash;';
    return parts.day + ' ' + MONTHS[parts.month - 1] + ' ' + parts.year;
  }

  function dateKey(value) {
    var parts = dateParts(value);
    if (!parts) return '';
    return parts.year + '-' + pad2(parts.month) + '-' + pad2(parts.day);
  }

  function formatTimestamp(value) {
    var raw = text(value).trim();
    if (!raw) return formatDate(new Date());
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return formatDate(raw);
    var parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) {
      return parsed.getDate() + ' ' + MONTHS[parsed.getMonth()] + ' ' +
        parsed.getFullYear() + ', ' + pad2(parsed.getHours()) + ':' +
        pad2(parsed.getMinutes());
    }
    return dateParts(raw) ? formatDate(raw) : formatDate(new Date());
  }

  function normalizeMethod(value) {
    var method = cleanText(value).toLowerCase();
    if (method === 'weighted' || method === 'percent' ||
        method === 'custom' || method === 'proportional') {
      return method;
    }
    return 'equal';
  }

  function normalizeKind(value) {
    var kind = cleanText(value).toLowerCase();
    return kind === 'tax' || kind === 'discount' ? kind : 'item';
  }

  function splitMethodLabel(method) {
    if (method === 'weighted') return 'Weights';
    if (method === 'percent') return 'Percent';
    if (method === 'custom') return 'Custom';
    if (method === 'proportional') return 'Bill ratio';
    return 'Equal';
  }

  function plural(count, singular, many) {
    return count === 1 ? singular : (many || singular + 's');
  }

  function personHtml(name, userName) {
    if (name === userName) return '<span class="pdf-you">You</span>';
    return escapeHtml(name);
  }

  function personDetailedHtml(name, userName) {
    if (name === userName) {
      if (cleanText(userName) !== 'You') {
        return escapeHtml(name) + ' <span class="pdf-you">(You)</span>';
      }
      return '<span class="pdf-you">You</span>';
    }
    return escapeHtml(name);
  }

  function isAmountReasonLabel(label) {
    return label === 'Share mismatch' || label === 'Bill totals' || label === 'No splits';
  }

  function quotedNamesHtml(names) {
    return (names || []).map(function (name) {
      return '&ldquo;' + escapeHtml(name) + '&rdquo;';
    }).join(', ');
  }

  function icon(paths, className) {
    var list = Array.isArray(paths) ? paths : [paths];
    var body = '';
    list.forEach(function (path) {
      body += '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="' + path + '"></path>';
    });
    return '<svg class="' + (className || '') + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  var ICONS = {
    receipt: [
      'M6 3h12a1 1 0 0 1 1 1v16l-3-2-3 2-3-2-3 2V4a1 1 0 0 1 1-1z',
      'M9 8h6',
      'M9 12h6',
      'M9 16h3'
    ],
    wallet: [
      'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
      'M3 9h18',
      'M16 13h2'
    ],
    user: [
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
      'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
      'M22 21v-2a4 4 0 0 0-3-3.87',
      'M16 3.13a4 4 0 0 1 0 7.75'
    ],
    clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
    scale: [
      'M12 3v18',
      'M5 8h14',
      'M7 8l-4 8h8L7 8z',
      'M17 8l-4 8h8l-4-8z'
    ],
    check: ['M9 12l2 2 4-4', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'],
    warning: [
      'M12 9v4',
      'M12 17h.01',
      'M10.29 4.86L2.82 17.6A2 2 0 0 0 4.55 20h14.9a2 2 0 0 0 1.73-2.4L13.71 4.86a2 2 0 0 0-3.42 0z'
    ],
    split: ['M8 3v18', 'M16 3v18', 'M3 8h5', 'M16 16h5'],
    info: ['M12 16v-4', 'M12 8h.01', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z']
  };

  /* ---------------------------- CSS ------------------------------ */

  var REPORT_CSS = [
    '@page { size: A4; margin: 14mm 12mm 18mm; }',
    '',
    'body.pdf-standalone { margin: 0; padding: 28px 16px 40px; background: #eef2f7; }',
    'body.pdf-standalone .pdf-report { margin: 0 auto; }',
    '',
    '.pdf-report {',
    '  --pdf-ink: #0f172a;',
    '  --pdf-slate: #334155;',
    '  --pdf-muted: #64748b;',
    '  --pdf-faint: #94a3b8;',
    '  --pdf-line: #e2e8f0;',
    '  --pdf-line-strong: #cbd5e1;',
    '  --pdf-tint: #f8fafc;',
    '  --pdf-indigo: #4338ca;',
    '  --pdf-indigo-deep: #1e1b4b;',
    '  --pdf-indigo-soft: #eef2ff;',
    '  --pdf-emerald: #047857;',
    '  --pdf-emerald-soft: #ecfdf5;',
    '  --pdf-amber: #b45309;',
    '  --pdf-amber-soft: #fffbeb;',
    '  --pdf-red: #b91c1c;',
    '  --pdf-red-soft: #fef2f2;',
    '  box-sizing: border-box;',
    '  width: 100%;',
    '  max-width: 860px;',
    '  margin: 0 auto;',
    '  background: #ffffff;',
    '  color: var(--pdf-ink);',
    '  border: 1px solid var(--pdf-line);',
    '  border-radius: 18px;',
    '  box-shadow: 0 22px 55px rgba(15, 23, 42, 0.10), 0 2px 8px rgba(15, 23, 42, 0.04);',
    '  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;',
    '  font-size: 13px;',
    '  line-height: 1.45;',
    '  font-variant-numeric: tabular-nums lining-nums;',
    '  font-feature-settings: "tnum" 1, "lnum" 1;',
    '  -webkit-font-smoothing: antialiased;',
    '  text-rendering: optimizeLegibility;',
    '  -webkit-print-color-adjust: exact;',
    '  print-color-adjust: exact;',
    '}',
    '',
    '.pdf-report *, .pdf-report *::before, .pdf-report *::after {',
    '  box-sizing: border-box;',
    '  -webkit-print-color-adjust: exact;',
    '  print-color-adjust: exact;',
    '}',
    '',
    '.pdf-report h1, .pdf-report h2, .pdf-report h3, .pdf-report h4,',
    '.pdf-report p, .pdf-report ul, .pdf-report li, .pdf-report figure { margin: 0; }',
    '.pdf-report ul { padding: 0; list-style: none; }',
    '.pdf-report svg { display: block; }',
    '.pdf-report table { width: 100%; border-collapse: collapse; }',
    '.pdf-report th { text-align: left; }',
    '.pdf-report .pdf-num { text-align: right; font-variant-numeric: tabular-nums lining-nums; }',
    '.pdf-report .pdf-you { font-weight: 700; white-space: nowrap; }',
    '.pdf-report .pdf-muted { color: var(--pdf-muted); }',
    '.pdf-report .pdf-sr-only {',
    '  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;',
    '  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;',
    '}',
    '',
    '/* header band */',
    '.pdf-report .pdf-hero {',
    '  position: relative;',
    '  overflow: hidden;',
    '  padding: 26px 28px 24px;',
    '  color: #ffffff;',
    '  background-color: #312e81;',
    '  background-image:',
    '    radial-gradient(900px 300px at 88% -30%, rgba(129, 140, 248, 0.55), transparent 62%),',
    '    linear-gradient(135deg, #1e1b4b 0%, #312e81 58%, #3730a3 100%);',
    '  border-top: 4px solid #818cf8;',
    '  border-radius: 17px 17px 0 0;',
    '}',
    '.pdf-report .pdf-hero::after {',
    '  content: "";',
    '  position: absolute;',
    '  right: -54px;',
    '  bottom: -88px;',
    '  width: 210px;',
    '  height: 210px;',
    '  border-radius: 50%;',
    '  border: 1px solid rgba(199, 210, 254, 0.20);',
    '  box-shadow: 0 0 0 30px rgba(199, 210, 254, 0.06), 0 0 0 62px rgba(199, 210, 254, 0.035);',
    '  pointer-events: none;',
    '}',
    '.pdf-report .pdf-hero-top {',
    '  position: relative;',
    '  z-index: 1;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  gap: 14px;',
    '}',
    '.pdf-report .pdf-brand { display: flex; align-items: center; gap: 11px; min-width: 0; }',
    '.pdf-report .pdf-mark {',
    '  width: 42px;',
    '  height: 42px;',
    '  display: grid;',
    '  place-items: center;',
    '  flex: 0 0 auto;',
    '  color: #ffffff;',
    '  background: rgba(255, 255, 255, 0.12);',
    '  border: 1px solid rgba(255, 255, 255, 0.25);',
    '  border-radius: 13px;',
    '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15);',
    '}',
    '.pdf-report .pdf-mark svg { width: 23px; height: 23px; }',
    '.pdf-report .pdf-brand-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }',
    '.pdf-report .pdf-wordmark { font-size: 19px; line-height: 1.15; font-weight: 800; letter-spacing: -0.02em; }',
    '.pdf-report .pdf-tagline {',
    '  font-size: 8px;',
    '  line-height: 1.3;',
    '  font-weight: 700;',
    '  letter-spacing: 0.16em;',
    '  text-transform: uppercase;',
    '  color: #c7d2fe;',
    '}',
    '.pdf-report .pdf-statement-pill {',
    '  flex: 0 0 auto;',
    '  padding: 5px 10px;',
    '  border: 1px solid rgba(199, 210, 254, 0.30);',
    '  border-radius: 999px;',
    '  background: rgba(255, 255, 255, 0.08);',
    '  color: #e0e7ff;',
    '  font-size: 8px;',
    '  line-height: 1.2;',
    '  font-weight: 800;',
    '  letter-spacing: 0.13em;',
    '  text-transform: uppercase;',
    '  white-space: nowrap;',
    '}',
    '.pdf-report .pdf-hero-title { position: relative; z-index: 1; margin-top: 23px; }',
    '.pdf-report .pdf-hero-title h1 {',
    '  font-size: 36px;',
    '  line-height: 1.05;',
    '  font-weight: 800;',
    '  letter-spacing: -0.035em;',
    '}',
    '.pdf-report .pdf-hero-title p {',
    '  margin-top: 7px;',
    '  max-width: 540px;',
    '  color: #c7d2fe;',
    '  font-size: 12px;',
    '  line-height: 1.5;',
    '}',
    '.pdf-report .pdf-meta-grid {',
    '  position: relative;',
    '  z-index: 1;',
    '  display: grid;',
    '  grid-template-columns: repeat(4, minmax(0, 1fr));',
    '  gap: 18px;',
    '  margin-top: 23px;',
    '  padding-top: 17px;',
    '  border-top: 1px solid rgba(199, 210, 254, 0.20);',
    '}',
    '.pdf-report .pdf-meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }',
    '.pdf-report .pdf-meta-label {',
    '  color: #a5b4fc;',
    '  font-size: 8px;',
    '  line-height: 1.3;',
    '  font-weight: 800;',
    '  letter-spacing: 0.14em;',
    '  text-transform: uppercase;',
    '}',
    '.pdf-report .pdf-meta-value {',
    '  color: #f8fafc;',
    '  font-size: 11px;',
    '  line-height: 1.4;',
    '  font-weight: 600;',
    '  overflow-wrap: anywhere;',
    '}',
    '',
    '/* document body */',
    '.pdf-report .pdf-body { padding: 26px 28px 30px; }',
    '.pdf-report .pdf-section { margin-top: 26px; }',
    '.pdf-report .pdf-section-head {',
    '  display: flex;',
    '  align-items: flex-end;',
    '  justify-content: space-between;',
    '  gap: 16px;',
    '  margin-bottom: 14px;',
    '  padding-bottom: 9px;',
    '  border-bottom: 1px solid var(--pdf-line);',
    '}',
    '.pdf-report .pdf-eyebrow {',
    '  display: block;',
    '  margin-bottom: 3px;',
    '  color: var(--pdf-indigo);',
    '  font-size: 8px;',
    '  line-height: 1.3;',
    '  font-weight: 800;',
    '  letter-spacing: 0.17em;',
    '  text-transform: uppercase;',
    '}',
    '.pdf-report .pdf-section-head h2 {',
    '  color: var(--pdf-ink);',
    '  font-size: 18px;',
    '  line-height: 1.15;',
    '  font-weight: 800;',
    '  letter-spacing: -0.025em;',
    '}',
    '.pdf-report .pdf-section-note {',
    '  max-width: 48%;',
    '  color: var(--pdf-muted);',
    '  font-size: 9.5px;',
    '  line-height: 1.45;',
    '  text-align: right;',
    '}',
    '',
    '/* summary */',
    '.pdf-report .pdf-summary-grid {',
    '  display: grid;',
    '  grid-template-columns: repeat(4, minmax(0, 1fr));',
    '  gap: 11px;',
    '}',
    '.pdf-report .pdf-card {',
    '  min-width: 0;',
    '  padding: 14px 15px 13px;',
    '  border: 1px solid var(--pdf-line);',
    '  border-radius: 13px;',
    '  background: #ffffff;',
    '}',
    '.pdf-report .pdf-card-top {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  gap: 8px;',
    '  margin-bottom: 9px;',
    '}',
    '.pdf-report .pdf-card-label {',
    '  color: var(--pdf-muted);',
    '  font-size: 8.5px;',
    '  line-height: 1.3;',
    '  font-weight: 800;',
    '  letter-spacing: 0.10em;',
    '  text-transform: uppercase;',
    '}',
    '.pdf-report .pdf-card-icon {',
    '  width: 25px;',
    '  height: 25px;',
    '  display: grid;',
    '  place-items: center;',
    '  flex: 0 0 auto;',
    '  border: 1px solid currentColor;',
    '  border-radius: 8px;',
    '  background: rgba(255, 255, 255, 0.7);',
    '  opacity: 0.85;',
    '}',
    '.pdf-report .pdf-card-icon svg { width: 14px; height: 14px; }',
    '.pdf-report .pdf-card-value {',
    '  color: var(--pdf-ink);',
    '  font-size: clamp(17px, 2.55vw, 23px);',
    '  line-height: 1.15;',
    '  font-weight: 800;',
    '  letter-spacing: -0.035em;',
    '  overflow-wrap: anywhere;',
    '}',
    '.pdf-report .pdf-card-sub {',
    '  margin-top: 4px;',
    '  color: var(--pdf-muted);',
    '  font-size: 8.5px;',
    '  line-height: 1.4;',
    '}',
    '.pdf-report .pdf-card-total { background: #eef2ff; border-color: #dfe5ff; }',
    '.pdf-report .pdf-card-total .pdf-card-label,',
    '.pdf-report .pdf-card-total .pdf-card-icon { color: #4338ca; }',
    '.pdf-report .pdf-card-total .pdf-card-value { color: #1e1b4b; }',
    '.pdf-report .pdf-card-share { background: #ecfdf5; border-color: #d1fae5; }',
    '.pdf-report .pdf-card-share .pdf-card-label,',
    '.pdf-report .pdf-card-share .pdf-card-icon { color: #047857; }',
    '.pdf-report .pdf-card-share .pdf-card-value { color: #064e3b; }',
    '.pdf-report .pdf-card-open { background: #fffbeb; border-color: #fde68a; }',
    '.pdf-report .pdf-card-open .pdf-card-label,',
    '.pdf-report .pdf-card-open .pdf-card-icon { color: #b45309; }',
    '.pdf-report .pdf-card-open .pdf-card-value { color: #78350f; }',
    '.pdf-report .pdf-card-net { background: #ffffff; border-color: #dfe5f1; }',
    '.pdf-report .pdf-card-net .pdf-card-label,',
    '.pdf-report .pdf-card-net .pdf-card-icon { color: #475569; }',
    '.pdf-report .pdf-card-value.is-positive { color: var(--pdf-emerald); }',
    '.pdf-report .pdf-card-value.is-negative { color: var(--pdf-red); }',
    '.pdf-report .pdf-facts {',
    '  display: flex;',
    '  align-items: center;',
    '  flex-wrap: wrap;',
    '  gap: 5px 9px;',
    '  margin-top: 11px;',
    '  padding: 9px 12px;',
    '  border: 1px solid var(--pdf-line);',
    '  border-radius: 9px;',
    '  background: var(--pdf-tint);',
    '  color: var(--pdf-muted);',
    '  font-size: 9.5px;',
    '  line-height: 1.45;',
    '}',
    '.pdf-report .pdf-fact strong { color: var(--pdf-slate); font-weight: 800; }',
    '.pdf-report .pdf-dot { color: #cbd5e1; }',
    '',
    '/* balances */',
    '.pdf-report .pdf-panel {',
    '  border: 1px solid var(--pdf-line);',
    '  border-radius: 13px;',
    '  background: #ffffff;',
    '}',
    '.pdf-report .pdf-panel-head {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  gap: 10px;',
    '  padding: 11px 15px;',
    '  border-bottom: 1px solid var(--pdf-line);',
    '  border-radius: 12px 12px 0 0;',
    '  background: var(--pdf-tint);',
    '}',
    '.pdf-report .pdf-panel-title { color: var(--pdf-slate); font-size: 11px; font-weight: 800; }',
    '.pdf-report .pdf-mini-chip {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  padding: 3px 7px;',
    '  border: 1px solid var(--pdf-line);',
    '  border-radius: 999px;',
    '  background: #ffffff;',
    '  color: var(--pdf-muted);',
    '  font-size: 7.5px;',
    '  line-height: 1.2;',
    '  font-weight: 800;',
    '  letter-spacing: 0.08em;',
    '  text-transform: uppercase;',
    '  white-space: nowrap;',
    '}',
    '.pdf-report .pdf-balance-table { font-size: 10.5px; }',
    '.pdf-report .pdf-balance-table th {',
    '  padding: 8px 15px;',
    '  background: #ffffff;',
    '  border-bottom: 1px solid var(--pdf-line);',
    '  color: var(--pdf-faint);',
    '  font-size: 8px;',
    '  line-height: 1.3;',
    '  font-weight: 800;',
    '  letter-spacing: 0.10em;',
    '  text-transform: uppercase;',
    '}',
    '.pdf-report .pdf-balance-table td {',
    '  padding: 9px 15px;',
    '  border-bottom: 1px solid #f1f5f9;',
    '  vertical-align: middle;',
    '}',
    '.pdf-report .pdf-balance-table tbody tr:last-child td { border-bottom: 0; }',
    '.pdf-report .pdf-balance-person { color: var(--pdf-slate); font-weight: 600; overflow-wrap: anywhere; }',
    '.pdf-report .pdf-money-cell { white-space: nowrap; color: var(--pdf-slate); }',
    '.pdf-report .pdf-money-cell.is-positive, .pdf-report .pdf-num.is-positive { color: var(--pdf-emerald); font-weight: 700; }',
    '.pdf-report .pdf-money-cell.is-negative, .pdf-report .pdf-num.is-negative { color: var(--pdf-red); font-weight: 700; }',
    '.pdf-report .pdf-balance-table tfoot { display: table-row-group; }',
    '.pdf-report .pdf-total-row td {',
    '  padding: 8px 15px;',
    '  border-top: 1px solid var(--pdf-line-strong);',
    '  border-bottom: 0;',
    '  background: var(--pdf-tint);',
    '  color: var(--pdf-slate);',
    '  font-weight: 800;',
    '  font-size: 9.5px;',
    '}',
    '.pdf-report .pdf-total-row .pdf-balance-person { text-transform: uppercase; letter-spacing: 0.08em; font-size: 8px; }',
    '.pdf-report .pdf-note {',
    '  display: flex;',
    '  gap: 6px;',
    '  margin: 10px 15px 0;',
    '  color: var(--pdf-muted);',
    '  font-size: 9px;',
    '  line-height: 1.5;',
    '}',
    '.pdf-report .pdf-note svg { width: 13px; height: 13px; flex: 0 0 auto; margin-top: 1px; color: var(--pdf-faint); }',
    '.pdf-report .pdf-warning-note {',
    '  display: flex;',
    '  gap: 6px;',
    '  margin: 9px 15px 0;',
    '  padding: 7px 9px;',
    '  border: 1px solid #fde68a;',
    '  border-radius: 7px;',
    '  background: var(--pdf-amber-soft);',
    '  color: #92400e;',
    '  font-size: 8.8px;',
    '  line-height: 1.45;',
    '}',
    '.pdf-report .pdf-warning-note svg { width: 13px; height: 13px; flex: 0 0 auto; margin-top: 1px; }',
    '.pdf-report .pdf-rounding-note {',
    '  display: flex;',
    '  gap: 6px;',
    '  margin: 9px 15px 0;',
    '  padding: 7px 9px;',
    '  border: 1px solid #c7d2fe;',
    '  border-radius: 7px;',
    '  background: #eef2ff;',
    '  color: #3730a3;',
    '  font-size: 8.8px;',
    '  line-height: 1.45;',
    '}',
    '.pdf-report .pdf-rounding-note svg { width: 13px; height: 13px; flex: 0 0 auto; margin-top: 1px; color: #4f46e5; }',
    '.pdf-report .pdf-rounding-note strong { color: #312e81; }',
    '.pdf-report .pdf-settle .pdf-rounding-note { margin-left: 0; margin-right: 0; }',
    '.pdf-report .pdf-settle {',
    '  margin-top: 13px;',
    '  padding: 13px 15px 15px;',
    '  border-top: 1px solid var(--pdf-line);',
    '  border-radius: 0 0 12px 12px;',
    '  background: #fcfdff;',
    '}',
    '.pdf-report .pdf-settle-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }',
    '.pdf-report .pdf-settle-head h3 { color: var(--pdf-slate); font-size: 11px; font-weight: 800; }',
    '.pdf-report .pdf-method-tag {',
    '  padding: 2px 6px;',
    '  border: 1px solid #e0e7ff;',
    '  border-radius: 5px;',
    '  background: var(--pdf-indigo-soft);',
    '  color: var(--pdf-indigo);',
    '  font-size: 7px;',
    '  line-height: 1.3;',
    '  font-weight: 800;',
    '  letter-spacing: 0.07em;',
    '  text-transform: uppercase;',
    '  white-space: nowrap;',
    '}',
    '.pdf-report .pdf-settle-list { border: 1px solid var(--pdf-line); border-radius: 9px; background: #ffffff; }',
    '.pdf-report .pdf-settle-row {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  gap: 10px;',
    '  padding: 8px 11px;',
    '  border-bottom: 1px solid #f1f5f9;',
    '  font-size: 10px;',
    '}',
    '.pdf-report .pdf-settle-row:last-child { border-bottom: 0; }',
    '.pdf-report .pdf-settle-text { color: var(--pdf-slate); line-height: 1.45; }',
    '.pdf-report .pdf-settle-verb { color: var(--pdf-muted); margin: 0 1px; }',
    '.pdf-report .pdf-settle-amount { color: var(--pdf-indigo-deep); font-weight: 800; white-space: nowrap; }',
    '.pdf-report .pdf-settled-up {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 9px;',
    '  padding: 10px 11px;',
    '  border: 1px solid #a7f3d0;',
    '  border-radius: 9px;',
    '  background: var(--pdf-emerald-soft);',
    '  color: #065f46;',
    '}',
    '.pdf-report .pdf-settled-up svg { width: 19px; height: 19px; flex: 0 0 auto; color: var(--pdf-emerald); }',
    '.pdf-report .pdf-settled-up strong { display: block; font-size: 10.5px; line-height: 1.4; }',
    '.pdf-report .pdf-settled-up span { display: block; color: #047857; font-size: 9px; line-height: 1.4; }',
    '.pdf-report .pdf-settled-up.is-warn { border-color: #fde68a; background: var(--pdf-amber-soft); color: #92400e; }',
    '.pdf-report .pdf-settled-up.is-warn svg { color: var(--pdf-amber); }',
    '.pdf-report .pdf-settled-up.is-warn span { color: #92400e; }',
    '',
    '/* bills */',
    '.pdf-report .pdf-bill-list { display: flex; flex-direction: column; gap: 14px; }',
    '.pdf-report .pdf-bill { border: 1px solid var(--pdf-line); border-radius: 13px; background: #ffffff; }',
    '.pdf-report .pdf-bill-head {',
    '  display: flex;',
    '  align-items: flex-start;',
    '  justify-content: space-between;',
    '  gap: 16px;',
    '  padding: 13px 15px 12px;',
    '  border-bottom: 1px solid var(--pdf-line);',
    '  border-radius: 12px 12px 0 0;',
    '  background: var(--pdf-tint);',
    '}',
    '.pdf-report .pdf-bill-main { min-width: 0; flex: 1 1 auto; }',
    '.pdf-report .pdf-bill-kicker {',
    '  display: flex;',
    '  align-items: center;',
    '  flex-wrap: wrap;',
    '  gap: 5px;',
    '  color: #6366f1;',
    '  font-size: 8px;',
    '  line-height: 1.3;',
    '  font-weight: 800;',
    '  letter-spacing: 0.12em;',
    '  text-transform: uppercase;',
    '}',
    '.pdf-report .pdf-bill-name {',
    '  margin: 3px 0 5px;',
    '  color: var(--pdf-ink);',
    '  font-size: 16px;',
    '  line-height: 1.25;',
    '  font-weight: 800;',
    '  letter-spacing: -0.02em;',
    '  overflow-wrap: anywhere;',
    '}',
    '.pdf-report .pdf-bill-meta {',
    '  display: flex;',
    '  align-items: center;',
    '  flex-wrap: wrap;',
    '  gap: 4px 7px;',
    '  color: var(--pdf-muted);',
    '  font-size: 9px;',
    '  line-height: 1.45;',
    '}',
    '.pdf-report .pdf-bill-meta strong { color: var(--pdf-slate); font-weight: 700; }',
    '.pdf-report .pdf-bill-meta-dot { color: #cbd5e1; }',
    '.pdf-report .pdf-bill-date { color: var(--pdf-muted); font-weight: 700; letter-spacing: 0; text-transform: none; }',
    '.pdf-report .pdf-bill-side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: 0 0 auto; text-align: right; }',
    '.pdf-report .pdf-status {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  padding: 3px 8px;',
    '  border: 1px solid transparent;',
    '  border-radius: 999px;',
    '  font-size: 7.5px;',
    '  line-height: 1.25;',
    '  font-weight: 800;',
    '  letter-spacing: 0.07em;',
    '  text-transform: uppercase;',
    '  white-space: nowrap;',
    '}',
    '.pdf-report .pdf-status.is-settled { background: var(--pdf-emerald-soft); border-color: #a7f3d0; color: var(--pdf-emerald); }',
    '.pdf-report .pdf-status.is-partly { background: var(--pdf-amber-soft); border-color: #fde68a; color: var(--pdf-amber); }',
    '.pdf-report .pdf-status.is-open { background: var(--pdf-indigo-soft); border-color: #c7d2fe; color: var(--pdf-indigo); }',
    '.pdf-report .pdf-bill-total { color: #312e81; font-size: 19px; line-height: 1.1; font-weight: 800; letter-spacing: -0.03em; white-space: nowrap; }',
    '.pdf-report .pdf-bill-total-label { color: var(--pdf-faint); font-size: 7px; line-height: 1.2; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }',
    '.pdf-report .pdf-items { table-layout: fixed; }',
    '.pdf-report .pdf-items th {',
    '  padding: 8px 15px;',
    '  border-bottom: 1px solid var(--pdf-line);',
    '  background: #ffffff;',
    '  color: var(--pdf-faint);',
    '  font-size: 7.5px;',
    '  line-height: 1.3;',
    '  font-weight: 800;',
    '  letter-spacing: 0.10em;',
    '  text-transform: uppercase;',
    '}',
    '.pdf-report .pdf-items th:first-child { width: 74%; }',
    '.pdf-report .pdf-items th:last-child { width: 26%; }',
    '.pdf-report .pdf-th-bill {',
    '  display: block;',
    '  color: var(--pdf-slate);',
    '  font-size: 8px;',
    '  line-height: 1.2;',
    '  font-weight: 800;',
    '  letter-spacing: 0.03em;',
    '  text-transform: none;',
    '  margin-bottom: 2px;',
    '}',
    '.pdf-report .pdf-items td {',
    '  padding: 10px 15px 11px;',
    '  border-bottom: 1px solid #f1f5f9;',
    '  vertical-align: top;',
    '}',
    '.pdf-report .pdf-items tbody tr:last-child td { border-bottom: 0; }',
    '.pdf-report .pdf-item-title {',
    '  display: flex;',
    '  align-items: center;',
    '  flex-wrap: wrap;',
    '  gap: 5px 7px;',
    '  color: var(--pdf-ink);',
    '  font-size: 11.5px;',
    '  line-height: 1.35;',
    '  font-weight: 700;',
    '  overflow-wrap: anywhere;',
    '}',
    '.pdf-report .pdf-item-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 5px; margin-top: 4px; }',
    '.pdf-report .pdf-cat {',
    '  display: inline-flex;',
    '  padding: 2px 6px;',
    '  border: 1px solid var(--pdf-line);',
    '  border-radius: 5px;',
    '  background: #f1f5f9;',
    '  color: #475569;',
    '  font-size: 8px;',
    '  line-height: 1.3;',
    '  font-weight: 600;',
    '}',
    '.pdf-report .pdf-method {',
    '  display: inline-flex;',
    '  padding: 2px 5px;',
    '  border: 1px solid #e0e7ff;',
    '  border-radius: 5px;',
    '  background: var(--pdf-indigo-soft);',
    '  color: var(--pdf-indigo);',
    '  font-size: 7px;',
    '  line-height: 1.3;',
    '  font-weight: 800;',
    '  letter-spacing: 0.06em;',
    '  text-transform: uppercase;',
    '  white-space: nowrap;',
    '}',
    '.pdf-report .pdf-chip {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  padding: 2px 6px;',
    '  border: 1px solid transparent;',
    '  border-radius: 999px;',
    '  font-size: 7.5px;',
    '  line-height: 1.3;',
    '  font-weight: 700;',
    '  white-space: nowrap;',
    '}',
    '.pdf-report .pdf-chip.is-settled { background: var(--pdf-emerald-soft); border-color: #a7f3d0; color: var(--pdf-emerald); }',
    '.pdf-report .pdf-chip.is-open { background: #f1f5f9; border-color: var(--pdf-line); color: var(--pdf-muted); }',
    '.pdf-report .pdf-chip.is-warning { background: var(--pdf-amber-soft); border-color: #fde68a; color: #92400e; }',
    '.pdf-report .pdf-kind {',
    '  display: inline-flex;',
    '  padding: 2px 6px;',
    '  border: 1px solid transparent;',
    '  border-radius: 5px;',
    '  font-size: 7px;',
    '  line-height: 1.3;',
    '  font-weight: 800;',
    '  letter-spacing: 0.06em;',
    '  text-transform: uppercase;',
    '  white-space: nowrap;',
    '}',
    '.pdf-report .pdf-kind.is-tax { background: var(--pdf-amber-soft); border-color: #fde68a; color: #92400e; }',
    '.pdf-report .pdf-kind.is-discount { background: var(--pdf-emerald-soft); border-color: #a7f3d0; color: var(--pdf-emerald); }',
    '.pdf-report .pdf-shares { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }',
    '.pdf-report .pdf-share {',
    '  display: inline-flex;',
    '  align-items: baseline;',
    '  gap: 4px;',
    '  max-width: 100%;',
    '  padding: 2px 7px;',
    '  border: 1px solid #e0e7ff;',
    '  border-radius: 999px;',
    '  background: var(--pdf-indigo-soft);',
    '  color: #3730a3;',
    '  font-size: 8.3px;',
    '  line-height: 1.35;',
    '  white-space: nowrap;',
    '}',
    '.pdf-report .pdf-share-name { font-weight: 600; }',
    '.pdf-report .pdf-share-amt { color: #312e81; font-weight: 800; }',
    '.pdf-report .pdf-share.is-you { background: #e0e7ff; border-color: #c7d2fe; }',
    '.pdf-report .pdf-share.is-negative { background: var(--pdf-emerald-soft); border-color: #a7f3d0; color: #065f46; }',
    '.pdf-report .pdf-share.is-negative .pdf-share-amt { color: var(--pdf-emerald); }',
    '.pdf-report .pdf-share.is-unknown { background: var(--pdf-amber-soft); border-color: #fde68a; color: #92400e; }',
    '.pdf-report .pdf-share.is-unknown .pdf-share-amt { color: #92400e; }',
    '.pdf-report .pdf-no-shares {',
    '  display: inline-flex;',
    '  padding: 2px 6px;',
    '  border: 1px solid #fde68a;',
    '  border-radius: 5px;',
    '  background: var(--pdf-amber-soft);',
    '  color: #92400e;',
    '  font-size: 8px;',
    '  line-height: 1.35;',
    '}',
    '.pdf-report .pdf-item-amount {',
    '  color: var(--pdf-ink);',
    '  font-size: 11.5px;',
    '  line-height: 1.35;',
    '  font-weight: 800;',
    '  text-align: right;',
    '  white-space: nowrap;',
    '}',
    '.pdf-report .pdf-item-amount.is-negative { color: var(--pdf-emerald); }',
    '.pdf-report .pdf-item-flag {',
    '  display: inline-flex;',
    '  align-items: flex-start;',
    '  gap: 4px;',
    '  max-width: 100%;',
    '  margin-top: 5px;',
    '  padding: 3px 6px;',
    '  border: 1px solid transparent;',
    '  border-radius: 5px;',
    '  font-size: 8px;',
    '  line-height: 1.4;',
    '}',
    '.pdf-report .pdf-item-flag svg { width: 11px; height: 11px; flex: 0 0 auto; margin-top: 1px; }',
    '.pdf-report .pdf-item-flag.is-error { background: var(--pdf-red-soft); border-color: #fecaca; color: var(--pdf-red); }',
    '.pdf-report .pdf-item-flag.is-warn { background: var(--pdf-amber-soft); border-color: #fde68a; color: #92400e; }',
    '.pdf-report .pdf-item-flag.is-rounding { background: #eef2ff; border-color: #c7d2fe; color: #3730a3; }',
    '.pdf-report .pdf-empty-bill { padding: 16px 15px; border-bottom: 1px solid #f1f5f9; color: var(--pdf-muted); font-size: 9.5px; text-align: center; }',
    '.pdf-report .pdf-bill-foot {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  flex-wrap: wrap;',
    '  gap: 10px;',
    '  padding: 9px 15px 10px;',
    '  border-top: 1px solid var(--pdf-line);',
    '  border-radius: 0 0 12px 12px;',
    '  background: var(--pdf-tint);',
    '}',
    '.pdf-report .pdf-foot-figures { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }',
    '.pdf-report .pdf-foot-figure { display: flex; flex-direction: column; gap: 1px; }',
    '.pdf-report .pdf-foot-figure span { color: var(--pdf-faint); font-size: 7px; line-height: 1.3; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; }',
    '.pdf-report .pdf-foot-figure strong { color: var(--pdf-slate); font-size: 9.5px; line-height: 1.35; font-weight: 800; }',
    '.pdf-report .pdf-foot-figure strong.is-good { color: var(--pdf-emerald); }',
    '.pdf-report .pdf-foot-figure strong.is-bad { color: var(--pdf-amber); }',
    '.pdf-report .pdf-recon {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  gap: 4px;',
    '  padding: 4px 8px;',
    '  border: 1px solid transparent;',
    '  border-radius: 999px;',
    '  font-size: 8px;',
    '  line-height: 1.3;',
    '  font-weight: 800;',
    '  white-space: nowrap;',
    '}',
    '.pdf-report .pdf-recon svg { width: 12px; height: 12px; flex: 0 0 auto; }',
    '.pdf-report .pdf-recon.is-good { background: var(--pdf-emerald-soft); border-color: #a7f3d0; color: var(--pdf-emerald); }',
    '.pdf-report .pdf-recon.is-warn { background: var(--pdf-amber-soft); border-color: #fde68a; color: #92400e; }',
    '.pdf-report .pdf-rounding-chip {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  gap: 4px;',
    '  padding: 3px 8px;',
    '  border: 1px solid #c7d2fe;',
    '  border-radius: 999px;',
    '  background: #eef2ff;',
    '  color: #3730a3;',
    '  font-size: 7.5px;',
    '  line-height: 1.3;',
    '  font-weight: 800;',
    '  white-space: nowrap;',
    '}',
    '.pdf-report .pdf-rounding-chip svg { width: 11px; height: 11px; flex: 0 0 auto; color: #4f46e5; }',
    '.pdf-report .pdf-bill-rounding {',
    '  flex-basis: 100%;',
    '  margin-top: 2px;',
    '  padding: 5px 7px;',
    '  border: 1px solid #dbe3ff;',
    '  border-radius: 5px;',
    '  background: #f5f7ff;',
    '  color: #3730a3;',
    '  font-size: 8px;',
    '  line-height: 1.45;',
    '}',
    '.pdf-report .pdf-bill-rounding strong { color: #312e81; }',
    '',
    '/* empty state */',
    '.pdf-report .pdf-empty {',
    '  padding: 30px 18px;',
    '  border: 1px dashed var(--pdf-line-strong);',
    '  border-radius: 13px;',
    '  background: var(--pdf-tint);',
    '  text-align: center;',
    '  color: var(--pdf-muted);',
    '}',
    '.pdf-report .pdf-empty-icon {',
    '  width: 40px;',
    '  height: 40px;',
    '  display: grid;',
    '  place-items: center;',
    '  margin: 0 auto 9px;',
    '  border: 1px solid #e0e7ff;',
    '  border-radius: 12px;',
    '  background: var(--pdf-indigo-soft);',
    '  color: var(--pdf-indigo);',
    '}',
    '.pdf-report .pdf-empty-icon svg { width: 21px; height: 21px; }',
    '.pdf-report .pdf-empty strong { display: block; color: var(--pdf-slate); font-size: 12px; }',
    '.pdf-report .pdf-empty p { margin-top: 3px; font-size: 9.5px; line-height: 1.5; }',
    '',
    '/* data checks */',
    '.pdf-report .pdf-checks {',
    '  margin-top: 26px;',
    '  padding: 18px 18px 14px;',
    '  border: 1px solid var(--pdf-line);',
    '  border-radius: 15px;',
    '  background: var(--pdf-tint);',
    '}',
    '.pdf-report .pdf-checks .pdf-section-head { margin-bottom: 12px; }',
    '.pdf-report .pdf-clean-banner {',
    '  display: flex;',
    '  align-items: flex-start;',
    '  gap: 10px;',
    '  padding: 13px 14px;',
    '  border: 1px solid #a7f3d0;',
    '  border-radius: 11px;',
    '  background: var(--pdf-emerald-soft);',
    '  color: #065f46;',
    '}',
    '.pdf-report .pdf-clean-banner > svg { width: 22px; height: 22px; flex: 0 0 auto; margin-top: 1px; color: var(--pdf-emerald); }',
    '.pdf-report .pdf-clean-banner strong { display: block; font-size: 12px; line-height: 1.35; }',
    '.pdf-report .pdf-clean-banner p { margin-top: 2px; color: #047857; font-size: 9px; line-height: 1.5; }',
    '.pdf-report .pdf-check-summary {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 11px;',
    '  margin-bottom: 11px;',
    '  padding: 11px 13px;',
    '  border: 1px solid #fde68a;',
    '  border-radius: 11px;',
    '  background: var(--pdf-amber-soft);',
    '  color: #92400e;',
    '}',
    '.pdf-report .pdf-check-summary.is-error { border-color: #fecaca; background: var(--pdf-red-soft); color: var(--pdf-red); }',
    '.pdf-report .pdf-check-count {',
    '  display: grid;',
    '  place-items: center;',
    '  width: 32px;',
    '  height: 32px;',
    '  flex: 0 0 auto;',
    '  border: 1px solid currentColor;',
    '  border-radius: 9px;',
    '  background: rgba(255, 255, 255, 0.55);',
    '  font-size: 14px;',
    '  font-weight: 800;',
    '  line-height: 1;',
    '}',
    '.pdf-report .pdf-check-summary strong { display: block; font-size: 11px; line-height: 1.35; }',
    '.pdf-report .pdf-check-summary p { margin-top: 1px; font-size: 8.5px; line-height: 1.45; opacity: 0.9; }',
    '.pdf-report .pdf-issues { display: flex; flex-direction: column; gap: 8px; }',
    '.pdf-report .pdf-issue {',
    '  padding: 9px 11px 10px;',
    '  border: 1px solid var(--pdf-line);',
    '  border-left: 3px solid #f59e0b;',
    '  border-radius: 8px;',
    '  background: #ffffff;',
    '}',
    '.pdf-report .pdf-issue.is-error { border-left-color: #dc2626; }',
    '.pdf-report .pdf-issue-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 7px; margin-bottom: 4px; }',
    '.pdf-report .pdf-sev {',
    '  padding: 2px 6px;',
    '  border: 1px solid #fde68a;',
    '  border-radius: 4px;',
    '  background: var(--pdf-amber-soft);',
    '  color: #92400e;',
    '  font-size: 6.8px;',
    '  line-height: 1.3;',
    '  font-weight: 800;',
    '  letter-spacing: 0.08em;',
    '  text-transform: uppercase;',
    '}',
    '.pdf-report .pdf-issue.is-error .pdf-sev { border-color: #fecaca; background: var(--pdf-red-soft); color: var(--pdf-red); }',
    '.pdf-report .pdf-issue-where { color: var(--pdf-muted); font-size: 8.5px; line-height: 1.4; overflow-wrap: anywhere; }',
    '.pdf-report .pdf-issue-sep { color: #cbd5e1; margin: 0 2px; }',
    '.pdf-report .pdf-reasons { display: flex; flex-direction: column; gap: 2px; }',
    '.pdf-report .pdf-reasons li { color: #475569; font-size: 8.8px; line-height: 1.5; overflow-wrap: anywhere; }',
    '.pdf-report .pdf-reason-label { color: var(--pdf-slate); font-weight: 800; margin-right: 4px; }',
    '.pdf-report .pdf-method-note { margin-top: 11px; color: var(--pdf-faint); font-size: 8px; line-height: 1.55; }',
    '.pdf-report .pdf-rounding-notes {',
    '  margin-top: 11px;',
    '  padding: 12px 13px;',
    '  border: 1px solid #c7d2fe;',
    '  border-radius: 10px;',
    '  background: #f5f7ff;',
    '}',
    '.pdf-report .pdf-rounding-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }',
    '.pdf-report .pdf-rounding-head h3 { color: #312e81; font-size: 12px; font-weight: 800; letter-spacing: -0.01em; }',
    '.pdf-report .pdf-rounding-intro { color: #475569; font-size: 8.8px; line-height: 1.5; margin-bottom: 7px; }',
    '.pdf-report .pdf-rounding-item { padding: 8px 9px; border: 1px solid #dbe3ff; border-radius: 7px; background: #ffffff; }',
    '.pdf-report .pdf-rounding-item + .pdf-rounding-item { margin-top: 6px; }',
    '.pdf-report .pdf-rounding-where { color: #4338ca; font-size: 9px; line-height: 1.4; font-weight: 700; margin-bottom: 3px; overflow-wrap: anywhere; }',
    '.pdf-report .pdf-rounding-item p { color: #475569; font-size: 8.7px; line-height: 1.5; }',
    '.pdf-report .pdf-rounding-metrics { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; color: #4338ca; font-size: 7.8px; font-weight: 700; }',
    '.pdf-report .pdf-rounding-metrics span { white-space: nowrap; }',
    '',
    '/* footer */',
    '.pdf-report .pdf-footer {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  flex-wrap: wrap;',
    '  gap: 6px 12px;',
    '  padding: 13px 28px 16px;',
    '  border-top: 1px solid var(--pdf-line);',
    '  border-radius: 0 0 17px 17px;',
    '  background: #ffffff;',
    '  color: var(--pdf-faint);',
    '  font-size: 8px;',
    '  line-height: 1.5;',
    '}',
    '.pdf-report .pdf-footer strong { color: var(--pdf-muted); font-weight: 700; }',
    '',
    '/* narrow screens */',
    '@media screen and (max-width: 760px) {',
    '  .pdf-report .pdf-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }',
    '}',
    '',
    '@media screen and (max-width: 640px) {',
    '  body.pdf-standalone { padding: 0; background: #ffffff; }',
    '  body.pdf-standalone .pdf-report { border-left: 0; border-right: 0; border-radius: 0; }',
    '  .pdf-report { border-radius: 0; box-shadow: none; border-left: 0; border-right: 0; }',
    '  .pdf-report .pdf-hero { padding: 20px 17px 18px; border-radius: 0; }',
    '  .pdf-report .pdf-hero-top { gap: 9px; }',
    '  .pdf-report .pdf-mark { width: 36px; height: 36px; border-radius: 11px; }',
    '  .pdf-report .pdf-mark svg { width: 20px; height: 20px; }',
    '  .pdf-report .pdf-wordmark { font-size: 17px; }',
    '  .pdf-report .pdf-tagline { font-size: 7px; }',
    '  .pdf-report .pdf-statement-pill { display: none; }',
    '  .pdf-report .pdf-hero-title { margin-top: 18px; }',
    '  .pdf-report .pdf-hero-title h1 { font-size: 27px; }',
    '  .pdf-report .pdf-hero-title p { font-size: 10.5px; line-height: 1.45; }',
    '  .pdf-report .pdf-meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 10px; margin-top: 17px; padding-top: 13px; }',
    '  .pdf-report .pdf-meta-label { font-size: 7px; }',
    '  .pdf-report .pdf-meta-value { font-size: 10px; }',
    '  .pdf-report .pdf-body { padding: 18px 14px 20px; }',
    '  .pdf-report .pdf-section { margin-top: 21px; }',
    '  .pdf-report .pdf-section-head { align-items: flex-start; flex-wrap: wrap; gap: 4px; margin-bottom: 11px; padding-bottom: 7px; }',
    '  .pdf-report .pdf-section-note { max-width: 100%; text-align: left; font-size: 8.5px; }',
    '  .pdf-report .pdf-section-head h2 { font-size: 16px; }',
    '  .pdf-report .pdf-eyebrow { font-size: 7px; }',
    '  .pdf-report .pdf-summary-grid { gap: 8px; }',
    '  .pdf-report .pdf-card { padding: 11px 11px 10px; border-radius: 11px; }',
    '  .pdf-report .pdf-card-top { margin-bottom: 7px; }',
    '  .pdf-report .pdf-card-label { font-size: 7.5px; }',
    '  .pdf-report .pdf-card-icon { width: 20px; height: 20px; border-radius: 6px; }',
    '  .pdf-report .pdf-card-icon svg { width: 11px; height: 11px; }',
    '  .pdf-report .pdf-card-value { font-size: 17px; }',
    '  .pdf-report .pdf-card-sub { font-size: 7.8px; }',
    '  .pdf-report .pdf-facts { margin-top: 8px; padding: 7px 9px; gap: 4px 7px; font-size: 8.5px; }',
    '  .pdf-report .pdf-panel { border-radius: 11px; }',
    '  .pdf-report .pdf-panel-head { padding: 9px 11px; }',
    '  .pdf-report .pdf-panel-title { font-size: 10px; }',
    '  .pdf-report .pdf-mini-chip { font-size: 6.5px; padding: 2px 5px; }',
    '  .pdf-report .pdf-balance-table thead { display: none; }',
    '  .pdf-report .pdf-balance-table, .pdf-report .pdf-balance-table tbody, .pdf-report .pdf-balance-table tfoot { display: block; width: 100%; }',
    '  .pdf-report .pdf-balance-table tr { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px 9px; padding: 9px 11px; border-bottom: 1px solid #f1f5f9; }',
    '  .pdf-report .pdf-balance-table tbody tr:last-child { border-bottom: 0; }',
    '  .pdf-report .pdf-balance-table td { display: block; padding: 0; border: 0; }',
    '  .pdf-report .pdf-balance-table td.pdf-balance-person { grid-column: 1 / -1; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 11px; }',
    '  .pdf-report .pdf-balance-table td.pdf-money-cell { display: flex; flex-direction: column; gap: 1px; text-align: left; white-space: normal; }',
    '  .pdf-report .pdf-balance-table td.pdf-money-cell::before { content: attr(data-label); color: var(--pdf-faint); font-size: 6.5px; line-height: 1.3; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; }',
    '  .pdf-report .pdf-balance-table .pdf-total-row { border-top: 1px solid var(--pdf-line-strong); background: var(--pdf-tint); }',
    '  .pdf-report .pdf-total-row td { padding: 0; border: 0; background: transparent; }',
    '  .pdf-report .pdf-total-row .pdf-balance-person { font-size: 8px; }',
    '  .pdf-report .pdf-note, .pdf-report .pdf-warning-note { margin-left: 11px; margin-right: 11px; font-size: 8px; }',
    '  .pdf-report .pdf-rounding-note { margin-left: 11px; margin-right: 11px; font-size: 8px; }',
    '  .pdf-report .pdf-rounding-chip { font-size: 6.7px; padding: 2px 6px; }',
    '  .pdf-report .pdf-bill-rounding { font-size: 7.4px; }',
    '  .pdf-report .pdf-rounding-notes { padding: 10px; }',
    '  .pdf-report .pdf-rounding-head h3 { font-size: 11px; }',
    '  .pdf-report .pdf-rounding-intro, .pdf-report .pdf-rounding-item p { font-size: 8px; }',
    '  .pdf-report .pdf-rounding-where { font-size: 8.2px; }',
    '  .pdf-report .pdf-rounding-metrics { font-size: 7px; }',
    '  .pdf-report .pdf-settle { padding: 11px; }',
    '  .pdf-report .pdf-settle-row { padding: 7px 9px; font-size: 9px; }',
    '  .pdf-report .pdf-settled-up strong { font-size: 9.5px; }',
    '  .pdf-report .pdf-settled-up span { font-size: 8px; }',
    '  .pdf-report .pdf-bill { border-radius: 11px; }',
    '  .pdf-report .pdf-bill-head { padding: 11px 11px 10px; border-radius: 10px 10px 0 0; gap: 10px; }',
    '  .pdf-report .pdf-bill-name { font-size: 14.5px; }',
    '  .pdf-report .pdf-bill-kicker { font-size: 7px; }',
    '  .pdf-report .pdf-bill-meta { font-size: 8px; }',
    '  .pdf-report .pdf-bill-total { font-size: 16px; }',
    '  .pdf-report .pdf-bill-side { gap: 3px; }',
    '  .pdf-report .pdf-items th { padding: 6px 11px; }',
    '  .pdf-report .pdf-items th:first-child { width: 70%; }',
    '  .pdf-report .pdf-items th:last-child { width: 30%; }',
    '  .pdf-report .pdf-items td { padding: 8px 11px 9px; }',
    '  .pdf-report .pdf-item-title { font-size: 10.5px; }',
    '  .pdf-report .pdf-item-amount { font-size: 10.5px; }',
    '  .pdf-report .pdf-share { font-size: 7.6px; padding: 2px 6px; }',
    '  .pdf-report .pdf-cat, .pdf-report .pdf-chip { font-size: 7px; }',
    '  .pdf-report .pdf-kind, .pdf-report .pdf-method { font-size: 6.4px; }',
    '  .pdf-report .pdf-bill-foot { padding: 8px 11px; border-radius: 0 0 10px 10px; }',
    '  .pdf-report .pdf-foot-figures { gap: 9px; }',
    '  .pdf-report .pdf-foot-figure span { font-size: 6.4px; }',
    '  .pdf-report .pdf-foot-figure strong { font-size: 8.6px; }',
    '  .pdf-report .pdf-recon { font-size: 7.2px; padding: 3px 7px; }',
    '  .pdf-report .pdf-checks { margin-top: 21px; padding: 13px 11px 11px; border-radius: 11px; }',
    '  .pdf-report .pdf-clean-banner { padding: 11px; border-radius: 9px; }',
    '  .pdf-report .pdf-clean-banner strong { font-size: 11px; }',
    '  .pdf-report .pdf-clean-banner p { font-size: 8px; }',
    '  .pdf-report .pdf-check-summary { padding: 9px 10px; border-radius: 9px; }',
    '  .pdf-report .pdf-check-summary strong { font-size: 10px; }',
    '  .pdf-report .pdf-check-summary p { font-size: 7.8px; }',
    '  .pdf-report .pdf-check-count { width: 28px; height: 28px; border-radius: 7px; font-size: 12px; }',
    '  .pdf-report .pdf-issue { padding: 8px 9px 9px; }',
    '  .pdf-report .pdf-issue-where { font-size: 7.8px; }',
    '  .pdf-report .pdf-reasons li { font-size: 8px; }',
    '  .pdf-report .pdf-method-note { font-size: 7.3px; }',
    '  .pdf-report .pdf-footer { padding: 12px 14px 14px; border-radius: 0; font-size: 7.5px; }',
    '}',
    '',
    '/* print */',
    '@media print {',
    '  body.pdf-standalone { margin: 0; padding: 0; background: #ffffff; }',
    '  body.pdf-standalone .pdf-report { margin: 0; }',
    '  .pdf-report { max-width: none; width: auto; margin: 0; padding: 0; border: 0; border-radius: 0; box-shadow: none; font-size: 9.2pt; }',
    '  .pdf-report .pdf-hero { padding: 16px 18px 14px; margin: 0 0 14px; border-radius: 0; border-top-width: 4px; break-inside: avoid; page-break-inside: avoid; break-after: avoid; page-break-after: avoid; }',
    '  .pdf-report .pdf-mark { width: 31px; height: 31px; border-radius: 8px; }',
    '  .pdf-report .pdf-mark svg { width: 17px; height: 17px; }',
    '  .pdf-report .pdf-wordmark { font-size: 13pt; }',
    '  .pdf-report .pdf-tagline { font-size: 6pt; }',
    '  .pdf-report .pdf-statement-pill { display: inline-flex; font-size: 6pt; padding: 3px 7px; }',
    '  .pdf-report .pdf-hero-title { margin-top: 13px; }',
    '  .pdf-report .pdf-hero-title h1 { font-size: 22pt; }',
    '  .pdf-report .pdf-hero-title p { margin-top: 4px; font-size: 7.6pt; }',
    '  .pdf-report .pdf-meta-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 12px; padding-top: 9px; }',
    '  .pdf-report .pdf-meta-label { font-size: 6pt; }',
    '  .pdf-report .pdf-meta-value { font-size: 7.8pt; }',
    '  .pdf-report .pdf-body { padding: 0; }',
    '  .pdf-report .pdf-section { margin-top: 13px; }',
    '  .pdf-report .pdf-section-head { margin-bottom: 7px; padding-bottom: 5px; break-after: avoid; page-break-after: avoid; }',
    '  .pdf-report .pdf-eyebrow { font-size: 6pt; }',
    '  .pdf-report .pdf-section-head h2 { font-size: 12.5pt; }',
    '  .pdf-report .pdf-section-note { font-size: 7pt; }',
    '  .pdf-report .pdf-summary-grid { gap: 6px; break-inside: avoid; page-break-inside: avoid; }',
    '  .pdf-report .pdf-card { padding: 7px 8px 8px; border-radius: 6px; }',
    '  .pdf-report .pdf-card-top { margin-bottom: 5px; }',
    '  .pdf-report .pdf-card-label { font-size: 6.3pt; }',
    '  .pdf-report .pdf-card-icon { width: 17px; height: 17px; border-radius: 4px; }',
    '  .pdf-report .pdf-card-icon svg { width: 9px; height: 9px; }',
    '  .pdf-report .pdf-card-value { font-size: 11.5pt; }',
    '  .pdf-report .pdf-card-sub { font-size: 6.1pt; }',
    '  .pdf-report .pdf-facts { margin-top: 6px; padding: 5px 7px; font-size: 7pt; border-radius: 5px; break-inside: avoid; }',
    '  .pdf-report .pdf-panel { border-radius: 6px; }',
    '  .pdf-report .pdf-panel-head { padding: 6px 8px; border-radius: 5px 5px 0 0; break-after: avoid; }',
    '  .pdf-report .pdf-panel-title { font-size: 8.5pt; }',
    '  .pdf-report .pdf-mini-chip { font-size: 5.8pt; padding: 2px 4px; }',
    '  .pdf-report .pdf-balance-table { font-size: 7.8pt; }',
    '  .pdf-report .pdf-balance-table th { padding: 4px 8px; font-size: 5.9pt; }',
    '  .pdf-report .pdf-balance-table td { padding: 4px 8px; }',
    '  .pdf-report .pdf-total-row td { padding: 4px 8px; font-size: 7pt; }',
    '  .pdf-report .pdf-note { margin: 6px 8px 0; font-size: 6.7pt; }',
    '  .pdf-report .pdf-warning-note { margin: 6px 8px 0; padding: 5px 6px; font-size: 6.5pt; border-radius: 4px; }',
    '  .pdf-report .pdf-rounding-note { margin: 6px 8px 0; padding: 5px 6px; font-size: 6.5pt; border-radius: 4px; }',
    '  .pdf-report .pdf-settle { padding: 8px 8px 9px; border-radius: 0 0 5px 5px; }',
    '  .pdf-report .pdf-settle-head { margin-bottom: 5px; }',
    '  .pdf-report .pdf-settle-head h3 { font-size: 8.3pt; }',
    '  .pdf-report .pdf-method-tag { font-size: 5.5pt; }',
    '  .pdf-report .pdf-settle-list { border-radius: 5px; }',
    '  .pdf-report .pdf-settle-row { padding: 4px 7px; font-size: 7.4pt; break-inside: avoid; page-break-inside: avoid; }',
    '  .pdf-report .pdf-settled-up { padding: 7px; border-radius: 5px; }',
    '  .pdf-report .pdf-settled-up strong { font-size: 7.7pt; }',
    '  .pdf-report .pdf-settled-up span { font-size: 6.7pt; }',
    '  .pdf-report .pdf-bill-list { gap: 8px; }',
    '  .pdf-report .pdf-bill { border-radius: 6px; break-inside: avoid; page-break-inside: avoid; }',
    '  .pdf-report .pdf-bill-head { padding: 7px 9px 6px; border-radius: 5px 5px 0 0; gap: 10px; break-inside: avoid; page-break-inside: avoid; break-after: avoid; page-break-after: avoid; }',
    '  .pdf-report .pdf-bill-kicker { font-size: 5.9pt; }',
    '  .pdf-report .pdf-bill-name { margin: 2px 0 3px; font-size: 10.5pt; }',
    '  .pdf-report .pdf-bill-meta { font-size: 6.6pt; gap: 2px 5px; }',
    '  .pdf-report .pdf-bill-side { gap: 2px; }',
    '  .pdf-report .pdf-status { font-size: 5.5pt; padding: 2px 5px; }',
    '  .pdf-report .pdf-bill-total { font-size: 12pt; }',
    '  .pdf-report .pdf-bill-total-label { font-size: 5.2pt; }',
    '  .pdf-report .pdf-items { table-layout: fixed; }',
    '  .pdf-report .pdf-items th { padding: 4px 8px; font-size: 5.9pt; }',
    '  .pdf-report .pdf-items th:first-child { width: 74%; }',
    '  .pdf-report .pdf-items th:last-child { width: 26%; }',
    '  .pdf-report .pdf-th-bill { font-size: 6.4pt; margin-bottom: 1px; }',
    '  .pdf-report .pdf-items td { padding: 5px 8px 6px; }',
    '  .pdf-report .pdf-item-title { font-size: 8.2pt; }',
    '  .pdf-report .pdf-item-meta { margin-top: 2px; }',
    '  .pdf-report .pdf-cat, .pdf-report .pdf-chip { font-size: 5.8pt; padding: 1px 4px; }',
    '  .pdf-report .pdf-kind, .pdf-report .pdf-method { font-size: 5.4pt; padding: 1px 3px; }',
    '  .pdf-report .pdf-shares { margin-top: 3px; gap: 3px; }',
    '  .pdf-report .pdf-share { font-size: 6.2pt; padding: 1px 4px; }',
    '  .pdf-report .pdf-no-shares { font-size: 6pt; }',
    '  .pdf-report .pdf-item-amount { font-size: 8.2pt; }',
    '  .pdf-report .pdf-item-flag { margin-top: 3px; font-size: 5.9pt; }',
    '  .pdf-report .pdf-empty-bill { padding: 8px; font-size: 6.7pt; }',
    '  .pdf-report .pdf-bill-foot { padding: 5px 9px 6px; border-radius: 0 0 5px 5px; gap: 7px; break-inside: avoid; page-break-inside: avoid; }',
    '  .pdf-report .pdf-foot-figures { gap: 9px; }',
    '  .pdf-report .pdf-foot-figure span { font-size: 5.3pt; }',
    '  .pdf-report .pdf-foot-figure strong { font-size: 7pt; }',
    '  .pdf-report .pdf-recon { font-size: 5.9pt; padding: 2px 5px; }',
    '  .pdf-report .pdf-rounding-chip { font-size: 5.6pt; padding: 2px 5px; }',
    '  .pdf-report .pdf-bill-rounding { font-size: 6.2pt; padding: 3px 5px; border-radius: 4px; }',
    '  .pdf-report .pdf-empty { padding: 14px 10px; border-radius: 6px; }',
    '  .pdf-report .pdf-empty-icon { width: 30px; height: 30px; margin-bottom: 5px; border-radius: 8px; }',
    '  .pdf-report .pdf-empty-icon svg { width: 16px; height: 16px; }',
    '  .pdf-report .pdf-empty strong { font-size: 9pt; }',
    '  .pdf-report .pdf-empty p { margin-top: 1px; font-size: 7pt; }',
    '  .pdf-report .pdf-checks { margin-top: 13px; padding: 9px 9px 7px; border-radius: 6px; break-inside: avoid; page-break-inside: avoid; }',
    '  .pdf-report .pdf-clean-banner { padding: 7px 8px; border-radius: 5px; break-inside: avoid; page-break-inside: avoid; }',
    '  .pdf-report .pdf-clean-banner strong { font-size: 8.4pt; }',
    '  .pdf-report .pdf-clean-banner p { font-size: 6.6pt; }',
    '  .pdf-report .pdf-check-summary { margin-bottom: 6px; padding: 6px 7px; border-radius: 5px; break-inside: avoid; page-break-inside: avoid; }',
    '  .pdf-report .pdf-check-summary strong { font-size: 7.7pt; }',
    '  .pdf-report .pdf-check-summary p { font-size: 6.2pt; }',
    '  .pdf-report .pdf-check-count { width: 22px; height: 22px; border-radius: 5px; font-size: 9pt; }',
    '  .pdf-report .pdf-issues { gap: 5px; }',
    '  .pdf-report .pdf-issue { padding: 6px 7px; border-radius: 5px; break-inside: avoid; page-break-inside: avoid; }',
    '  .pdf-report .pdf-issue-head { margin-bottom: 2px; }',
    '  .pdf-report .pdf-sev { font-size: 5.2pt; padding: 1px 3px; }',
    '  .pdf-report .pdf-issue-where { font-size: 6.2pt; }',
    '  .pdf-report .pdf-reasons li { font-size: 6.4pt; line-height: 1.45; }',
    '  .pdf-report .pdf-method-note { margin-top: 7px; font-size: 5.9pt; }',
    '  .pdf-report .pdf-rounding-notes { margin-top: 7px; padding: 7px 8px; border-radius: 5px; break-inside: avoid; page-break-inside: avoid; }',
    '  .pdf-report .pdf-rounding-head { margin-bottom: 3px; break-after: avoid; page-break-after: avoid; }',
    '  .pdf-report .pdf-rounding-head h3 { font-size: 8.3pt; }',
    '  .pdf-report .pdf-rounding-intro { font-size: 6.4pt; margin-bottom: 4px; }',
    '  .pdf-report .pdf-rounding-item { padding: 5px 6px; border-radius: 4px; }',
    '  .pdf-report .pdf-rounding-item p { font-size: 6.3pt; }',
    '  .pdf-report .pdf-rounding-where { font-size: 6.7pt; }',
    '  .pdf-report .pdf-rounding-metrics { font-size: 5.9pt; }',
    '  .pdf-report .pdf-footer { padding: 7px 0 0; border-radius: 0; font-size: 6.2pt; break-inside: avoid; page-break-inside: avoid; }',
    '  .pdf-report table { page-break-inside: auto; }',
    '  .pdf-report thead { display: table-header-group; }',
    '  .pdf-report tfoot { display: table-row-group; }',
    '  .pdf-report tr { break-inside: avoid; page-break-inside: avoid; }',
    '  .pdf-report .pdf-bill-head, .pdf-report .pdf-bill-foot, .pdf-report .pdf-issue,',
    '  .pdf-report .pdf-clean-banner, .pdf-report .pdf-check-summary, .pdf-report .pdf-settle-row,',
    '  .pdf-report .pdf-rounding-item {',
    '    break-inside: avoid;',
    '    page-break-inside: avoid;',
    '  }',
    '}'
  ].join('\n');


  /* ---------------------------- model ---------------------------- */

  function compareItems(a, b) {
    if (a.order !== b.order) return a.order - b.order;
    var aDate = dateKey(a.date);
    var bDate = dateKey(b.date);
    if (aDate && !bDate) return -1;
    if (!aDate && bDate) return 1;
    if (aDate !== bDate) return aDate < bDate ? -1 : 1;
    return a.rawIndex - b.rawIndex;
  }

  function compareBills(a, b) {
    var aDate = dateKey(a.date);
    var bDate = dateKey(b.date);
    if (aDate && !bDate) return -1;
    if (!aDate && bDate) return 1;
    if (aDate !== bDate) return aDate < bDate ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.rawIndex - b.rawIndex;
  }

  function sumAmounts(items) {
    var total = 0;
    (items || []).forEach(function (item) {
      total += toNumber(item.amount);
    });
    return total;
  }

  function sumShareValues(items) {
    var total = 0;
    (items || []).forEach(function (item) {
      (item.splits || []).forEach(function (split) {
        total += toNumber(split.value);
      });
    });
    return total;
  }

  /* The total a reader gets by adding the 2-decimal share pills. */
  function displayedShareTotal(items) {
    var total = 0;
    (items || []).forEach(function (item) {
      (item.splits || []).forEach(function (split) {
        total += round2(split.value);
      });
    });
    return round2(total);
  }

  function sumPersonShare(items, person) {
    var total = 0;
    (items || []).forEach(function (item) {
      (item.splits || []).forEach(function (split) {
        if (split.name === person) total += toNumber(split.value);
      });
    });
    return total;
  }

  function sumPaid(items, person) {
    var total = 0;
    (items || []).forEach(function (item) {
      if (item.paidBy === person) total += toNumber(item.amount);
    });
    return total;
  }

  function billStatus(items) {
    if (!items.length) return { key: 'is-open', label: 'Open' };
    var settled = 0;
    items.forEach(function (item) {
      if (item.settled) settled += 1;
    });
    if (settled === items.length) return { key: 'is-settled', label: 'Settled' };
    if (settled > 0) return { key: 'is-partly', label: 'Partly settled' };
    return { key: 'is-open', label: 'Open' };
  }

  function involvedPeople(bill) {
    var names = [];
    function add(name) {
      if (!name) return;
      if (names.indexOf(name) === -1) names.push(name);
    }
    add(bill.payer);
    bill.items.forEach(function (item) {
      add(item.paidBy);
      item.splits.forEach(function (split) { add(split.name); });
    });
    return names;
  }

  function decorateBill(bill) {
    bill.items.sort(compareItems);
    if (!dateParts(bill.date) && bill.items.length) bill.date = bill.items[0].date;
    bill.status = billStatus(bill.items);
    bill.itemTotal = round2(sumAmounts(bill.items));
    bill.shareTotal = round2(sumShareValues(bill.items));
    bill.difference = round2(bill.itemTotal - bill.shareTotal);
    bill.people = involvedPeople(bill);
    bill.peopleCount = bill.people.length;
    bill.issues = [];
    bill.issueSeverity = null;
    bill.itemIssueCount = 0;
  }

  function greedySettlements(balanceRows) {
    var debtors = [];
    var creditors = [];
    balanceRows.forEach(function (row) {
      if (row.rawNet < -TOLERANCE) {
        debtors.push({ person: row.person, amount: Math.abs(row.rawNet) });
      } else if (row.rawNet > TOLERANCE) {
        creditors.push({ person: row.person, amount: row.rawNet });
      }
    });
    debtors.sort(function (a, b) { return b.amount - a.amount; });
    creditors.sort(function (a, b) { return b.amount - a.amount; });

    var suggestions = [];
    var i = 0;
    var j = 0;
    while (i < debtors.length && j < creditors.length) {
      var debtor = debtors[i];
      var creditor = creditors[j];
      var amount = Math.min(debtor.amount, creditor.amount);
      if (amount > 0.004) {
        suggestions.push({
          from: debtor.person,
          to: creditor.person,
          amount: round2(amount)
        });
      }
      debtor.amount -= amount;
      creditor.amount -= amount;
      if (debtor.amount < 0.01) i += 1;
      if (creditor.amount < 0.01) j += 1;
    }
    return suggestions;
  }

  function buildModel(source) {
    var data = source && typeof source === 'object' ? source : {};
    var userName = cleanText(data.userName) || 'You';
    var currency = cleanText(data.currency) || DEFAULT_CURRENCY;

    var participants = [];
    function addParticipant(name) {
      var value = cleanText(name);
      if (value && participants.indexOf(value) === -1) participants.push(value);
    }
    if (Array.isArray(data.participants)) {
      data.participants.forEach(addParticipant);
    }
    if (participants.indexOf(userName) === -1) participants.unshift(userName);

    var rawProjects = Array.isArray(data.projects) ? data.projects : [];
    var rawItems = Array.isArray(data.items) ? data.items : [];

    var bills = rawProjects.map(function (project, index) {
      project = project && typeof project === 'object' ? project : {};
      return {
        id: text(project.id),
        name: cleanText(project.name) || 'Untitled bill',
        date: project.date,
        payer: cleanText(project.payer),
        createdAt: toNumber(project.createdAt),
        rawIndex: index,
        synthetic: false,
        items: []
      };
    });

    var billById = Object.create(null);
    bills.forEach(function (bill) {
      if (!Object.prototype.hasOwnProperty.call(billById, bill.id)) {
        billById[bill.id] = bill;
      }
    });

    var items = rawItems.map(function (rawItem, index) {
      rawItem = rawItem && typeof rawItem === 'object' ? rawItem : {};
      var splitData = rawItem.splits &&
        typeof rawItem.splits === 'object' &&
        !Array.isArray(rawItem.splits) ? rawItem.splits : {};
      var splits = [];
      var splitSeen = Object.create(null);
      Object.keys(splitData).forEach(function (key) {
        var name = cleanText(key);
        if (!name) return;
        var value = toNumber(splitData[key]);
        if (splitSeen[name]) {
          splitSeen[name].value += value;
        } else {
          var split = { name: name, value: value };
          splitSeen[name] = split;
          splits.push(split);
        }
      });
      return {
        id: text(rawItem.id),
        projectId: text(rawItem.projectId),
        order: isFinite(Number(rawItem.order)) ? Number(rawItem.order) : index,
        date: rawItem.date,
        description: cleanText(rawItem.description) || 'Untitled item',
        category: cleanText(rawItem.category) || 'Uncategorised',
        amount: toNumber(rawItem.amount),
        paidBy: cleanText(rawItem.paidBy),
        splitMethod: normalizeMethod(rawItem.splitMethod),
        splits: splits,
        settled: !!rawItem.settled,
        kind: normalizeKind(rawItem.kind),
        rawIndex: index,
        issueReasons: [],
        issueSeverity: null
      };
    });

    var orphans = [];
    items.forEach(function (item) {
      var bill = billById[item.projectId];
      if (bill) bill.items.push(item);
      else orphans.push(item);
    });

    bills.forEach(decorateBill);
    bills.sort(compareBills);

    if (orphans.length) {
      var orphanDates = orphans.map(function (item) { return dateKey(item.date); })
        .filter(Boolean)
        .sort();
      var orphanBill = {
        id: '__unlinked__',
        name: 'Unlinked items',
        date: orphanDates.length ? orphanDates[0] : '',
        payer: '',
        createdAt: 0,
        rawIndex: rawProjects.length,
        synthetic: true,
        items: orphans
      };
      decorateBill(orphanBill);
      billById.__unlinked__ = orphanBill;
      bills.push(orphanBill);
    }

    var allItems = [];
    bills.forEach(function (bill) {
      allItems = allItems.concat(bill.items);
    });

    allItems.forEach(function (item) {
      item.shareSum = round2(sumShareValues([item]));
      item.difference = round2(item.shareSum - round2(item.amount));
      item.roundingNote = null;
    });

    /*
      Display rounding notes. These are deliberately not issues: the raw
      split is within the app tolerance, but adding the 2-decimal share pills
      does not equal the item amount. The report explains the cent instead of
      calling valid data corrupt.
    */
    var roundingNotes = [];
    bills.forEach(function (bill) {
      bill.roundingNotes = [];
      bill.displayedShareTotal = displayedShareTotal(bill.items);
      bill.displayedDifference = round2(bill.displayedShareTotal - bill.itemTotal);

      bill.items.forEach(function (item) {
        if (!item.splits.length) return;
        if (Math.abs(item.shareSum - round2(item.amount)) > TOLERANCE) return;
        var displayed = displayedShareTotal([item]);
        var residual = round2(displayed - round2(item.amount));
        if (Math.abs(residual) <= 0.004) return;
        var note = {
          scope: 'item',
          bill: bill,
          item: item,
          amount: round2(item.amount),
          rawShareSum: sumShareValues([item]),
          rawShareSumRounded: round2(sumShareValues([item])),
          displayedShareTotal: displayed,
          residual: residual
        };
        item.roundingNote = note;
        bill.roundingNotes.push(note);
        roundingNotes.push(note);
      });

      if (!bill.roundingNotes.length && bill.items.length &&
          Math.abs(bill.difference) <= TOLERANCE &&
          Math.abs(bill.displayedDifference) > 0.004) {
        var billNote = {
          scope: 'bill',
          bill: bill,
          item: null,
          amount: bill.itemTotal,
          rawShareSum: sumShareValues(bill.items),
          rawShareSumRounded: bill.shareTotal,
          displayedShareTotal: bill.displayedShareTotal,
          residual: bill.displayedDifference
        };
        bill.roundingNotes.push(billNote);
        roundingNotes.push(billNote);
      }

      bill.hasRounding = bill.roundingNotes.length > 0;
    });

    var openItems = allItems.filter(function (item) { return !item.settled; });
    var totalSpend = round2(sumAmounts(allItems));
    var openSpend = round2(sumAmounts(openItems));
    var yourShare = round2(sumPersonShare(allItems, userName));
    var yourOpenPaidRaw = sumPaid(openItems, userName);
    var yourOpenShareRaw = sumPersonShare(openItems, userName);
    var yourOpenPaid = round2(yourOpenPaidRaw);
    var yourOpenShare = round2(yourOpenShareRaw);
    var yourOpenNet = round2(yourOpenPaidRaw - yourOpenShareRaw);
    var settledCount = allItems.length - openItems.length;

    var balanceRows = participants.map(function (person) {
      var rawPaid = sumPaid(openItems, person);
      var rawShare = sumPersonShare(openItems, person);
      return {
        person: person,
        rawPaid: rawPaid,
        rawShare: rawShare,
        rawNet: rawPaid - rawShare,
        paid: round2(rawPaid),
        share: round2(rawShare),
        net: round2(rawPaid - rawShare)
      };
    });
    var totalPaid = round2(balanceRows.reduce(function (sum, row) {
      return sum + row.rawPaid;
    }, 0));
    var totalShare = round2(balanceRows.reduce(function (sum, row) {
      return sum + row.rawShare;
    }, 0));
    var totalNet = round2(balanceRows.reduce(function (sum, row) {
      return sum + row.rawNet;
    }, 0));

    var balanceDisplayRounding = {
      paidDisplayTotal: round2(balanceRows.reduce(function (sum, row) {
        return sum + row.paid;
      }, 0)),
      shareDisplayTotal: round2(balanceRows.reduce(function (sum, row) {
        return sum + row.share;
      }, 0)),
      netDisplayTotal: round2(balanceRows.reduce(function (sum, row) {
        return sum + row.net;
      }, 0))
    };
    balanceDisplayRounding.paidDelta = round2(balanceDisplayRounding.paidDisplayTotal - totalPaid);
    balanceDisplayRounding.shareDelta = round2(balanceDisplayRounding.shareDisplayTotal - totalShare);
    balanceDisplayRounding.netDelta = round2(balanceDisplayRounding.netDisplayTotal - totalNet);
    balanceDisplayRounding.has = Math.abs(balanceDisplayRounding.paidDelta) > 0.004 ||
      Math.abs(balanceDisplayRounding.shareDelta) > 0.004 ||
      Math.abs(balanceDisplayRounding.netDelta) > 0.004;

    var unknownOpenNames = [];
    var unknownSeen = Object.create(null);
    function addUnknown(name) {
      if (!name || participants.indexOf(name) !== -1) return;
      if (unknownSeen[name]) return;
      unknownSeen[name] = true;
      unknownOpenNames.push(name);
    }
    openItems.forEach(function (item) {
      addUnknown(item.paidBy);
      item.splits.forEach(function (split) { addUnknown(split.name); });
    });

    var settlements = greedySettlements(balanceRows);

    var transferDisplayTotal = round2(settlements.reduce(function (sum, suggestion) {
      return sum + suggestion.amount;
    }, 0));
    var positiveNetDisplayTotal = round2(balanceRows.reduce(function (sum, row) {
      return row.net > 0 ? sum + row.net : sum;
    }, 0));
    var settlementDisplayRounding = {
      transferDisplayTotal: transferDisplayTotal,
      positiveNetDisplayTotal: positiveNetDisplayTotal,
      delta: round2(transferDisplayTotal - positiveNetDisplayTotal),
      has: settlements.length > 0 &&
        Math.abs(round2(transferDisplayTotal - positiveNetDisplayTotal)) > 0.004
    };

    var billDates = bills.map(function (bill) { return dateKey(bill.date); })
      .filter(Boolean)
      .sort();

    /* ------------------------- data checks ------------------------- */

    var issues = [];
    var errorCount = 0;
    var warnCount = 0;

    function addIssue(scope, bill, item, reasons) {
      var hasError = reasons.some(function (reason) {
        return reason.severity === 'error';
      });
      var isAmount = reasons.some(function (reason) {
        return isAmountReasonLabel(reason.label);
      });
      var issue = {
        scope: scope,
        bill: bill,
        item: item,
        reasons: reasons,
        severity: hasError ? 'error' : 'warn',
        isAmount: isAmount
      };
      issues.push(issue);
      if (hasError) errorCount += 1;
      else warnCount += 1;

      if (item) {
        item.issueReasons = item.issueReasons.concat(reasons);
        if (hasError) item.issueSeverity = 'error';
        else if (!item.issueSeverity) item.issueSeverity = 'warn';
      }
      bill.issues.push(issue);
      if (hasError) bill.issueSeverity = 'error';
      else if (!bill.issueSeverity) bill.issueSeverity = 'warn';
    }

    bills.forEach(function (bill) {
      var billReasons = [];

      if (bill.synthetic) {
        billReasons.push({
          severity: 'warn',
          label: 'Unlinked items',
          detail: bill.items.length + ' ' +
            plural(bill.items.length, 'item has', 'items have') +
            ' no matching bill record. They are still included in totals.'
        });
      }

      if (!bill.items.length) {
        billReasons.push({
          severity: 'warn',
          label: 'No items',
          detail: 'This bill has no items to check.'
        });
      } else if (Math.abs(bill.difference) > TOLERANCE) {
        billReasons.push({
          severity: 'error',
          label: 'Bill totals',
          detail: 'Items total ' + formatMoney(bill.itemTotal, currency) +
            '; shares total ' + formatMoney(bill.shareTotal, currency) +
            ' (gap ' + formatMoney(Math.abs(bill.difference), currency) + ').'
        });
      }

      if (billReasons.length) addIssue('bill', bill, null, billReasons);

      bill.items.forEach(function (item) {
        var reasons = [];
        var hasSplits = item.splits.length > 0;
        var amount = round2(item.amount);

        if (!hasSplits) {
          var noSplitDetail = 'No one is assigned. Shares total ' +
            formatMoney(0, currency) + '; item amount ' +
            formatMoney(amount, currency);
          if (Math.abs(item.difference) > TOLERANCE) {
            noSplitDetail += ' (gap ' + formatMoney(Math.abs(item.difference), currency) + ')';
          }
          noSplitDetail += '.';
          reasons.push({
            severity: 'warn',
            label: 'No splits',
            detail: noSplitDetail
          });
        } else if (Math.abs(item.difference) > TOLERANCE) {
          reasons.push({
            severity: 'error',
            label: 'Share mismatch',
            detail: 'Shares add up to ' + formatMoney(item.shareSum, currency) +
              '; item amount is ' + formatMoney(amount, currency) +
              ' (gap ' + formatMoney(Math.abs(item.difference), currency) + ').'
          });
        }

        if (item.paidBy !== bill.payer) {
          reasons.push({
            severity: 'error',
            label: 'Payer mismatch',
            detail: (item.paidBy
              ? 'Item paid by ' + personDetailedHtml(item.paidBy, userName)
              : 'No payer is set on this item') +
              '; bill payer is ' +
              (bill.payer ? personDetailedHtml(bill.payer, userName) : 'not set') +
              '. Balances use the item payer.'
          });
        }

        if (!item.paidBy) {
          if (!bill.payer) {
            reasons.push({
              severity: 'warn',
              label: 'Missing payer',
              detail: 'No payer is recorded on this item or its bill.'
            });
          }
        } else if (participants.indexOf(item.paidBy) === -1) {
          reasons.push({
            severity: 'warn',
            label: 'Payer not in Participants',
            detail: quotedNamesHtml([item.paidBy]) +
              ' is not in Participants; their payments are excluded from balances.'
          });
        }

        var unknownShares = [];
        item.splits.forEach(function (split) {
          if (participants.indexOf(split.name) === -1 &&
              unknownShares.indexOf(split.name) === -1) {
            unknownShares.push(split.name);
          }
        });
        if (unknownShares.length) {
          reasons.push({
            severity: 'warn',
            label: 'Unknown participant',
            detail: 'Share ' + (unknownShares.length === 1 ? 'name ' : 'names ') +
              quotedNamesHtml(unknownShares) +
              (unknownShares.length === 1 ? ' is' : ' are') +
              ' not in Participants; excluded from balances.'
          });
        }

        if (reasons.length) addIssue('item', bill, item, reasons);
      });
    });

    bills.forEach(function (bill) {
      bill.itemIssueCount = bill.issues.filter(function (issue) {
        return issue.scope === 'item';
      }).length;
    });

    var amountFindingCount = 0;
    var otherFindingCount = 0;
    issues.forEach(function (issue) {
      issue.reasons.forEach(function (reason) {
        if (isAmountReasonLabel(reason.label)) {
          amountFindingCount += 1;
        } else {
          otherFindingCount += 1;
        }
      });
    });

    var generatedAt = formatTimestamp(data.generatedAt || new Date());

    return {
      userName: userName,
      currency: currency,
      participants: participants,
      bills: bills,
      allItems: allItems,
      openItems: openItems,
      totalSpend: totalSpend,
      openSpend: openSpend,
      yourShare: yourShare,
      yourOpenPaid: yourOpenPaid,
      yourOpenShare: yourOpenShare,
      yourOpenNet: yourOpenNet,
      settledCount: settledCount,
      balanceRows: balanceRows,
      totalPaid: totalPaid,
      totalShare: totalShare,
      totalNet: totalNet,
      settlements: settlements,
      settlementDisplayRounding: settlementDisplayRounding,
      balanceDisplayRounding: balanceDisplayRounding,
      roundingNotes: roundingNotes,
      unknownOpenNames: unknownOpenNames,
      issues: issues,
      errorCount: errorCount,
      warnCount: warnCount,
      amountFindingCount: amountFindingCount,
      otherFindingCount: otherFindingCount,
      rangeStart: billDates.length ? billDates[0] : '',
      rangeEnd: billDates.length ? billDates[billDates.length - 1] : '',
      generatedAt: generatedAt,
      billsCount: bills.length,
      itemCount: allItems.length,
      openItemCount: openItems.length,
      participantCount: participants.length
    };
  }


  /* ---------------------------- render --------------------------- */

  function sectionHead(eyebrow, title, note) {
    return '<div class="pdf-section-head">' +
      '<div><span class="pdf-eyebrow">' + eyebrow + '</span><h2>' + title + '</h2></div>' +
      (note ? '<p class="pdf-section-note">' + note + '</p>' : '') +
    '</div>';
  }

  function metaItem(label, value) {
    return '<div class="pdf-meta">' +
      '<span class="pdf-meta-label">' + label + '</span>' +
      '<span class="pdf-meta-value">' + value + '</span>' +
    '</div>';
  }

  function renderHero(model) {
    var period;
    if (!model.rangeStart) {
      period = 'No dated bills';
    } else if (model.rangeStart === model.rangeEnd) {
      period = formatDate(model.rangeStart);
    } else {
      period = formatDate(model.rangeStart) + ' &ndash; ' + formatDate(model.rangeEnd);
    }

    return '<header class="pdf-hero">' +
      '<div class="pdf-hero-top">' +
        '<div class="pdf-brand">' +
          '<span class="pdf-mark" aria-hidden="true">' + icon(ICONS.receipt) + '</span>' +
          '<span class="pdf-brand-text">' +
            '<span class="pdf-wordmark">SplitTrack</span>' +
            '<span class="pdf-tagline">Bills, split fairly</span>' +
          '</span>' +
        '</div>' +
        '<span class="pdf-statement-pill">Expense statement</span>' +
      '</div>' +
      '<div class="pdf-hero-title">' +
        '<h1>Expense Statement</h1>' +
        '<p>Every bill, every share, every amount &mdash; laid out to be checked.</p>' +
      '</div>' +
      '<div class="pdf-meta-grid">' +
        metaItem('Prepared for', escapeHtml(model.userName)) +
        metaItem('Generated', model.generatedAt) +
        metaItem('Currency', escapeHtml(model.currency)) +
        metaItem('Period', period) +
      '</div>' +
    '</header>';
  }

  function summaryCard(tone, label, value, sub, iconPaths, valueClass) {
    return '<article class="pdf-card pdf-card-' + tone + '">' +
      '<div class="pdf-card-top">' +
        '<span class="pdf-card-label">' + label + '</span>' +
        '<span class="pdf-card-icon">' + icon(iconPaths) + '</span>' +
      '</div>' +
      '<div class="pdf-card-value' + (valueClass ? ' ' + valueClass : '') + '">' + value + '</div>' +
      '<div class="pdf-card-sub">' + sub + '</div>' +
    '</article>';
  }

  function factHtml(count, label) {
    return '<span class="pdf-fact"><strong>' + count + '</strong> ' +
      plural(count, label) + '</span>';
  }

  function renderSummary(model) {
    var netClass = '';
    var netSub = 'Paid equals your share';
    if (model.yourOpenNet > TOLERANCE) {
      netClass = 'is-positive';
      netSub = 'You are owed across open items';
    } else if (model.yourOpenNet < -TOLERANCE) {
      netClass = 'is-negative';
      netSub = 'You owe across open items';
    }

    return '<section class="pdf-section pdf-summary">' +
      sectionHead('At a glance', 'Summary', 'Totals include settled items; open figures do not.') +
      '<div class="pdf-summary-grid">' +
        summaryCard('total', 'Total spend', formatMoney(model.totalSpend, model.currency),
          'Tax and discounts included', ICONS.wallet) +
        summaryCard('share', 'Your share', formatMoney(model.yourShare, model.currency),
          'Your portion of all items', ICONS.user) +
        summaryCard('open', 'Open spend', formatMoney(model.openSpend, model.currency),
          'Unsettled items only', ICONS.clock) +
        summaryCard('net', 'Your open net',
          formatMoney(model.yourOpenNet, model.currency, { plus: true }),
          netSub, ICONS.scale, netClass) +
      '</div>' +
      '<div class="pdf-facts">' +
        factHtml(model.billsCount, 'bill') +
        '<span class="pdf-dot">&middot;</span>' +
        factHtml(model.itemCount, 'item') +
        '<span class="pdf-dot">&middot;</span>' +
        factHtml(model.participantCount, 'participant') +
        '<span class="pdf-dot">&middot;</span>' +
        factHtml(model.settledCount, 'settled item') +
      '</div>' +
    '</section>';
  }

  function balanceRowsHtml(model) {
    return model.balanceRows.map(function (row) {
      var netClass = '';
      if (row.net > TOLERANCE) netClass = 'is-positive';
      else if (row.net < -TOLERANCE) netClass = 'is-negative';
      return '<tr>' +
        '<td class="pdf-balance-person" data-label="Person">' +
          personHtml(row.person, model.userName) +
        '</td>' +
        '<td class="pdf-num pdf-money-cell" data-label="Paid">' +
          formatMoney(row.paid, model.currency) +
        '</td>' +
        '<td class="pdf-num pdf-money-cell" data-label="Share">' +
          formatMoney(row.share, model.currency) +
        '</td>' +
        '<td class="pdf-num pdf-money-cell ' + netClass + '" data-label="Net">' +
          formatMoney(row.net, model.currency, { plus: true }) +
        '</td>' +
      '</tr>';
    }).join('');
  }

  function settlementsHtml(model) {
    var inner;
    if (!model.settlements.length) {
      var settledClass = 'pdf-settled-up';
      var title = 'Everyone is settled up.';
      var sub = 'No open transfers are needed.';
      if (model.unknownOpenNames.length && Math.abs(model.totalNet) > TOLERANCE) {
        settledClass += ' is-warn';
        title = 'No participant transfers suggested.';
        sub = 'Some open entries are outside Participants. See Data checks.';
      }
      inner = '<div class="' + settledClass + '">' +
        icon(ICONS.check) +
        '<div><strong>' + title + '</strong><span>' + sub + '</span></div>' +
      '</div>';
    } else {
      inner = '<div class="pdf-settle-list">' +
        model.settlements.map(function (suggestion) {
          var verb = suggestion.from === model.userName ? 'owe' : 'owes';
          return '<div class="pdf-settle-row">' +
            '<span class="pdf-settle-text">' +
              personHtml(suggestion.from, model.userName) +
              ' <span class="pdf-settle-verb">' + verb + '</span> ' +
              personHtml(suggestion.to, model.userName) +
            '</span>' +
            '<span class="pdf-settle-amount">' +
              formatMoney(suggestion.amount, model.currency) +
            '</span>' +
          '</div>';
        }).join('') +
      '</div>';
    }

    var settlementRoundingNote = '';
    var settlementRounding = model.settlementDisplayRounding;
    if (settlementRounding && settlementRounding.has) {
      settlementRoundingNote = '<p class="pdf-rounding-note">' + icon(ICONS.info) +
        '<span><strong>Display rounding:</strong> the rounded transfers add to ' +
        formatMoney(settlementRounding.transferDisplayTotal, model.currency) +
        '; rounded positive nets total ' +
        formatMoney(settlementRounding.positiveNetDisplayTotal, model.currency) +
        ' (' + formatMoney(Math.abs(settlementRounding.delta), model.currency) +
        ' difference). Transfer math uses raw balances; this is display-only.</span></p>';
    }

    return '<div class="pdf-settle">' +
      '<div class="pdf-settle-head">' +
        '<h3>Settlement suggestions</h3>' +
        '<span class="pdf-method-tag">Greedy matching</span>' +
      '</div>' +
      inner +
      settlementRoundingNote +
      '<p class="pdf-note">' + icon(ICONS.info) +
        '<span>Open balances only. Suggestions minimise transfers; they are not a record of payments made.</span>' +
      '</p>' +
    '</div>';
  }

  function renderBalances(model) {
    var unknownNote = '';
    if (model.unknownOpenNames.length) {
      unknownNote = '<p class="pdf-warning-note">' + icon(ICONS.warning) +
        '<span><strong>' + model.unknownOpenNames.length + ' open ' +
        plural(model.unknownOpenNames.length, 'name') + '</strong> outside Participants ' +
        (model.unknownOpenNames.length === 1 ? 'is' : 'are') +
        ' excluded from these balances: ' +
        quotedNamesHtml(model.unknownOpenNames) +
        '. See Data checks.</span></p>';
    }

    var totalNote = '';
    if (Math.abs(model.totalNet) > TOLERANCE) {
      totalNote = '<p class="pdf-warning-note">' + icon(ICONS.warning) +
        '<span>Participant balances do not net to zero (open difference ' +
        formatMoney(Math.abs(model.totalNet), model.currency) +
        '). Check payer and share names in Data checks.</span></p>';
    }

    var totalRow = '<tr class="pdf-total-row">' +
      '<td class="pdf-balance-person" data-label="Person">Total</td>' +
      '<td class="pdf-num pdf-money-cell" data-label="Paid">' +
        formatMoney(model.totalPaid, model.currency) +
      '</td>' +
      '<td class="pdf-num pdf-money-cell" data-label="Share">' +
        formatMoney(model.totalShare, model.currency) +
      '</td>' +
      '<td class="pdf-num pdf-money-cell" data-label="Net">' +
        formatMoney(model.totalNet, model.currency, { plus: true }) +
      '</td>' +
    '</tr>';

    var balanceRoundingNote = '';
    var balanceRounding = model.balanceDisplayRounding;
    if (balanceRounding && balanceRounding.has) {
      var roundingParts = [];
      if (Math.abs(balanceRounding.paidDelta) > 0.004) {
        roundingParts.push('paid ' + formatMoney(balanceRounding.paidDisplayTotal, model.currency) +
          ' vs ' + formatMoney(model.totalPaid, model.currency));
      }
      if (Math.abs(balanceRounding.shareDelta) > 0.004) {
        roundingParts.push('shares ' + formatMoney(balanceRounding.shareDisplayTotal, model.currency) +
          ' vs ' + formatMoney(model.totalShare, model.currency));
      }
      if (Math.abs(balanceRounding.netDelta) > 0.004) {
        roundingParts.push('net ' + formatMoney(balanceRounding.netDisplayTotal, model.currency, { plus: true }) +
          ' vs ' + formatMoney(model.totalNet, model.currency, { plus: true }));
      }
      balanceRoundingNote = '<p class="pdf-rounding-note">' + icon(ICONS.info) +
        '<span><strong>Display rounding:</strong> the rounded rows add to ' +
        roundingParts.join('; ') +
        '. Raw totals are unchanged; this is a 2-decimal display effect.</span></p>';
    }

    return '<section class="pdf-section pdf-balances">' +
      sectionHead('Open items only', 'Balances',
        'Settled items are excluded from paid, share and net.') +
      '<div class="pdf-panel">' +
        '<div class="pdf-panel-head">' +
          '<span class="pdf-panel-title">Paid minus share, by person</span>' +
          '<span class="pdf-mini-chip">Settled items excluded</span>' +
        '</div>' +
        '<table class="pdf-balance-table">' +
          '<caption class="pdf-sr-only">Open balances by participant. Net equals paid minus share.</caption>' +
          '<thead><tr>' +
            '<th scope="col">Person</th>' +
            '<th scope="col" class="pdf-num">Paid</th>' +
            '<th scope="col" class="pdf-num">Share</th>' +
            '<th scope="col" class="pdf-num">Net</th>' +
          '</tr></thead>' +
          '<tbody>' + balanceRowsHtml(model) + '</tbody>' +
          '<tfoot>' + totalRow + '</tfoot>' +
        '</table>' +
        balanceRoundingNote +
        '<p class="pdf-note">' + icon(ICONS.info) +
          '<span>Balances use each item&rsquo;s recorded payer. Settled items stay in totals and bill tables but are excluded here.</span>' +
        '</p>' +
        unknownNote +
        totalNote +
        settlementsHtml(model) +
      '</div>' +
    '</section>';
  }

  function renderBillFooter(bill, model) {
    var diffClass = Math.abs(bill.difference) > TOLERANCE ? 'is-bad' : 'is-good';
    var reconciliation;

    if (!bill.issues.length) {
      reconciliation = '<span class="pdf-recon is-good">' +
        icon(ICONS.check) + 'Reconciled</span>';
    } else {
      var note;
      if (Math.abs(bill.difference) > TOLERANCE) {
        note = 'Totals off by ' + formatMoney(Math.abs(bill.difference), model.currency);
      } else if (bill.synthetic) {
        note = 'Unlinked items';
      } else if (!bill.items.length) {
        note = 'No items';
      } else {
        note = bill.itemIssueCount + ' ' +
          plural(bill.itemIssueCount, 'item check') + ' flagged';
      }
      reconciliation = '<span class="pdf-recon is-warn">' +
        icon(ICONS.warning) + note + '</span>';
    }

    var roundingChip = '';
    var roundingLine = '';
    if (bill.hasRounding) {
      roundingChip = '<span class="pdf-rounding-chip">' + icon(ICONS.info) +
        'Rounding note</span>';
      if (Math.abs(bill.displayedDifference) > 0.004) {
        roundingLine = '<div class="pdf-bill-rounding"><strong>Display rounding:</strong> ' +
          'rounded shares add to ' + formatMoney(bill.displayedShareTotal, model.currency) +
          '; raw shares total ' + formatMoney(bill.shareTotal, model.currency) + ' (' +
          formatMoney(Math.abs(bill.displayedDifference), model.currency) +
          (bill.displayedDifference < 0 ? ' less' : ' more') +
          '). Raw reconciliation is unchanged.</div>';
      } else {
        roundingLine = '<div class="pdf-bill-rounding"><strong>Display rounding:</strong> ' +
          'one or more shown shares are rounded to 2 decimals. Raw shares reconcile; see Rounding notes.</div>';
      }
    }

    return '<div class="pdf-bill-foot">' +
      '<div class="pdf-foot-figures">' +
        '<span class="pdf-foot-figure"><span>Items total</span><strong>' +
          formatMoney(bill.itemTotal, model.currency) + '</strong></span>' +
        '<span class="pdf-foot-figure"><span>Shares total</span><strong>' +
          formatMoney(bill.shareTotal, model.currency) + '</strong></span>' +
        '<span class="pdf-foot-figure"><span>Difference</span><strong class="' + diffClass + '">' +
          formatMoney(bill.difference, model.currency, { plus: true }) + '</strong></span>' +
      '</div>' +
      reconciliation +
      roundingChip +
      roundingLine +
    '</div>';
  }

  function renderItemRow(item, bill, model) {
    var badges = '';
    if (item.kind === 'tax') {
      badges += '<span class="pdf-kind is-tax">Tax / fee</span>';
    } else if (item.kind === 'discount') {
      badges += '<span class="pdf-kind is-discount">Discount</span>';
    }

    var payerChip = '';
    if (item.paidBy !== bill.payer) {
      payerChip = '<span class="pdf-chip is-warning">Paid by ' +
        (item.paidBy ? personDetailedHtml(item.paidBy, model.userName) : 'not set') +
        '</span>';
    }

    var shares = item.splits.map(function (split) {
      var classes = 'pdf-share';
      if (round2(split.value) < 0) classes += ' is-negative';
      if (split.name === model.userName) classes += ' is-you';
      if (model.participants.indexOf(split.name) === -1) classes += ' is-unknown';
      return '<span class="' + classes + '">' +
        '<span class="pdf-share-name">' + personHtml(split.name, model.userName) + '</span>' +
        '<span class="pdf-share-amt">' + formatMoney(split.value, model.currency) + '</span>' +
      '</span>';
    }).join('');

    if (!shares) {
      shares = '<span class="pdf-no-shares">No shares assigned</span>';
    }

    var flag = '';
    if (item.issueReasons.length) {
      var labels = item.issueReasons.map(function (reason) {
        return escapeHtml(reason.label);
      }).join(' &middot; ');
      flag = '<div class="pdf-item-flag ' +
        (item.issueSeverity === 'error' ? 'is-error' : 'is-warn') + '">' +
        icon(ICONS.warning) +
        '<span>' + labels + ' &mdash; see Data checks</span>' +
      '</div>';
    }

    var roundingFlag = '';
    if (item.roundingNote) {
      roundingFlag = '<div class="pdf-item-flag is-rounding">' + icon(ICONS.info) +
        '<span>Display rounding: shown shares add to ' +
          formatMoney(item.roundingNote.displayedShareTotal, model.currency) +
          '; raw shares total ' +
          formatMoney(item.roundingNote.rawShareSum, model.currency) +
          ' (' + formatMoney(Math.abs(item.roundingNote.residual), model.currency) +
          (item.roundingNote.residual < 0 ? ' less' : ' more') +
          '). Display only.</span>' +
      '</div>';
    }

    return '<tr class="pdf-item-row' + (item.settled ? ' is-settled' : '') + '">' +
      '<td>' +
        '<div class="pdf-item-title">' +
          escapeHtml(item.description) + badges +
        '</div>' +
        '<div class="pdf-item-meta">' +
          '<span class="pdf-cat">' + escapeHtml(item.category) + '</span>' +
          '<span class="pdf-method">' + splitMethodLabel(item.splitMethod) + '</span>' +
          '<span class="pdf-chip ' + (item.settled ? 'is-settled' : 'is-open') + '">' +
            (item.settled ? 'Settled' : 'Unsettled') +
          '</span>' +
          payerChip +
        '</div>' +
        '<div class="pdf-shares">' + shares + '</div>' +
        flag +
        roundingFlag +
      '</td>' +
      '<td class="pdf-num">' +
        '<span class="pdf-item-amount' + (round2(item.amount) < 0 ? ' is-negative' : '') + '">' +
          formatMoney(item.amount, model.currency) +
        '</span>' +
      '</td>' +
    '</tr>';
  }

  function renderBill(bill, index, model) {
    var table;
    if (bill.items.length) {
      table = '<table class="pdf-items">' +
        '<caption class="pdf-sr-only">Items and shares for ' + escapeHtml(bill.name) + '</caption>' +
        '<thead><tr>' +
          '<th scope="col"><span class="pdf-th-bill">' + escapeHtml(bill.name) +
            '</span>Item &amp; shares</th>' +
          '<th scope="col" class="pdf-num">Amount</th>' +
        '</tr></thead>' +
        '<tbody>' +
          bill.items.map(function (item) {
            return renderItemRow(item, bill, model);
          }).join('') +
        '</tbody>' +
      '</table>';
    } else {
      table = '<div class="pdf-empty-bill">No items in this bill.</div>';
    }

    var unlinkedChip = bill.synthetic
      ? '<span class="pdf-chip is-warning">Unlinked</span>'
      : '';

    return '<article class="pdf-bill">' +
      '<div class="pdf-bill-head">' +
        '<div class="pdf-bill-main">' +
          '<div class="pdf-bill-kicker">Bill ' + pad2(index + 1) +
            ' <span class="pdf-bill-meta-dot">&middot;</span>' +
            '<span class="pdf-bill-date">' + formatDate(bill.date) + '</span>' +
            unlinkedChip +
          '</div>' +
          '<h3 class="pdf-bill-name">' + escapeHtml(bill.name) + '</h3>' +
          '<div class="pdf-bill-meta">' +
            '<span>Paid by ' + (bill.payer
              ? '<strong>' + personHtml(bill.payer, model.userName) + '</strong>'
              : '<span class="pdf-muted">Not set</span>') + '</span>' +
            '<span class="pdf-bill-meta-dot">&middot;</span>' +
            '<span>' + bill.items.length + ' ' + plural(bill.items.length, 'item') + '</span>' +
            (bill.peopleCount
              ? '<span class="pdf-bill-meta-dot">&middot;</span><span>' +
                bill.peopleCount + ' ' + plural(bill.peopleCount, 'person', 'people') + '</span>'
              : '') +
          '</div>' +
        '</div>' +
        '<div class="pdf-bill-side">' +
          '<span class="pdf-status ' + bill.status.key + '">' + bill.status.label + '</span>' +
          '<span class="pdf-bill-total">' + formatMoney(bill.itemTotal, model.currency) + '</span>' +
          '<span class="pdf-bill-total-label">Bill total</span>' +
        '</div>' +
      '</div>' +
      table +
      renderBillFooter(bill, model) +
    '</article>';
  }

  function renderBills(model) {
    var content;
    if (!model.bills.length) {
      content = '<div class="pdf-empty">' +
        '<div class="pdf-empty-icon">' + icon(ICONS.receipt) + '</div>' +
        '<strong>No bills yet</strong>' +
        '<p>Add a bill in SplitTrack, then build the statement again.</p>' +
      '</div>';
    } else {
      content = model.bills.map(function (bill, index) {
        return renderBill(bill, index, model);
      }).join('');
    }

    return '<section class="pdf-section pdf-bills">' +
      sectionHead('Line by line', 'Bills', 'Oldest first &middot; every item shows its shares') +
      '<div class="pdf-bill-list">' + content + '</div>' +
    '</section>';
  }

  function renderIssue(issue) {
    var where;
    if (issue.scope === 'item') {
      where = escapeHtml(issue.bill.name);
      if (issue.item.description !== issue.bill.name) {
        where += '<span class="pdf-issue-sep">/</span>' +
          escapeHtml(issue.item.description);
      }
    } else {
      where = escapeHtml(issue.bill.name);
    }

    var reasons = issue.reasons.map(function (reason) {
      return '<li><span class="pdf-reason-label">' + escapeHtml(reason.label) +
        '</span><span>' + reason.detail + '</span></li>';
    }).join('');

    var severityLabel = issue.isAmount
      ? 'Amount check'
      : (issue.severity === 'error' ? 'Integrity check' : 'Data check');

    return '<article class="pdf-issue ' +
      (issue.severity === 'error' ? 'is-error' : 'is-warn') + '">' +
      '<div class="pdf-issue-head">' +
        '<span class="pdf-sev">' + severityLabel + '</span>' +
        '<span class="pdf-issue-where">' + where + '</span>' +
      '</div>' +
      '<ul class="pdf-reasons">' + reasons + '</ul>' +
    '</article>';
  }

  function renderRoundingNote(note, model) {
    var where;
    if (note.scope === 'item') {
      where = escapeHtml(note.bill.name);
      if (note.item.description !== note.bill.name) {
        where += '<span class="pdf-issue-sep">/</span>' +
          escapeHtml(note.item.description);
      }
    } else {
      where = escapeHtml(note.bill.name);
    }

    var amountLabel = note.scope === 'item' ? 'item amount' : 'bill total';
    var rawExact = Math.abs(round2(note.rawShareSum - note.amount)) <= 0.0001;
    return '<article class="pdf-rounding-item">' +
      '<div class="pdf-rounding-where">' + where + '</div>' +
      '<p>Raw shares total ' + formatMoney(note.rawShareSum, model.currency) +
        ' against the ' + amountLabel + ' of ' +
        formatMoney(note.amount, model.currency) + '. ' +
        (rawExact
          ? 'The raw split is exact.'
          : 'The raw split is within ' + formatMoney(TOLERANCE, model.currency) +
            ' of the ' + amountLabel + '.') +
        ' The displayed 2-decimal shares add to ' +
        formatMoney(note.displayedShareTotal, model.currency) +
        (Math.abs(note.residual) > 0.004
          ? ' (' + formatMoney(Math.abs(note.residual), model.currency) +
            (note.residual < 0 ? ' less' : ' more') + ')'
          : '') +
        '. This is display rounding only; no money is missing.</p>' +
      '<div class="pdf-rounding-metrics">' +
        '<span>Raw ' + formatMoney(note.rawShareSum, model.currency) + '</span>' +
        '<span>Displayed ' + formatMoney(note.displayedShareTotal, model.currency) + '</span>' +
        '<span>Residual ' + formatMoney(note.residual, model.currency, { plus: true }) + '</span>' +
      '</div>' +
    '</article>';
  }

  function renderChecks(model) {
    var body;
    if (!model.issues.length) {
      var sub = model.itemCount
        ? model.billsCount + ' ' + plural(model.billsCount, 'bill') + ' and ' +
          model.itemCount + ' ' + plural(model.itemCount, 'item') +
          ' checked. No raw share gaps, bill mismatches, payer conflicts or unknown names.'
        : 'No items in this statement yet. Add a bill to populate the checks.';
      if (model.roundingNotes.length) {
        sub += ' Raw totals reconcile; ' + model.roundingNotes.length + ' ' +
          plural(model.roundingNotes.length, 'display-rounding note') + ' below.';
      }
      body = '<div class="pdf-clean-banner">' + icon(ICONS.check) +
        '<div><strong>All totals reconcile</strong><p>' + sub + '</p></div>' +
      '</div>';
    } else {
      var summaryClass = model.errorCount ? 'is-error' : '';
      var amountText = model.amountFindingCount
        ? model.amountFindingCount + ' ' +
          plural(model.amountFindingCount, 'amount issue') + ' flagged'
        : 'No amount errors';
      var otherText = model.otherFindingCount
        ? model.otherFindingCount + ' ' +
          plural(model.otherFindingCount, 'other issue') + ' flagged'
        : 'No other issues';
      var roundingText = model.roundingNotes.length
        ? ' &middot; ' + model.roundingNotes.length + ' ' +
          plural(model.roundingNotes.length, 'display-rounding note')
        : '';
      body = '<div class="pdf-check-summary ' + summaryClass + '">' +
        '<span class="pdf-check-count">' + model.issues.length + '</span>' +
        '<div><strong>' + model.issues.length + ' data ' +
          plural(model.issues.length, 'check') + ' ' +
          (model.issues.length === 1 ? 'needs' : 'need') + ' attention</strong>' +
          '<p>' + amountText + ' &middot; ' + otherText + roundingText + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="pdf-issues">' +
        model.issues.map(renderIssue).join('') +
      '</div>';
    }

    var roundingBlock = '';
    if (model.roundingNotes.length) {
      roundingBlock = '<div class="pdf-rounding-notes">' +
        '<div class="pdf-rounding-head">' +
          '<div><span class="pdf-eyebrow">Display only</span><h3>Rounding notes</h3></div>' +
          '<span class="pdf-rounding-chip">' + icon(ICONS.info) + 'Not an error</span>' +
        '</div>' +
        '<p class="pdf-rounding-intro">Raw shares reconcile. A 2-decimal display can leave a 0.01 difference; it is explained here and is not counted as a data error.</p>' +
        model.roundingNotes.map(function (note) {
          return renderRoundingNote(note, model);
        }).join('') +
      '</div>';
    }

    return '<section class="pdf-section pdf-checks">' +
      sectionHead('Accuracy', 'Data checks',
        'Every share, payer and bill total is verified.') +
      body +
      roundingBlock +
      '<p class="pdf-method-note">Method: item and bill totals are rounded to 2 decimals; differences of ' +
        formatMoney(TOLERANCE, model.currency) +
        ' or less are treated as matching. Names are compared with Participants after trimming spaces. ' +
        'Settled items are included in reconciliation. Displayed shares are rounded to 2 decimals; see Rounding notes where displayed cents differ from raw totals.</p>' +
    '</section>';
  }

  function renderFooter(model) {
    return '<footer class="pdf-footer">' +
      '<span><strong>SplitTrack</strong> &middot; Expense Statement</span>' +
      '<span>Generated <strong>' + model.generatedAt +
        '</strong> &middot; amounts in <strong>' + escapeHtml(model.currency) + '</strong></span>' +
    '</footer>';
  }

  function renderReport(model) {
    return '<div class="pdf-report">' +
      renderHero(model) +
      '<main class="pdf-body">' +
        renderSummary(model) +
        renderBalances(model) +
        renderBills(model) +
        renderChecks(model) +
      '</main>' +
      renderFooter(model) +
    '</div>';
  }

  function buildReportHtml(data) {
    return renderReport(buildModel(data));
  }

  /* --------------------------- public API ------------------------ */

  function ensureStyles(doc) {
    var existing = doc.getElementById(STYLE_ID);
    if (existing) {
      if (existing.getAttribute('data-version') !== CSS_VERSION) {
        existing.textContent = REPORT_CSS;
        existing.setAttribute('data-version', CSS_VERSION);
      }
      return existing;
    }

    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-split-track-pdf', 'report');
    style.setAttribute('data-version', CSS_VERSION);
    style.textContent = REPORT_CSS;
    var head = doc.head || doc.getElementsByTagName('head')[0] || doc.documentElement;
    head.appendChild(style);
    return style;
  }

  function renderInto(container, data) {
    if (!container || typeof container !== 'object') {
      throw new Error('SplitTrackPdfReport.renderInto: a container element is required.');
    }
    var doc = container.ownerDocument ||
      (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElement !== 'function') {
      throw new Error('SplitTrackPdfReport.renderInto: a browser document is required.');
    }
    ensureStyles(doc);
    container.innerHTML = buildReportHtml(data);
    return container;
  }

  function buildStandaloneHtml(data) {
    return '<!DOCTYPE html>\n' +
      '<html lang="en">\n' +
      '<head>\n' +
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<meta name="color-scheme" content="light">\n' +
      '<title>SplitTrack Expense Statement</title>\n' +
      '<style>\n' + REPORT_CSS + '\n</style>\n' +
      '</head>\n' +
      '<body class="pdf-standalone">\n' +
      buildReportHtml(data) + '\n' +
      '</body>\n' +
      '</html>';
  }

  var api = {
    renderInto: renderInto,
    buildStandaloneHtml: buildStandaloneHtml
  };

  if (typeof window !== 'undefined') {
    window.SplitTrackPdfReport = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();

