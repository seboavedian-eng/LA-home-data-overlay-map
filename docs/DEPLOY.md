# Putting the pilot on brickline.tech

What you already have (from your email, November 2026):

- **Domain:** brickline.tech at Squarespace Domains.
- **Hosting:** Render, account with a service "Brickline Studio". That service runs the old Arlington ADU app from the public repo `adu-eligibility-app`.

The pilot replaces it. Nothing here is verified against the live services: the sandbox it was built in can't reach Render, Squarespace or brickline.tech.

## What goes online, and what never does

| Online (the deploy package) | Never online |
|---|---|
| `brickline.html` as the home page, privacy and terms pages | `blockgroups.html` (the explorer: personal-use data) |
| Scripts, styles, map libraries, zone rules | `raw-data/` (Redfin exports, your ratings table, sign-ups) |
| Census and assessor data files | `.env`, `ors-api-key.txt`, `census-api-key.txt` |
| Schools file **with ratings removed** | GreatSchools ratings |
| `server.py` (the public server) | `scripts/listing-server.py` (local only: it serves the whole folder) |

`scripts/build-public-site.py` copies from an allowlist. The build refuses to finish if any key file, raw-data, Redfin export, sign-up file or rating gets in. `tests/test_public_server.py` plants every one of those and checks.

## Once: accounts and keys (about 45 minutes)

| # | Where | Do this | You get |
|---|---|---|---|
| 1 | GitHub → each repo → Settings → General → Danger Zone | **Change visibility → Private** for `LA-home-data-overlay-map` and `adu-eligibility-app` | Code and research hidden |
| 2 | resend.com | Sign up → Domains → Add `brickline.tech` | 3–4 DNS records to paste |
| 3 | Squarespace → Domains → brickline.tech → DNS → Custom records | Add each Resend record exactly as shown; wait for Resend to say "Verified" | Emails that don't land in spam |
| 4 | resend.com → API Keys | Create a key with sending access only | `RESEND_API_KEY` |
| 5 | locationiq.com | Sign up (free plan) → Access Tokens | `LOCATIONIQ_KEY` |
| 6 | openrouteservice.org | Your existing key (the one in `ors-api-key.txt`) | `ORS_API_KEY` |

## Each release: build and upload (about 10 minutes)

On your computer, in the project folder:

```
python scripts/build-public-site.py
```

This makes `dist/`. It prints what it left out, and warns if the Census file is missing.

**The first time only,** publish `dist/` as its own private repo. In GitHub Desktop:
- File → Add local repository → choose `dist`. Say yes to "create a repository" if asked.
- Publish repository → name it `brickline-site` → keep **"Keep this code private"** ticked.

**Every later time:** run the build again (it keeps `dist/.git`), then in GitHub Desktop commit and push. Render redeploys by itself.

## Once: Render

| # | Where | Do this |
|---|---|---|
| 1 | Render → New → Blueprint | Pick `brickline-site`; Render reads `render.yaml` and creates the "brickline" web service |
| 2 | The service → Environment | Fill `OWNER_EMAIL` (your Gmail), `RESEND_API_KEY`, `LOCATIONIQ_KEY`, `ORS_API_KEY`. `UNSUB_SECRET` is generated for you |
| 3 | The service → Settings → Custom Domains | Add `brickline.tech` and `www.brickline.tech`; Render shows the DNS values |
| 4 | Squarespace → brickline.tech → DNS | Remove the old records pointing at the ADU app; add Render's values (usually an A record for `@` and a CNAME for `www`) [Likely] |
| 5 | Render → Brickline Studio (old ADU app) | Settings → Suspend (or Delete). It uses old libraries and accepts requests from any site |
| 6 | The service → Plan (optional) | Starter, so it never sleeps. Free sleeps when idle: first visit waits about a minute, and saved sign-ups are wiped on restart |

## Check it works

1. Open https://brickline.tech. The pilot appears, with "Pilot" (not "Pilot · your data") at the top.
2. Answer two questions, give your own email, click "Show my results".
3. Within a minute you get **two** emails: your shortlist, and a "Brickline lead" copy.
4. Click "Open your results on the map" in the email; your answers come back.
5. Click "Unsubscribe" in the email; the page says you're unsubscribed.
6. Visit https://brickline.tech/.env and https://brickline.tech/raw-data/; both must say "Not found".
7. Render → the service → Logs shows one line per API call. Failures name the service and the error.

## What the server does (server/brickline_server.py)

| Endpoint | Does | Guard |
|---|---|---|
| `/` and site files | Serves `site/` only | No folder listings, no dotfiles, known file types only |
| `GET /api/config` | Tells the page what's proxied | Never includes a key |
| `POST /api/lead` | Keeps the sign-up, emails you, emails the visitor their results | Hidden field, under-1-second check, 10 posts/10 min per visitor, 3 result emails/day per address, unsubscribe list |
| `GET /api/unsubscribe` | Stops future result emails | Signed link (`UNSUB_SECRET`) |
| `POST /api/isochrone`, `GET /api/directions` | Commute areas and drive times | LA County only, 1–60 min, 120 lookups/10 min per visitor |
| `GET /api/geocode` | Address search and suggestions (LocationIQ) | LA County box, 3+ characters, same limit |

Every response carries security headers: a content policy (scripts from the site only, plus `'unsafe-eval'` for Turf), no framing, no sniffing, HTTPS-only.

## Known gaps

- **Free plan restarts wipe `data/`** (sign-ups and the unsubscribe list). Every sign-up is also emailed to you, so nothing is lost; the unsubscribe list is. Use Starter with a disk, or move both to a database, before real volume.
- **Privacy and terms are drafts.** Add your contact address, and have a lawyer read them before paid reports.
- **Data files are served whole** (e.g. the price table). Serving per area is the next step if copying becomes a worry.
