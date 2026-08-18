// content.js — SPA-aware Job Agent + LLM loading overlay

(function () {

  // ── SPA URL change detection ────────────────────────────────────────────────

  (() => {
    const wrap = (orig, name) => function () {
      const ret = orig.apply(this, arguments);
      window.dispatchEvent(new Event(name));
      window.dispatchEvent(new Event('locationchange'));
      return ret;
    };
    history.pushState    = wrap(history.pushState,    'pushstate');
    history.replaceState = wrap(history.replaceState, 'replacestate');
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));
  })();

  // ── Loading overlay ─────────────────────────────────────────────────────────

  const OVERLAY_ID = 'ja-loading-overlay';

  function showLoadingOverlay(label) {
    if (document.getElementById(OVERLAY_ID)) {
      document.getElementById(OVERLAY_ID + '-label').textContent = label;
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(16px);
      background: #0f1318;
      color: #d4dde8;
      font-family: 'IBM Plex Mono', monospace, monospace;
      font-size: 12px;
      padding: 10px 20px;
      border-radius: 24px;
      border: 1px solid #1e2a38;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      opacity: 0;
      transition: opacity 0.2s ease, transform 0.2s ease;
      pointer-events: none;
      user-select: none;
      white-space: nowrap;
    `;

    const style = document.createElement('style');
    style.id = OVERLAY_ID + '-style';
    style.textContent = `
      @keyframes ja-spin { to { transform: rotate(360deg); } }
      @keyframes ja-pulse-dot { 0%,100%{opacity:1} 50%{opacity:0.3} }
      #${OVERLAY_ID}-spinner {
        width: 14px; height: 14px;
        border: 2px solid #1e2a38;
        border-top-color: #FF9933;
        border-radius: 50%;
        animation: ja-spin 0.7s linear infinite;
        flex-shrink: 0;
      }
      #${OVERLAY_ID}-dots span {
        display: inline-block;
        width: 4px; height: 4px;
        border-radius: 50%;
        background: #FF9933;
        margin-left: 2px;
        animation: ja-pulse-dot 1.2s ease-in-out infinite;
      }
      #${OVERLAY_ID}-dots span:nth-child(2) { animation-delay: 0.2s; }
      #${OVERLAY_ID}-dots span:nth-child(3) { animation-delay: 0.4s; }
    `;
    document.head.appendChild(style);

    const spinner = document.createElement('div');
    spinner.id = OVERLAY_ID + '-spinner';

    const labelEl = document.createElement('span');
    labelEl.id = OVERLAY_ID + '-label';
    labelEl.textContent = label;
    labelEl.style.cssText = 'color:#d4dde8;letter-spacing:0.03em;';

    const dots = document.createElement('span');
    dots.id = OVERLAY_ID + '-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';

    overlay.appendChild(spinner);
    overlay.appendChild(labelEl);
    overlay.appendChild(dots);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.style.opacity = '1';
        overlay.style.transform = 'translateX(-50%) translateY(0)';
      });
    });
  }

  function hideLoadingOverlay() {
    const overlay = document.getElementById(OVERLAY_ID);
    const style   = document.getElementById(OVERLAY_ID + '-style');
    if (!overlay) return;
    overlay.style.opacity   = '0';
    overlay.style.transform = 'translateX(-50%) translateY(10px)';
    setTimeout(() => { overlay.remove(); style?.remove(); }, 220);
  }

  // ── Job Agent pill (bottom-right) ───────────────────────────────────────────

  const STATUS_COLORS = {
    scanning: '#ffb300',
    ready:    '#00e676',
    applied:  '#00e5ff',
    error:    '#ff5252',
    loading:  '#FF9933',
    idle:     '#4a5a6a',
  };

  function createJobAgent() {
    if (document.getElementById('ja-indicator')) return;
    const el = document.createElement('div');
    el.id = 'ja-indicator';
    el.style.cssText = `
      position: fixed; bottom: 20px; right: 20px;
      background: #0f1318; color: #d4dde8;
      font-family: monospace; font-size: 11px;
      padding: 7px 14px; border-radius: 20px;
      border: 1px solid #1e2a38; z-index: 99999;
      display: flex; align-items: center; gap: 7px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      cursor: pointer; user-select: none;
      transition: border-color 0.2s;
    `;
    const dot = document.createElement('span');
    dot.id = 'ja-indicator-dot';
    dot.style.cssText = `
      width: 7px; height: 7px; border-radius: 50%;
      background: #4a5a6a; flex-shrink: 0;
      transition: background 0.3s;
    `;
    const label = document.createElement('span');
    label.id = 'ja-indicator-label';
    label.textContent = 'Job Agent';
    el.appendChild(dot);
    el.appendChild(label);
    document.body.appendChild(el);
    el.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'JOB_AGENT_CLICKED', url: location.href });
    });
  }

  function removeJobAgent() { document.getElementById('ja-indicator')?.remove(); }

  function updateAgentPill(status, label) {
    const dot = document.getElementById('ja-indicator-dot');
    const lbl = document.getElementById('ja-indicator-label');
    if (!dot || !lbl) return;
    dot.style.background = STATUS_COLORS[status] || STATUS_COLORS.idle;
    lbl.textContent      = label || 'Job Agent';
  }

  // ── Message listener ────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SPA_NAVIGATE') {
      handlePageChange(msg.url || location.href);
      return;
    }
    if (msg.type !== 'TAB_STATUS') return;
    if (msg.status === 'loading') {
      showLoadingOverlay(msg.label || 'Working…');
      updateAgentPill('loading', msg.label || 'Working…');
    } else {
      hideLoadingOverlay();
      updateAgentPill(msg.status === 'idle' ? 'idle' : msg.status, msg.label || 'Job Agent');
    }
  });

  // ── Show/hide pill based on URL ─────────────────────────────────────────────

  function handlePageChange(url) {
    const lower = url.toLowerCase();
    let parsed, parsedPath = '';
    try { parsed = new URL(url); parsedPath = parsed.pathname; } catch (_) {}

    const isLinkedInJobDetail =
      /linkedin\.com\/jobs\//.test(lower) &&
      (
        (parsed?.searchParams?.has('currentJobId') || false) ||
        /\/jobs\/view\/\d+/.test(parsedPath)
      );

    const isJobPage =
      isLinkedInJobDetail ||
      lower.includes('/careers') ||
      /myworkdayjobs\.com\/.*\/job\/[^/]+/.test(parsedPath) ||
      lower.includes('indeed.com') ||
      lower.includes('glassdoor.com') ||
      lower.includes('naukri.com') ||
      /\/(jobs|job|apply|opening|position)(\/|$)/i.test(parsedPath);

    if (isJobPage) { createJobAgent(); }
    else           { removeJobAgent(); }
  }

  handlePageChange(location.href);
  window.addEventListener('locationchange', () => handlePageChange(location.href));

  // ── Viewed-jobs filter ──────────────────────────────────────────────────────
  //
  // WHEN the filter runs:
  //   • On initial page load / hard reload.
  //   • When the job LIST changes: pagination or a new search query.
  //   • When the user manually toggles the filter in the popup.
  //
  // WHEN the filter does NOT run:
  //   • When the user clicks a job card (currentJobId appears in the URL).
  //     The card they are reading must stay visible in the left panel.
  //   • On any other mid-browsing DOM change — LinkedIn stamps "Viewed" on
  //     a card as soon as it is opened; hiding it at that moment is wrong.
  //
  // Detection strategy (priority order):
  //   1. Footer badge whose text contains "Viewed" (covers "Viewed 2 days ago").
  //   2. Legacy BEM class names on the <li> itself.
  //   3. Descendant element whose class contains "--seen" or "--viewed".
  //   4. Visited-link modifier class on the title anchor.

  // ID of the job the user currently has open in the right panel.
  let activeJobId = null;

  // ── Animation styles ───────────────────────────────────────────────────────
  // Injected once. Cards collapse in two phases:
  //   1. Fade out  (opacity → 0, 220 ms)
  //   2. Fold away (max-height + margins → 0, 280 ms, starts 180 ms in)

  (function injectCollapseStyles() {
    if (document.getElementById('sentinelx-styles')) return;
    const s = document.createElement('style');
    s.id = 'sentinelx-styles';
    s.textContent = `
      .sentinelx-collapsing {
        overflow:       hidden !important;
        pointer-events: none   !important;
        opacity:        1;
        max-height:     300px;
        transition:
          opacity       0.22s ease         0ms,
          max-height    0.28s ease-in-out  180ms,
          margin-top    0.28s ease-in-out  180ms,
          margin-bottom 0.28s ease-in-out  180ms;
      }
      .sentinelx-collapsing.sentinelx-collapse {
        opacity:       0   !important;
        max-height:    0   !important;
        margin-top:    0   !important;
        margin-bottom: 0   !important;
      }
      .sentinelx-restoring {
        overflow:   hidden !important;
        opacity:    0;
        max-height: 0;
        transition:
          max-height    0.22s ease-in-out  0ms,
          margin-top    0.22s ease-in-out  0ms,
          margin-bottom 0.22s ease-in-out  0ms,
          opacity       0.25s ease         180ms;
      }
      .sentinelx-restoring.sentinelx-restore {
        opacity:    1;
        max-height: 300px;
      }
    `;
    document.head.appendChild(s);
  })();

  /**
   * Smoothly collapse a card out of the list, then set display:none.
   * @param {Element} card
   * @param {number}  delayMs  stagger offset so cards fold one after another
   */
  function animateHide(card, delayMs) {
    card.setAttribute('data-sentinelx-hidden', 'viewed');

    setTimeout(function () {
      card.classList.add('sentinelx-collapsing');

      // Double rAF: let the browser paint the initial state before
      // adding the class that starts the transition.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          card.classList.add('sentinelx-collapse');

          function onEnd(e) {
            if (e.propertyName !== 'max-height') return;
            card.removeEventListener('transitionend', onEnd);
            card.classList.remove('sentinelx-collapsing', 'sentinelx-collapse');
            card.style.setProperty('display', 'none', 'important');
          }
          card.addEventListener('transitionend', onEnd);

          // Fallback for reduced-motion / transition never firing.
          setTimeout(function () {
            card.removeEventListener('transitionend', onEnd);
            card.classList.remove('sentinelx-collapsing', 'sentinelx-collapse');
            card.style.setProperty('display', 'none', 'important');
          }, 600);
        });
      });
    }, delayMs);
  }

  /**
   * Smoothly restore a card that was hidden by SentinelX.
   */
  function animateShow(card) {
    card.style.removeProperty('display');
    card.removeAttribute('data-sentinelx-hidden');
    card.classList.add('sentinelx-restoring');

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        card.classList.add('sentinelx-restore');

        function onEnd(e) {
          if (e.propertyName !== 'opacity') return;
          card.removeEventListener('transitionend', onEnd);
          card.classList.remove('sentinelx-restoring', 'sentinelx-restore');
        }
        card.addEventListener('transitionend', onEnd);

        setTimeout(function () {
          card.removeEventListener('transitionend', onEnd);
          card.classList.remove('sentinelx-restoring', 'sentinelx-restore');
        }, 550);
      });
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** True when the URL is a job-detail view (right panel open), not a list page. */
  function isJobDetailUrl(url) {
    try {
      const u = new URL(url);
      return u.searchParams.has('currentJobId') ||
             /\/jobs\/view\/\d+/.test(u.pathname);
    } catch (_) { return false; }
  }

  /** Sync activeJobId from the current URL (works for click, keyboard, back/forward). */
  function syncActiveJobFromUrl(url) {
    try {
      const u = new URL(url);
      const qid = u.searchParams.get('currentJobId');
      if (qid) { activeJobId = qid; return; }
      const m = u.pathname.match(/\/jobs\/view\/(\d+)/);
      if (m) { activeJobId = m[1]; return; }
    } catch (_) {}
    activeJobId = null;
  }

  /** Extract the numeric job ID from a card <li>. */
  function getJobIdFromCard(card) {
    if (card.dataset.occludableJobId) return card.dataset.occludableJobId;

    const inner = card.querySelector('[data-job-id]');
    if (inner && inner.dataset.jobId) return inner.dataset.jobId;

    const viewLink = card.querySelector('a[href*="/jobs/view/"]');
    if (viewLink) {
      const m = (viewLink.href || '').match(/\/jobs\/view\/(\d+)/);
      if (m) return m[1];
    }

    const qLink = card.querySelector('a[href*="currentJobId"]');
    if (qLink) {
      try {
        const u  = new URL(qLink.href);
        const id = u.searchParams.get('currentJobId');
        if (id) return id;
      } catch (_) {}
    }

    return null;
  }

  /**
   * Returns true if LinkedIn's DOM marks this card as already viewed.
   * Uses a word-boundary "viewed" match so "Viewed 2 days ago" is caught too.
   */
  function cardIsMarkedViewed(card) {
    // Method 1: footer state badge (most reliable in current LinkedIn).
    const footerBadges = card.querySelectorAll(
      '.job-card-container__footer-job-state, [class*="footer-job-state"]'
    );
    for (let i = 0; i < footerBadges.length; i++) {
      if (/\bviewed\b/i.test(footerBadges[i].textContent)) return true;
    }

    // Method 2: legacy BEM class names on the <li> itself.
    const legacyClasses = [
      'jobs-search-results__list-item--seen',
      'job-card-container--viewed',
      'jobs-search-results__list-item--viewed',
    ];
    for (let i = 0; i < legacyClasses.length; i++) {
      if (card.classList.contains(legacyClasses[i])) return true;
    }

    // Method 3: any descendant with a --seen or --viewed BEM modifier.
    if (card.querySelector('[class*="--seen"], [class*="--viewed"]')) return true;

    // Method 4: visited-link modifier on the title anchor.
    const titleLink = card.querySelector(
      '.job-card-list__title--link, .job-card-container__link'
    );
    if (titleLink) {
      if (titleLink.classList.contains('job-card-list__title--link--visited')) return true;
      if (titleLink.closest('[class*="seen"]') || titleLink.closest('[class*="viewed"]')) return true;
    }

    return false;
  }

  /**
   * Hide all viewed job cards in the current list.
   * The card whose ID matches activeJobId is always left visible.
   * If no cards are in the DOM yet, retries up to ~3s (LinkedIn can be slow).
   */
  function applyViewedFilter(attempt) {
    if (!/linkedin\.com\/jobs/.test(location.href)) return;

    chrome.storage.local.get(['hideViewedJobs'], function (result) {
      if (!result.hideViewedJobs) return;

      const candidates = document.querySelectorAll(
        'li[data-occludable-job-id], li.scaffold-layout__list-item'
      );

      // If DOM isn't ready yet, retry (max ~4 attempts × 700 ms = ~2.8 s).
      if (candidates.length === 0) {
        var n = (attempt || 0) + 1;
        if (n <= 4) setTimeout(function () { applyViewedFilter(n); }, 700);
        return;
      }

      let stagger = 0;
      candidates.forEach(function (card) {
        // Skip cards this extension already hid.
        if (card.getAttribute('data-sentinelx-hidden')) return;

        // Only hide cards LinkedIn has marked as viewed.
        if (!cardIsMarkedViewed(card)) return;

        const id = getJobIdFromCard(card);

        // Never hide the card the user is currently reading.
        if (id && id === activeJobId) return;

        animateHide(card, stagger);
        stagger += 60;
      });
    });
  }

  /** Restore all cards hidden by SentinelX with a smooth fade-in. */
  function restoreAllCards() {
    document.querySelectorAll('[data-sentinelx-hidden]').forEach(function (el) {
      animateShow(el);
    });
  }

  // ── SPA navigation handler ─────────────────────────────────────────────────
  //
  // LinkedIn is a SPA; every URL change fires `locationchange`.
  //
  //   A. Job-card opened (currentJobId / /jobs/view/):
  //      → sync activeJobId only. List unchanged.
  //
  //   B. Navigating AWAY from jobs (jobs → home):
  //      → restore hidden cards so they're not stuck in the DOM.
  //
  //   C. Arriving AT jobs from a non-jobs page (home → jobs):
  //      → apply filter on newly rendered list. Do NOT restoreAllCards().
  //
  //   D. Already on jobs, list changed (new search / pagination):
  //      → restoreAllCards() + re-filter.
  //
  //   (no-op): replaceState tweak with same list key — MutationObserver handles it.

  /** True when URL is a LinkedIn jobs list page (not home, not a job detail). */
  function isJobsListUrl(href) {
    return /linkedin\.com\/jobs/.test(href) && !isJobDetailUrl(href);
  }

  /** Stable key for the current job search — ignores currentJobId param. */
  function jobsListKey(href) {
    try {
      var u = new URL(href);
      if (/\/jobs\/search/.test(u.pathname)) {
        var p = new URLSearchParams();
        ['keywords', 'location', 'start', 'f_TPR', 'f_E', 'f_JT', 'f_WT'].forEach(function (k) {
          if (u.searchParams.has(k)) p.set(k, u.searchParams.get(k));
        });
        return u.pathname + '?' + p.toString();
      }
      return u.pathname;
    } catch (_) { return href; }
  }

  var previousHref    = location.href;
  var previousListKey = jobsListKey(location.href);

  window.addEventListener('locationchange', function () {
    var href = location.href;

    // Case A
    if (isJobDetailUrl(href)) {
      syncActiveJobFromUrl(href);
      previousHref = href;
      return;
    }

    var wasOnJobsList  = isJobsListUrl(previousHref);
    var nowOnJobsList  = isJobsListUrl(href);
    var currentListKey = jobsListKey(href);
    var listChanged    = (currentListKey !== previousListKey);

    previousHref    = href;
    previousListKey = currentListKey;
    activeJobId     = null;

    if (!nowOnJobsList) {
      // Case B: leaving jobs section — restore so DOM is clean.
      restoreAllCards();
      return;
    }

    if (!wasOnJobsList) {
      // Case C: arriving at jobs from home/elsewhere.
      // LinkedIn renders a fresh list. Just filter — no restore needed.
      setTimeout(applyViewedFilter, 900);
      return;
    }

    // Case D: jobs → jobs with a different search/pagination.
    if (listChanged) {
      restoreAllCards();
      setTimeout(applyViewedFilter, 900);
    }
    // Same list key = minor replaceState — MutationObserver covers new cards.
  });

  // ── Handle toggle message from popup ──────────────────────────────────────

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'FILTER_TOGGLE') {
      if (msg.hideViewedJobs) {
        syncActiveJobFromUrl(location.href); // make sure activeJobId is current
        setTimeout(applyViewedFilter, 300);
      } else {
        restoreAllCards();
      }
    }
  });

  // ── Run once on initial page load ──────────────────────────────────────────

  syncActiveJobFromUrl(location.href);
  setTimeout(applyViewedFilter, 1200);

  // ── MutationObserver — new-card-only trigger ───────────────────────────────
  //
  // LinkedIn appends more cards as the user scrolls (infinite scroll).
  // We filter those new cards when they land in the DOM.
  //
  // Critically, we check each mutation's addedNodes to confirm that an actual
  // job-card <li> was inserted — not just an attribute/class/text change
  // (e.g. LinkedIn stamping a "Viewed" badge on the card the user just opened).
  // Badge updates must NOT trigger the filter.

  (function observeJobList() {
    // NOTE: Do NOT guard with a jobs-URL check here.
    // The content script may load on the home page (linkedin.com/feed).
    // We still need the locationchange listener registered so that when the
    // user navigates home → jobs, the observer starts up correctly.

    let debounce = null;
    let startRetryTimer = null;

    const observer = new MutationObserver(function (mutations) {
      const hasNewCards = mutations.some(function (m) {
        return Array.from(m.addedNodes).some(function (n) {
          return n.nodeType === Node.ELEMENT_NODE && (
            n.matches('li[data-occludable-job-id], li.scaffold-layout__list-item') ||
            n.querySelector('li[data-occludable-job-id]')
          );
        });
      });
      if (!hasNewCards) return; // ignore badge updates, class toggles, etc.

      clearTimeout(debounce);
      debounce = setTimeout(applyViewedFilter, 600);
    });

    function startObserver() {
      // Only observe when actually on a jobs page.
      if (!/linkedin\.com\/jobs/.test(location.href)) return;

      const list = document.querySelector(
        '.jobs-search-results-list, .scaffold-layout__list, ul.RwzuNNKBgKoBogrHFmNcjDzsQeyclVbobU'
      );
      if (list) {
        observer.observe(list, { childList: true, subtree: true });
      } else {
        // List not in DOM yet — keep retrying until it appears.
        clearTimeout(startRetryTimer);
        startRetryTimer = setTimeout(startObserver, 800);
      }
    }

    // Start immediately if we're already on a jobs page on load.
    startObserver();

    // Reconnect after every navigation (including home → jobs).
    window.addEventListener('locationchange', function () {
      observer.disconnect();
      clearTimeout(startRetryTimer);
      if (!isJobDetailUrl(location.href) && /linkedin\.com\/jobs/.test(location.href)) {
        // Give LinkedIn time to render the new list before we attach.
        startRetryTimer = setTimeout(startObserver, 1000);
      }
    });
  })();


})();