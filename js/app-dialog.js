/* ------------------------------------------------------------------
   SplitTrack dialog + toast system.

   Replaces browser-native alert()/confirm() popups with themed in-app
   dialogs. Exposes:
     AppDialog.alert(message, options) -> Promise
     AppDialog.confirm(message, options) -> Promise<boolean>
     AppDialog.toast(message, type, duration)
   Also installs window.alert so every remaining alert() call is themed.
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  var ICON_PATHS = {
    info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    warning: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
    error: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z',
    success: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    question: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
  };

  var TYPE_CLASSES = {
    info: { iconBox: 'bg-indigo-50 text-indigo-600 border-indigo-100', bar: 'bg-indigo-500', button: 'bg-indigo-600 hover:bg-indigo-700' },
    question: { iconBox: 'bg-indigo-50 text-indigo-600 border-indigo-100', bar: 'bg-indigo-500', button: 'bg-indigo-600 hover:bg-indigo-700' },
    warning: { iconBox: 'bg-amber-50 text-amber-600 border-amber-100', bar: 'bg-amber-500', button: 'bg-amber-600 hover:bg-amber-700' },
    error: { iconBox: 'bg-red-50 text-red-600 border-red-100', bar: 'bg-red-500', button: 'bg-red-600 hover:bg-red-700' },
    success: { iconBox: 'bg-emerald-50 text-emerald-600 border-emerald-100', bar: 'bg-emerald-500', button: 'bg-emerald-600 hover:bg-emerald-700' }
  };

  var activeDialog = null;
  var previousFocus = null;
  var toastSeq = 0;

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function iconSvg(name, cls) {
    var path = ICON_PATHS[name] || ICON_PATHS.info;
    return '<svg class="' + (cls || 'w-5 h-5') + '" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="' + path + '"></path></svg>';
  }

  function ensureDialog() {
    if (document.getElementById('app-dialog')) return;
    var wrap = document.createElement('div');
    wrap.id = 'app-dialog';
    wrap.className = 'hide fixed inset-0 z-[130] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
    wrap.setAttribute('role', 'presentation');
    wrap.innerHTML =
      '<div id="app-dialog-card" class="bg-white w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title" aria-describedby="app-dialog-message">' +
        '<div class="p-4">' +
          '<div class="flex items-start gap-3">' +
            '<div id="app-dialog-icon" class="flex-shrink-0 w-10 h-10 rounded-full border flex items-center justify-center"></div>' +
            '<div class="flex-1 min-w-0 pt-0.5">' +
              '<h3 id="app-dialog-title" class="font-bold text-gray-800 text-base leading-snug"></h3>' +
              '<p id="app-dialog-message" class="text-sm text-gray-600 mt-1 whitespace-pre-wrap break-words leading-relaxed"></p>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div id="app-dialog-actions" class="p-3 bg-gray-50 border-t border-gray-200 flex justify-end gap-2"></div>' +
      '</div>';
    document.body.appendChild(wrap);
  }

  function closeDialog(value) {
    var dialog = activeDialog;
    if (!dialog) return;
    activeDialog = null;
    var wrap = document.getElementById('app-dialog');
    if (wrap) wrap.classList.add('hide');
    if (dialog.keyHandler) document.removeEventListener('keydown', dialog.keyHandler);
    if (previousFocus && typeof previousFocus.focus === 'function') {
      try { previousFocus.focus(); } catch (err) { /* ignore */ }
    }
    previousFocus = null;
    if (dialog.resolve) dialog.resolve(value);
  }

  function focusableButtons(card) {
    return Array.prototype.slice.call(card.querySelectorAll('button:not([disabled])'));
  }

  function show(options) {
    options = options || {};
    ensureDialog();

    if (activeDialog) closeDialog(null);

    var wrap = document.getElementById('app-dialog');
    var card = document.getElementById('app-dialog-card');
    var iconBox = document.getElementById('app-dialog-icon');
    var titleEl = document.getElementById('app-dialog-title');
    var messageEl = document.getElementById('app-dialog-message');
    var actions = document.getElementById('app-dialog-actions');
    if (!wrap || !card || !iconBox || !titleEl || !messageEl || !actions) {
      return Promise.resolve(false);
    }

    var type = TYPE_CLASSES[options.type] ? options.type : 'info';
    var typeClass = TYPE_CLASSES[type];
    var iconName = options.icon || type;
    if (!ICON_PATHS[iconName]) iconName = type;

    titleEl.textContent = options.title || 'Notice';
    messageEl.textContent = options.message || '';
    iconBox.className = 'flex-shrink-0 w-10 h-10 rounded-full border flex items-center justify-center ' + typeClass.iconBox;
    iconBox.innerHTML = iconSvg(iconName);

    var buttons = Array.isArray(options.buttons) && options.buttons.length
      ? options.buttons.slice()
      : [{ label: 'OK', value: true, style: 'primary' }];

    actions.innerHTML = '';
    var buttonEls = [];
    buttons.forEach(function (button, index) {
      var el = document.createElement('button');
      el.type = 'button';
      var style = button.style || (index === buttons.length - 1 ? 'primary' : 'secondary');
      if (style === 'danger') {
        el.className = 'px-4 py-2 rounded-lg text-sm font-bold text-white bg-red-600 hover:bg-red-700 transition-colors';
      } else if (style === 'primary') {
        el.className = 'px-4 py-2 rounded-lg text-sm font-bold text-white ' + typeClass.button + ' transition-colors';
      } else {
        el.className = 'px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-200 transition-colors';
      }
      el.textContent = button.label || 'OK';
      el.addEventListener('click', function () { closeDialog(button.value); });
      actions.appendChild(el);
      buttonEls.push(el);
    });

    previousFocus = document.activeElement;
    wrap.classList.remove('hide');

    var keyHandler = function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog(options.cancelValue !== undefined ? options.cancelValue : null);
        return;
      }
      if (event.key === 'Tab') {
        var focusables = focusableButtons(card);
        if (!focusables.length) return;
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', keyHandler);

    wrap.onclick = function (event) {
      if (event.target === wrap) {
        closeDialog(options.cancelValue !== undefined ? options.cancelValue : null);
      }
    };

    var primary = buttonEls.length ? buttonEls[buttonEls.length - 1] : null;
    if (primary) setTimeout(function () { primary.focus(); }, 30);

    return new Promise(function (resolve) {
      activeDialog = { resolve: resolve, keyHandler: keyHandler };
    });
  }

  function alertDialog(message, options) {
    options = options || {};
    return show({
      title: options.title || 'Notice',
      message: message,
      type: options.type || 'info',
      icon: options.icon,
      cancelValue: true,
      buttons: [{ label: options.okLabel || 'OK', value: true, style: 'primary' }]
    });
  }

  function confirmDialog(message, options) {
    options = options || {};
    var danger = !!options.danger;
    return show({
      title: options.title || 'Please confirm',
      message: message,
      type: options.type || (danger ? 'error' : 'warning'),
      icon: options.icon,
      cancelValue: false,
      buttons: [
        { label: options.cancelLabel || 'Cancel', value: false, style: 'secondary' },
        { label: options.confirmLabel || 'Confirm', value: true, style: danger ? 'danger' : 'primary' }
      ]
    }).then(function (value) { return value === true; });
  }

  function ensureToastStack() {
    var stack = document.getElementById('app-toast-stack');
    if (stack) return stack;
    stack = document.createElement('div');
    stack.id = 'app-toast-stack';
    stack.className = 'fixed left-1/2 -translate-x-1/2 bottom-24 z-[140] w-[calc(100%-2rem)] max-w-sm space-y-2 pointer-events-none';
    stack.setAttribute('aria-live', 'polite');
    stack.setAttribute('aria-atomic', 'false');
    document.body.appendChild(stack);
    return stack;
  }

  function toast(message, type, duration) {
    var stack = ensureToastStack();
    var tone = TYPE_CLASSES[type] ? type : 'success';
    var toneClass = TYPE_CLASSES[tone];
    var id = 'app-toast-' + (++toastSeq);
    var el = document.createElement('div');
    el.id = id;
    el.className = 'pointer-events-auto flex items-start gap-2.5 rounded-xl bg-white border border-gray-200 shadow-lg px-3.5 py-3 transition-all duration-200 opacity-0 translate-y-2';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<div class="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ' + toneClass.iconBox + '">' + iconSvg(tone, 'w-4 h-4') + '</div>' +
      '<p class="flex-1 min-w-0 text-sm font-medium text-gray-700 leading-snug break-words">' + esc(message) + '</p>' +
      '<button type="button" class="flex-shrink-0 text-gray-400 hover:text-gray-600 p-0.5" aria-label="Dismiss notification">' +
        '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>' +
      '</button>';

    function remove() {
      if (!el.parentNode) return;
      el.classList.add('opacity-0', 'translate-y-2');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }

    el.querySelector('button').addEventListener('click', remove);
    stack.appendChild(el);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.classList.remove('opacity-0', 'translate-y-2');
      });
    });
    setTimeout(remove, duration || 3400);
  }

  window.AppDialog = {
    alert: alertDialog,
    confirm: confirmDialog,
    toast: toast
  };
  window.appAlert = alertDialog;
  window.appConfirm = confirmDialog;
  window.appToast = toast;

  // Every existing alert() in the app becomes a themed dialog. Callers do not
  // depend on alert's return value, so this is safe.
  window.alert = function (message) {
    return alertDialog(message);
  };
})();
