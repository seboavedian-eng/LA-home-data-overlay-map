# What this is and where it's going

## The goal

Find a house in LA County using data, not vibes.

Listing sites tell you about the house. They tell you almost nothing about the
250 metres around it. This app puts the neighbourhood data next to the listing
so you can rule places out quickly and know why.

One user. Runs on your laptop. No accounts, no server, no cloud.

## Why a block group

A block group is about 600-3,000 people — roughly a few streets. It's the
smallest area the Census publishes income and demographics for.

Zip codes are useless for this. A zip can span a canyon and a flood plain.

## Features, and why each exists

### Built

| Feature | Why |
|---|---|
| Block group / tract / zip outlines | The frame everything else hangs on |
| Age, sex, ethnicity, ancestry | Who lives there |
| Income: median, per-capita, brackets | What you're buying into |
| Education, work, commute | Whether it's a commuter street or a working one |
| Housing stock: type, tenure, age | Detached vs flats, owners vs renters |
| Home prices from the Assessor roll | The only free source for *single-family* prices |
| Sales table per block group | The individual sales behind each median |
| Redfin listings on the map | Your actual candidates, in context |
| Favourites, notes, not-interested | It's a shortlist tool, not just a map |
| Fire, flood, seismic, pollution, noise, wind | The six things that make a cheap house cheap |
| Schools: zones + dots + your GreatSchools ratings | Usually the single biggest driver of price |
| Jurisdiction, zoning, historic | Which rulebook applies to building here |
| Satellite + parcel outlines | Where the trees, slope and lot lines actually are |
| Add a house by address | Not everything comes from Redfin |
| Paste a listing, it fills the card | Typing beds/baths/sqft by hand is the tedious part |

### Not built yet

| Feature | Why it matters | What's blocking it |
|---|---|---|
| Zone rules lookup | Turns "R1" into what you can build | Need the ordinance text — every route to it is blocked from the build sandbox |
| Sewer vs septic | Septic kills an ADU or costs five figures | Nothing. Ready to build |
| Easements (county-mapped) | A drainage easement kills an ADU outright | Nothing. Ready to build |
| Easements (private) | The ones that actually bite | No GIS layer exists — they live in title reports |
| Code enforcement history | Unpermitted work before you offer | Need to know which cities; most small ones publish nothing |

## Limits

### Feature level

- **School boundaries are from 2015-16.** NCES ran the survey twice and
  stopped. It's the only county-wide source. Confirm with the district.
- **School ratings are a snapshot of your GreatSchools table.** They are as
  current as the day you collected them. Re-collect and re-run the script to refresh.
- **Prices are reconstructed, not real sale prices.** The public roll has no
  sale price column. Prop 13 lets us infer it for recently-sold houses.
- **ACS is a 5-year average.** It describes roughly 2-3 years ago, not today.
- **Commute times are free-flow.** No free router models LA traffic.
- **Zoning shows the code only.** What the code permits isn't in any map.

### Product level

- **You run the scripts.** Four of them, occasionally. Nothing auto-updates.
- **Everything lives in one browser.** Favourites and notes are in local
  storage. Clear your browser, lose your shortlist.
- **Any publisher can break a layer** by renaming a field or moving a service.
  The app tells you which one and keeps going.
- **LA County only.** Most of it would work elsewhere; none of it is tested.

## Unlocks

Things that would each open up a lot:

1. **Export/import your shortlist** — ends the local-storage risk in an hour
   of work.
2. **Current attendance zones** — per district where published, or a paid
   county-wide source; 2015-16 is the weakest link in the school layer now.
3. **A title report parser** — turns escrow docs into card rows.
4. **Rental comps** — would make this work for investment, not just living.

## Next horizon

In rough order of value per hour of work:

1. Sewer + easements (no input needed, real ADU blockers)
2. Zone rules for your 5 target jurisdictions
3. Shortlist export
4. Commute with real traffic (needs a Mapbox key)
5. Everything else
