# js/data/

Empty until you run `scripts/fetch-census-data.sh` once (needs your own
internet access - this repo can't include it pre-generated, see the main
README's "Known limitations"). That script saves `acs-zcta.json` here, and
the app prefers loading it from this local file over any live network call.

Committing `acs-zcta.json` once you have it is a good idea: it makes the
whole app work with zero live third-party dependency for anyone else who
clones the repo, and it only needs regenerating when `ACS_YEAR` in
`js/config.js` changes (about once a year).
