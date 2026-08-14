// Локализация поверх chrome.i18n. Тексты — в _locales/{en,ru}/messages.json;
// default_locale = en, браузер с русским интерфейсом получает ru автоматически.
//
// В разметке текст остаётся авторским (русским) и служит запасным: если ключ
// не найден, getMessage вернёт пустую строку, и мы НЕ затираем то, что есть.
// Поэтому опечатка в ключе деградирует до русского текста, а не до дыры в UI.

/** getMessage с подстановками; пустая строка, если ключа нет. */
export function t(key, subs) {
  return chrome.i18n.getMessage(key, subs) || "";
}

/**
 * Проставить переводы по data-атрибутам:
 *   data-i18n             — textContent
 *   data-i18n-html        — innerHTML (ТОЛЬКО наши строки из messages.json,
 *                           пользовательские данные сюда не попадают)
 *   data-i18n-placeholder — placeholder
 *   data-i18n-title       — title
 */
export function localizeDom(root = document) {
  document.documentElement.lang = chrome.i18n.getUILanguage().split("-")[0];
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const msg = t(el.dataset.i18n);
    if (msg) el.textContent = msg;
  }
  for (const el of root.querySelectorAll("[data-i18n-html]")) {
    const msg = t(el.dataset.i18nHtml);
    if (msg) el.innerHTML = msg;
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    const msg = t(el.dataset.i18nPlaceholder);
    if (msg) el.placeholder = msg;
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    const msg = t(el.dataset.i18nTitle);
    if (msg) el.title = msg;
  }
}
