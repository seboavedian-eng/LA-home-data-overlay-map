# BiggerPockets verification and extension (live-page pass)

**Method.** Researched 2026-11-03. Every BiggerPockets page below was fetched with plain `curl -s -m 20` (no custom headers). All 32 cited URLs plus 36 new candidate threads returned HTTP 200; none was blocked. `/posts/5637061` returned 302, and `curl -L` resolved it to `/forums/311/topics/975650-how-accurate-is-rentometer#post_5637061`. Dates and text come from each page's schema.org JSON-LD (`WebPage.mainEntity` = `DiscussionForumPosting`). **Date caution:** on these pages the topic-level `datePublished` is the *last-activity* date. The real original-post date is `dateCreated`, and every "OP" date below uses `dateCreated`. Earlier search snippets mixed the two up, which is how a 2022 reply got dated "early 2026". Reply dates are each comment's own `dateCreated`. The JSON-LD sometimes holds a few fewer replies than `commentCount` (for example 6 of 7 on topic 1293035), so a quote that isn't found may sit in an unserved reply. In that case I mark it "not found on the served page" rather than "false". The member blog has no forum JSON-LD; its date comes from the page's `datetime` attributes (2018-11-28) and the label "Posted almost 8 years ago". Affiliations were checked against each poster's BiggerPockets profile description where noted.

## Q1. Do the BiggerPockets citations in the report and notes hold up on the live pages?

### Takeaway
About a third of the BP citations are accurate as written. About a third are real quotes pinned to the **wrong thread URL** or the **wrong year**. The rest are snippet paraphrases that don't appear anywhere on the cited page. The most important correction is context: the AirDNA "$33k vs $100–125k" complaint was a **confirmed temporary glitch, fixed within about two days** (Nov 2025). The BP Pro "calculators are awesome" thread is actually a **complaint thread**.

### Cited Findings

**Zillow / rent estimates — "Rent Estimate Accuracy of Zillow vs Redfin vs Rent-O-Meter?"** (OP William DeHaan, 2024-08-22)
- Report: the SoCal landlord got three rent figures for one house. **Confirmed.** OP (2024-08-22), 5-bed, 3,350 sf house in Oceanside CA: "Zillow says $5600 per month, Redfin says $5000 per month, Rent-O-Meter says $4100 - $4500 per month." — [BP 1206540](https://www.biggerpockets.com/forums/52/topics/1206540-rent-estimate-accuracy-of-zillow-vs-redfin-vs-rent-o-meter)
- Report: Zillow rent estimates "tend to run high". **Partly.** The phrase is not on the page. The substance is supported: Greg M. (2024-08-22, 3 likes) got "Rentometer: $3,868 Redfin: $4,173 Zillow: $6,233" for a unit he had just renewed, and Zillow was the highest. Stephen Delahoussaye (2026-05-18) adds that "these tools pull from listed rents not actual lease prices and they cannot account for condition, layout, or the micro neighborhood trends". Adam Bartomeo (2026-05-17): "They are ALL absolute crap." — [BP 1206540](https://www.biggerpockets.com/forums/52/topics/1206540-rent-estimate-accuracy-of-zillow-vs-redfin-vs-rent-o-meter)

**Mashvisor**
- Report: "grossly overestimating the occupancy", with 20 nights shown and 10 real (~2018–19), cited to topic 715383. **Not supported.** Neither the phrase nor the 20/10 figures appear in 715383 or in any other fetched Mashvisor thread. Thread "Any else use Mashvisor? How accurate is it?" (OP Colin M., 2019-06-05) has a single reply, from Chris T. (2019-06-06): "I found their numbers to be misleading… the top listings either greatly under estimated the rehab costs or seemed to have an inflated rental rate. (Looks like all their data is coming from Zillow)." The overestimation direction is supported; the quote and the numbers are not. — [BP 715383](https://www.biggerpockets.com/forums/725/topics/715383-any-else-use-mashvisor-how-accurate-is-it)
- Notes: "fairly accurate in the Smokies", cited to 715383. **Wrong thread.** The quote is from "Accuracy of Mashvisor data/analysis?" (OP 2018-01-23), in a reply by "Account Closed" dated **2020-05-08**: "Mashvisor I've found to be fairly accurate in the Smokies but not too accurate for the Florida rentals… gave me a slew of either very high revenues or extremely low revenues." — [BP 530420](https://www.biggerpockets.com/forums/530/topics/530420-accuracy-of-mashvisor-data-analysis)
- Notes: Airbnb occupancy matched "the 75th percentile". **Confirmed.** Mohyuddin Rehmattullah (2019-05-23, 3 likes): "Their data is quite inaccurate… Their airbnb occupancy rates are closer to the 75th percentile properties on airbnb and not the 50th percentile… half of their 'HOA' fees numbers are wrong." The same thread has more complaints from 2018-01-25: Tyler Work, "I have the paid subscription but have yet to get any real value out of it", and Evangeline Hooie, who "just ended my paid subscription". There is also praise: Nate Burgher (2018-01-23) found "the short-term rental info to be pretty solid", and Bradley Chapman (2020-05-09) liked that "you can export the data". — [BP 530420](https://www.biggerpockets.com/forums/530/topics/530420-accuracy-of-mashvisor-data-analysis)
- Notes: data "so inaccurate that it was completely unusable" (413555). **Not supported.** The phrase is not on the page. "Thoughts on Mashvisor?" (OP 2017-02-18) is mostly praise. Andrew Frishman (2018-02-15, 5 likes): "I am impressed with allot of its features… Its strength is it is a great tool to assist in valuations. I do find that some of the projected rents are incorrect." — [BP 413555](https://www.biggerpockets.com/forums/88/topics/413555-thoughts-on-mashvisor)
- Notes: thread titled "Beware Mashvisor Bait and Switch", body unknown. **Now readable.** OP Julie Flynn (2026-07-02): "Mashvisor is a dishonest bait-and-switch company. You don't find out until AFTER you have paid $149 that the analytics you need are only avialable at the way more expensive price point." There is one reply (Chris Seveney, a BP moderator, same day) asking whether she had confirmed the plan with them first. — [BP 1293786](https://www.biggerpockets.com/forums/88/topics/1293786-beware-mashvisor-bait-and-switch)

**BiggerPockets Pro and the BP Rent Estimator**
- Report: "flip, BRRRR, multi... calculators which are awesome!!" (topic 1293035). **Not found on the served page** (the page JSON-LD serves 6 of 7 replies). The framing is also misleading. "Bigger Pockets for what?" (OP Ian Robinson, **2026-06-25**) is a complaint: "I see spreadsheets that do math I can do myself. I see 'local' Pros that are anything but local… I simply do not see what value I am getting after paying for a membership." Replies are mixed. Caleb Brown (2026-06-25): "Pro is really ideal if you use the tools and calculators." Greg Scott (2026-06-25): "Pro didn't seem a great fit for me either." — [BP 1293035](https://www.biggerpockets.com/forums/55/topics/1293035-bigger-pockets-for-what)
- Report: Pro "creates a strong buy-in to the community". **Confirmed, verbatim.** "Paying for BiggerPockets Pro creates a strong buy-in to the community and motivates you to learn more, faster." The author is David Pere ("From Military To Millionaire"), and the post dates to about **2018-11-28**. **Bias flag:** the post's "Become a BiggerPockets Pro member here" link goes to `frommilitarytomillionaire.com/we-recommend-BP-Pro/`, the author's own redirect, which is likely a referral or affiliate link. The page does not show whether the author is BP staff, so the notes' "one endorser flagged as BP staff" could not be checked here. — [BP member blog](https://www.biggerpockets.com/member-blogs/10341/80188-is-biggerpockets-pro-worth-your-money)
- Report: "most likely not all that valuable to you if you are completely new". **Not supported.** The sentence is not in this blog post. The post is entirely positive. — [BP member blog](https://www.biggerpockets.com/member-blogs/10341/80188-is-biggerpockets-pro-worth-your-money)
- Notes: refund and cancellation complaints. **Confirmed.** "Trying to cancel BP pro membership" (OP 2023-06-05):
  - Tomara Fisher (2024-08-19, 5 likes): auto-renewed, "only to have the cancellation effective 8/19/2025".
  - Lisio Guy (2024-09-06): "I canceled few months ago, but got billed again... this is scam".
  - Solane Mesfin (2024-10-28): "No reply from support staff."
  - **Vendor replies:** Hilary C. (profile: Sr. Director of Customer Service, BiggerPockets) and Michael S. (profile: BiggerPockets Support).
  - Source: [BP 1121397](https://www.biggerpockets.com/forums/25/topics/1121397-trying-to-cancel-bp-pro-membership)
  - The bank stop-payment is in "Cancelling My Bigger Pockets Membership" (OP 2020-11-09). Ying Coyle (**2026-02-12**): "I have tried to cancel and get refund many times, never heard back. I have to ask my bank to put a stop payment on this." — [BP 892664](https://www.biggerpockets.com/forums/25/topics/892664-cancelling-my-bigger-pockets-membership)
- Report: the Rent Estimator showed $650 for a $1,500 rental, cited to 984857. **Wrong thread.** The quote is the OP of "What's a point to use Rent Estimator if it's so far from truth" (Vitalii Lunko, **2024-02-22**): "I have rented house for $1,500 but rent estimator shows $650 😂It should be deleted from bigger pockets." Gilad Lifshitz (2024-02-22): "the rent estimator here is usually showing lower numbers compared to Rentometer". Anastasia Osorio (2024-02-26): "Same experience here." — [BP 1173849](https://www.biggerpockets.com/forums/853/topics/1173849-whats-a-point-to-use-rent-estimator-if-its-so-far-from-truth)
- Report: "Horribly inaccurate for my market", cited to 1153346 and dated ~2022–25. **Wrong thread and wrong year, and the scope is wider than stated.** The quote is in "Rentometer and BP Rent Estimator" (OP 2021-09-15), from Mason Hickman (**2021-09-21**): "Both are horribly inaccurate for my market on Cape Cod. Many apartments are rented 'pre-MLS'." "Both" means Rentometer **and** the BP estimator. "Always inaccurate" is Brendan Miller (2021-09-16) in the same thread: "i don't use the BP rent estimator, it's always inaccurate whenever i've used it". — [BP 984857](https://www.biggerpockets.com/forums/52/topics/984857-rentometer-and-bp-rent-estimator)
- Report: multifamily rents use single-family rates, cited to 1145013. **Wrong thread.** The wording is from "Using BiggerPockets Rent Estimator Tool" (OP Tyler Lee, **2023-09-20**, no replies): "it seems to be using SFH rental rates for this value and does not break it up per unit." Topic 1145013 (OP Ricardo Riveros, 2023-09-29) only partly supports it: "i'm always getting low accuracy… i cannot get a good estimate of rent per unit." — [BP 1143190](https://www.biggerpockets.com/forums/432/topics/1143190-using-biggerpockets-rent-estimator-tool); [BP 1145013](https://www.biggerpockets.com/forums/432/topics/1145013-rental-estimates-for-multi-family)
- **Vendor employee in thread:** in "Most Accurate Rent Estimator", Scott Trench (2023-11-14) explains: "We purchase the data from Altos, and then build an algorithm to estimate rents." He was BiggerPockets' CEO at the time; his current profile reads "Rental Property Investor". Ke Nan Wang (2023-11-13): BP showed about $2,500 for a unit listed at $2,250 and cut to $2,190 after 15 days, "using comp that's from my 2020 listings". — [BP 1153346](https://www.biggerpockets.com/forums/921/topics/1153346-most-accurate-rent-estimator)

**Rentometer / RentCast**
- Report: Rentometer is "a great place to start". **Confirmed.** Brad Hammond (**2021-08-08**, 3 likes): "Rentometer is a great place to start but for accurate rental rates, you need to do your own digging. Rentometer doesn't take into account the nuances of the unit." The thread is "How accurate is Rentometer?" (OP 2021-08-08). — [BP 975650 #post_5637061](https://www.biggerpockets.com/forums/311/topics/975650-how-accurate-is-rentometer)
- Notes: the older thread said the data refreshes often enough. **Confirmed**, with OP date **2014-09-20**: "it seems to be often enough so that the data is not outdated." — [BP 148464](https://www.biggerpockets.com/forums/80/topics/148464-rentometer---their-data-seems-to-be-pretty-spot-onwhat-say-you)
- Notes: "a big fan of Rentcast.io". **Confirmed.** Jake Andronico (**2023-11-13**): "I'm a big fan of Rentcast.io. We also average this with Zillow, BP calc." — [BP 1153346](https://www.biggerpockets.com/forums/921/topics/1153346-most-accurate-rent-estimator)

**AirDNA**
- Report: "at times scarily accurate", cited to 1088287 and dated ~2021–24. **Wrong thread.** The quote is in "How accurate is AirDNA for STR revenue projection?" (OP 2023-10-02), from Zach Edelman (**2023-10-02**, 16 likes, the top reply): "we, a lender, compared twelve months of actuals against Air DNA… and have found it to be at times scarily accurate." — [BP 1145464](https://www.biggerpockets.com/forums/530/topics/1145464-how-accurate-is-airdna-for-str-revenue-projection)
- Report: "runs a bit low, better than too high", 67% vs 76%. **Confirmed, with small wording fixes.** OP Samuel Boyd (2023-10-02): "AirDNA's projected occupancy is 67% compared to 76% that we are actually seeing… ADR is $244 compared to $259." Sarah Kensinger (2023-10-02): "it does run a bit low, better then to high that's for sure!" Same thread, critical: Brett Deas (2023-10-02): "The rentalizer tool is very inaccurate, from what I have seen." — [BP 1145464](https://www.biggerpockets.com/forums/530/topics/1145464-how-accurate-is-airdna-for-str-revenue-projection)
- What 1088287 actually contains ("how accurate airdna rentalizer in your experience?", OP 2023-01-10):
  - Praise: Nick Velez (2023-01-10): "projected to do 47k and I did 71k year one… somewhat on the conservative side."
  - Complaint: Michael Baum (2023-01-10): "there weren't many in our area so the data was skewed way high."
  - Limited use: Noah Laker (2023-02-10): "AirDNA is good for one thing only: Macroanalytics."
  - **Possible competitor affiliate:** Sara Levy-Lambert (2023-01-11 and 01-21) recommends the "Awning Airbnb Estimator" and offers "our team of analysts". Her profile gives no employer.
  - Source: [BP 1088287](https://www.biggerpockets.com/forums/530/topics/1088287-how-accurate-airdna-rentalizer-in-your-experience)
- Report: AirDNA showed "$33k when it does $100k to $125k a year" (date n/f). **Quote confirmed, but the finding needs a context fix.** OP (Account Closed, **2025-11-10**): "Ran it against the property I owned for almost a decade it shows $33k when it does $100k to $125k a year. The numbers use to be within plus or minus 10%." Within a day:
  - Andrew Steffens (2025-11-11, 5 likes): "My AirDNA rep just emailed me it is a known issue and is being worked on."
  - Eric Lawson (2025-11-12): "Looks fixed now. Yesterday my prop showed $77k and today its showing at $132k."
  - So this was a temporary outage of roughly 2025-11-10 to 11-12, not ongoing inaccuracy. In the same thread Michael Baum (2025-11-10) separately says "AirDNA has always been a crap shoot… I have seen AirDNA overestimate by a ton. Like 200% over".
  - Source: [BP 1268169](https://www.biggerpockets.com/forums/530/topics/1268169-did-airdna-projected-revenue-just-take-a-nose-dive)
- Notes' topic 1191880 ("How accurate are AirDNA estimates & calculators for STR's?", OP **2024-05-22**):
  - **Bias flag:** the OP, AJ Wong (profile: Real Estate Broker, Oregon & California Coast), opens with "The simple answer is highly accurate" and cites a CBRE study.
  - Complaint: Ryan Moyer (2024-05-22, 3 likes): the revenue AirDNA shows for his own house "is not very accurate compared to the revenue I'm actually making. On all of my properties."
  - Praise with a caveat: Calvin Baughman (2024-05-23, 3 likes): "quite accurate, even if it doesn't have 100% reliability."
  - Complaint: Account Closed (2024-05-24): "accurate as much as a weatherman… 50% accurate and off by over 50% on others."
  - Source: [BP 1191880](https://www.biggerpockets.com/forums/530/topics/1191880-how-accurate-are-airdna-estimates-and-calculators-for-strs)

**PropStream**
- Report: an owner who sold in 2019 — PropStream "still lists him as the owner". **Not found on the page. Partly supported in substance.** "Inaccurate Propstream data" (OP Jonathan Boyd, **2024-08-21**): "Propstream shows old owner. An investor bought this in February of '24, and flipped and sold in July of '24. County records updated, Propstream did not." — [BP 1206319](https://www.biggerpockets.com/forums/48/topics/1206319-inaccurate-propstream-data)
- Notes: "an owner having been there for 10+ years when that owner actually sold 8 months ago… completely unqualified lead", cited to 1105783. **Wrong thread.** It is the 1206319 OP (2024-08-21). — [BP 1206319](https://www.biggerpockets.com/forums/48/topics/1206319-inaccurate-propstream-data)
- Notes: the "race track in county deeds" quote and "stale data, wrong data is an industry wide problem", both cited to 1206319. **Wrong thread.** Both are from Curt Smith (**2022-04-08**, 2 likes, a self-described long-time PropStream user who defends it: "its my view that PS is the best") in "why PropStream Sucks". OP Ron Hollingsworth (2022-04-07): even with the remove "on market" filter, "I still get Active listings." — [BP 1032178](https://www.biggerpockets.com/forums/898/topics/1032178-why-propstream-sucks)
- "Bad Propstream Data" (OP Trent Rogers, **2023-03-24**):
  - Complaint (OP): houses "barely standing, partially burned, or boarded up" listed as "occupied", and "the last sale date is way off".
  - Defence: Lydia R. (2023-03-24, 6 likes) explains that vacancy is inferred from mailing address and homestead data.
  - Mixed: Jonathan Schlimme (2023-04-11): "isn't always accurate but its pretty close".
  - Source: [BP 1105783](https://www.biggerpockets.com/forums/93/topics/1105783-bad-propstream-data)

**PropertyRadar**
- Report: "a Sacramento investor" used it for years for pre-foreclosures (410489, ~2012–17). **Partly. The location isn't stated and the thread is wrong.** Mandy S (**2013-10-08**) in "PropertyRadar or RealtyTrac?": "I have used PropertyRadar.com for several years primarily for tracking pre-foreclosures to purchase at the courthouse steps. Their data is pretty accurate and up to the minute." The word "Sacramento" appears in no fetched thread. — [BP 102749](https://www.biggerpockets.com/forums/92/topics/102749-propertyradar-or-realtytrac)
- What 410489 actually contains ("Thoughts on PropertyRadar", OP **2017-02-09**):
  - Praise: Erle Mcdonald (2017-02-10): "it is the best in the California market ... I have purchased 40+ properties using it."
  - Praise, with self-flagged bias: Jay Hinrichs (2017-02-10): "well I am going to be totally bias here but the info is accurate and extremely valuable."
  - Complaint: Sam Shueh (2019-08-18): "Terrible for phone #… On common names like John Smith etc not accurate."
  - **Vendor:** Sean O'Toole, identified as PropertyRadar's CEO/Founder in topic 177884, answers questions in this thread.
  - Source: [BP 410489](https://www.biggerpockets.com/forums/48/topics/410489-thoughts-on-propertyradar)
- Report: phone numbers more accurate than PropStream's, dated "~early 2026". **Quote confirmed, date wrong.** Zackary C Dunn (profile: Contractor, Tampa FL), **2022-12-06**: "I find the phone numbers are much more accurate than propstream. The customer service is also great." The 2026-02-02 date was the thread's last activity. — [BP 1081306](https://www.biggerpockets.com/forums/93/topics/1081306-anyone-here-using-propertyradar)
- Report: some BP praise comes from PropertyRadar staff. **Confirmed.** Jacob Camhi (username `propertyradar`), **2026-03-25**: "I am on the team over there, so I am a little biased." He was replying to Kevin Hintz (2024-08-24): "PropertyRadar has been a lifesaver for me." Another disclosure: Rick H. (2015-02-26) in topic 177884: "CEO/Founder Sean O'Toole is a friend." — [BP 1205572](https://www.biggerpockets.com/forums/109/topics/1205572-best-lead-generation-tools-for-real-estate-investors-what-s-your-go-to); [BP 177884](https://www.biggerpockets.com/forums/898/topics/177884-property-radar)
- Notes: clunkier than rivals, and it froze. **Confirmed.** CJ Glenn (OP, **2017-07-14**): "Property Radar seems a little clunkier to use and even gets stuck once in awhile on my Macbook on Mozilla." He followed up the same day, leaning towards PropertyRadar for accuracy. — [BP 465603](https://www.biggerpockets.com/forums/41/topics/465603-difference-between-property-radar-realtytrac-and-foreclosurecom)

**NeighborhoodScout**
- Report: a BP member checked their own zip and "the information wasn't accurate", cited to 474309. **Wrong thread.** The quote is in "Vacancy Rates on NeighborhoodScout" (OP 2017-03-30), from Marcia Maynard (**2017-04-01**): "The information wasn't accurate. What I read sounded like a fortune teller grasping at generalities." "Take their information with caution" is the OP, Alexander Spira (2017-04-01), in the same thread, not 308518. Also there: Erik D. (2017-04-04) saw a 9.4% vacancy rate for St Paul that conflicted "with what Zillow, RedFin, and Trulia have to say". — [BP 428017](https://www.biggerpockets.com/forums/52/topics/428017-vacancy-rates-on-neighborhoodscout)
- Topic 474309 ("Is 'neighborhoodscout.com' a reliable site?", OP **2017-08-06**) has only one reply (2017-08-07), suggesting Trulia and city-data instead. It contains no accuracy verdict. — [BP 474309](https://www.biggerpockets.com/forums/12/topics/474309-is-neighborhoodscoutcom-a-reliable-site)
- Notes: "some of the info is available only by subscription" (308518). **Not found on the page.** "Neighborhoodscout usefulness?" (OP **2016-05-08**):
  - Complaint: Anastasia Jordan (2016-05-08): it gave "inaccurate statistics which if correct would make this area look even worse."
  - Complaint: Patrick Smith (2016-05-08) called the description of his neighbourhood "over the top".
  - Source: [BP 308518](https://www.biggerpockets.com/forums/48/topics/308518-neighborhoodscout-usefulness)

### Inferences
- The pattern of errors (right quote, wrong URL in the same topic cluster) suggests the earlier pass took snippets from search pages that merged several threads. Any BP citation not re-checked here should be treated as unverified.
- Correcting the dates moves much of the evidence older: the BP Rent Estimator criticism is 2021–2024, the PropertyRadar phone praise is 2022, and the NeighborhoodScout complaints are 2016–2017. Only the AirDNA glitch (Nov 2025), the Mashvisor bait-and-switch (Jul 2026), BP Pro value doubts (Jun 2026), BP cancellation complaints (2024–2026) and the PropertyRadar staff post (Mar 2026) are recent.
- The AirDNA "$33k" item should not stand as an accuracy finding without the "glitch, fixed within ~2 days" caveat.

### Gaps
- The "20 nights vs 10" Mashvisor anecdote, the "calculators which are awesome!!" quote, "not all that valuable if completely new", "still lists him as the owner", "Sacramento" and "only by subscription" could not be found in any served thread text. Each could come from a reply not included in the page JSON-LD, from a different thread, or from a search-engine paraphrase.
- Vote counts beyond the per-post `likes` were not available. Upvotes are shown above where non-zero.

## Q2. Additional recent (2024–2026) BiggerPockets threads per player

### Takeaway
Recent BP material is plentiful for AirDNA, ChatGPT/AI, BP Pro, PropStream/PropertyRadar, Zillow rent/value estimates and inspectors. It is thin or one-line for Mashvisor, HouseCanary, NeighborhoodScout and Regrid. I found **no** 2024–2026 BP thread with concrete experience of Realtor.com, RentCast (beyond 2023), First Street, or Symbium. Recurring recent themes: every tool is a "ballpark", PriceLabs is challenging AirDNA, and AI is used for screening but not for the underwriting math.

### Cited Findings

**Zillow**
- "Zestimate is gone on Zillow. Is there a similar reliable tool?" (OP Ryan Jenkins, **2025-07-17**):
  - The OP reports Zestimates missing on many listings, especially FSBO. Amy Pfaffman (2025-07-20): "I'm still seeing Zestimates on Zillow."
  - Complaint: Mark Turner (2025-07-19): "Zestimate was never a reliable method of evaluating property… it was 'Zestimating' a lake front property of mine at 1/2 the price" (an incident from 2018).
  - Complaint: Amanda Jacobellis (2025-07-20): Zestimates "have no way to account for… views, weird layouts, wierd lots, dark rooms."
  - Source: [BP 1251562](https://www.biggerpockets.com/forums/93/topics/1251562-zestimate-is-gone-on-zillow-is-there-a-similar-reliable-tool)
- "Wildly Different Rent Estimates" (OP Daniel Barad, **2024-05-04**):
  - OP: Zillow $2,200, Rentometer $3,500 average, Apartments.com $3,500, BP $2,500 for one condo.
  - Complaint: Corby Goade (2024-05-06): "Zillow is probably the worst place to get rental comps. Anyone can put an ad up."
  - Praise: Bradley Buxton (2024-05-04): "The Zillow and BP seems to be the most accurate."
  - Source: [BP 1188394](https://www.biggerpockets.com/forums/12/topics/1188394-wildly-different-rent-estimates)

**Redfin**
- "Redfin listing experience" (OP **2025-06-04**):
  - Praise (OP, a seller): "much improved over local agents. The commission was 1.5% and included not just professional photos but also a 3D virtual walkthrough."
  - Complaint: Christian Maluo (2025-06-11), an agent: "Locally I find them to be the Uber of Realtors… The small about you saved may be eclipsed quickly during repair negotiations."
  - Complaint: Russell Brazil (2025-06-22), an agent: "All one needs to do is google Redfin Reviews."
  - Source: [BP 1246039](https://www.biggerpockets.com/forums/21/topics/1246039-redfin-listing-experience)
- "Critique a Redfin Listing" (OP **2025-06-05**): "Redfin charges 1.5% listing fee. I liked how this included 3D walkthrough and virtual staging." — [BP 1246227](https://www.biggerpockets.com/forums/21/topics/1246227-critique-a-redfin-listing)
- Agents pushing back on Redfin and Zillow is expected; they are commission competitors.

**Realtor.com** — no 2024–2026 thread with concrete experience was found (see Gaps).

**RPR / agent CMAs**
- "How I Estimate ARV Using Recent Sold Comps When Analyzing Deals" (OP **2026-02-15**):
  - Praise: Jorge Vazquez (2026-02-15, 3 likes): "I like using both RPR and MLS CMA reports too… I look at the three closest and most recent properties: one sold, one pending, and one active."
  - Praise: Doug Smith (2026-02-15, Tampa) got his license for MLS access and builds his own CMAs.
  - Source: [BP 1278111](https://www.biggerpockets.com/forums/88/topics/1278111-how-i-estimate-arv-using-recent-sold-comps-when-analyzing-deals)
- "The ARV Question: Need Pointers on Using CMA for Accurate Comps!" (OP **2024-10-11**): the OP moved from PropStream to CMAs because "lately, I've noticed the data feels a bit outdated" on PropStream. — [BP 1214222](https://www.biggerpockets.com/forums/48/topics/1214222-the-arv-question-need-pointers-on-using-cma-for-accurate-comps)
- Caveat: a note investor's explainer (OP 2025-06-29) calls a CMA "informal… meant to help get a eyeball value", typically as-is. — [BP 1249067](https://www.biggerpockets.com/forums/70/topics/1249067-bpo-cma-appraisal-what-s-the-difference-and-why-as-is-vs-arv-matters)

**Home inspectors**
- "Picking a home inspector" (OP **2024-03-06**):
  - Complaint: Russell Brazil (2024-03-06, 2 likes): "Some inspectors are too casual and miss too many things. Conversely, some are too alarmist."
  - Complaint: Leo R. (2024-03-07): "even the best inspectors will occasionally miss important issues… I don't use one home inspector, I use SEVE[RAL]."
  - Advice: Bruce Woodruff (2024-03-06, 3 likes, a former inspector) recommends inspectors with a building or engineering background.
  - Source: [BP 1176518](https://www.biggerpockets.com/forums/67/topics/1176518-picking-a-home-inspector)
- "Home inspection for new builds?" (OP **2025-06-14**):
  - Complaint (OP): a realtor-referred inspector gave "a shallow report".
  - Ed O. (2025-06-14): "Don't use good ol boys affiliated with the seller."
  - Chase Busick (2025-06-19): "most home inspectors have little to no actual experience in construction."
  - Source: [BP 1247285](https://www.biggerpockets.com/forums/21/topics/1247285-home-inspection-for-new-builds)
- Related: "Is a sewer scope worth it in Columbus OH?" (OP 2024-05-20, 45 replies). Bob S. (2024-05-22): "I have had to replace about 20 over the last 10 years at about 10k each." — [BP 1191338](https://www.biggerpockets.com/forums/48/topics/1191338-is-a-sewer-scope-worth-it-in-columbus-oh)

**ChatGPT / AI for real estate**
- "Wondering if ChatGPT is a good tool to do all my market research with" (OP **2025-04-17**):
  - The OP pastes whole Zillow listings into paid ChatGPT Deep Research.
  - Mixed: Nick Perret Efferson (2025-04-17): "for accurate market numbers it can sometimes be trusted and other times not… If you input the numbers yourself, it can analyze and crunch numbers very well."
  - Caution: Chris Seveney (2025-04-18): "garbage in - garbage out… sometimes the responses may not be accurate."
  - Source: [BP 1239784](https://www.biggerpockets.com/forums/48/topics/1239784-wondering-if-chatgpt-is-a-good-tool-to-do-all-my-market-research-with)
- "How to use AI to vet a deal in under 30 mins" (OP **2026-03-03**; the OP uses Claude Code):
  - Praise: Jim Page (2026-03-03) uses ChatGPT for a "nine gate" screen.
  - Limit: Ryan D. (2026-03-18): "No LLM in the math. If my underwriting gives a different answer depending on how I phrase something, I don't trust it."
  - Limit: Iliya Muzychuk (2026-04-29): "LLMs are not good in math!!"
  - Limit: Stephen Quesinberry (2026-03-24): AI is for "screening deals or doing quick back-of-the-napkin checks".
  - **Possible vendors:** Eric Davis says he "decided to just build the tool myself"; Chris Lin says "I built a process that screens every listing daily".
  - Source: [BP 1280027](https://www.biggerpockets.com/forums/432/topics/1280027-how-to-use-ai-to-vet-a-deal-in-under-30-mins)
- Context on forum quality: in "The future of BiggerPockets Forums with ChatGPT" (OP 2025-08-04), moderator Chris Seveney (2025-08-04, 14 likes) says: "As a moderator, we do crack down on AI generated content, but you cannot catch all of it." This lowers the evidential weight of some 2025–26 BP replies. — [BP 1256285](https://www.biggerpockets.com/forums/80/topics/1256285-the-future-of-biggerpockets-forums-with-chatgpt)

**DealCheck**
- "Deal Analysis Software" (OP **2024-04-08**):
  - Praise: Jake Baker (2024-04-09, 2 likes): "It's more comprehensive than the BP Calculators and simple enough where it doesn't overcomplicate the analysis."
  - Mixed: Eric Davis (2026-03-20): "solid for quick residential analysis… For commercial or anything with multiple tenants, it gets thin pretty fast." He says elsewhere that he built his own tool, so he is a possible competitor.
  - Source: [BP 1183345](https://www.biggerpockets.com/forums/80/topics/1183345-deal-analysis-software)
- "Tool for analyzing deals" (OP **2026-02-02**):
  - Praise: Mario Benavidez (2026-02-02, a property-management and sales rep soliciting business): "the BiggerPockets calculator or DealCheck are the best places to start."
  - Praise: Sam McCormack (2026-02-03): "I've seen DealCheck too used by my clients."
  - Source: [BP 1276686](https://www.biggerpockets.com/forums/921/topics/1276686-tool-for-analyzing-deals)

**Mashvisor** (recent mentions are thin)
- Andrew Street (**2025-10-20**): "Mashvisor is good too but leans more toward long-term analysis." — [BP 1265836](https://www.biggerpockets.com/forums/530/topics/1265836-what-service-do-you-use-when-analyzing-a-deal-eg-airdna-mashvisor-etc)
- Bryant Xavier (**2025-02-01**, says he has 6 years in STR): "Mashvisor – Helps compare long-term vs. short-term rental pote[ntial]." — [BP 1229034](https://www.biggerpockets.com/forums/80/topics/1229034-best-str-tech)
- The concrete recent complaint is the 2026-07-02 bait-and-switch post (Q1).

**BiggerPockets Pro**
- "BiggerPockets PRO Perks" (OP **2026-04-05**):
  - **Vendor employee:** Ashley Rigsbee (profile: "Customer Success & Onboarding Specialist at BiggerPockets"), 2026-04-24: "Most investors find the PRO annual perks worth it". She lists Kiavi, LendingOne (up to $2,000/yr toward DSCR closing costs) and Steadily (5% off).
  - Complaint: Ed O. (2026-04-24): "I recently ended my pro membership after more than a decade. I'm tired of fighting through the weeds in the forums… The partners offering deals are in areas we do not need help with."
  - Source: [BP 1283884](https://www.biggerpockets.com/forums/25/topics/1283884-biggerpockets-pro-perks)
- "Should I buy the pro membership?" (OP **2024-01-01**):
  - Praise: Steve Kenney (2024-01-03): "I've found that just the calculators are worth the pro membership."
  - Praise: Nick Kossey (2024-01-02): "it has been phenomenal."
  - Pricing complaint: Deepa Telagam (2024-01-02): bundling Bootcamp with "free" Pro cost about $625, against about $444 if bought the other way round.
  - Source: [BP 1161591](https://www.biggerpockets.com/forums/12/topics/1161591-should-i-buy-the-pro-membership)

**Rentometer**
- Complaint: Rick Albert (**2025-06-25**): "In my experience Rentometer has been inaccurate… if you have a lot of comps of tract homes where they are all identical, then it may be more accurate." Ned Carey (2025-06-21) notes the BP estimator needs Pro. — [BP 1248103](https://www.biggerpockets.com/forums/922/topics/1248103-how-to-estimate-what-i-can-charge-for-rent)
- Praise: Jon Schwartz (**2024-05-05**): "I agree that Rentometer is probably closest. I start with Rentometer." Nathan Gesner (2024-05-06, 3 likes): Zillow, Rentometer and the like are "useful for getting a ballpark". — [BP 1188394](https://www.biggerpockets.com/forums/12/topics/1188394-wildly-different-rent-estimates)

**RentCast** — the only on-page praise is from 2023 (Q1). The search tool summarised a "Dealcheck now uses RentCast… pretty accurate" reply, but I did not open or date that page (see Gaps).

**AirDNA**
- "Rabbu or AirDna or both?" (OP **2025-06-15**):
  - Mixed: Myka Artis (2025-06-15): "AirDNA doesn't have the best accuracy, but to me, it is excellent for getting a general idea of a market… Pricelabs has been a little more accurate… [AirDNA] struggles to distinguish between a booked night and a blocked night."
  - Complaint: Andrew Steffens (2025-06-17): "I have seen wildly different projections for the same house across multiple platforms."
  - Source: [BP 1247359](https://www.biggerpockets.com/forums/530/topics/1247359-rabbu-or-airdna-or-both)
- "Are there books or guides on how to actually interpret AirDna data or others?" (OP **2025-07-16**):
  - Complaint: Michael Baum (2025-07-17): "it had our house at somewhere around $1400 a night. No where near realistic… Ours got lumped in with a $15,000 a week mega log mansion… I always have found it very optimistic."
  - Praise: Andrew Steffens (2025-07-17): in his comp-rich area "it does a good job providing a range of expected revenue and occupancy."
  - Source: [BP 1251437](https://www.biggerpockets.com/forums/530/topics/1251437-are-there-books-or-guides-on-how-to-actually-interpret-airdna-data-or-others)
- Also: Robin Simon (2024-12-17): "AirDNA has a pretty strong track record." — [BP 1222216](https://www.biggerpockets.com/forums/530/topics/1222216-advice-please-i-have-a-somewhat-tricky-question-regarding-airdna)

**PropStream**
- Complaint: the 2024-10-11 OP in topic 1214222 (above) says PropStream comps "feel a bit outdated". — [BP 1214222](https://www.biggerpockets.com/forums/48/topics/1214222-the-arv-question-need-pointers-on-using-cma-for-accurate-comps)
- "PropStream or PropertyRadar - Freshest Leads" (OP **2025-01-18**):
  - Mark G. (2025-01-18): "I heard that PropStream updates this data on a weekly to monthly basis, whereas PropertyRadar updates the data daily". This is hearsay.
  - David Rong (2026-09-09): "freshness: it's decided at the county, not by the logo on the tool… every platform (PropStream included) is just re-pulling that same county feed."
  - Source: [BP 1226773](https://www.biggerpockets.com/forums/93/topics/1226773-propstream-or-propertyradar-freshest-leads)
- Price data point: Chris Seveney (2024-11-13): PropStream lets you "pul 10,000 contacts per month. Whether that is worth the $99…" — [BP 1218585](https://www.biggerpockets.com/forums/530/topics/1218585-propstream-worth-it-for-client-outreach)

**PropertyRadar**
- Praise: Mark Hockridge (**2025-04-24**): "PropertyRadar is a very effective tool for building audiences/lists… then connect with the owners through email, phone/SMS, direct mail, and online ads." His profile shows no employer; the vocabulary echoes PropertyRadar's marketing, so his affiliation is unverified. — [BP 1240071](https://www.biggerpockets.com/forums/921/topics/1240071-property-radar-software)
- PropertyRadar's daily-update claim appears only as hearsay (Mark G., 2025-01-18, above). The 2026-03-25 staff post is covered in Q1. — [BP 1226773](https://www.biggerpockets.com/forums/93/topics/1226773-propstream-or-propertyradar-freshest-leads)

**HouseCanary** (thin)
- Mohammed Rahman (**2026-01-26**, 2 likes): "HouseCanary/CanaryAI is a more advanced valuation/AVM tool, great if you want deeper automated valuation models and condition-adjusted comps." This is a recommendation, not reported use. — [BP 1275847](https://www.biggerpockets.com/forums/88/topics/1275847-estimating-arv-software-programs)
- Context: BiggerPockets calls HouseCanary "our data partner" in its market guides, so BP blog content about HouseCanary is not independent. Source: the search-result summary of [BP blog 2025 markets](https://www.biggerpockets.com/blog/best-markets-to-buy-your-first-property-in-2025); not opened on the page.

**NeighborhoodScout** (thin)
- Lauren Robins (**2025-05-21**): "One of the most popular and widely used is NeighborhoodScout… provides crime maps, trends, and risk scores." The reply is generic, gives no personal experience, and reads like AI or promotional text. — [BP 1244298](https://www.biggerpockets.com/forums/921/topics/1244298-crime-rate-by-city-data)

**First Street (Flood Factor)** — the most concrete thread is from 2023.
- "Flood risk concern" (OP **2023-05-06**): a Maryland property in FEMA Zone X scored 9/10 on Flood Factor. Sarah Kassem (2023-05-07): "Flood Factor shows future flood risk… FEMA flooding also only shows flooding from rivers or oceans, while Flood Factor shows flooding from rivers, oceans and rainfall." — [BP 1115075](https://www.biggerpockets.com/forums/55/topics/1115075-flood-risk-concern)
- The 2025 AE-zone thread does not mention First Street. — [BP 1229076](https://www.biggerpockets.com/forums/62/topics/1229076-investing-in-a-high-risk-flood-zone-ae-worth-it-or-hard-pass)

**Regrid**
- Praise: OP of "Suggest software/apps… for low-volume niche investor" (**2024-06-16**): "Regrid is one of the more useful free tools." — [BP 1195866](https://www.biggerpockets.com/forums/12/topics/1195866-suggest-software-apps-research-off-market-leads-for-low-volume-niche-investor)
- Complaint (outside the window): Jevon Shaw (2023-01-19): "There's an iOS app called The Regrid Property app… Some information has been incorrect in my experience." — [BP 1090645](https://www.biggerpockets.com/forums/67/topics/1090645-driving-for-dollars-app)
- Related, not Regrid-specific: Frank Benitez (2026-03-22): "aggregators being a little behind… you still end up going back to the county sites anyway." Ryan Stomel (2026-03-22) cites "LA County, Riverside, San Bernardino all have different portals." — [BP 1282325](https://www.biggerpockets.com/forums/80/topics/1282325-how-are-you-all-speeding-up-parcel-research-across-different-counties)

**Symbium** — the only BP mention is from 2023. Steve Meyers (2023-03-07, a San Diego agent): "check out https://symbium.com/ it's a good site that let's you see your lot's feasibility and connects you with ADU contractors." — [BP 1101178](https://www.biggerpockets.com/forums/61/topics/1101178-best-adu-design-and-contracting-companies-in-san-diego-county)

### Inferences
- PriceLabs is now named on BP as more accurate than AirDNA (2025). AirDNA's main recent praise is conditional on comp-dense markets.
- Recent BP data-platform debates converge on "freshness is set by the county feed". This supports reading directly from county or assessor sources, as this app does, over aggregators.
- Vendor and affiliate presence is significant in recent threads: BP staff (Ashley Rigsbee, Hilary C., Michael S.), PropertyRadar staff (Jacob Camhi), PM and sales reps, and self-described tool builders. Moderators say they cannot catch all AI-generated posts. Late-2025 and 2026 BP praise should be weighted down accordingly.

### Gaps
- **Realtor.com:** no 2024–2026 BP thread with concrete user experience was found. The closest is "Accuracy of Real Estate Data" (2023-08-18), which had no Realtor.com-specific reply in the served text.
- **RentCast 2024+:** not found on a verified page.
- **First Street 2024+:** not found.
- **Symbium 2024+:** not found.
- **HouseCanary and NeighborhoodScout:** the recent mentions carry no first-hand experience.
- Mark Hockridge's possible PropertyRadar affiliation, Sara Levy-Lambert's possible Awning affiliation and David Pere's possible affiliate link were not confirmable from the BP pages alone.
- The search tool's summaries sometimes claimed quotes that I then could not find on the pages. Only the on-page text is cited above.
