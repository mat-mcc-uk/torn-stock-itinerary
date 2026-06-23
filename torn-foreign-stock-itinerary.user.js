// ==UserScript==
// @name         Torn Foreign Stock & Itinerary Optimizer
// @namespace    mcc.torn.stock-itinerary
// @version      1.18.0
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
  const RESTOCK_RATIO = 0.5;                      // refill ≈ half sell-out time
  const MIN_POINTS_FOR_FIT = 4;                   // need this many to trust a rate
  const MIN_DECLINE_FOR_FIT = 30;                 // and this much total drop (items)

  // Buy-on-arrival policy: you land, buy, leave. You will not wait at a
  // destination for a restock. Any item that isn't already on the shelf when
  // you land is a no-fly. This is the max seconds you'd tolerate waiting; set
  // to 15 to match the post-arrival grace period, effectively "no waiting".
  const MAX_WAIT_SEC = 15;

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
  // FLIGHT_TIME_MULT applies Torn's global flight-time reduction first.
  function effectiveOneWay(oneWayMin) {
    let mult = TRAVEL_METHODS[travelMethod].timeMult;
    if (mailingBook) mult *= MAILING_BOOK_MULT;
    return oneWayMin * FLIGHT_TIME_MULT * mult;
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

  async function fetchStockData() {
    const data = await gmFetch('https://yata.yt/api/v1/travel/export/');
    stockData = data.stocks || {};
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

  // One user call pulling cash, travel state, and status in a single request.
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
        const back = destCode ? effectiveOneWay(COUNTRIES[destCode].oneWayMin) : 0;
        state.delayToTakeoffMin = flightLeftMin + back;
      }
    } else if (stateStr === 'abroad' || /^in /.test(state.description.toLowerCase())) {
      // Standing abroad: fly home before you can launch again.
      state.location = 'abroad';
      const here = destCode ? effectiveOneWay(COUNTRIES[destCode].oneWayMin) : 0;
      state.delayToTakeoffMin = here;
    } else {
      // In Torn (or okay/hospital/jail at home): can take off now.
      state.location = 'torn';
      state.delayToTakeoffMin = 0;
    }
    return state;
  }

  // ---------------------------------------------------------------------
  // Stock history + restock prediction
  // ---------------------------------------------------------------------

  // History shape in GM storage:
  //   { "chi:264": [[tsMs, qty], [tsMs, qty], ...], ... }
  // Key is countryCode:itemId. Arrays are time-ordered, oldest first.

  function loadHistory() {
    try {
      return JSON.parse(GM_getValue(HISTORY_KEY, '{}'));
    } catch {
      return {};
    }
  }

  function saveHistory(hist) {
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

        // Skip duplicate consecutive readings (same qty within 90s) to keep
        // the series compact; still captures every real change.
        if (last && last[1] === stockItem.quantity && now - last[0] < 90 * 1000) {
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

  // Linear fit over the most recent monotonically-declining run, returning
  // items sold per minute (positive number) or null if not enough signal.
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

    // Least-squares slope of qty vs minutes.
    const t0 = run[0][0];
    const xs = run.map((p) => (p[0] - t0) / 60000);
    const ys = run.map((p) => p[1]);
    const n = xs.length;
    const sx = xs.reduce((a, b) => a + b, 0);
    const sy = ys.reduce((a, b) => a + b, 0);
    const sxx = xs.reduce((a, b) => a + b * b, 0);
    const sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
    const denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    const slope = (n * sxy - sx * sy) / denom; // qty change per minute
    if (slope >= 0) return null; // not declining
    return -slope; // sold per minute
  }

  // Measure how long the last completed sell-out cycle took (minutes), from a
  // post-restock peak down to zero/near-zero. Used to size the restock wait.
  function lastSelloutDurationMin(series) {
    if (!series || series.length < MIN_POINTS_FOR_FIT) return null;
    let peakIdx = -1;
    let peakVal = -1;
    // Find a peak followed later by a near-zero.
    for (let i = 0; i < series.length; i++) {
      if (series[i][1] > peakVal) {
        peakVal = series[i][1];
        peakIdx = i;
      }
    }
    if (peakIdx < 0) return null;
    for (let j = peakIdx + 1; j < series.length; j++) {
      if (series[j][1] <= Math.max(1, peakVal * 0.02)) {
        return (series[j][0] - series[peakIdx][0]) / 60000;
      }
    }
    return null;
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
      restockPeak: null,
      confidence: 'low',
    };
    if (!series || series.length < MIN_POINTS_FOR_FIT) return result;

    const qty = series[series.length - 1][1];
    const rate = sellRatePerMin(series);
    result.sellRate = rate;
    // Highest stock seen: a stand-in for how much a fresh restock puts on the
    // shelf. Used to project stock when an empty item refills mid-flight.
    result.restockPeak = Math.max(...series.map((p) => p[1]));

    if (qty <= 0) {
      result.state = 'empty';
      // Restock ≈ half the last sell-out duration, snapped to a tick.
      const sellout = lastSelloutDurationMin(series);
      const emptiedAt = series[series.length - 1][0];
      if (sellout) {
        const waitMin = sellout * RESTOCK_RATIO;
        result.nextRestockMs = nextTick(emptiedAt + waitMin * 60000);
        result.confidence = 'medium';
      } else {
        // No measured cycle: fall back to the next tick as a floor.
        result.nextRestockMs = nextTick(now);
        result.confidence = 'low';
      }
      return result;
    }

    if (rate && rate > 0) {
      result.state = 'depleting';
      result.etaEmptyMin = qty / rate;
      result.confidence = series.length >= MIN_POINTS_FOR_FIT * 2 ? 'medium' : 'low';
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

      const oneWayMin = effectiveOneWay(country.oneWayMin);
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
        const sellValue = marketInfo ? marketInfo.market_value : null;
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
        const projected = Math.max(
          0,
          Math.round(stockItem.quantity - pred.sellRate * minsToLanding)
        );
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

    // In stock, no measurable decline: stock is sitting there to grab.
    if (stockItem.quantity >= cap) {
      return {
        code: 'go',
        label: 'Go',
        reason: `${stockItem.quantity} in stock, stable, grab and go`,
        expectedStockOnArrival: stockItem.quantity,
      };
    }
    return {
      code: 'risky',
      label: 'Risky',
      reason: `Only ${stockItem.quantity} in stock, partial load`,
      expectedStockOnArrival: stockItem.quantity,
    };
  }

  // hh:mm local clock for a timestamp.
  function fmtClock(tsMs) {
    return new Date(tsMs).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }


  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------

  GM_addStyle(`
    #tsi-panel {
      position: fixed;
      top: 80px;
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
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      user-select: none;
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
    #tsi-panel .tsi-v-wait { background: #5a2424; color: #f0a0a0; }
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
          <button class="tsi-toggle" id="tsi-collapse">_</button>
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
    // Start collapsed on narrow screens so the panel doesn't block the shop.
    const isNarrow = window.matchMedia('(max-width: 784px)').matches;
    if (isNarrow) panel.classList.add('tsi-collapsed');
    // Settings start open on desktop (room to spare), closed on narrow so the
    // results table is the default view. The gear toggles either way.
    if (!isNarrow) {
      document.getElementById('tsi-settings').classList.remove('tsi-settings-hidden');
    }

    panel.querySelector('h3').addEventListener('click', () => {
      panel.classList.toggle('tsi-collapsed');
      const collapsed = panel.classList.contains('tsi-collapsed');
      document.getElementById('tsi-collapse').textContent = collapsed ? '+' : '_';
      // Expanding after a collapse: pull fresh data now rather than waiting
      // for the next interval tick.
      if (!collapsed) refreshAll();
    });
    // Reflect initial state in the button glyph.
    document.getElementById('tsi-collapse').textContent = isNarrow ? '+' : '_';

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

    document.getElementById('tsi-country').addEventListener('change', (e) => {
      countryFilter = e.target.value;
      GM_setValue('countryFilter', countryFilter);
      renderTable();
    });

    document.getElementById('tsi-refresh').addEventListener('click', refreshAll);

    // Toggle a per-item history chart by clicking its row. Delegation on the
    // tbody means the single listener survives every re-render.
    document.getElementById('tsi-tbody').addEventListener('click', (e) => {
      const row = e.target.closest('tr.tsi-item-row');
      if (!row) return;
      const key = row.dataset.key;
      if (expandedCharts.has(key)) expandedCharts.delete(key);
      else expandedCharts.add(key);
      renderTable();
    });
  }

  function formatMoney(n) {
    if (n === null || n === undefined) return '—';
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(Math.round(n)).toLocaleString();
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
    return `<span class="tsi-verdict ${cls}" title="${v.reason.replace(/"/g, '')}">${v.label}</span>`;
  }

  function restockCell(r, now) {
    const p = r.pred;
    if (p.state === 'empty' && p.nextRestockMs) return fmtCountdown(p.nextRestockMs, now);
    if (p.state === 'depleting' && p.etaEmptyMin != null) {
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
        ${restockMark}
        <polyline points="${pts}" fill="none" stroke="#5aa0f0" stroke-width="1.5"/>
      </svg>
    `;
  }

  // Track which item rows have their chart expanded, so the chart survives the
  // periodic re-render. Keyed by countryCode:itemId.
  const expandedCharts = new Set();

  function renderTable(hist, now) {
    hist = hist || loadHistory();
    now = now || Date.now();
    const rows = rankItineraries(hist, now);
    const tbody = document.getElementById('tsi-tbody');
    if (!tbody) return;

    // Swap the profit column header to match the chosen display mode.
    const profitHead = document.getElementById('tsi-profit-head');
    if (profitHead) profitHead.textContent = profitMode === 'trip' ? '$/trip' : '$/hr';

    tbody.innerHTML = rows
      .slice(0, 50)
      .map((r) => {
        const profitVal = profitMode === 'trip' ? r.profitPerTrip : r.profitPerHour;
        const profitClass =
          profitVal === null ? '' : profitVal >= 0 ? 'tsi-profit-pos' : 'tsi-profit-neg';
        const key = r.countryCode + ':' + r.itemId;
        const isOpen = expandedCharts.has(key);
        const mainRow = `
          <tr class="tsi-item-row ${r.isWatched ? 'tsi-watched' : ''}" data-key="${key}">
            <td>${verdictCell(r.verdict)}</td>
            <td>${r.item}${r.isWatched ? ' ★' : ''}</td>
            <td>${r.quantity}${r.cashLimited ? ` <span style="color:#f0d27a" title="Cash only covers ${r.itemsAvailable}">(buy ${r.itemsAvailable})</span>` : ''}</td>
            <td class="${profitClass}">${formatMoney(profitVal)}</td>
            <td class="tsi-col-extra">${r.country}</td>
            <td class="tsi-col-extra">${restockCell(r, now)}</td>
            <td class="tsi-col-extra">${formatTime(r.roundTripMin)}</td>
          </tr>
        `;
        if (!isOpen) return mainRow;
        const chart = buildChartSVG(hist[key], r.pred, now);
        const chartRow = `
          <tr class="tsi-chart-row" data-key="${key}">
            <td colspan="7" style="padding:6px 8px;background:#141414">
              <div style="font-size:11px;color:#aaa;margin-bottom:2px">
                ${r.item} (${r.country}) stock history
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
    const best = document.getElementById('tsi-bestpick');
    if (best) {
      if (goRows.length) {
        const watchedGo = goRows.filter((r) => r.isWatched);
        const pick = (watchedGo.length ? watchedGo : goRows)[0];
        best.style.display = 'block';
        const pickVal = profitMode === 'trip' ? pick.profitPerTrip : pick.profitPerHour;
        const pickUnit = profitMode === 'trip' ? '/trip' : '/hr';
        best.innerHTML = `<strong>Fly now:</strong> ${pick.item} in ${pick.country}. ${pick.verdict.reason}, ${formatMoney(pickVal)}${pickUnit}`;
      } else {
        best.style.display = 'none';
      }
    }

    const effcap = document.getElementById('tsi-effcap');
    if (effcap) {
      effcap.textContent = `(carrying ${effectiveCapacity()} with ${
        TRAVEL_METHODS[travelMethod].name
      })`;
    }

    const moneyEl = document.getElementById('tsi-money');
    if (moneyEl) {
      if (userMoney !== null) {
        moneyEl.textContent = 'Cash: ' + formatMoney(userMoney);
        moneyEl.style.color = '#9fe8b0';
      } else if (TORN_API_KEY && affordFilter) {
        moneyEl.textContent = 'Cash unavailable (key needs money access)';
        moneyEl.style.color = '#e0a060';
      } else {
        moneyEl.textContent = '';
      }
    }

    const locEl = document.getElementById('tsi-location');
    if (locEl) {
      const d = Math.round(travelState.delayToTakeoffMin || 0);
      if (travelState.location === 'torn') {
        locEl.textContent = 'In Torn, ready to fly';
      } else if (travelState.location === 'abroad') {
        locEl.textContent = `${travelState.description || 'Abroad'}. Takeoff in ~${formatTime(d)} (after flying home)`;
      } else if (travelState.location === 'outbound') {
        locEl.textContent = `${travelState.description || 'Traveling'}. Takeoff in ~${formatTime(d)}`;
      } else if (travelState.location === 'returning') {
        locEl.textContent = `Heading to Torn. Takeoff in ~${formatTime(d)}`;
      } else {
        locEl.textContent = '';
      }
    }

    // Learning progress: how many tracked items have enough history to advise.
    const tracked = Object.values(hist).filter((s) => s.length >= MIN_POINTS_FOR_FIT).length;
    const total = Object.keys(hist).length;
    const status = document.getElementById('tsi-status');
    if (status) {
      const stamp = new Date().toLocaleTimeString();
      let msg = `Updated ${stamp}. Tracking ${tracked}/${total} items with enough history`;
      if (!TORN_API_KEY) msg += '. Add a Torn API key for profit figures';
      status.textContent = msg;
    }
  }

  // ---------------------------------------------------------------------
  // Refresh loop
  // ---------------------------------------------------------------------

  async function refreshAll() {
    // Skip network work when there's nothing to show: panel gone (navigated
    // away within the SPA) or collapsed. Saves Torn API calls against your
    // 100/min budget while you're not looking at it.
    const panel = document.getElementById('tsi-panel');
    if (!panel || panel.classList.contains('tsi-collapsed')) return;

    const status = document.getElementById('tsi-status');
    try {
      await Promise.all([fetchStockData(), fetchItemPrices(), fetchUserState()]);
      const now = Date.now();
      const hist = recordSnapshot(now);
      renderTable(hist, now);
    } catch (err) {
      console.error('Torn Stock Itinerary refresh failed:', err);
      if (status) status.textContent = 'Error: ' + err.message;
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
    // both browser and PDA without polling.
    const startObserver = () => {
      const target = document.body || document.documentElement;
      if (!target) {
        // Body not ready yet (can happen on PDA): retry shortly.
        setTimeout(startObserver, 200);
        return;
      }
      const observer = new MutationObserver(() => {
        if (onTravelPage()) {
          ensurePanel();
        } else {
          const stale = document.getElementById('tsi-panel');
          if (stale) stale.remove();
        }
      });
      observer.observe(target, { childList: true, subtree: true });
    };
    startObserver();

    setInterval(refreshAll, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
