const { PLATFORM, MSG, platformFromUrl } = require('../shared/constants');
const { classifyResponse, parseMenuResponse } = require('../shared/parsers');

const platform = platformFromUrl(window.location.href);
if (!platform) throw new Error('FeedMe: scraper loaded on unsupported URL');

// Guard against double-injection
if (window._feedmeScraperActive) return;
window._feedmeScraperActive = true;

function handleJson(url, data) {
  if (!data || typeof data !== 'object') return;
  const classification = classifyResponse(platform, data);
  if (!classification) return;
  let parsed;
  try {
    parsed = parseMenuResponse(platform, data);
  } catch (_) {
    return;
  }
  chrome.runtime.sendMessage({ type: MSG.PLATFORM_DATA, platform, classification, parsed, sourceUrl: url });
}

// Patch fetch
const _fetch = window.fetch.bind(window);
window.fetch = async function (...args) {
  const response = await _fetch(...args);
  const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
  response.clone().json().then((data) => handleJson(url, data)).catch(() => {});
  return response;
};

// Patch XHR
const _xhrOpen = XMLHttpRequest.prototype.open;
const _xhrSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method, url) {
  this._feedmeUrl = url;
  return _xhrOpen.apply(this, arguments);
};
XMLHttpRequest.prototype.send = function () {
  this.addEventListener('load', () => {
    try { handleJson(this._feedmeUrl ?? '', JSON.parse(this.responseText)); } catch (_) {}
  });
  return _xhrSend.apply(this, arguments);
};
