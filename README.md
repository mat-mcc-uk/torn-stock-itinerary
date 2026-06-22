# Torn Foreign Stock & Itinerary Optimizer

A userscript for [Torn](https://www.torn.com) that tracks foreign stock and tells you when to fly and what to buy. It pulls live stock levels from YATA, prices and your account state from the Torn API, logs stock history to predict restocks, and ranks every destination by profit per hour. It runs on desktop browsers (Tampermonkey) and Torn PDA.

## What it does

- Ranks every in-stock foreign item by profit per hour, factoring in your travel method and item capacity
- Predicts restocks from logged stock history and gives each item a Go / Wait / Risky verdict
- Reads your current location and works out how long until you can next take off, then folds that delay into the advice
- Filters out trips you can't afford based on your cash on hand
- Filters by watchlist (hunt one item like Xanax across all countries) or by a single country
- Shows a per-item stock history chart on click, with the predicted restock marked

## Install

You need a userscript manager first.

**Desktop browser:** install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari).

**Torn PDA:** the app has a built-in userscript manager under Settings.

Then install the script:

1. Open this link: [install the script](https://raw.githubusercontent.com/mat-mcc-uk/torn-stock-itinerary/main/torn-foreign-stock-itinerary.user.js)
2. Tampermonkey shows an install page. Click **Install**.
3. On Torn PDA, go to Settings, User Scripts, add a new script, and paste the same raw URL or the file contents.

The script only runs on the travel page (`torn.com/page.php?sid=travel`). Open the Travel Agency and the panel appears at the top right, or docked to the bottom on mobile.

## Set up your API key

The script needs your own Torn API key. Never use someone else's, and never share yours.

Create a key scoped to only what this script uses, rather than handing over full access. Go to **Preferences, API Key** in Torn and make a custom key with these selections:

- `torn`: `items`
- `user`: `money`, `travel`, `basic`

The `money` selection sits at Limited Access level, which is what powers the affordability filter and the location timing. If you skip it, those two features switch off and everything else still works.

Paste the key into the panel's API key field and click Save. The field masks the key by default. Click the eye button to check what you pasted. The key lives in your own userscript manager's storage and only ever goes to `api.torn.com`.

## Using it

The panel has a few controls:

- **Travel method:** pick Standard, Airstrip, WLT, or Business Class so flight times and capacity match your setup. Tick the mailing book box if you have it.
- **Base capacity:** your standard carry count from suitcases, job, and faction perks, before the travel method's +10.
- **Watchlist:** comma-separated item names. Watched items get a star and sort to the top.
- **Only watchlist:** show only watched items.
- **Hide unaffordable:** drop trips your cash can't cover.
- **Country:** narrow the table to one destination.

Each row shows a verdict (Go / Wait / Risky / Learning), the country, item, current stock, restock estimate, round-trip time, and profit per hour. Click a row to open its stock history chart.

## The learning period

Restock prediction needs history. The script logs stock every time it refreshes, so it starts blank and gets sharper as it watches. Until an item has enough logged readings, it shows **Learning** and gives no verdict. Leave the panel open on the travel page for a few hours before the advice is useful, longer for slow-selling long-haul items.

The status line shows how many items have enough history to advise on.

## Updates

The script carries `@updateURL` and `@downloadURL` headers pointing at this repo. Tampermonkey and Torn PDA check those and pull new versions automatically. To force a check in Tampermonkey, open the dashboard, go to the Utilities tab, and run a userscript update.

## How the prediction works

The script fits a sell rate to the recent decline in each item's logged stock, estimates when it will empty, and projects the next restock as roughly half the last sell-out duration, snapped to Torn's quarter-hour tick. It then simulates the item's state at the moment your flight would land, including the time to fly home and launch if you're already abroad, and picks a verdict from that.

Two constants near the top of the script tune the model once you've watched real cycles:

- `RESTOCK_RATIO` (default 0.5): refill time as a fraction of sell-out time. Community estimates range from a third to a half.
- `MIN_POINTS_FOR_FIT` (default 4): how many logged readings an item needs before the script trusts a rate.

## Limits and honesty

- Stock data comes from YATA's public export. If YATA is down or an item is missing from the feed, that item won't show.
- Restock timing is a heuristic, not a documented game mechanic. Treat verdicts as a strong hint, not a guarantee.
- Flight times carry a 3% in-game variance, so round-trip figures are close but not exact.
- The location timing is a snapshot refreshed every 60 seconds, so a mid-flight countdown can be up to a minute stale.

## Credits

Stock data from [YATA](https://yata.yt). Built for and shared with faction members.

## License

MIT
