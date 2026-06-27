// ==UserScript==
// @name         Torn Foreign Stock & Itinerary Optimizer
// @namespace    mcc.torn.stock-itinerary
// @version      2.6.1
// @description  Tracks foreign stock via YATA and ranks travel itineraries by profit, with item watchlist support (e.g. Xanax)
// @author       Mat
// @homepageURL  https://github.com/mat-mcc-uk/torn-stock-itinerary
// @supportURL   https://github.com/mat-mcc-uk/torn-stock-itinerary/issues
// @updateURL    https://raw.githubusercontent.com/mat-mcc-uk/torn-stock-itinerary/main/torn-foreign-stock-itinerary.user.js
// @downloadURL  https://raw.githubusercontent.com/mat-mcc-uk/torn-stock-itinerary/main/torn-foreign-stock-itinerary.user.js
// @match        https://www.torn.com/*
// @connect      yata.yt
// @connect      api.torn.com
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------

  const TORN_API_KEY = GM_getValue('tornApiKey', '');
  const REFRESH_MS = 60 * 1000;

  // Items the user always wants surfaced regardless of profit ranking.
  // Edit this list directly, or set via the panel's watchlist field.
  const DEFAULT_WATCHLIST = ['Xanax'];

  // One-way travel time in minutes, standard (no airstrip/business class).
  // Source: Torn wiki. Round trip = 2x for items requiring a return leg.
  const COUNTRIES = {
    mex: { name: 'Mexico', oneWayMin: 20 },
    cay: { name: 'Cayman Islands', oneWayMin: 57 },
    can: { name: 'Canada', oneWayMin: 37 },
    haw: { name: 'Hawaii', oneWayMin: 121 },
    uni: { name: 'United Kingdom', oneWayMin: 152 },
    arg: { name: 'Argentina', oneWayMin: 189 },
    swi: { name: 'Switzerland', oneWayMin: 169 },
    jap: { name: 'Japan', oneWayMin: 203 },
    chi: { name: 'China', oneWayMin: 219 },
    uae: { name: 'UAE', oneWayMin: 259 },
    sou: { name: 'South Africa', oneWayMin: 311 },
  };

  // Global flight-time reduction. Torn cut all flight times by 5.26% (the new
  // time is 18/19 of the old, i.e. multiply by 0.9474). The oneWayMin values
  // above stay as the original documented standard times; this factor applies
  // the cut in one place. Set back to 1 if Torn reverts it.
  const FLIGHT_TIME_MULT = 0.9474;

  // Maps the Torn API's travel.destination strings to our country codes.
  // The API uses full official names which differ from our short labels.
  const DEST_TO_CODE = {
    'mexico': 'mex',
    'cayman islands': 'cay',
    'canada': 'can',
    'hawaii': 'haw',
    'united kingdom': 'uni',
    'argentina': 'arg',
    'switzerland': 'swi',
    'japan': 'jap',
    'china': 'chi',
    'united arab emirates': 'uae',
    'uae': 'uae',
    'south africa': 'sou',
  };

  // Travel methods. timeMult applies to standard one-way time.
  // capacityBonus is the +items granted by the method itself (airstrip/WLT/
  // BCT all grant +10 and don't stack with each other). Standard grants none.
  // Source: Torn wiki. Airstrip 70% of standard, WLT 50%, BCT 30%.
  const TRAVEL_METHODS = {
    standard: { name: 'Standard', timeMult: 1.00, capacityBonus: 0 },
    airstrip: { name: 'Airstrip', timeMult: 0.70, capacityBonus: 10 },
    wlt:      { name: 'WLT (private jet)', timeMult: 0.50, capacityBonus: 10 },
    business: { name: 'Business Class', timeMult: 0.30, capacityBonus: 10 },
  };

  // "Mailing Yourself Abroad" book: further 25% reduction, stacks on top
  // of the chosen method.
  const MAILING_BOOK_MULT = 0.75;

  // ---------------------------------------------------------------------
  // Restock prediction config
  // ---------------------------------------------------------------------

  // Stock restocks only on quarter-hour ticks (xx:00/15/30/45) and refills
  // in roughly half the time it took to sell out. Predictions need a logged
  // time series, so the script records every YATA reading and projects from
  // observed sell rate. Until enough points exist per item, no verdict.

  const HISTORY_KEY = 'stockHistory';
  const HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000; // keep 48h per item
  const RESTOCK_TICK_MIN = 15;                   // quarter-hour grid
  // Restock-time heuristic: refill takes roughly (sellout duration × ratio).
  // 0.5 was the community-accepted value pre-December-2025. Torn changed
  // restock mechanics in that update and the new ratio varies by item, so
  // this is now user-tunable in settings.
  let restockRatio = GM_getValue('restockRatio', 0.5);
  const MIN_POINTS_FOR_FIT = 4;                   // need this many to trust a rate
  const MIN_DECLINE_FOR_FIT = 30;                 // and this much total drop (items)

  // Buy-on-arrival policy: you land, buy, leave. You will not wait at a
  // destination for a restock. Any item that isn't already on the shelf when
  // you land is a no-fly. This is the max seconds you'd tolerate waiting; set
  // to 15 to match the post-arrival grace period, effectively "no waiting".
  const MAX_WAIT_SEC = 15;

  // ---------------------------------------------------------------------
  // Tunable constants (previously magic numbers scattered through the code)
  // ---------------------------------------------------------------------

  // Skip recording a new snapshot if quantity hasn't changed within this
  // window. Keeps the time series compact without losing real transitions.
  const SNAPSHOT_DEDUPE_MS = 90 * 1000;

  // Treat stock <= ceil(max(1, peak * NEAR_ZERO_FRACTION)) as "sold out"
  // when measuring a sellout cycle. Allows for a stray reading or two of
  // residual stock that other players haven't grabbed.
  const NEAR_ZERO_FRACTION = 0.02;

  // Bounds on the user-tunable restock ratio. 0.1 to 2.0 covers plausible
  // values; outside this we ignore the input as a typo.
  const RESTOCK_RATIO_MIN = 0.1;
  const RESTOCK_RATIO_MAX = 2.0;

  // Confidence thresholds for empty-state predictions (history points).
  const CONF_HIGH_POINTS = 20;
  const CONF_MEDIUM_POINTS = 10;

  // MutationObserver fires hundreds of times per second on a busy page.
  // Debounce its handler so we don't run our cheap-but-not-free checks on
  // every micro-mutation Torn's SPA does.
  const OBSERVER_DEBOUNCE_MS = 250;

  // Safety margin: when projecting stock at landing on a depleting item,
  // multiply the predicted-remaining count by this. Compensates for bursty
  // buyers showing up during your flight; lower = more conservative.
  const DEPLETING_SAFETY_FACTOR = 0.85;

  // When current sell rate can't be measured (in-stock state, no detectable
  // decline yet), assume the entire current stock could deplete over this
  // many minutes. Used as a fallback so the script doesn't naively say "Go"
  // on a long flight just because stock looks stable in a few snapshots.
  // 60 minutes is roughly the median sellout window for active items.
  const TYPICAL_SELLOUT_MIN = 60;

  // When a depleting item's projected empty time is further out than this,
  // display "stable" instead of a specific countdown. The underlying
  // calculation may produce big numbers from noisy slow-mover data, and any
  // prediction more than a day out will be invalidated by the next restock
  // before it could ever come true.
  const LONG_ETA_THRESHOLD_MIN = 24 * 60;

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  let itemPrices = {};      // itemId -> { name, market_value }
  let stockData = {};       // countryCode -> [{ id, name, quantity, cost }]
  let userMoney = null;     // cash on hand, null = unknown (no permission/key)
  // Travel state derived from the Torn API. delayToTakeoffMin is how long until
  // you could next take off from Torn (get home + land). null = unknown.
  let travelState = { location: 'unknown', delayToTakeoffMin: 0, description: '' };
  let countryFilter = GM_getValue('countryFilter', 'all'); // 'all' or a country code
  let watchlist = GM_getValue('watchlist', DEFAULT_WATCHLIST);
  let watchlistFilter = GM_getValue('watchlistFilter', false); // show only watched
  let affordFilter = GM_getValue('affordFilter', true);        // hide unaffordable
  // Profit column display: 'hour' shows $/hr, 'trip' shows $/trip. Ranking
  // always uses $/hr regardless, since that's the true efficiency measure.
  let profitMode = GM_getValue('profitMode', 'hour');
  // Sell price discount applied to market_value. Torn's market_value tends to
  // sit above what items actually sell for on the Item Market. Default 5%.
  let sellDiscount = GM_getValue('sellDiscount', 5);
  // Per-item live Item Market price cache. Populated on demand when the user
  // clicks "Fetch live price" on a chart row. Keyed by itemId.
  // Does not persist: refreshed each session, one API call per lookup.
  const livePriceCache = {};
  // baseCapacity = suitcase/job/faction bonuses only, NOT the travel-method +10.
  // The method's +10 is added on top at calc time so switching method is live.
  let baseCapacity = GM_getValue('baseCapacity', 5);
  let travelMethod = GM_getValue('travelMethod', 'standard');
  let mailingBook = GM_getValue('mailingBook', false);

  // Effective items carried = base + method bonus.
  function effectiveCapacity() {
    return baseCapacity + TRAVEL_METHODS[travelMethod].capacityBonus;
  }

  // Effective one-way minutes for a country under current method + book.
  // Reads the observed flight-time cache first, falling back to the formula
  // (oneWayMin × FLIGHT_TIME_MULT × method × book) when no observation yet.
  // The cache is keyed per country/method/book so calibration is exact.
  function effectiveOneWay(codeOrMin) {
    // Backward-compat: callers may still pass a raw oneWayMin number (the
    // ranking loop does). When given a string country code we use the cache.
    if (typeof codeOrMin === 'string') {
      const code = codeOrMin;
      const key = code + ':' + travelMethod + (mailingBook ? ':book' : '');
      const observed = observedFlightTimes[key];
      if (typeof observed === 'number' && observed > 0) {
        return observed;
      }
      // No observation: fall back to formula.
      const country = COUNTRIES[code];
      if (!country) return 0;
      let mult = TRAVEL_METHODS[travelMethod].timeMult;
      if (mailingBook) mult *= MAILING_BOOK_MULT;
      return country.oneWayMin * FLIGHT_TIME_MULT * mult;
    }
    // Numeric input: legacy formula path (no code, can't check cache).
    let mult = TRAVEL_METHODS[travelMethod].timeMult;
    if (mailingBook) mult *= MAILING_BOOK_MULT;
    return codeOrMin * FLIGHT_TIME_MULT * mult;
  }

  // ---------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------

  function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url,
        headers: options.headers,
        data: options.body,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            try {
              resolve(JSON.parse(response.responseText));
            } catch (err) {
              reject(new Error('Bad JSON from ' + url));
            }
          } else {
            reject(new Error('HTTP ' + response.status + ' from ' + url));
          }
        },
        onerror: () => reject(new Error('Network error fetching ' + url)),
        ontimeout: () => reject(new Error('Timeout fetching ' + url)),
      });
    });
  }

  // Timestamp YATA reported with its last export, in ms. Used to show data
  // age in the status bar; null if not available.
  let yataExportMs = null;

  // Observed one-way flight times in minutes, learned from your actual
  // flights. Keyed by "countryCode:method" (e.g. "mex:airstrip"). When a
  // calibrated value is present, it overrides the hardcoded fallback.
  // Persisted across sessions so calibration accumulates over time.
  let observedFlightTimes = GM_getValue('observedFlightTimes', {});
  // Tracks the most recent flight we calibrated against so we don't re-record
  // the same flight on every poll. Just the destination + departed timestamp.
  let lastCalibratedFlight = null;

  async function fetchStockData() {
    const data = await gmFetch('https://yata.yt/api/v1/travel/export/');
    stockData = data.stocks || {};
    yataExportMs = typeof data.timestamp === 'number' ? data.timestamp * 1000 : null;
    return data.timestamp;
  }

  async function fetchItemPrices() {
    if (!TORN_API_KEY) return;
    const data = await gmFetch(
      'https://api.torn.com/torn/?selections=items&key=' + TORN_API_KEY
    );
    if (data.error) {
      console.warn('Torn API error:', data.error.error);
      return;
    }
    itemPrices = data.items || {};
  }

  // Fetch the live Item Market average price for one item. The v2 endpoint
  // returns a summary object per item with an average_price field, not
  // individual listings. Average is actually better than lowest for a stock-
  // running tool: the lowest single listing might be one unit at a weird
  // price you can't fill a suitcase with.
  async function fetchLivePrice(itemId) {
    if (!TORN_API_KEY) return null;
    try {
      const data = await gmFetch(
        'https://api.torn.com/v2/market/' + itemId + '/itemmarket?limit=1',
        { headers: { 'Authorization': 'ApiKey ' + TORN_API_KEY } }
      );
      if (data.error) {
        const msg = 'API error ' + data.error.code + ': ' + data.error.error;
        console.warn('Live price fetch failed:', msg);
        return { error: msg };
      }

      // Response wraps summary objects under itemmarket/listings, or sits at
      // the top level. Find whichever key holds an array.
      let entries = data.itemmarket || data.listings;
      if (!Array.isArray(entries) && typeof entries === 'object' && entries) {
        entries = Object.values(entries);
      }
      if (!Array.isArray(entries) && Array.isArray(data)) {
        entries = data;
      }

      if (!Array.isArray(entries) || entries.length === 0) {
        console.warn('Live price response shape unexpected. Keys:', Object.keys(data));
        console.warn('Full response:', JSON.stringify(data).slice(0, 800));
        return { error: 'No data returned' };
      }

      // Each entry is a per-item summary: { id, name, type, average_price }.
      // A single-item query returns one entry. Read the average_price.
      const entry = entries[0];
      const avg = entry.average_price;
      if (typeof avg !== 'number' || avg <= 0) {
        console.warn('Live price entry missing average_price. Sample:', JSON.stringify(entry));
        return { error: 'No average_price in response' };
      }

      livePriceCache[itemId] = avg;
      return { price: avg };
    } catch (err) {
      console.warn('Live price fetch error:', err);
      return { error: err.message || 'Network error' };
    }
  }
  // money needs a Limited Access key; travel/basic are lower. If money is
  // unreadable, userMoney stays null and only that filter no-ops.
  async function fetchUserState() {
    if (!TORN_API_KEY) return;
    try {
      const data = await gmFetch(
        'https://api.torn.com/user/?selections=money,travel,basic&key=' + TORN_API_KEY
      );
      if (data.error) {
        console.warn('User fetch failed:', data.error.error);
        userMoney = null;
        travelState = { location: 'unknown', delayToTakeoffMin: 0, description: '' };
        return;
      }
      userMoney = typeof data.money_onhand === 'number' ? data.money_onhand : null;
      travelState = deriveTravelState(data, Date.now());
    } catch (err) {
      console.warn('User fetch error:', err);
      userMoney = null;
      travelState = { location: 'unknown', delayToTakeoffMin: 0, description: '' };
    }
  }

  // Work out where you are and how many minutes until you could next take off
  // from Torn. Cases:
  //   In Torn        -> 0 (can launch now)
  //   Flying to Torn -> time_left only (land, then launch)
  //   Flying abroad  -> remaining flight + return leg from that country
  //   Abroad idle    -> return leg from current country
  // Return leg uses your current travel method/book so it tracks your settings.
  function deriveTravelState(data, now) {
    const state = { location: 'unknown', delayToTakeoffMin: 0, description: '' };
    const status = data.status || {};
    const travel = data.travel || {};
    const stateStr = (status.state || '').toLowerCase();
    state.description = status.description || '';

    // Resolve the country code involved, if any.
    const destName = (travel.destination || '').toLowerCase();
    const destCode = DEST_TO_CODE[destName];

    // Calibrate flight times from real flights. The API gives us departure
    // (`departed`) and arrival (`timestamp`) timestamps for active flights.
    // Their difference is the actual one-way time for the current method.
    // Recording this lets the script learn the real numbers regardless of
    // Torn balance changes.
    if (
      travel.departed &&
      travel.timestamp &&
      destCode &&
      destName !== 'torn' && // outbound only; return legs aren't useful here
      stateStr === 'traveling'
    ) {
      const flightId = destCode + ':' + travel.departed;
      if (flightId !== lastCalibratedFlight) {
        const totalMin = (travel.timestamp - travel.departed) / 60;
        if (totalMin > 0 && totalMin < 600) { // sanity-bounded
          recordFlightTime(destCode, travelMethod, mailingBook, totalMin);
          lastCalibratedFlight = flightId;
        }
      }
    }

    // Seconds left in any active flight.
    let flightLeftMin = 0;
    if (travel.timestamp) {
      flightLeftMin = Math.max(0, (travel.timestamp * 1000 - now) / 60000);
    } else if (typeof travel.time_left === 'number') {
      flightLeftMin = Math.max(0, travel.time_left / 60000);
    }

    if (stateStr === 'traveling') {
      if (destName === 'torn') {
        // On the way home: just wait out the landing.
        state.location = 'returning';
        state.delayToTakeoffMin = flightLeftMin;
      } else {
        // Outbound: land abroad, then fly all the way back to Torn.
        state.location = 'outbound';
        const back = destCode ? effectiveOneWay(destCode) : 0;
        state.delayToTakeoffMin = flightLeftMin + back;
      }
    } else if (stateStr === 'abroad' || /^in /.test(state.description.toLowerCase())) {
      // Standing abroad: fly home before you can launch again.
      state.location = 'abroad';
      const here = destCode ? effectiveOneWay(destCode) : 0;
      state.delayToTakeoffMin = here;
    } else {
      // In Torn (or okay/hospital/jail at home): can take off now.
      state.location = 'torn';
      state.delayToTakeoffMin = 0;
    }
    return state;
  }

  // Persist an observed flight time, blended with any prior observation for
  // the same country/method/book combination. We exponentially smooth so one
  // anomalous reading doesn't overwrite a settled estimate.
  function recordFlightTime(code, method, withBook, observedMin) {
    const key = code + ':' + method + (withBook ? ':book' : '');
    const prev = observedFlightTimes[key];
    const blended = prev == null ? observedMin : prev * 0.5 + observedMin * 0.5;
    observedFlightTimes[key] = blended;
    GM_setValue('observedFlightTimes', observedFlightTimes);
    console.log(
      `Calibrated flight time ${key}: ${observedMin.toFixed(2)}m ` +
      `(stored ${blended.toFixed(2)}m, was ${prev == null ? 'unset' : prev.toFixed(2) + 'm'})`
    );
  }

  // ---------------------------------------------------------------------
  // Stock history + restock prediction
  // ---------------------------------------------------------------------

  // History shape in GM storage:
  //   { "chi:264": [[tsMs, qty], [tsMs, qty], ...], ... }
  // Key is countryCode:itemId. Arrays are time-ordered, oldest first.

  // History is held in memory after first load and persisted to GM storage on
  // each snapshot. This avoids parsing/stringifying the whole blob on every
  // render call, which would otherwise happen many times per refresh.
  let historyCache = null;

  function loadHistory() {
    if (historyCache !== null) return historyCache;
    try {
      historyCache = JSON.parse(GM_getValue(HISTORY_KEY, '{}'));
    } catch {
      historyCache = {};
    }
    return historyCache;
  }

  function saveHistory(hist) {
    historyCache = hist; // keep cache in sync
    try {
      GM_setValue(HISTORY_KEY, JSON.stringify(hist));
    } catch (err) {
      // Storage full or quota hit: drop oldest half and retry once.
      console.warn('Stock history save failed, trimming.', err);
      for (const key of Object.keys(hist)) {
        hist[key] = hist[key].slice(Math.floor(hist[key].length / 2));
      }
      try {
        GM_setValue(HISTORY_KEY, JSON.stringify(hist));
      } catch {
        /* give up this cycle */
      }
    }
  }

  // Append the current snapshot. Records zero-stock readings too, since the
  // moment stock hits zero is what anchors a restock prediction.
  function recordSnapshot(now) {
    const hist = loadHistory();
    const cutoff = now - HISTORY_WINDOW_MS;

    for (const [code] of Object.entries(COUNTRIES)) {
      const entry = stockData[code];
      if (!entry || !entry.stocks) continue;

      for (const stockItem of entry.stocks) {
        const key = code + ':' + stockItem.id;
        if (!hist[key]) hist[key] = [];
        const series = hist[key];
        const last = series[series.length - 1];

        // Skip duplicate consecutive readings (same qty within dedupe window)
        // to keep the series compact; still captures every real change.
        if (last && last[1] === stockItem.quantity && now - last[0] < SNAPSHOT_DEDUPE_MS) {
          continue;
        }
        series.push([now, stockItem.quantity]);

        // Trim to window.
        while (series.length && series[0][0] < cutoff) series.shift();
      }
    }

    saveHistory(hist);
    return hist;
  }

  // Snap a timestamp up to the next quarter-hour tick.
  function nextTick(tsMs) {
    const d = new Date(tsMs);
    const min = d.getMinutes();
    const add = RESTOCK_TICK_MIN - (min % RESTOCK_TICK_MIN);
    d.setMinutes(min + (add === RESTOCK_TICK_MIN ? 0 : add), 0, 0);
    if (d.getTime() <= tsMs) d.setMinutes(d.getMinutes() + RESTOCK_TICK_MIN);
    return d.getTime();
  }

  // Recency-weighted least-squares fit over the current decline run.
  // Returns items sold per minute (positive number) or null if not enough
  // signal. Weights drop exponentially with age so a sudden shift in sell
  // rate (e.g. a faction running the route) shows up sooner.
  // Half-life of the weight is the run duration / 3, so the most recent
  // third of the run dominates.
  function sellRatePerMin(series) {
    if (!series || series.length < MIN_POINTS_FOR_FIT) return null;

    // Walk back from the end collecting points until stock rises (a restock),
    // which marks the start of the current decline run.
    const run = [];
    for (let i = series.length - 1; i >= 0; i--) {
      run.unshift(series[i]);
      if (i > 0 && series[i - 1][1] < series[i][1]) break; // prev was a restock
    }
    if (run.length < MIN_POINTS_FOR_FIT) return null;

    const drop = run[0][1] - run[run.length - 1][1];
    if (drop < MIN_DECLINE_FOR_FIT) return null;

    // Weighted least-squares slope of qty vs minutes. Weight by age, with
    // half-life = runDurationMin / 3. So a point taken at the start of the
    // run has weight 1/8 relative to a point taken now.
    const tEnd = run[run.length - 1][0];
    const runDurationMin = (tEnd - run[0][0]) / 60000;
    const halfLifeMin = Math.max(1, runDurationMin / 3);
    const decay = Math.LN2 / halfLifeMin;

    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (const [t, q] of run) {
      const xMin = (t - run[0][0]) / 60000;
      const ageMin = (tEnd - t) / 60000;
      const w = Math.exp(-decay * ageMin);
      sw += w;
      swx += w * xMin;
      swy += w * q;
      swxx += w * xMin * xMin;
      swxy += w * xMin * q;
    }
    const denom = sw * swxx - swx * swx;
    if (denom === 0) return null;
    const slope = (sw * swxy - swx * swy) / denom; // qty change per minute
    if (slope >= 0) return null; // not declining
    return -slope; // sold per minute
  }

  // Measure the most recent completed sell-out cycle in the series. Walks
  // backwards from "now" to find a near-zero reading, then back further to
  // the peak that preceded it. Returns { durationMin, peak } or null if no
  // complete cycle is logged.
  // Using the most recent cycle (not the global peak) means a one-off freak
  // high reading or a stale pre-update peak doesn't poison the prediction.
  function lastSellout(series) {
    if (!series || series.length < MIN_POINTS_FOR_FIT) return null;

    // Find the most recent index where stock was near zero.
    let zeroIdx = -1;
    for (let i = series.length - 1; i >= 0; i--) {
      // Threshold is set by the eventual peak we'll find; use 0 to start and
      // refine. A simple two-pass would be slow on long series, so we go in
      // one pass with a generous bound: treat <=1 as effectively empty here.
      if (series[i][1] <= 1) {
        zeroIdx = i;
        break;
      }
    }
    if (zeroIdx <= 0) return null;

    // Walk further back to find the peak that preceded this zero.
    let peakIdx = zeroIdx;
    let peakVal = series[zeroIdx][1];
    let foundPeak = false;
    for (let i = zeroIdx - 1; i >= 0; i--) {
      if (series[i][1] > peakVal) {
        peakVal = series[i][1];
        peakIdx = i;
        foundPeak = true;
      } else if (foundPeak && i > 0 && series[i][1] < series[i - 1][1]) {
        // Past the peak, and now stock is dropping going backwards: we've
        // crossed into a previous cycle. Stop so we measure THIS cycle only.
        // Skipping this check until we've found a peak prevents breaking on
        // the natural decline within the current sellout itself.
        break;
      }
    }
    if (peakIdx === zeroIdx) return null;

    // Refine the zero threshold using the peak we found, in case the cycle
    // hit "near zero" rather than absolute zero.
    const threshold = Math.max(1, peakVal * NEAR_ZERO_FRACTION);
    let refinedZeroIdx = zeroIdx;
    for (let i = peakIdx + 1; i < series.length; i++) {
      if (series[i][1] <= threshold) {
        refinedZeroIdx = i;
        break;
      }
    }

    const durationMin = (series[refinedZeroIdx][0] - series[peakIdx][0]) / 60000;
    if (durationMin <= 0) return null;
    return { durationMin, peak: peakVal };
  }

  // Produce a prediction object for one item's series given current qty.
  //   { state, qty, sellRate, etaEmptyMin, nextRestockMs, confidence }
  // state: 'learning' | 'in-stock' | 'depleting' | 'empty'
  function predictItem(series, now) {
    const result = {
      state: 'learning',
      sellRate: null,
      etaEmptyMin: null,
      nextRestockMs: null,
      rawRestockMs: null,
      restockPeak: null,
      // Derived from the last completed sellout cycle: peak/duration. Used as
      // a fallback when current sellRate can't be measured (low-volume item
      // with no detectable decline in current snapshots).
      historicalRatePerMin: null,
      confidence: 'low',
    };
    if (!series || series.length < MIN_POINTS_FOR_FIT) return result;

    const qty = series[series.length - 1][1];
    const rate = sellRatePerMin(series);
    result.sellRate = rate;

    // Use the most recent observed sellout cycle to seed both the restock
    // peak (how much a fresh refill puts on the shelf) and the wait time.
    // Falls back to current quantity if no full cycle is logged yet.
    const recent = lastSellout(series);
    result.restockPeak = recent ? recent.peak : Math.max(qty, 0);
    if (recent && recent.durationMin > 0) {
      result.historicalRatePerMin = recent.peak / recent.durationMin;
    }

    if (qty <= 0) {
      result.state = 'empty';
      // Restock = (last sellout duration × restockRatio), snapped to a tick.
      // We keep both the raw prediction and the snapped value: the snapped
      // time is what the script acts on (restocks really do fire on ticks),
      // the raw time drives confidence and range display.
      const emptiedAt = series[series.length - 1][0];
      if (recent) {
        const waitMin = recent.durationMin * restockRatio;
        result.rawRestockMs = emptiedAt + waitMin * 60000;
        result.nextRestockMs = nextTick(result.rawRestockMs);
        // Confidence rises with how many sell-out cycles have been observed,
        // since restockRatio is a population guess that varies per item.
        result.confidence = series.length >= CONF_HIGH_POINTS ? 'high'
          : series.length >= CONF_MEDIUM_POINTS ? 'medium'
          : 'low';
      } else {
        // No measured cycle: fall back to the next tick as a floor.
        result.rawRestockMs = now;
        result.nextRestockMs = nextTick(now);
        result.confidence = 'low';
      }
      return result;
    }

    if (rate && rate > 0) {
      result.state = 'depleting';
      result.etaEmptyMin = qty / rate;
      // Same tiered confidence as empty state, so depleting predictions are
      // held to the same evidence bar.
      result.confidence = series.length >= CONF_HIGH_POINTS ? 'high'
        : series.length >= CONF_MEDIUM_POINTS ? 'medium'
        : 'low';
    } else {
      result.state = 'in-stock';
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // Profit calculation
  // ---------------------------------------------------------------------

  // Builds a flat, ranked list of every (country, item) pair, with profit per
  // trip, profit per hour, and a fly-now verdict from restock prediction.
  function rankItineraries(hist, now) {
    const rows = [];

    for (const [code, country] of Object.entries(COUNTRIES)) {
      // Country filter: when set to a specific code, skip all others.
      if (countryFilter !== 'all' && countryFilter !== code) continue;

      const entry = stockData[code];
      if (!entry || !entry.stocks) continue;

      const oneWayMin = effectiveOneWay(code);
      const roundTripMin = oneWayMin * 2;
      const roundTripHours = roundTripMin / 60;

      // Minutes until you could take off from Torn (0 if already home).
      const takeoffDelay = travelState.delayToTakeoffMin || 0;

      for (const stockItem of entry.stocks) {
        const series = hist[code + ':' + stockItem.id];
        const pred = predictItem(series, now);

        // Verdict accounts for the time to get home and launch before flying.
        const verdict = adviseFlight(stockItem, pred, oneWayMin, now, takeoffDelay);

        // Drop only items that are empty AND not predicted to restock before
        // you'd land. Everything else is potentially flyable.
        if (stockItem.quantity <= 0 && verdict.code === 'skip') continue;

        const marketInfo = itemPrices[stockItem.id];
        const rawMarket = marketInfo ? marketInfo.market_value : null;
        // Use a live-fetched Item Market price if available (fetched on demand
        // by the user from the chart row), otherwise apply the sell discount to
        // market_value to get a more realistic figure.
        const livePrice = livePriceCache[stockItem.id] || null;
        const sellValue = livePrice !== null
          ? livePrice
          : rawMarket !== null
            ? rawMarket * (1 - sellDiscount / 100)
            : null;
        const isWatched = watchlist.some(
          (w) => w.toLowerCase() === stockItem.name.toLowerCase()
        );

        // Watchlist filter: when on, only watched items pass.
        if (watchlistFilter && !isWatched) continue;

        // Capacity you'd fill if stock allowed it.
        const stockCapacity = Math.min(
          effectiveCapacity(),
          Math.max(stockItem.quantity, verdict.expectedStockOnArrival || 0)
        );

        // Affordability: how many you can pay for with cash on hand. Only
        // applies when money is known and the item has a buy cost.
        let affordableUnits = stockCapacity;
        if (affordFilter && userMoney !== null && stockItem.cost > 0) {
          affordableUnits = Math.min(
            stockCapacity,
            Math.floor(userMoney / stockItem.cost)
          );
          // Can't afford a single one: drop it.
          if (affordableUnits < 1) continue;
        }

        const itemsAvailable = affordableUnits;
        const profitPerItem = sellValue !== null ? sellValue - stockItem.cost : null;
        const profitPerTrip =
          profitPerItem !== null ? profitPerItem * itemsAvailable : null;
        const profitPerHour =
          profitPerTrip !== null ? profitPerTrip / roundTripHours : null;

        // Flag when cash, not stock, is the limit, so the UI can show it.
        const cashLimited =
          affordFilter &&
          userMoney !== null &&
          stockItem.cost > 0 &&
          affordableUnits < stockCapacity;

        rows.push({
          country: country.name,
          countryCode: code,
          item: stockItem.name,
          itemId: stockItem.id,
          quantity: stockItem.quantity,
          cost: stockItem.cost,
          sellValue,
          profitPerItem,
          profitPerTrip,
          profitPerHour,
          roundTripMin,
          isWatched,
          itemsAvailable,
          cashLimited,
          pred,
          verdict,
        });
      }
    }

    // Watched first, then Go verdicts above Wait/Risky, then by profit/hour.
    const order = { go: 0, risky: 1, learning: 2, skip: 3 };
    rows.sort((a, b) => {
      if (a.isWatched !== b.isWatched) return a.isWatched ? -1 : 1;
      const oa = order[a.verdict.code] ?? 5;
      const ob = order[b.verdict.code] ?? 5;
      if (oa !== ob) return oa - ob;
      if (a.profitPerHour === null && b.profitPerHour === null) return 0;
      if (a.profitPerHour === null) return 1;
      if (b.profitPerHour === null) return -1;
      return b.profitPerHour - a.profitPerHour;
    });

    return rows;
  }

  // Decide whether to fly for an item right now, given its prediction and the
  // one-way time to the country. Returns a verdict with a short reason.
  //   code: 'go' | 'wait' | 'risky' | 'learning' | 'skip'
  function adviseFlight(stockItem, pred, oneWayMin, now, takeoffDelayMin = 0) {
    // Landing time = wait to take off (get home if abroad) + the flight itself.
    const landMs = now + (takeoffDelayMin + oneWayMin) * 60000;
    const cap = effectiveCapacity();

    // Buy-on-arrival: stock must already be on the shelf when you land, with no
    // more than MAX_WAIT_SEC of slack. Treat the landing-plus-grace moment as
    // the deadline by which stock must exist; anything restocking later is out.
    const buyByMs = landMs + MAX_WAIT_SEC * 1000;

    if (pred.state === 'learning') {
      return {
        code: 'learning',
        label: 'Learning',
        reason: 'Not enough history yet',
        expectedStockOnArrival: stockItem.quantity,
      };
    }

    if (pred.state === 'empty') {
      // Empty now, but it may refill while you're in the air. You won't wait at
      // the shop, so the restock must land before you do AND still have stock
      // left after post-restock selling by the time you arrive.
      if (pred.nextRestockMs && pred.nextRestockMs <= buyByMs) {
        // Minutes the shelf sells for between restock and your arrival.
        const sellMinAfterRestock = Math.max(0, (landMs - pred.nextRestockMs) / 60000);
        const peak = pred.restockPeak || 0;
        const rate = pred.sellRate || 0;
        const projected = Math.max(0, Math.round(peak - rate * sellMinAfterRestock));

        if (projected >= cap) {
          return {
            code: 'go',
            label: 'Go',
            reason: `Refills ~${fmtClock(pred.nextRestockMs)}, ~${projected} still there when you land`,
            expectedStockOnArrival: projected,
          };
        }
        if (projected >= 1) {
          return {
            code: 'risky',
            label: 'Risky',
            reason: `Refills ~${fmtClock(pred.nextRestockMs)} but only ~${projected} left on arrival`,
            expectedStockOnArrival: projected,
          };
        }
        // Refilled but sold out again before you land.
        return {
          code: 'skip',
          label: 'No fly',
          reason: `Refills ~${fmtClock(pred.nextRestockMs)} but sells out again before you land`,
          expectedStockOnArrival: 0,
        };
      }
      // No restock before you land: nothing on the shelf, and you won't wait.
      return {
        code: 'skip',
        label: 'No fly',
        reason: pred.nextRestockMs
          ? `Empty, next restock ~${fmtClock(pred.nextRestockMs)} after you'd land`
          : 'Empty, no restock estimate',
        expectedStockOnArrival: 0,
      };
    }

    if (pred.state === 'depleting' && pred.etaEmptyMin != null) {
      const emptyMs = now + pred.etaEmptyMin * 60000;
      // Stock still on the shelf when you land (within grace): buyable now.
      if (emptyMs >= buyByMs) {
        const minsToLanding = (landMs - now) / 60000;
        // Apply the safety factor: assume buyers might arrive in waves during
        // your flight so we slightly under-predict what'll be there.
        const projectedRaw = stockItem.quantity - pred.sellRate * minsToLanding;
        const projected = Math.max(0, Math.round(projectedRaw * DEPLETING_SAFETY_FACTOR));
        if (projected >= cap) {
          return {
            code: 'go',
            label: 'Go',
            reason: `~${projected} on the shelf when you land, fills ${cap}`,
            expectedStockOnArrival: projected,
          };
        }
        if (projected >= 1) {
          return {
            code: 'risky',
            label: 'Risky',
            reason: `Only ~${projected} left on arrival, partial load`,
            expectedStockOnArrival: projected,
          };
        }
      }
      // Sells out at or before you land. You won't wait for the refill.
      return {
        code: 'skip',
        label: 'No fly',
        reason: `Sells out ~${fmtClock(emptyMs)}, before you land. You'd have to wait`,
        expectedStockOnArrival: 0,
      };
    }

    // In stock, no measurable current decline. We can't promise the stock
    // will survive the flight just because it isn't visibly declining right
    // now: it might be freshly restocked and about to drop, or sell rate
    // might be too low to detect over the few snapshots we have.
    //
    // Prefer the historical rate from this item's last completed sellout
    // cycle (peak/duration). That's data-driven and item-specific: a fast
    // mover like Xanax gives a high rate, a slow mover gives a low rate.
    // Falls back to a generic TYPICAL_SELLOUT_MIN heuristic when no cycle
    // has been logged yet.
    const minsToLanding = (landMs - now) / 60000;
    const assumedRate = pred.historicalRatePerMin && pred.historicalRatePerMin > 0
      ? pred.historicalRatePerMin
      : stockItem.quantity / TYPICAL_SELLOUT_MIN;
    const usingHistorical = pred.historicalRatePerMin > 0;
    const projected = Math.max(
      0,
      Math.round(stockItem.quantity - assumedRate * minsToLanding * DEPLETING_SAFETY_FACTOR)
    );

    // Reason text changes slightly depending on the rate source, so the user
    // can tell whether the projection is item-specific or a generic guess.
    const rateNote = usingHistorical
      ? `at this item's recent ~${assumedRate.toFixed(1)}/min sellout pace`
      : `at a typical pace`;

    if (projected >= cap) {
      return {
        code: 'go',
        label: 'Go',
        reason: `${stockItem.quantity} in stock, ~${projected} likely on arrival ${rateNote}`,
        expectedStockOnArrival: projected,
      };
    }
    if (projected >= 1) {
      return {
        code: 'risky',
        label: 'Risky',
        reason: `${stockItem.quantity} in stock now, ~${projected} likely on arrival ${rateNote} (${formatTime(minsToLanding)} flight)`,
        expectedStockOnArrival: projected,
      };
    }
    return {
      code: 'skip',
      label: 'No fly',
      reason: `${stockItem.quantity} in stock now but likely empty ${rateNote} after ${formatTime(minsToLanding)}`,
      expectedStockOnArrival: 0,
    };
  }

  // hh:mm local clock for a timestamp.
  function fmtClock(tsMs) {
    return new Date(tsMs).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // Compact relative timestamp for chart axis. Shows "-Nh" or "-Nd" if more
  // than a few hours back, else the clock time.
  function fmtChartTime(tsMs, now) {
    const ageMin = (now - tsMs) / 60000;
    if (ageMin < 60) return Math.round(ageMin) + 'm ago';
    if (ageMin < 24 * 60) return Math.round(ageMin / 60) + 'h ago';
    return Math.round(ageMin / (24 * 60)) + 'd ago';
  }


  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------

  GM_addStyle(`
    #tsi-panel {
      position: fixed;
      /* Dock to bottom-right above Torn's chat tabs (~50px tall). Avoids
         covering the Return home button which lives in the top-right. */
      bottom: 50px;
      right: 10px;
      width: 420px;
      max-width: calc(100vw - 20px);
      max-height: 80vh;
      overflow-y: auto;
      background: #1b1b1b;
      color: #e0e0e0;
      border: 1px solid #444;
      border-radius: 6px;
      font-family: Arial, sans-serif;
      font-size: 12px;
      z-index: 9999;
      box-shadow: 0 2px 10px rgba(0,0,0,0.5);
    }
    /* When collapsed, only the header bar shows. */
    #tsi-panel.tsi-collapsed { overflow: hidden; }
    #tsi-panel.tsi-collapsed .tsi-body { display: none; }
    /* Title swap: full name normally, short name when collapsed to a pill. */
    #tsi-panel .tsi-title-short { display: none; }
    #tsi-panel.tsi-collapsed .tsi-title-full { display: none; }
    #tsi-panel.tsi-collapsed .tsi-title-short { display: inline; }
    /* Narrow screens (PDA / mobile). Collapsed: a compact pill on the right so
       it doesn't cover the flight timer. Expanded: docks full width above the
       bottom tab bar. The clearance (64px) clears PDA's tab row plus safe area;
       raise it if your tab bar is taller. */
    @media (max-width: 784px) {
      #tsi-panel {
        top: auto;
        bottom: calc(64px + env(safe-area-inset-bottom, 0px));
        right: 6px;
        left: auto;
        width: auto;
        max-width: calc(100vw - 12px);
        max-height: 50vh;
        border-radius: 6px;
      }
      /* Expanded on narrow: span the full width and round only the top. */
      #tsi-panel:not(.tsi-collapsed) {
        right: 0;
        left: 0;
        width: 100%;
        max-width: 100%;
        border-radius: 6px 6px 0 0;
      }
      /* Collapsed pill: tighten the header so it reads as a small button. */
      #tsi-panel.tsi-collapsed h3 {
        padding: 8px 12px;
        font-size: 13px;
      }
      #tsi-panel.tsi-collapsed h3 > span:first-child {
        margin-right: 6px;
      }
      /* Short title only in the collapsed pill; gear is useless there. */
      #tsi-panel.tsi-collapsed .tsi-gear-wrap,
      #tsi-panel.tsi-collapsed #tsi-gear { display: none; }
    }
    #tsi-panel h3 {
      margin: 0;
      padding: 8px 10px;
      background: #2a2a2a;
      border-bottom: 1px solid #444;
      /* Indicates draggable on desktop. On PDA the cursor is irrelevant but
         touch-action prevents the browser from scroll-stealing the gesture. */
      cursor: move;
      touch-action: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
      user-select: none;
    }
    /* While dragging, drop the box shadow into something punchier so the
       user gets clear feedback that the panel is following their pointer. */
    #tsi-panel.tsi-dragging {
      box-shadow: 0 4px 20px rgba(90,160,240,0.4);
      opacity: 0.95;
      transition: none;
    }
    #tsi-panel .tsi-body { padding: 8px 10px; }
    #tsi-panel table { width: 100%; border-collapse: collapse; }
    #tsi-panel th, #tsi-panel td {
      text-align: left;
      padding: 3px 4px;
      border-bottom: 1px solid #333;
      color: #f0f0f0;
    }
    #tsi-panel th { color: #c8c8c8; font-weight: bold; }
    #tsi-panel td { color: #f0f0f0; }
    #tsi-panel tr.tsi-watched { background: #2e2a14; }
    #tsi-panel .tsi-profit-pos { color: #6fcf6f; }
    #tsi-panel .tsi-profit-neg { color: #e06666; }
    #tsi-panel .tsi-ccode {
      display: inline-block;
      font-family: monospace;
      font-size: 10px;
      color: #9fb8e8;
      background: #2b3340;
      padding: 0 3px;
      border-radius: 3px;
      vertical-align: middle;
    }
    #tsi-panel input, #tsi-panel button, #tsi-panel select {
      font-size: 11px;
      padding: 2px 5px;
      margin: 2px 0;
    }
    #tsi-panel input, #tsi-panel select {
      background: #2b2b2b;
      color: #f0f0f0;
      border: 1px solid #555;
      border-radius: 3px;
    }
    #tsi-panel button {
      background: #3a3a3a;
      color: #f0f0f0;
      border: 1px solid #666;
      border-radius: 3px;
      cursor: pointer;
    }
    #tsi-panel button:hover { background: #4a4a4a; }
    #tsi-panel .tsi-toggle {
      cursor: pointer;
      background: none;
      border: none;
      color: #ccc;
      font-size: 14px;
    }
    #tsi-panel .tsi-status { color: #888; font-size: 11px; margin-bottom: 6px; }
    #tsi-panel .tsi-verdict {
      display: inline-block;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: bold;
      font-size: 10px;
      cursor: help;
    }
    #tsi-panel .tsi-v-go { background: #1e5631; color: #9fe8b0; }
    #tsi-panel .tsi-v-risky { background: #5e4b16; color: #f0d27a; }
    #tsi-panel .tsi-v-learning { background: #333; color: #999; }
    #tsi-panel .tsi-v-skip { background: #2a2a2a; color: #777; }
    #tsi-panel #tsi-bestpick { font-size: 12px; color: #cfe8d6; }
    #tsi-panel tr.tsi-item-row { cursor: pointer; }
    #tsi-panel tr.tsi-item-row:hover { background: #242424; }
    #tsi-panel tr.tsi-item-row.tsi-watched:hover { background: #38331a; }
    /* Settings section, toggled by the gear. */
    #tsi-panel .tsi-settings {
      border-top: 1px solid #333;
      border-bottom: 1px solid #333;
      margin: 6px 0;
      padding: 6px 0;
    }
    #tsi-panel .tsi-settings.tsi-settings-hidden { display: none; }
    #tsi-panel .tsi-settings > div { margin: 4px 0; }
    #tsi-panel #tsi-glance { font-size: 11px; margin-bottom: 4px; }
    /* Narrow screens (PDA): drop secondary columns, enlarge touch targets,
       and let settings controls fill the width so they stop cramming. */
    @media (max-width: 784px) {
      #tsi-panel .tsi-col-extra { display: none; }
      #tsi-panel input, #tsi-panel button, #tsi-panel select {
        font-size: 14px;
        padding: 6px 8px;
      }
      #tsi-panel .tsi-settings select,
      #tsi-panel #tsi-watch { width: 100% !important; box-sizing: border-box; }
      #tsi-panel .tsi-settings > div { margin: 8px 0; }
      #tsi-panel th, #tsi-panel td { padding: 6px 4px; }
      #tsi-panel .tsi-toggle { font-size: 20px; padding: 4px 8px; }
      #tsi-panel .tsi-verdict { font-size: 12px; padding: 2px 7px; }
    }
  `);

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'tsi-panel';
    panel.innerHTML = `
      <h3>
        <span class="tsi-title-full">Foreign Stock Itinerary</span>
        <span class="tsi-title-short">Stock</span>
        <span>
          <button class="tsi-toggle" id="tsi-gear" title="Settings">⚙</button>
          <button class="tsi-toggle" id="tsi-collapse">▼</button>
        </span>
      </h3>
      <div class="tsi-body" id="tsi-body">
        <div class="tsi-status" id="tsi-status">Loading...</div>
        <div id="tsi-glance">
          <span id="tsi-location" style="color:#9fb8e8"></span>
          <span id="tsi-money" style="color:#9fe8b0;margin-left:8px"></span>
        </div>
        <div id="tsi-bestpick" style="margin:6px 0;padding:5px;background:#14241a;border-radius:4px;display:none"></div>

        <div class="tsi-settings tsi-settings-hidden" id="tsi-settings">
          <div>
            API key:
            <input id="tsi-key" type="password" placeholder="Torn API key" style="width:140px"
                   autocomplete="off" value="${TORN_API_KEY}">
            <button id="tsi-key-show" type="button" title="Show/hide key">👁</button>
            <button id="tsi-save-key">Save</button>
          </div>
          <div>
            Watchlist:
            <input id="tsi-watch" type="text" style="width:200px"
                   value="${watchlist.join(', ')}">
            <button id="tsi-save-watch">Save</button>
          </div>
          <div>
            <label style="margin-right:10px">
              <input type="checkbox" id="tsi-watchfilter"${watchlistFilter ? ' checked' : ''}>
              Only watchlist
            </label>
            <label>
              <input type="checkbox" id="tsi-affordfilter"${affordFilter ? ' checked' : ''}>
              Hide unaffordable
            </label>
          </div>
          <div>
            Show profit as:
            <select id="tsi-profitmode" style="width:120px">
              <option value="hour"${profitMode === 'hour' ? ' selected' : ''}>Per hour</option>
              <option value="trip"${profitMode === 'trip' ? ' selected' : ''}>Per trip</option>
            </select>
          </div>
          <div>
            Sell discount:
            <input id="tsi-discount" type="number" min="0" max="30" step="0.5"
                   style="width:55px" value="${sellDiscount}">
            %
            <span style="color:#888;font-size:10px">
              Applied to market_value. Tap a row's Fetch price button for a live figure.
            </span>
          </div>
          <div>
            Restock ratio:
            <input id="tsi-restockratio" type="number" min="${RESTOCK_RATIO_MIN}" max="${RESTOCK_RATIO_MAX}" step="0.05"
                   style="width:55px" value="${restockRatio}">
            <span style="color:#888;font-size:10px">
              Refill ≈ sellout × ratio. 0.5 is the old norm; Torn's Dec 2025 change altered this. Tune by observation.
            </span>
          </div>
          <div>
            Country:
            <select id="tsi-country" style="width:150px">
              <option value="all"${countryFilter === 'all' ? ' selected' : ''}>All countries</option>
              ${Object.entries(COUNTRIES)
                .map(
                  ([code, c]) =>
                    `<option value="${code}"${
                      code === countryFilter ? ' selected' : ''
                    }>${c.name}</option>`
                )
                .join('')}
            </select>
          </div>
          <div>
            Travel:
            <select id="tsi-method" style="width:150px">
              ${Object.entries(TRAVEL_METHODS)
                .map(
                  ([key, m]) =>
                    `<option value="${key}"${
                      key === travelMethod ? ' selected' : ''
                    }>${m.name}</option>`
                )
                .join('')}
            </select>
            <label style="margin-left:6px">
              <input type="checkbox" id="tsi-mailing"${mailingBook ? ' checked' : ''}>
              Mailing book (-25%)
            </label>
          </div>
          <div>
            Base capacity:
            <input id="tsi-capacity" type="number" min="1" max="44" style="width:50px"
                   value="${baseCapacity}">
            <span id="tsi-effcap" style="color:#888"></span>
            <button id="tsi-save-capacity">Save</button>
            <button id="tsi-refresh">Refresh now</button>
          </div>
          <div>
            <span id="tsi-calibration-status" style="color:#888;font-size:10px"></span>
            <button id="tsi-clear-calibration" style="font-size:10px">Clear calibration</button>
            <span style="color:#888;font-size:10px">
              Flight times auto-calibrate from your real trips. Clear to start over.
            </span>
          </div>
          <div>
            <button id="tsi-reset-data" style="background:#4a2424;border-color:#7a3838">Reset cached data</button>
            <span style="color:#888;font-size:10px">
              Clears stock history and live prices. Use if predictions are stuck
              or after a big Torn update changes the underlying mechanics.
            </span>
          </div>
          <div>
            <button id="tsi-reset-position">Reset panel position</button>
            <span style="color:#888;font-size:10px">
              Returns the panel to its default location. Use if you dragged it
              somewhere awkward or it appears off-screen after a screen rotate.
            </span>
          </div>
        </div>

        <table id="tsi-table">
          <thead>
            <tr>
              <th>Fly?</th><th>Item</th><th>Stock</th><th id="tsi-profit-head">$/hr</th>
              <th class="tsi-col-extra">Country</th>
              <th class="tsi-col-extra">Restock</th>
              <th class="tsi-col-extra">RT</th>
            </tr>
          </thead>
          <tbody id="tsi-tbody"></tbody>
        </table>
      </div>
    `;
    document.body.appendChild(panel);

    // Collapse by tapping the header (better touch target than a small button).
    // Default to collapsed on page open so the panel doesn't cover other UI;
    // tap the header to expand when you want to see itineraries.
    const isNarrow = window.matchMedia('(max-width: 784px)').matches;
    panel.classList.add('tsi-collapsed');
    // Settings start open on desktop (room to spare), closed on narrow so the
    // results table is the default view. The gear toggles either way.
    if (!isNarrow) {
      document.getElementById('tsi-settings').classList.remove('tsi-settings-hidden');
    }

    // Apply any saved custom position before wiring drag handlers.
    if (panelPosition) applyPanelPosition(panel, panelPosition);

    // Header doubles as click target (collapse toggle) and drag handle.
    // Distinguish tap from drag by movement distance: under 5px counts as a
    // click, anything more is a drag. PointerEvents cover mouse and touch
    // uniformly so this works on both desktop and PDA.
    const header = panel.querySelector('h3');
    const DRAG_THRESHOLD_PX = 5;
    let dragState = null;

    header.addEventListener('pointerdown', (e) => {
      // Ignore clicks on buttons inside the header (collapse arrow, gear).
      if (e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      dragState = {
        startX: e.clientX,
        startY: e.clientY,
        panelStartLeft: rect.left,
        panelStartTop: rect.top,
        moved: false,
        pointerId: e.pointerId,
      };
      // Capture so we keep receiving move/up even if the pointer leaves the
      // header. Without this, fast drags lose tracking.
      try { header.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });

    header.addEventListener('pointermove', (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      dragState.moved = true;
      panel.classList.add('tsi-dragging');
      // Apply position live so the drag feels real-time.
      applyPanelPosition(panel, {
        left: dragState.panelStartLeft + dx,
        top: dragState.panelStartTop + dy,
      });
      // Block touch scrolling under the header while dragging.
      e.preventDefault();
    });

    function endDrag(e) {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const wasDrag = dragState.moved;
      const finalRect = panel.getBoundingClientRect();
      try { header.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      dragState = null;
      panel.classList.remove('tsi-dragging');

      if (wasDrag) {
        // Save the dropped position.
        savePanelPosition({ left: finalRect.left, top: finalRect.top });
      } else {
        // Tap, not drag: toggle collapse like the old click handler did.
        toggleCollapse();
      }
    }
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);

    // Toggle helper used by both the header tap and the collapse button click.
    // Kept as a closure so it can be referenced from inside endDrag too.
    function toggleCollapse() {
      panel.classList.toggle('tsi-collapsed');
      const collapsed = panel.classList.contains('tsi-collapsed');
      document.getElementById('tsi-collapse').textContent = collapsed ? '▲' : '▼';
      if (!collapsed) refreshAll();
    }

    // Collapse button: explicit click handler so it works regardless of
    // whether the header tap is being interpreted as drag-start. Stop the
    // pointerdown propagating so the drag detector doesn't try to track it.
    const collapseBtn = document.getElementById('tsi-collapse');
    collapseBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapse();
    });

    // Reflect initial collapsed state in the button glyph.
    collapseBtn.textContent = '▲';

    // Gear toggles the settings section. Stop the click bubbling to the header
    // so it doesn't also collapse the whole panel.
    document.getElementById('tsi-gear').addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('tsi-settings').classList.toggle('tsi-settings-hidden');
    });

    document.getElementById('tsi-save-key').addEventListener('click', () => {
      const val = document.getElementById('tsi-key').value.trim();
      GM_setValue('tornApiKey', val);
      location.reload();
    });

    document.getElementById('tsi-key-show').addEventListener('click', () => {
      const input = document.getElementById('tsi-key');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    document.getElementById('tsi-save-watch').addEventListener('click', () => {
      const val = document.getElementById('tsi-watch').value;
      watchlist = val.split(',').map((s) => s.trim()).filter(Boolean);
      GM_setValue('watchlist', watchlist);

      // Warn about unknown names so typos don't silently produce empty
      // watchlists. Only run when item prices are loaded; otherwise skip.
      const known = Object.values(itemPrices)
        .map((i) => (i && i.name ? i.name.toLowerCase() : ''))
        .filter(Boolean);
      if (known.length > 0) {
        const unknown = watchlist.filter(
          (w) => !known.includes(w.toLowerCase())
        );
        if (unknown.length > 0) {
          alert(
            'Watchlist saved, but these names don\'t match any known Torn item:\n\n' +
              unknown.join(', ') +
              '\n\nCheck spelling. Names are case-insensitive but must match exactly otherwise.'
          );
        }
      }
      renderTable();
    });

    document.getElementById('tsi-save-capacity').addEventListener('click', () => {
      const val = parseInt(document.getElementById('tsi-capacity').value, 10);
      if (val > 0) {
        baseCapacity = val;
        GM_setValue('baseCapacity', baseCapacity);
        renderTable();
      }
    });

    document.getElementById('tsi-method').addEventListener('change', (e) => {
      travelMethod = e.target.value;
      GM_setValue('travelMethod', travelMethod);
      renderTable();
    });

    document.getElementById('tsi-mailing').addEventListener('change', (e) => {
      mailingBook = e.target.checked;
      GM_setValue('mailingBook', mailingBook);
      renderTable();
    });

    document.getElementById('tsi-watchfilter').addEventListener('change', (e) => {
      watchlistFilter = e.target.checked;
      GM_setValue('watchlistFilter', watchlistFilter);
      renderTable();
    });

    document.getElementById('tsi-affordfilter').addEventListener('change', (e) => {
      affordFilter = e.target.checked;
      GM_setValue('affordFilter', affordFilter);
      renderTable();
    });

    document.getElementById('tsi-profitmode').addEventListener('change', (e) => {
      profitMode = e.target.value;
      GM_setValue('profitMode', profitMode);
      renderTable();
    });

    document.getElementById('tsi-discount').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= 0 && val <= 30) {
        sellDiscount = val;
        GM_setValue('sellDiscount', sellDiscount);
        renderTable();
      }
    });

    document.getElementById('tsi-restockratio').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val >= RESTOCK_RATIO_MIN && val <= RESTOCK_RATIO_MAX) {
        restockRatio = val;
        GM_setValue('restockRatio', restockRatio);
        // renderTable re-runs predictItem, so the new ratio takes effect now.
        renderTable();
      }
    });

    document.getElementById('tsi-country').addEventListener('change', (e) => {
      countryFilter = e.target.value;
      GM_setValue('countryFilter', countryFilter);
      renderTable();
    });

    document.getElementById('tsi-refresh').addEventListener('click', refreshAll);

    document.getElementById('tsi-reset-data').addEventListener('click', () => {
      if (!confirm(
        'Clear all stock history and cached live prices? Predictions will need '
          + 'a few hours of fresh data to rebuild. This won\'t affect your '
          + 'settings or API key.'
      )) return;
      GM_setValue(HISTORY_KEY, '{}');
      historyCache = {};
      for (const k of Object.keys(livePriceCache)) delete livePriceCache[k];
      expandedCharts.clear();
      saveExpandedCharts();
      renderTable();
    });

    document.getElementById('tsi-clear-calibration').addEventListener('click', () => {
      if (!confirm(
        'Clear all calibrated flight times? The script will fall back to '
          + 'estimated times until you fly again. Flight times will recalibrate '
          + 'automatically as you make new trips.'
      )) return;
      observedFlightTimes = {};
      GM_setValue('observedFlightTimes', observedFlightTimes);
      renderTable();
    });

    document.getElementById('tsi-reset-position').addEventListener('click', () => {
      savePanelPosition(null);
      applyPanelPosition(panel, null);
    });

    // Toggle a per-item history chart by clicking its row. Also handles the
    // "Fetch live price" button inside the chart row. Delegation on the tbody
    // means the single listener survives every re-render.
    document.getElementById('tsi-tbody').addEventListener('click', async (e) => {
      // Live-price button: fetch the real Item Market price and re-render.
      const priceBtn = e.target.closest('.tsi-live-price-btn');
      if (priceBtn) {
        e.stopPropagation(); // don't toggle the chart row
        const itemId = parseInt(priceBtn.dataset.itemid, 10);
        priceBtn.textContent = 'Fetching...';
        priceBtn.disabled = true;
        const result = await fetchLivePrice(itemId);
        if (!result || result.error) {
          priceBtn.textContent = result ? result.error : 'No key set';
          priceBtn.disabled = false;
        } else {
          renderTable(); // re-render with the new cached price
        }
        return;
      }
      const row = e.target.closest('tr.tsi-item-row');
      if (!row) return;
      const key = row.dataset.key;
      if (expandedCharts.has(key)) expandedCharts.delete(key);
      else expandedCharts.add(key);
      saveExpandedCharts();
      renderTable();
    });

    // After all elements are in the DOM, cache the ones renderTable hits often.
    cacheDOM();
  }

  function formatMoney(n) {
    if (n === null || n === undefined) return '—';
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(Math.round(n)).toLocaleString();
  }

  // Escape user-supplied or external strings before inserting into HTML.
  // YATA item names and verdict reasons go through here so a stray < or &
  // can't break markup or inject attributes.
  function escapeHTML(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Round-trip minutes -> "1h23m" / "45m".
  function formatTime(min) {
    const m = Math.round(min);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
  }

  // Minutes-from-now -> "in 12m" / "in 1h05m" / "now".
  function fmtCountdown(tsMs, now) {
    const diff = Math.round((tsMs - now) / 60000);
    if (diff <= 0) return 'now';
    if (diff < 60) return 'in ' + diff + 'm';
    return 'in ' + Math.floor(diff / 60) + 'h' + String(diff % 60).padStart(2, '0') + 'm';
  }

  function verdictCell(v) {
    const cls = 'tsi-v-' + v.code;
    return `<span class="tsi-verdict ${cls}" title="${escapeHTML(v.reason)}">${escapeHTML(v.label)}</span>`;
  }

  function restockCell(r, now) {
    const p = r.pred;
    if (p.state === 'empty' && p.nextRestockMs) {
      const conf = p.confidence || 'low';
      // High: trust the snapped tick. Medium/low: show that it may be later
      // and add a tag so the user reads it as a hint, not a guarantee.
      if (conf === 'high') {
        return fmtCountdown(p.nextRestockMs, now);
      }
      // For medium/low confidence, expose the window: from the snapped tick
      // to a second tick later (~15 extra min of uncertainty per drop in
      // confidence). Display the range as a countdown range.
      const padTicks = conf === 'medium' ? 1 : 2;
      const latestMs = p.nextRestockMs + padTicks * RESTOCK_TICK_MIN * 60000;
      const earliest = fmtCountdown(p.nextRestockMs, now);
      const latest = fmtCountdown(latestMs, now);
      const tag = conf === 'medium'
        ? '<span style="color:#c8a050;font-size:9px">med</span>'
        : '<span style="color:#e08060;font-size:9px">low</span>';
      return `${earliest}–${latest} ${tag}`;
    }
    if (p.state === 'depleting' && p.etaEmptyMin != null) {
      // Very long projections (more than a day out) carry false precision:
      // the underlying rate is dominated by noise on slow movers, and any
      // restock will invalidate the number long before it comes true.
      // Treat these as effectively stable.
      if (p.etaEmptyMin > LONG_ETA_THRESHOLD_MIN) return 'stable';
      return 'empties ' + fmtCountdown(now + p.etaEmptyMin * 60000, now);
    }
    if (p.state === 'learning') return '—';
    return 'stable';
  }

  // Build an inline SVG stock-history chart for one item's series.
  // Shows quantity over time with restock jumps visible, a predicted-restock
  // marker when empty, and gridline labels. No external library.
  function buildChartSVG(series, pred, now) {
    if (!series || series.length < 2) {
      return '<div style="color:#888;padding:8px">Not enough history logged yet to chart.</div>';
    }

    const W = 380;
    const H = 110;
    const padL = 34;
    const padR = 8;
    const padT = 10;
    const padB = 18;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const t0 = series[0][0];
    // Extend the right edge to include the predicted restock when the item is
    // empty, so the "restock" marker is always on-chart rather than off the edge.
    let tEnd = Math.max(series[series.length - 1][0], now);
    if (pred && pred.state === 'empty' && pred.nextRestockMs) {
      tEnd = Math.max(tEnd, pred.nextRestockMs);
    }
    const t1 = tEnd;
    const tSpan = Math.max(1, t1 - t0);
    const maxQ = Math.max(...series.map((p) => p[1]), 1);

    const x = (t) => padL + ((t - t0) / tSpan) * plotW;
    const y = (q) => padT + plotH - (q / maxQ) * plotH;

    const pts = series.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');

    const grid = [0, maxQ / 2, maxQ]
      .map((q) => {
        const yy = y(q).toFixed(1);
        return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#333" stroke-width="1"/>
                <text x="${padL - 4}" y="${(+yy + 3).toFixed(1)}" fill="#777" font-size="9" text-anchor="end">${Math.round(q)}</text>`;
      })
      .join('');

    const nowX = x(now).toFixed(1);
    const nowLine = `<line x1="${nowX}" y1="${padT}" x2="${nowX}" y2="${padT + plotH}" stroke="#555" stroke-width="1" stroke-dasharray="2,2"/>
                     <text x="${nowX}" y="${H - 6}" fill="#888" font-size="9" text-anchor="middle">now</text>`;

    // X-axis time labels at sensible intervals. We show labels at "start"
    // (oldest data shown), "now", and one tick in between if it fits.
    const startX = padL;
    const startLabel = `<text x="${startX}" y="${H - 6}" fill="#888" font-size="9" text-anchor="start">${fmtChartTime(t0, now)}</text>`;
    // Middle label if there's room and the span is wide enough.
    let midLabel = '';
    const spanHours = tSpan / (60 * 60 * 1000);
    if (spanHours >= 2 && nowX - startX > 100) {
      const tMid = t0 + tSpan / 2;
      const midX = x(tMid).toFixed(1);
      midLabel = `<text x="${midX}" y="${H - 6}" fill="#888" font-size="9" text-anchor="middle">${fmtChartTime(tMid, now)}</text>`;
    }

    let restockMark = '';
    if (pred && pred.state === 'empty' && pred.nextRestockMs) {
      const rx = x(pred.nextRestockMs);
      if (rx >= padL && rx <= W - padR) {
        const rxs = rx.toFixed(1);
        restockMark = `<line x1="${rxs}" y1="${padT}" x2="${rxs}" y2="${padT + plotH}" stroke="#6fcf6f" stroke-width="1" stroke-dasharray="3,2"/>
                       <text x="${rxs}" y="${padT + 8}" fill="#6fcf6f" font-size="9" text-anchor="middle">restock</text>`;
      }
    }

    return `
      <svg width="${W}" height="${H}" style="max-width:100%;display:block">
        ${grid}
        ${nowLine}
        ${startLabel}
        ${midLabel}
        ${restockMark}
        <polyline points="${pts}" fill="none" stroke="#5aa0f0" stroke-width="1.5"/>
      </svg>
    `;
  }

  // Track which item rows have their chart expanded, so the chart survives the
  // periodic re-render. Keyed by countryCode:itemId. Persisted to storage so
  // expansions survive page reloads and PDA navigation.
  const expandedCharts = new Set(GM_getValue('expandedCharts', []));

  function saveExpandedCharts() {
    GM_setValue('expandedCharts', Array.from(expandedCharts));
  }

  // Custom panel position from user dragging. Null means use CSS defaults
  // (bottom-right on desktop, docked bottom on PDA). Stored as {left, top}
  // pixel offsets from the top-left.
  let panelPosition = GM_getValue('panelPosition', null);

  function savePanelPosition(pos) {
    panelPosition = pos;
    GM_setValue('panelPosition', pos);
  }

  // Clamp a position so the panel stays visible in the current viewport. We
  // need to keep at least PANEL_MARGIN_PX of the header on screen so the user
  // can always grab and move it again, even after orientation changes shrink
  // the viewport.
  function clampPanelPosition(pos, panelEl) {
    const PANEL_MARGIN_PX = 40; // min visible drag target on any edge
    const rect = panelEl.getBoundingClientRect();
    const w = rect.width || 320;
    const h = rect.height || 40;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      left: Math.max(PANEL_MARGIN_PX - w, Math.min(pos.left, vw - PANEL_MARGIN_PX)),
      top: Math.max(0, Math.min(pos.top, vh - PANEL_MARGIN_PX)),
    };
  }

  // Apply a saved position to the panel element as inline styles. Inline
  // beats the bottom/right CSS rules, but we also have to clear those rules
  // by setting bottom/right to auto inline, otherwise the panel renders at
  // the intersection of all four constraints (and gets stretched).
  function applyPanelPosition(panel, pos) {
    if (!pos) {
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.style.bottom = '';
      return;
    }
    const clamped = clampPanelPosition(pos, panel);
    panel.style.left = clamped.left + 'px';
    panel.style.top = clamped.top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  // DOM element handles cached after buildPanel so renderTable doesn't run
  // getElementById for the same ids on every refresh.
  const dom = {};

  function cacheDOM() {
    dom.tbody = document.getElementById('tsi-tbody');
    dom.profitHead = document.getElementById('tsi-profit-head');
    dom.bestpick = document.getElementById('tsi-bestpick');
    dom.effcap = document.getElementById('tsi-effcap');
    dom.money = document.getElementById('tsi-money');
    dom.location = document.getElementById('tsi-location');
    dom.status = document.getElementById('tsi-status');
    dom.calibrationStatus = document.getElementById('tsi-calibration-status');
  }

  function renderTable(hist, now) {
    hist = hist || loadHistory();
    now = now || Date.now();
    const rows = rankItineraries(hist, now);

    // Use cached DOM refs. If a ref is missing (panel rebuilt mid-session),
    // re-cache and try again. This avoids dozens of getElementById per render.
    let tbody = dom.tbody;
    if (!tbody || !tbody.isConnected) {
      cacheDOM();
      tbody = dom.tbody;
    }
    if (!tbody) return;

    // Swap the profit column header to match the chosen display mode.
    if (dom.profitHead) {
      dom.profitHead.textContent = profitMode === 'trip' ? '$/trip' : '$/hr';
    }

    tbody.innerHTML = rows
      .slice(0, 50)
      .map((r) => {
        const profitVal = profitMode === 'trip' ? r.profitPerTrip : r.profitPerHour;
        const profitClass =
          profitVal === null ? '' : profitVal >= 0 ? 'tsi-profit-pos' : 'tsi-profit-neg';
        const key = r.countryCode + ':' + r.itemId;
        const isOpen = expandedCharts.has(key);
        const mainRow = `
          <tr class="tsi-item-row ${r.isWatched ? 'tsi-watched' : ''}" data-key="${key}" data-itemid="${r.itemId}">
            <td>${verdictCell(r.verdict)}</td>
            <td><span class="tsi-ccode">${r.countryCode.toUpperCase()}</span> ${escapeHTML(r.item)}${r.isWatched ? ' ★' : ''}</td>
            <td>${r.quantity}${r.cashLimited ? ` <span style="color:#f0d27a" title="Cash only covers ${r.itemsAvailable}">(buy ${r.itemsAvailable})</span>` : ''}</td>
            <td class="${profitClass}">${formatMoney(profitVal)}</td>
            <td class="tsi-col-extra">${escapeHTML(r.country)}</td>
            <td class="tsi-col-extra">${restockCell(r, now)}</td>
            <td class="tsi-col-extra">${formatTime(r.roundTripMin)}</td>
          </tr>
        `;
        if (!isOpen) return mainRow;
        const chart = buildChartSVG(hist[key], r.pred, now);
        const cachedPrice = livePriceCache[r.itemId];
        const priceNote = cachedPrice
          ? `<span style="color:#9fe8b0">Market avg: ${formatMoney(cachedPrice)}</span>`
          : `<span style="color:#888">Market value used (${sellDiscount}% discount applied)</span>`;
        const chartRow = `
          <tr class="tsi-chart-row" data-key="${key}">
            <td colspan="7" style="padding:6px 8px;background:#141414">
              <div style="font-size:11px;color:#aaa;margin-bottom:2px">
                ${escapeHTML(r.item)} (${escapeHTML(r.country)}) stock history
              </div>
              <div style="font-size:11px;margin-bottom:4px;display:flex;align-items:center;gap:8px">
                ${priceNote}
                ${TORN_API_KEY
                  ? `<button class="tsi-live-price-btn" data-itemid="${r.itemId}"
                       style="font-size:10px;padding:1px 6px">
                       ${cachedPrice ? '↻ Refresh avg' : 'Fetch market avg'}
                     </button>`
                  : ''}
              </div>
              ${chart}
            </td>
          </tr>
        `;
        return mainRow + chartRow;
      })
      .join('');

    // Best pick: highest profit/hr among 'go' verdicts (watched gets priority).
    const goRows = rows.filter((r) => r.verdict.code === 'go' && r.profitPerHour !== null);
    if (dom.bestpick) {
      if (goRows.length) {
        const watchedGo = goRows.filter((r) => r.isWatched);
        const pick = (watchedGo.length ? watchedGo : goRows)[0];
        dom.bestpick.style.display = 'block';
        const pickVal = profitMode === 'trip' ? pick.profitPerTrip : pick.profitPerHour;
        const pickUnit = profitMode === 'trip' ? '/trip' : '/hr';
        dom.bestpick.innerHTML = `<strong>Fly now:</strong> ${escapeHTML(pick.item)} in ${escapeHTML(pick.country)}. ${escapeHTML(pick.verdict.reason)}, ${formatMoney(pickVal)}${pickUnit}`;
      } else {
        dom.bestpick.style.display = 'none';
      }
    }

    if (dom.effcap) {
      dom.effcap.textContent = `(carrying ${effectiveCapacity()} with ${
        TRAVEL_METHODS[travelMethod].name
      })`;
    }

    if (dom.calibrationStatus) {
      // Count how many countries have a calibrated time for current method+book.
      const suffix = ':' + travelMethod + (mailingBook ? ':book' : '');
      const calibrated = Object.keys(observedFlightTimes).filter((k) => k.endsWith(suffix)).length;
      const total = Object.keys(COUNTRIES).length;
      dom.calibrationStatus.textContent =
        `Calibrated: ${calibrated}/${total} countries for ${TRAVEL_METHODS[travelMethod].name}${mailingBook ? ' + book' : ''}. `;
    }

    if (dom.money) {
      if (userMoney !== null) {
        dom.money.textContent = 'Cash: ' + formatMoney(userMoney);
        dom.money.style.color = '#9fe8b0';
      } else if (TORN_API_KEY && affordFilter) {
        dom.money.textContent = 'Cash unavailable (key needs money access)';
        dom.money.style.color = '#e0a060';
      } else {
        dom.money.textContent = '';
      }
    }

    if (dom.location) {
      const d = Math.round(travelState.delayToTakeoffMin || 0);
      if (travelState.location === 'torn') {
        dom.location.textContent = 'In Torn, ready to fly';
      } else if (travelState.location === 'abroad') {
        dom.location.textContent = `${travelState.description || 'Abroad'}. Takeoff in ~${formatTime(d)} (after flying home)`;
      } else if (travelState.location === 'outbound') {
        dom.location.textContent = `${travelState.description || 'Traveling'}. Takeoff in ~${formatTime(d)}`;
      } else if (travelState.location === 'returning') {
        dom.location.textContent = `Heading to Torn. Takeoff in ~${formatTime(d)}`;
      } else {
        dom.location.textContent = '';
      }
    }

    // Learning progress: how many tracked items have enough history to advise.
    const tracked = Object.values(hist).filter((s) => s.length >= MIN_POINTS_FOR_FIT).length;
    const total = Object.keys(hist).length;
    if (dom.status) {
      const stamp = new Date().toLocaleTimeString();
      let msg = `Updated ${stamp}. Tracking ${tracked}/${total} items with enough history`;
      // YATA's export is crowd-sourced and can lag the actual game state. Show
      // how stale the data is when we know, so users don't trust a 5-min-old
      // reading as live.
      if (yataExportMs !== null) {
        const ageMin = Math.round((Date.now() - yataExportMs) / 60000);
        if (ageMin >= 2) {
          msg += `. YATA data ${ageMin}m old`;
        }
      }
      if (!TORN_API_KEY) msg += '. Add a Torn API key for profit figures';
      dom.status.textContent = msg;
    }
  }

  // ---------------------------------------------------------------------
  // Refresh loop
  // ---------------------------------------------------------------------

  async function refreshAll() {
    const panel = document.getElementById('tsi-panel');
    // No panel at all means we navigated away within the SPA; nothing to do.
    if (!panel) return;

    // Each fetch is independent: YATA stock, Torn item prices, user state.
    // Use allSettled so a single failure (typically YATA going 502 for a few
    // minutes) doesn't blank the whole panel. We render with whatever did
    // come back, falling back to previously cached stockData.
    const results = await Promise.allSettled([
      fetchStockData(),
      fetchItemPrices(),
      fetchUserState(),
    ]);

    const failed = [];
    const labels = ['YATA stock', 'Torn item prices', 'user state'];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed.push(labels[i]);
        console.warn(labels[i] + ' fetch failed:', r.reason);
      }
    });

    const now = Date.now();
    // Always record a snapshot so collapsed-panel users still build history.
    // Previously, collapsing the panel halted data collection.
    const hist = recordSnapshot(now);

    // Skip the heavy render work when the panel is collapsed.
    if (panel.classList.contains('tsi-collapsed')) return;

    renderTable(hist, now);

    if (dom.status) {
      if (failed.length === 0) {
        // Successful refresh: leave renderTable's "Updated X. Tracking N/M"
        // message in place, since it carries more info than just a timestamp.
      } else if (failed.includes('YATA stock')) {
        // YATA is a third-party service; flag clearly so it doesn't look like
        // a script bug. Other services have their own messages.
        dom.status.textContent =
          'YATA temporarily unreachable. Showing last known stock. Retrying next refresh.';
      } else {
        dom.status.textContent = 'Partial update: ' + failed.join(', ') + ' failed';
      }
    }
  }

  // True when the travel agency shop is actually on screen. Torn is a single
  // page app, so the URL can read sid=travel before the shop has rendered,
  // and the shop can disappear when you navigate away without a page reload.
  // Checks the whole URL (search + hash) because PDA sometimes routes the
  // travel page through the hash rather than the query string.
  function onTravelPage() {
    return /[?&#]sid=travel\b/.test(location.href);
  }

  function ensurePanel() {
    if (!onTravelPage()) return;
    if (!document.body) return;
    if (document.getElementById('tsi-panel')) return;
    buildPanel();
    refreshAll();
  }

  function init() {
    ensurePanel();

    // Re-inject if Torn's SPA re-renders and wipes the panel, and tear it
    // down when you leave the travel page. A single observer on body covers
    // both browser and PDA without polling. Debounced so it doesn't fire
    // on every micro-mutation while Torn's UI is animating.
    const startObserver = () => {
      const target = document.body || document.documentElement;
      if (!target) {
        // Body not ready yet (can happen on PDA): retry shortly.
        setTimeout(startObserver, 200);
        return;
      }
      let pending = null;
      const handle = () => {
        pending = null;
        if (onTravelPage()) {
          ensurePanel();
        } else {
          const stale = document.getElementById('tsi-panel');
          if (stale) stale.remove();
        }
      };
      const observer = new MutationObserver(() => {
        if (pending !== null) return;
        pending = setTimeout(handle, OBSERVER_DEBOUNCE_MS);
      });
      observer.observe(target, { childList: true, subtree: true });
    };
    startObserver();

    // Re-clamp the panel's custom position when the viewport changes size,
    // typically a phone orientation flip. Without this, a position saved in
    // landscape can land off-screen in portrait.
    let resizeTimer = null;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const panel = document.getElementById('tsi-panel');
        if (panel && panelPosition) applyPanelPosition(panel, panelPosition);
      }, 150);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    setInterval(refreshAll, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
