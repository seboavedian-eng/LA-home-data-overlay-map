# Rent & STR data tools: user sentiment on Rentometer, RentCast and AirDNA

**Method and limits (read first).** Researched 2026-11-03. WebFetch could not reach `www.trustpilot.com` or `www.biggerpockets.com` (DNS blocked in this sandbox: "getaddrinfo ENOTFOUND"). After two hosts failed the same way I stopped fetching. Every finding below comes from **WebSearch result snippets and summaries**, not from reading the pages in full. So:
- Text in quotation marks is wording a search snippet attributed to the page. I could not check it against the live page, and it may be paraphrased.
- None of the searches surfaced Reddit threads. Reddit sentiment is a gap, not a "no complaints" finding.
- "Echoed by N users" counts were not visible anywhere, so they are omitted.
- Many "review" pages that ranked (bnbcalc, airbtics, rentest.ai, rpcapitallending, newsilver, realtyapi) are competitor or affiliate content. They are flagged where used.

---

## What do landlords, investors and hosts repeatedly praise about each?

### Takeaway
- **Rentometer** is praised as a fast, simple first benchmark for asking rents.
- **RentCast** is praised for estimates that match local listings and MLS comps, for showing its comps, ranges and confidence scores, and for a usable free tier and API.
- **AirDNA** is praised for market-level depth (occupancy and ADR trends, seasonality, history since 2018, Market Score). Some hosts call its property-level estimates "scarily accurate".

### Cited Findings
**Rentometer**
- Offerings: a BiggerPockets agent reply calls it "a great place to start but for accurate rental rates, you need to do your own digging." This is praise with a caveat. — [BiggerPockets post](https://www.biggerpockets.com/posts/5637061)
- Accuracy, older material: a BiggerPockets thread titled "Rentometer - Their data seems to be pretty spot on.....what say you?" is about 12 years old (c. 2013–14). One investor there said the data was refreshed often enough not to be outdated. — [BiggerPockets thread (c. 2013)](https://www.biggerpockets.com/forums/80/topics/148464-rentometer---their-data-seems-to-be-pretty-spot-onwhat-say-you)
- Coverage and sample control: Rentometer says you can widen or narrow the radius to change the sample size. — [Rentometer features](https://www.rentometer.com/rentometer-features)
- Support and billing: the single BBB customer review praises a refund Rentometer gave after the customer missed a renewal cancellation. — [BBB profile](https://www.bbb.org/us/ma/boston/profile/information-technology-services/rentometer-inc-0021-240536)
- Rentometer's own testimonials page praises its accuracy, but the company picks those testimonials, so they are not independent. — [Rentometer testimonials](https://www.rentometer.com/pages/testimonials)

**RentCast**
- Accuracy, Trustpilot: reviewers mostly praise accuracy and ease of use. One said it is "very close to actual rental comps pulled from the MLS." — [Trustpilot RentCast](https://www.trustpilot.com/review/rentcast.io)
- Accuracy compared with Zillow: affiliate-style review pages say Reddit and Trustpilot reviewers find RentCast "align[s] closely with what they're seeing in local listings — more so than Zillow's Zestimate rental tool." This is second-hand and the underlying Reddit posts were not found. — [bnbcalc RentCast review 2026](https://www.bnbcalc.com/reviews/rentcast-review-2026); [Seedly](https://seedly.sg/posts/rentcast-active-best-coupon-code/)
- Forum: a BiggerPockets poster says they are "a big fan of Rentcast.io." The thread is about 3 years old (c. 2023) and mainly about the BiggerPockets estimator. — [BiggerPockets "Most Accurate Rent Estimator"](https://www.biggerpockets.com/forums/921/topics/1153346-most-accurate-rent-estimator)
- UI and transparency: each estimate shows a confidence score, a low-to-high range, and the comps used. — [RentCast rent estimates feature page](https://www.rentcast.io/features/property-rent-estimates); [bnbcalc 2026](https://www.bnbcalc.com/reviews/rentcast-review-2026)
- API breadth: the API covers 140M+ property records, owner details, value and rent AVMs, and comps. A Zapier integration shipped in Feb 2024. — [RentCast developer docs](https://developers.rentcast.io); [API changelog 2024-02](https://developers.rentcast.io/changelog/api-release-2024-02)
- API maintenance: the changelog shows targeted accuracy fixes, for example better value and rent estimates for studio layouts. — [RentCast developer docs/changelog](https://developers.rentcast.io)
- Third-party MCP servers wrap the RentCast API, which suggests developers are adopting it. — [glama mcp_rentcast](https://glama.ai/mcp/servers/tandat8503/mcp_rentcast/tools/get_rent_estimates); [robcerda rentcast-mcp-server](https://glama.ai/mcp/servers/robcerda/rentcast-mcp-server/tools/get_rent_estimate)

**AirDNA**
- Accuracy, close matches: one BiggerPockets host saw projected occupancy of 67% against an actual 76%, and projected ADR of $244 against an actual $259, so the tool ran low. Another host said it "runs a bit low, better than too high." A lender who compared 12 months of actuals found it "at times scarily accurate." Thread dates were not visible; they are probably 2021–2024. — [BP "How accurate is AirDNA for STR revenue projection?"](https://www.biggerpockets.com/forums/530/topics/1145464-how-accurate-is-airdna-for-str-revenue-projection); [BP "How accurate are AirDNA estimates…"](https://www.biggerpockets.com/forums/530/topics/1191880-how-accurate-are-airdna-estimates-and-calculators-for-strs); [BP "how accurate airdna rentalizer in your experience?"](https://www.biggerpockets.com/forums/530/topics/1088287-how-accurate-airdna-rentalizer-in-your-experience)
- Accuracy, total revenue: a 2026 test by Chalet (a competitor) found AirDNA "nearly matched our property's total revenue at $69,500." — [Chalet best Airbnb calculator 2026](https://www.getchalet.com/blog/the-best-airbnb-calculator)
- Offerings: reviewers call its market-level data the deepest in the category, covering occupancy trends and seasonal ADR. Coverage is global, even on the Free plan, with history back to 2018 and a Market Score tool. — [strspecialist AirDNA review 2026](https://strspecialist.com/reviews/airdna-analytics-review); [bnbcalc AirDNA review 2026](https://www.bnbcalc.com/reviews/airdna-review-2026); [realestatebees](https://realestatebees.com/software/airdna/)
- Market-level accuracy, vendor claim: AirDNA says it estimated Airbnb's revenue at 95–99% accuracy, and reports 94.9% against Airbnb and 98.7% against Vrbo public filings. These are aggregate figures, not per-listing. — [AirDNA accuracy page](https://www.airdna.co/airdna-accuracy); [AirDNA blog Q2 2022 (2022)](https://www.airdna.co/blog/airdna-data-accuracy-validated-by-airbnb-q2-2022-report)
- Support: one Trustpilot reviewer said an agent "went above and beyond as a gesture of goodwill to ensure a full refund." — [Trustpilot AirDNA](https://www.trustpilot.com/review/www.airdna.co)

### Inferences
- Praise for RentCast and Rentometer is mostly about speed and a believable "first number". Neither has a body of praise for matching signed leases.
- AirDNA's most solid strength is aggregate market trends. Praise for property-level accuracy is anecdotal and mixed (see the complaints below).

### Gaps
- No Reddit threads (r/landlord, r/realestateinvesting, r/airbnb_hosts) were surfaced by search, and Reddit pages could not be fetched or tested.
- No praise was found for UI/UX of any tool beyond "easy to use" (RentCast, Trustpilot).

---

## What do they repeatedly complain about?

### Takeaway
- **AirDNA**: the dominant complaints are billing (auto-renewal, a 2-day cancellation window, refused refunds) and property-level estimates that swing or are wrong. Sometimes the total is right but the occupancy/ADR mix behind it is wrong.
- **Rentometer**: complaints are about asking rents rather than achieved rents, thin samples in small markets, older comps on the free and lower tiers, and a tight free limit.
- **RentCast**: complaints are about sources that are not disclosed, comps that are listings rather than leases, weak results in thin or rural markets, clumsy multi-family setup, plan limits, and API costs that rise fast for search-heavy use.

### Cited Findings
**Rentometer**
- Accuracy, asking vs achieved rent: Rentometer itself says its listing-based data "generally reflect advertised asking rents, which may differ from the final rent agreed upon." — [Rentometer About Our Data](https://www.rentometer.com/about-our-data)
- Sample size: a 2026 review says small and rural markets have few recent listings, so the comp set shrinks and the estimate gets shakier. Another source complains that it returns a clean range "whether it had forty good comps or four bad ones." That source is a competitor. — [bnbcalc Rentometer review 2026](https://www.bnbcalc.com/reviews/rentometer-review-2026); [rentest.ai "Is Rentometer Accurate?"](https://rentest.ai/blog/is-rentometer-accurate)
- Data freshness: competitor blogs say free-tier comps can be 12+ months old, while paid tiers filter to the last 3 months (Pro) or 12 months (Pro Lite). Rentometer's own pages confirm that the recency filter differs by tier. — [newsilver](https://newsilver.com/the-lender/rentometer-alternatives/); [rpcapitallending](https://rpcapitallending.com/blog/b/rentometer-alternatives); [Rentometer pricing](https://www.rentometer.com/products-and-pricing)
- Transparency: Rentometer does not disclose its data sources in detail, so accuracy varies by area. — [Landlord Studio](https://www.landlordstudio.com/blog/what-is-rentometer-and-how-useful-is-it); [rentprep](https://rentprep.com/blog/rentometer-reviews/)
- Pricing: the free tier allows 5 reports per 30 days. Rentometer says the free tool "isn't designed for high volume usage or professional usage." — [Rentometer products & pricing](https://www.rentometer.com/products-and-pricing)
- Freshness, second-hand: a competitor page says Reddit and G2 reviewers "frequently flag data freshness as a concern." I could not verify this. — [bnbcalc Rentometer 2026](https://www.bnbcalc.com/reviews/rentometer-review-2026)
- App: a recent Google Play review complains of repeated login problems and errors. — [Google Play](https://play.google.com/store/apps/details?id=com.rentometer.rentestimates)

**RentCast**
- Transparency: one review says accuracy "can be inconsistent" because RentCast does not disclose its sources. Another says accuracy depends on the scope and quality of its market data. — [rentalrealestate.com](https://rentalrealestate.com/tools/rentcast/); [softwarefinder](https://softwarefinder.com/property-management-software/rentcast)
- Asking vs achieved rent: "comps are listings, so they show what owners asked, not what tenants signed." — [bnbcalc RentCast 2026](https://www.bnbcalc.com/reviews/rentcast-review-2026)
- Coverage: thin rural or unusual properties may need manual comp checks. — [jakenfinancegroup](https://jakenfinancegroup.com/blog/rentcast-review/)
- UI: a Trustpilot reviewer had to enter a multi-family property multiple times to get the units right. Other reviewers complain about plan limits. — [Trustpilot RentCast](https://www.trustpilot.com/review/rentcast.io)
- Offerings: RentCast is "rent data, not deal analysis," with no cap-rate, cash-flow or financing math. — [portfoliocostguide RentCast vs Rentometer](https://portfoliocostguide.com/rentcast-vs-rentometer)
- API cost: a listings-API comparison calls per-request pricing "steep at entry." It says the pricing suits one lookup per property with caching but adds up fast for search-heavy workloads. The source is a competing API vendor. — [realtyapi.io](https://www.realtyapi.io/blog/best-real-estate-listing-api)
- API tiers: a third-party MCP server warns that the API "may return basic property data instead of detailed rent estimates depending on subscription tier." Its docs also say to pass beds, baths and square footage for better accuracy. — [glama mcp_rentcast](https://glama.ai/mcp/servers/@tandat8503/mcp_rentcast/tree/d6ec3ba6887e7400ebba718d1f2f37204014b70f)
- Billing: the web app and the API are billed separately, so a web subscription includes no API quota. — [jakenfinancegroup](https://jakenfinancegroup.com/blog/rentcast-review/); [aiandrealtors](https://aiandrealtors.com/review-rentcast)

**AirDNA**
- Accuracy swings: a host who has owned a property for almost a decade says it showed "$33k when it does $100k to $125k a year." The same host says the numbers "used to be within plus or minus 10%." — [BP "Did AirDNA Projected Revenue Just Take A Nose Dive?"](https://www.biggerpockets.com/forums/530/topics/1268169-did-airdna-projected-revenue-just-take-a-nose-dive)
- Right total, wrong mix: Chalet's 2026 test found AirDNA assumed 79% occupancy at $242 ADR, against an actual 70% at $310. — [Chalet 2026](https://www.getchalet.com/blog/the-best-airbnb-calculator)
- Overestimation: some users say the Rentalizer overestimates, partly because revenue includes cleaning fees. — [your.rentals Rentalizer guide](https://your.rentals/blog/airdna-rentalizer/)
- Falling reputation: one review says AirDNA was once praised for accuracy, but people now call its data "inaccurate" and "oftentimes wrong." The source is a competitor. — [airbtics AirDNA review (2024)](https://airbtics.com/airdna-review/)
- Method limits: occupancy comes from public calendars, so host-blocked dates look like bookings. Direct, off-platform bookings are invisible. The comp search uses a 10-mile radius. — [andrealeonel substack](https://andrealeonel.substack.com/p/cleaning-and-adjusting-airbnb-data-for-a-more-accurate-analysis-e650eff5b37e); [Chalet 2026](https://www.getchalet.com/blog/the-best-airbnb-calculator)
- Property-level and small-market accuracy concerns are the common con in review roundups. — [bnbcalc AirDNA 2026](https://www.bnbcalc.com/reviews/airdna-review-2026); [plumlending](https://plumlending.com/insights/airdna-short-term-rental-data-analytics-review)
- Billing, Trustpilot: AirDNA's replies say a cancellation must arrive at least 2 days before renewal. Reviewers report:
  - being charged after trying to cancel, and the company not confirming the cancellation;
  - getting only a half refund;
  - having a refund withheld until they added a new card;
  - "wish they sent a reminder" before billing.
  A third-party summary says recent 1-star reviews cluster around billing (June 2026). — [Trustpilot AirDNA](https://www.trustpilot.com/review/www.airdna.co); [checkthat.ai summary](https://checkthat.ai/brands/airdna/reviews)
- Billing and data, Capterra: one reviewer was charged again a year after cancelling, one paid for a service never received, and a July 2024 review titled "Inconsistent Data" called the data unusable. — [Capterra Canada AirDNA](https://www.capterra.ca/software/1063630/airdna)
- Offerings: there is no direct Airbnb integration for auto-pricing (it needs a PMS or channel manager), and all plans are single-user. — [bnbcalc AirDNA 2026](https://www.bnbcalc.com/reviews/airdna-review-2026); [bnbcalc dynamic pricing review](https://bnbcalc.com/reviews/airdna-airbnb-dynamic-pricing-review)

**California / Palm Springs specifics**
- **Palm Springs**, AirDNA market page, October 2026 snapshot:
  - TTM average revenue $65.5K, 52% occupancy, $428 ADR.
  - Revenue up 74.1% YoY while active listings are down 45.0%.
  - A swing that large may reflect how the averages are built (Palm Springs has capped STR permits), not a real change in demand. Treat it with caution. — [AirDNA Palm Springs](https://www.airdna.co/vacation-rental-data/app/us/california/palm-springs/overview)
- **Joshua Tree**, AirDNA snapshots disagree:
  - $53.7K revenue, 53% occupancy, $300 ADR across 2,655 listings (Aug 2026).
  - $53.9K on the California market page.
  - $42.5K as cited by Rakidzich.
  - AirROI says $51.9K and 45.6% occupancy; Rabbu is about $33K. — [AirDNA Joshua Tree](https://www.airdna.co/vacation-rental-data/app/us/california/joshua-tree/overview); [AirDNA California](https://www.airdna.co/vacation-rental-data/app/us/california); [AirROI](https://www.airroi.com/airbnb-data/united-states/california/joshua-tree); [Rakidzich](https://www.rakidzich.com/articles/sedona-vs-joshua-tree-vs-scottsdale-airbnb-2026)

### Inferences
- **Same blind spot in all three:** each estimates from listings or calendars, not from signed leases or payouts. RentCast and Rentometer reflect asking rents. AirDNA cannot tell bookings from blocked dates. A tool that labels this plainly ("asking, n=…, age of comps") would answer the most common accuracy complaint.
- **Billing is AirDNA's sharpest reputational weakness**, sharper than accuracy. No comparable billing complaints were found for RentCast or Rentometer; Rentometer's BBB profile has zero complaints.
- **Sources disagree by roughly 1.6× in one desert market.** That is evidence for showing a range from several sources rather than a single point estimate.

### Gaps
- No LA-specific sentiment was found for Rentometer or RentCast, for example rent-controlled units being mis-estimated.
- No independent backtest was found of RentCast or Rentometer estimates against signed leases.
- The "AirDNA overestimates" claim versus the "runs low" claim cannot be settled. The evidence goes both ways and is anecdotal.

---

## Ratings on Trustpilot, G2, Capterra, BBB, App Store and Google Play

### Takeaway
All figures below were seen via search snippets on 2026-11-03. Only AirDNA's Trustpilot page has a meaningful sample. Every other platform has fewer than 20 reviews per tool, or no figure was found.

### Cited Findings
| Tool | Platform | Rating | Reviews | Note / source |
|---|---|---|---|---|
| AirDNA | Trustpilot | 4.6 / 5 | 942 | Via a third-party summary. Recent 1-star reviews are about billing. [checkthat.ai](https://checkthat.ai/brands/airdna/reviews); [Trustpilot](https://www.trustpilot.com/review/www.airdna.co) |
| AirDNA | Capterra | 1.3 / 5 | 3 | [Capterra CA](https://www.capterra.ca/software/1063630/airdna) |
| AirDNA | G2 | 3.6 / 5 | 4 | Via an aggregator. A "4.7 / 152" figure seen elsewhere appears to be a different product, so it is not used. [bnbcalc 2026](https://www.bnbcalc.com/reviews/airdna-review-2026) |
| RentCast | Trustpilot | 4.5 / 5 | 14 | The snippet's capture was about 711 days old, so roughly late 2024. [ch.trustpilot](https://ch.trustpilot.com/review/rentcast.io) |
| RentCast | G2 / Capterra / BBB / apps | not found | — | — |
| Rentometer | BBB | A+, not accredited | 1 review, 0 complaints in 3 years | [BBB](https://www.bbb.org/us/ma/boston/profile/information-technology-services/rentometer-inc-0021-240536) |
| Rentometer | Google Play | 3.2 / 5 | 9 | [Google Play](https://play.google.com/store/apps/details?id=com.rentometer.rentestimates) |
| Rentometer | Trustpilot / G2 / Capterra / App Store | not found | — | — |

**Pricing and billing facts**

*RentCast API*
- Its API page lists a free tier of 50 calls a month, with overage from $0.20 down to $0.015 per request. — [rentcast.io/api](https://www.rentcast.io/api)
- Third-party sources list the tiers as Foundation ($74, 1,000 calls), Growth ($199, 5,000) and Scale ($449, 25,000). — [aiandrealtors](https://aiandrealtors.com/review-rentcast); [jakenfinancegroup](https://jakenfinancegroup.com/blog/rentcast-review/)
- **Conflict:** another snippet claimed a free tier of 2 calls a month and a $29 Starter plan with 100 calls. That is probably an old plan or a different product. Treat the official API page as authoritative.

*RentCast web app*
- The free plan includes 5 comps and 5 portfolio properties; Pro raises comps to 20. Third-party source. — [bnbcalc 2026](https://www.bnbcalc.com/reviews/rentcast-review-2026)

*Rentometer*
- The free tier allows 5 reports per 30 days. — [Rentometer pricing](https://www.rentometer.com/products-and-pricing)
- Cancelling takes effect at the end of the billing period, and can be done through the Customer Portal or support@rentometer.com. — [Rentometer help center](https://rentometer.zendesk.com/hc/en-us/articles/115000679403-How-do-I-cancel-my-account)

**Sources most useful or reliable for this kind of research**
- **BiggerPockets forums.** These were the best source of first-hand comparisons of projected against actual figures, with specific occupancy, ADR and revenue numbers. Weaknesses: threads are often undated in snippets, many are 2–12 years old, and the site was not fetchable here.
- **Trustpilot.** This is the only platform with real volume for AirDNA (942 reviews), and it is best for billing and support complaints. Company replies also reveal policy, such as AirDNA's 2-day cancellation rule. Weaknesses: small samples for RentCast, and not fetchable here.
- **Vendor docs, about-data pages and changelogs.** These are reliable for methodology admissions, such as Rentometer's "asking rents" and AirDNA's definition of revenue, and for pricing. They are not reliable for accuracy claims, which are self-reported and market-level.
- **Chalet's test.** Useful as one of the few structured comparisons of estimates against actual results, but Chalet is a competitor.
- **Weak sources.** G2 and Capterra have tiny samples (3–4 reviews), so they are statistically useless here. Many top-ranking "reviews" (bnbcalc, airbtics, rentest.ai, realtyapi, alternatives lists) are competitor or affiliate SEO content: useful for leads, not as evidence.
- **Not reached.** Reddit never appeared in results. Searching with `site:reddit.com`, or fetching it directly once the network allows it, is the main next step.

### Inferences
- AirDNA's high Trustpilot score sitting alongside a cluster of 1-star billing reviews suggests the product satisfies most users while the renewal and refund policy causes the angry minority.

### Gaps
- No App Store (iOS) ratings were found for any of the three.
- No Trustpilot rating was found for Rentometer, and no G2 or Capterra rating for RentCast or Rentometer.
- No GitHub issues or developer-forum complaints were found for the RentCast API.
- Before quoting any of these figures, re-check the live pages once `trustpilot.com`, `biggerpockets.com` and `reddit.com` are allowed in the session network settings.
