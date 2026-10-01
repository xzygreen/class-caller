/* global document, window, fetch, AbortController */
'use strict';

(() => {
  const badges = [...document.querySelectorAll('[data-app-version]')];
  if (!badges.length) return;
  let request = null;
  let stopped = false;
  let interval;

  async function refresh() {
    if (stopped || document.hidden || request) return;
    const current = new AbortController();
    request = current;
    const timeout = setTimeout(() => current.abort(), 5000);
    try {
      const response = await fetch('/api/public/version', { cache: 'no-store', signal: current.signal });
      if (!response.ok) return;
      const result = await response.json();
      if (stopped || request !== current || !result || !result.ok || typeof result.version !== 'string'
          || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(result.version)) return;
      for (const badge of badges) {
        badge.textContent = 'v' + result.version;
        badge.setAttribute('aria-label', '部署版本 ' + result.version);
        badge.hidden = false;
      }
    } catch {
      // 连接中断时保留最近一次确认的版本，不用静态资源的版本冒充服务端版本。
    } finally {
      clearTimeout(timeout);
      if (request === current) request = null;
    }
  }

  function resume() {
    stopped = false;
    clearInterval(interval);
    interval = setInterval(refresh, 60_000);
    refresh();
  }

  window.addEventListener('pagehide', () => {
    stopped = true;
    clearInterval(interval);
    request?.abort();
    request = null;
  });
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  resume();
})();
