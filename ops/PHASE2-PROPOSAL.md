# Phase 2 Proposal — MM Payments lead tap (PLANNING ONLY)

Status: draft for Matt's approval. Nothing here is built. No repo is created, no credentials are requested, no production is touched, $0 spend.
Source: Report F (files/phase2/report-f.md on the museclaudepilot board), as corrected by Muse post ouj9h8.

## 1. Scope after the ownership correction
- getmmpayments.com (MM Payments) is Matt's. getpaymts.com (PAYMTS) belongs to James.
- The test copy covers the **mm-payments repo only**.
- PAYMTS-side changes are OUT of scope and need James's go-ahead: Orlando city page, sitemap, 16px inputs, gray empty card.
- Report F section 5 ("PAYMTS is likely his") is superseded.
- Report F's historical findings are not current defects; retest each before acting (Matt retested Nov 20: getmmpayments.com links to getpaymts.com/get-started/?ref=MM and it loads).

## 2. Report F — the 7 fixes
| # | Fix | Owner of the site | Phase 2 status |
|---|-----|-------------------|----------------|
| 1 | Add an Orlando, FL city page to PAYMTS (existing 8 city pages are big metros; Orlando is the 321 home market) | James | Out of scope; needs James's approval |
| 2 | Confirm or create a Google Business Profile for the Orlando 321 number | Matt/James (unclear) | Out of scope for engineering; Matt's call; confirm number and any existing GBP first |
| 3 | Add phone number to MM Payments (321-750-8507; confirm it is Matt's line first) and add a canonical tag to the MM homepage | Matt | IN SCOPE (planning) |
| 4 | Surface the /partners/ referral program from a footer link to a visible section/link on the MM homepage | Matt | IN SCOPE (planning) |
| 5 | Bump form/calculator inputs to 16px on PAYMTS (all 9 are 15px; iOS zooms on focus) | James | Out of scope; needs James's approval |
| 6 | Fix or locate /sitemap.xml (404) | James (PAYMTS); check MM separately | Out of scope for PAYMTS; read-only check of MM |
| 7 | Check the gray empty card under "Built for Businesses" in a real browser; remove if dead placeholder | James | Out of scope; needs James's approval |

Report F also notes: effort 2-4 hours, $0 monthly; new city page, GBP and publishing a phone number are Matt's call.

## 3. Attribution check (question for James, not an engineering task)
Matt is paid on referred clients only if the referral is tracked; `?ref=MM` is the mechanism. Baseline finding: getpaymts.com internal links drop `?ref=MM`. Read-only questions for James (no change to his site):
1. Is attribution captured from the landing parameter only, or persisted (cookie / localStorage / server-side session)?
2. Is `ref` stored with the calculator email capture and the statement-review form submission?
3. Does attribution survive navigation from the landing page to /get-started/ and other pages?
4. How does MiCamp/the ISO credit Matt (by ref value, by merchant application link, by contract)?
No testing that submits forms or creates leads on James's live site.

## 4. Sandbox guards (apply to every Phase 2 PR)
1. **No Brevo key ever** in the repo, test copy, CI, env, logs or posts. Email sending code is stubbed.
2. **Send-script guard plus CI check on every PR**: any script that can send email/SMS or POST to a third party must refuse to run unless an explicit `ALLOW_SEND` is set, which CI never sets; a CI job fails the PR if a send path is reachable without the guard or if a secret-like string is added.
3. **Fixture data instead of real leads**: only synthetic records (fake names, example.com addresses, 555 numbers). No real lead, merchant, or statement data in the repo.
4. **No live scraping**: no network fetches of live sites from tests or scripts; use saved HTML fixtures.
5. **No host connection**: no deploy, FTP/SSH, DNS, or hosting-panel access from the test copy.
6. No production changes, no purchases, $0 spend.

## 5. Test copy plan (not created)
- One private repo copy of mm-payments only, created by Matt after approval (not by Claude).
- Branch protection on main; Claude works on `claude/<TASK_ID>-<slug>` branches via PR; Matt merges.
- Planned tasks: (a) phone number block + canonical tag on the homepage, (b) /partners/ promotion section, (c) retest of links incl. `?ref=MM` targets against fixtures, (d) sandbox guard CI check.
- Each task gets acceptance tests Muse can verify independently.

## 6. Identity and review controls (planning)
- Muse gets a separate GitHub machine account as part of the design. Matt approves before anything is created; Claude does not create accounts.
- Kilo removal is Matt's step (GitHub as mslugga35).
- Commits authored as mslugga35 noreply, no co-author trailers.

## 7. Costs and decisions for Matt
- Engineering for items 3-4 and the guards: $0 added monthly.
- GitHub Pro (required reviews on a private repo) is Matt's call after Nov 27. Cost: GitHub Pro is a paid per-month plan (check current price on GitHub before deciding); alternative is Matt merging manually without required-review enforcement.
- Approvals needed from Matt: publishing a phone number on MM (confirm 321-750-8507 is his line), GBP creation, creating the test repo, creating Muse's GitHub identity.
- Approvals needed from James (via Matt): anything on getpaymts.com, answers to section 3.

## 8. Open questions
- Is 321-750-8507 Matt's line?
- Does a Google Business Profile already exist, and under whom?
- Does MM have its own sitemap and canonical today? (read-only check)
- Who at James's side can answer the attribution questions?
