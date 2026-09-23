# Decisions worth remembering

Short notes on choices that aren't obvious from the code, so we don't re-argue
them later.

**Block groups, not zip codes.** A zip can span a canyon and a flood plain.
Block groups are a few streets.

**No backend.** The app is one HTML file plus vendored libraries. It's
downloadable, has no running costs and can't break while you sleep. The one
exception is `listing-server.py`, because a static page can't hold an API key
without publishing it.

**Assessed value as a price proxy.** The public roll has no sale price column.
Prop 13 resets assessed value to purchase price on a sale, so for a
recently-sold house the assessed value *is* roughly the price. Two guards keep
paper transfers out: a base-year test, and a price-per-sqft plausibility band.

**SFR is classified from the text column, not the use code.** The numeric
Property Use Code in LA County's export doesn't reliably mean what the code
table says. Learned the hard way.

**DOM markers, not canvas circles, for listing pins.** Under `preferCanvas`, a
vector layer with its own pane creates a second canvas covering the whole map
that swallows every other click. Cost a long debugging session.

**Every card row must cite its source.** `cardRow()` refuses a row without a
tip, and `test_data_coverage.py` fails if a fetched field never reaches a card.
Two structural guards against silent drift.

**School boundaries from SABS despite being 2015-16.** It's the only dataset
covering every LA County district. The alternative — hand-translating written
boundary descriptions into polygons — is days of geometry where one slip puts
a house in the wrong zone. The age is labelled in three places instead.

**Ratings computed from CAASPP, not scraped from GreatSchools.** No free API,
paid tiers give bands not numbers, scraping is against their terms. Computing
from the public test data their own rating rests on is honest and explainable.
Your own CSV overrides it.

**Unrated schools are hidden by a rating filter.** Showing them alongside
filtered ones would imply they qualified.

**A decile needs at least 20 schools.** A lone school in its pool was being
rated 1 of 10 purely for being alone — a damning verdict drawn from nothing.
The test caught it.

**Tests use real mouse clicks where hit-testing matters.** `layer.fire("click")`
bypasses the DOM, and 218 tests once passed while the map was unusable.
