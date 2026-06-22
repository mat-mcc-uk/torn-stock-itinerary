# Tutorial & FAQ

A walkthrough of the Foreign Stock Itinerary Optimizer: what it does, how to read it, and where its limits are.

## What it is

The script watches foreign stock and tells you the best trip to make right now. It sits on the Travel Agency page, pulls live stock from YATA and prices from the Torn API, and ranks every destination by profit per hour. It learns each item's sell and restock pattern over time, then tells you whether to fly with a Go, Risky, or No fly verdict.

It runs on desktop browsers through Tampermonkey and on mobile through Torn PDA.

## First run

1. Install a userscript manager (Tampermonkey on desktop, the built-in manager on PDA).
2. Install the script from the raw GitHub link.
3. Open the Travel Agency page. The panel appears top right on desktop, docked near the bottom on mobile.
4. Open settings (the gear icon) and paste your Torn API key.
5. Set your travel method, base capacity, and watchlist.
6. Leave it running. It starts blank and gets useful as it logs data.

## The API key

Make a custom key in Torn under Preferences, API Key, scoped to only what the script needs:

- `torn`: items
- `user`: money, travel, basic

Never use someone else's key and never share yours. The key stays in your own userscript manager's storage and only ever goes to api.torn.com. Without the `money` selection, the affordability filter and location timing switch off and everything else still works.

## Reading the table

Each row is one item at one destination.

- **Fly?** the verdict: Go, Risky, No fly, or Learning. Hover or tap for the reasoning.
- **Item** the item name. A star marks watchlist items.
- **Stock** current quantity. A "(buy N)" tag in amber means your cash only covers N of them.
- **$/hr** profit per hour of round-trip flight time, your main ranking number.

On desktop you also get Country, Restock, and RT (round-trip time) columns. On mobile those hide to save space. Tap any row to open a stock history chart with the predicted restock marked.

The banner above the table shows the single best Go pick right now. The line below the status shows where you are and how long until you can next take off.

## The verdicts

The script assumes you land, buy, and leave. It never tells you to wait at a destination for a restock.

- **Go** stock will be on the shelf when you land, enough to fill your capacity.
- **Risky** stock will be there but not a full load. You will come home with a partial.
- **No fly** nothing to buy on arrival. Either it is empty and stays empty until after you land, or it sells out before you get there, or it refills mid-flight but sells out again before you arrive.
- **Learning** not enough logged history to judge yet.

If you are abroad or mid-flight, the verdict adds the time to get home and take off again before checking whether stock will be there.

## The learning period

Restock prediction needs history, and the script builds that history itself by logging stock every refresh. It cannot predict from a cold start.

A new item shows Learning until it has at least four logged readings across a real decline. Until then, no verdict. Leave the panel open on the travel page for a few hours to warm it up, longer for slow-selling long-haul items that take an age to move. The status line tells you how many items have enough history.

History older than 48 hours is dropped to keep storage manageable.

---

# FAQ

**Why is an item I expected missing from the list?**

Run through these in order:

1. Your cash can't cover one of it and "Hide unaffordable" is on. A single Xanax runs hundreds of thousands, so a low balance hides it. Toggle the filter off to check.
2. The Country filter is set to somewhere else. Set it back to All countries.
3. "Only watchlist" is on and the item isn't on your watchlist.
4. It's empty right now and won't restock before you'd land, so it's correctly dropped under the buy-on-arrival rule.
5. YATA's feed doesn't currently list it. The script only knows what YATA reports.

**Why does everything say Learning?**

The script just started, or you cleared its history. It needs to watch each item decline over several refreshes before it trusts a sell rate. Give it a few hours on the travel page.

**Why did it tell me to fly and the stock was gone when I landed?**

Prediction is a heuristic, not a guarantee. The likely causes: another player cleared the shelf faster than the logged rate suggested, or the restock dropped less than the script's estimate. The estimate sharpens as it logs more cycles for that item. If it keeps happening on one item, the restock size assumption is off and the prediction self-corrects with more data.

**Does it buy items for me or fly automatically?**

No. It only advises. You make every purchase and every flight yourself. It reads data and ranks options, nothing more.

**Does it work mid-flight?**

It loads, but there's nothing to buy in the air, so the table is empty until you land. The location line still shows your takeoff countdown. The shop and its stock only exist once you arrive.

**Why does profit per hour look different after I change travel method?**

Faster methods cut flight time, which raises profit per hour even though profit per trip is the same. Switching method, toggling the mailing book, or changing capacity all recompute the table live.

**Where does the stock data come from? Is it live?**

From YATA's public export, which is crowd-sourced from players travelling with contributing scripts. It's close to live but only as fresh as the last player to report. An item can show stock that's a few minutes stale.

**Does it need a paid subscription to anything?**

No. YATA's export is free and needs no key. The Torn API key is free. Nothing here costs Torn cash or real money.

**Is my API key safe?**

It's stored locally in your userscript manager and only sent to api.torn.com. It's masked behind dots in the settings field. It isn't encrypted, so anyone with access to your device and userscript manager could read it, the same as any userscript. Use a scoped custom key rather than a full-access one.

**Can the whole faction share one key?**

No. Each person uses their own key. The script reads your cash, your location, and your travel state, which are personal to you.

**What are RESTOCK_RATIO and the other constants?**

Tuning knobs near the top of the script:

- `RESTOCK_RATIO` (0.5): how long a restock takes as a fraction of the sell-out time. Community estimates range from a third to a half. Adjust once you've watched real cycles on the charts.
- `MIN_POINTS_FOR_FIT` (4): how many logged readings before the script trusts a rate.
- `MAX_WAIT_SEC` (15): how long you'd tolerate waiting on arrival. At 15 it effectively means stock must already be there.

**It's cramped or hidden on PDA.**

Update to the latest version. The panel docks above PDA's bottom tab bar and collapses its settings behind the gear on narrow screens. If it still sits too low or too high, the clearance value in the script's mobile CSS (commented as the tab clearance) is the number to nudge.

**How do I get updates?**

The script carries update headers pointing at the repo. Tampermonkey and PDA pull new versions automatically. To force a check in Tampermonkey, run a userscript update from the dashboard's Utilities tab.

## What it does not do

To be clear about the boundaries:

- It does not buy, sell, or travel for you.
- It does not guarantee stock will be there. It predicts, and predictions miss.
- It does not work without warming up first.
- It does not see stock Torn hasn't told YATA about.
- It does not track your drug cooldown, energy, or nerve.
- It does not tell you to wait anywhere. Every Go means buy on arrival.
