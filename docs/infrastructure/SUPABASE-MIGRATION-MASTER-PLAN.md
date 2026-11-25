# Supabase Migration Master Plan (T-20261125-06)

The one master plan for moving away from Supabase (owner strategy, 2026-11-25, board post d2rjcg). Updates revise this
file; there are no competing reports. **Research and planning only: nothing has been migrated, bought, cancelled or
changed.** No migration work follows from this plan without a separate owner-approved task.

**Version 1.0 (merged), 2026-11-25.** This file reconciles the two drafts into one: the PC2 research (PR #12, first
version d8b4e45) and the PC1 draft v0.1 (board file `infra/MASTER-MIGRATION-PLAN.md` v1, task xw39q1). That board file
is superseded by this one. Where the two drafts disagreed, section 12 says what was chosen and why.

> **Public repo.** This file is in a public repository, so it names apps and features only. It has no project ids,
> table names, connection details, security details (which key, where, since when) or MM Payments planning. Those
> stay in private notes.

Status of every fact: **VERIFIED** (checked during this run, source shown), **LAST KNOWN** (from a dated internal
note, not re-checked today), or **ESTIMATE** (my judgement or a public list price I did not re-check today).

---

## 1. Owner summary (plain English)

**Security comes first, migration or not.** Before any app moves, any database admin key that may have been exposed
gets replaced. Muse is bringing this to you as a separate security decision; it does not wait for this plan, and this
plan does not start until it is done. (The details stay out of this public file.)

**What you would save.** Not much money, at least not soon. Our best current estimate is about **$35 a month** for
Supabase (November 9 cost review; nobody has looked at an actual invoice yet). The last bill anyone saw, in May, was
$35 to $45. Most of it is the $25 Pro plan, and HiddenBag needs that plan.
HiddenBag and DailyAI stay where they are, as you decided. While they stay, the most we can cut is about **$10 a month**
(about $120 a year), by closing the second Supabase database. That only works once every app on it has moved.
The full **$35 to $45 a month** saving comes only if HiddenBag moves one day, and that needs your separate approval.

**What you actually gain now:** less lock-in. New projects stop defaulting to Supabase, we get backups we control, and
small apps stop sharing one database where one mistake hits several sites.

**What could go wrong.**
1. Moving an app can break logins or lose data if it is rushed. Every move follows the checklist in section 8:
   backup first, test copy first, keep the old one running so we can switch back.
2. Your Hetzner server is already full. It has about 0.9 GB of free memory and is already using its emergency overflow
   memory. Running databases on it today would slow down everything else on it. Hosting databases there means a bigger
   server first, which is new spending and needs your yes.
3. Self-hosting means we look after backups and updates ourselves instead of Supabase doing it.

**Recommendation.**
1. Stop choosing Supabase for new projects. Use a single-file database (SQLite) or Cloudflare's free database (D1)
   unless the project really needs more. Costs nothing.
2. First move: **RV Dump Stations** (section 7). Its data is public, it has no logins, it is small, and it already runs
   on our own server. It also sits in the second Supabase database, so it is a real first step toward closing that one.
3. Then the other small apps in that second database, one at a time. Leave HiddenBag, DailyAI and the Team Florida
   accounting app where they are for now.
4. Once the second database is empty, ask you whether to close it (about $10 a month).

---

## 2. Inventory: which apps use Supabase

Sources: dependency files and code on **PC2 only** (`C:\Users\mslug\*`, 90 folders scanned, `node_modules`, `.git` and
build folders excluded), the Vercel project list (12 projects, via the Vercel connector), and an internal Supabase
map note (LAST KNOWN 2026-05-11). **PC1 folders were not reachable from this PC2 run.** Apps that exist only on PC1
are listed from the internal note and marked that way. Env var names are shown, never values.

| App | Supabase? | Evidence (PC2 unless noted) |
|---|---|---|
| HiddenBag (`hiddenbag-v2`, site + Discord bot) | **YES** (heavy) | `@supabase/*` in package.json; client imports in 195 files; 79 migration files; env `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`, `SUPABASE_ACCESS_TOKEN`; Vercel project `hiddenbag-v2` |
| HiddenBag review copy (`thehiddenbag-review`) | YES (copy of the above) | 169 import files, 78 migrations; same project, not a separate app |
| DailyAI picks (`dailyai-picks-local`) | **YES** | package.json dep; 5 files with client imports (`index.js`, `consensus_checker.py`); env `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| DailyAI Betting site | YES (LAST KNOWN, PC1 / Hetzner) | internal note lists it on the HiddenBag database; Hetzner runs `dailyai*` processes (VERIFIED names only) |
| Team Florida accounting app | **YES** (heavy) | code in 531 files mentions Supabase, client imports in 114, auth calls in 74, database functions (`.rpc`) in 35; env `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ACCESS_TOKEN`; Vercel project `team-florida-accounting`. Note: Team Florida is read-only for us |
| PeptideFacts (`peptidefacts`, `pf-ops`) | **YES, leftovers only** | package.json dep; only scripts mention it (`load-passages`, `purge-answer-cache`, `test-ask-budget`). The feature they served (`/api/ask`) was retired on 2026-11-19 (returns 410, internal note). Live pages do not appear to need Supabase. UNVERIFIED: whether the live site still reads it at all |
| pickleballcourts.cc | YES (LAST KNOWN, PC1) | internal note: 3 env files point at the HiddenBag database; not on PC2 |
| ClipRush / clip-ai | **NO** on PC2 | no Supabase dependency or import (one unrelated `.rpc` text match). Internal note lists an older PC1 copy with a Supabase env file: UNVERIFIED |
| Mission Control (`mission-control`) | **YES** (light) | package.json dep; 3 files with imports; env `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server key only, no user logins) |
| LarsHomes | YES | 44 import files, storage calls in 7, edge/scheduled functions referenced in 69 files (count includes generated and deploy files), 4 migrations; env `VITE_SUPABASE_*`, `SUPABASE_DB_URL` |
| Wattz Up (`wattz-up-v2`) | YES (light) | 5 import files; env `NEXT_PUBLIC_SUPABASE_*`; Vercel project `wattz-up-v2` (last updated March 2026) |
| AI Calendar | YES (light) | 4 import files, 1 migration; env `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| AI stock research reports | YES (light) | 6 import files, auth calls in 7, 2 migrations; env `NEXT_PUBLIC_SUPABASE_*` |
| RV Dump Stations, AI Tools HQ, Coaches Corner | YES (LAST KNOWN, PC1) | internal note lists them on the second database; Vercel projects `rv-dump-stations`, `site`, `coaches-corner` exist (VERIFIED names) |
| AGG map | YES (PC1 draft) | PC1 code scan: the same data is copied in both databases. Not on PC2 |
| Archon | YES (PC1 draft) | PC1 code scan: uses vector search, low use. Not on PC2 |
| Every1Raise | YES (PC1 draft) | PC1 code scan: on database A, uses logins; whether it is live is unknown |
| Leftover jobs in database B | 2 old edge functions + 2 scheduled database jobs from July 2025 (PC1 draft) | Targets unknown. Check what they call, then probably delete (needs approval) |
| MM Payments | NO on PC2 | `mm-payments` has no Supabase dependency or import. Any further planning stays out of this public repo |
| Team Florida websites (`TeamFloridaWebsite`, `tf-release-*`) | NO | no Supabase dependency or import |
| Jemile Weeks site, PupilScale, Oracle HCM tables, r2g-academy, second-brain | NO / not checked deeply | no Supabase dependency in their package files on PC2 |

Databases (LAST KNOWN 2026-05-11): **two** Supabase projects. Database A holds HiddenBag, DailyAI, pickleballcourts,
Mission Control, LarsHomes and several retired tools. Database B holds Team Florida accounting, Wattz Up, AI Tools HQ,
RV Dump Stations and Coaches Corner. A third project was deleted on 2026-05-11. The PC1 draft adds: HiddenBag is the
largest (35+ tables, 14 database functions, about 6.4 GB); RV Dump Stations has 5 small tables of public data; DailyAI
reads HiddenBag's tables, so the two move together or not at all. **Conflict:** the PC1 draft places PeptideFacts on
database B with its own magic-link logins and full-text search; the PC2 code shows only leftover scripts for a feature
retired on 2026-11-19. Whichever is right, the live site's runtime use is UNVERIFIED until someone checks it.

## 3. Features each app uses

Counts are files matching each pattern on PC2. "Realtime" counts are pattern matches on `.channel(` and `realtime`.
Most of these are Discord channels, not Supabase Realtime, so treat them as **unconfirmed**.

| App | Database | Auth (logins) | Storage (files) | Realtime | Edge / scheduled functions | DB functions (rpc) | Migrations |
|---|---|---|---|---|---|---|---|
| HiddenBag | yes | yes (31 files) | none found | unconfirmed (10) | none found | yes (12) | 79 |
| DailyAI picks | yes | none found | none | unconfirmed (1) | none | none | 0 (schema lives with HiddenBag) |
| Team Florida accounting | yes | **yes, heavy (74)**, incl. phone/Apple sign-in settings | none found | unconfirmed (19) | none found | **yes (35)** | 0 in repo (UNVERIFIED where schema lives) |
| PeptideFacts | scripts only | no | no | no | no | 1 | 6 (old feature) |
| Mission Control | yes | no | no | unconfirmed (1) | no | 1 | 0 |
| LarsHomes | yes | yes (7) | **yes (7)** | unconfirmed (3) | **yes** | 1 | 4 |
| Wattz Up | yes | none found | no | unconfirmed (1) | no | 1 | 0 |
| AI Calendar | yes | no | no | unconfirmed (1) | no | 1 | 1 |
| AI stock research | yes | yes (7) | no | unconfirmed (2) | no | 0 | 2 |

Scheduled jobs: most "cron" work runs on Hetzner PM2 processes or Vercel cron that call Supabase, not Supabase's own
scheduler. UNVERIFIED: whether any `pg_cron` jobs exist inside either database (needs dashboard access).

## 4. Supabase cost and usage

| Item | Value | Status |
|---|---|---|
| Plan | Pro, one organization | LAST KNOWN 2026-05-11 |
| Pro base | $25/month | LAST KNOWN (internal note) |
| Database A compute (micro) | $9.97/month | LAST KNOWN |
| Database B compute (micro) | $9.97/month, plus about 16.5 GB egress | LAST KNOWN |
| Bill at that time | $44.66/month before the third project was deleted, "toward $25" after | LAST KNOWN |
| **Current bill** | **not verified** | The Supabase connector needs sign-in on this unattended run; no billing page was reachable |
| Usage drivers | Database B egress from RV Dump Stations listing pages hitting the database on every render (internal note); HiddenBag's pick pipeline (most writes) | LAST KNOWN |

Pro includes a compute credit, so the true monthly total is somewhere between **$25 and $45**. Matt or Muse should read
the real number from the Supabase billing page before section 9's totals are trusted.

## 5. Hetzner server capacity (VERIFIED, read-only check 2026-11-25 11:50 ET)

| Measure | Value |
|---|---|
| CPU | 3 vCPU, load average 0.20 |
| Memory | 3.7 GB total, **0.9 GB available**, swap 2.2 GB of 4 GB **in use** |
| Disk | 75 GB, 55 GB used, **18 GB free** (76%) |
| Running | 80 PM2 processes (24 online at the time): HiddenBag, DailyAI, clip, predict, PeptideFacts, pickleballcourts, RV, Wattz, Jemile, ops, SEO and more |
| PostgreSQL | PC2 check: client tool installed, no database server seen running. **Conflict:** the PC1 draft (from a 2026-11-09 note) says PostgreSQL 16 runs there for one small tool. Not re-checked in the merge run (server access not available unattended): UNVERIFIED |
| Backups | PC1 draft: a nightly encrypted pull backup with a nightly restore test already runs. Any new database must be added to it. LAST KNOWN |
| Price | Conflicting records: $9.99/month or €32.49/month. UNVERIFIED until someone reads the invoice |

**Headroom: effectively none for a database server.** Swap use means memory is already short. A small SQLite app adds
almost nothing. A PostgreSQL server for HiddenBag-size data would need a bigger server (new spending, owner
decision). A second small server or an upgrade to the next size is roughly $8 to $15 a month (ESTIMATE, Hetzner list
prices not re-checked today).

## 6. Option comparison

Prices are ESTIMATES from public list prices as I last knew them; re-check before any purchase decision.

| Option | Monthly cost | Portability | Maintenance for a two-agent team | Backup / disaster recovery | Best fit |
|---|---|---|---|---|---|
| Self-hosted PostgreSQL (Hetzner) | $0 on current server (no room today); about $8–15 for more server | Very high (standard Postgres) | **Medium-high**: updates, backups, monitoring, disk alerts are ours | Ours to build: nightly `pg_dump` to R2 + restore drills | Larger apps after a server upgrade |
| SQLite (file on the app's server) | $0 | High (one file) | **Low** | Copy the file (or Litestream) to R2 | Internal tools, single-server apps, small sites |
| Neon (hosted Postgres) | Free tier for small DBs; paid from roughly $5–20 | High (standard Postgres) | Low | Managed point-in-time restore | Apps that need Postgres without us running a server |
| Cloudflare D1 | Free tier generous; about $5 with Workers paid | Medium (SQLite dialect, Cloudflare API) | Low | Built-in time travel; export to SQL | Read-mostly sites already on Cloudflare Pages |
| Cloudflare R2 | First 10 GB free, then about $0.015/GB; no egress fees | High (S3 API) | Low | Bucket versioning | File storage, backups for every option above |
| Better Auth | $0 (open-source library) | High (runs inside the app, any SQL DB) | Medium: we own login security and updates | Lives in the app's DB | Replacing Supabase Auth when an app moves |
| Self-hosted Supabase (transitional) | $0 software, but it needs about 2–4 GB RAM | Medium | **High**: many containers to patch | Ours to build | Only as a short bridge; not recommended on today's server |

## 7. Recommended backend per app, and the first move

| App | Recommendation | Why |
|---|---|---|
| HiddenBag | **Stay on Supabase** | Owner rule: stays stable. Heaviest user (auth, rpc, 79 migrations). Revisit only with a bigger server and an owner-approved task |
| DailyAI (picks + site) | **Stay on Supabase** | Owner rule. Shares HiddenBag's database, so it moves with HiddenBag, if ever |
| Team Florida accounting | **Stay for now**; later Neon + Better Auth | Heavy auth (phone/Apple sign-in) and 35 DB functions; read-only for us; moving logins for parents and coaches is high risk |
| PeptideFacts | **Drop the dependency** (no database) | Runtime feature retired; only leftover scripts remain. Removal is a code change that needs the normal PeptideFacts owner release approval |
| Mission Control | **SQLite** (optional rehearsal) | Internal, server key only, no user logins, few files. It is on database A, which stays, so moving it saves nothing; useful only as a dry run of the checklist |
| AGG map | **SQLite on Hetzner**, and remove the duplicate copy | Same shape as RV Dump Stations |
| Archon | **Local Postgres with vectors, or retire** | Low use; confirm it is still needed first |
| Every1Raise | **Decide after confirming it is live** | Don't migrate what may be dead |
| AI Calendar, AI stock research | **SQLite or Neon free**, or archive if unused | Light use; check whether either is still live before any work |
| Wattz Up | **D1 or Neon free**, or archive | Light use; Vercel project not updated since March 2026 |
| RV Dump Stations | **SQLite on Hetzner** (first move) | Public data, no logins, 5 small tables, already served from Hetzner; removes database B's main egress driver |
| AI Tools HQ | **Static data in the build, or D1** | Reads data only at build time; already on Cloudflare Pages |
| Coaches Corner | **Decide after confirming it is live** | Uses logins; don't migrate what may be dead |
| LarsHomes | **Stay for now**; later Neon + R2 + Better Auth | Uses storage and edge functions; more parts to move |
| pickleballcourts.cc | **Stay for now** (on HiddenBag's DB) | Not on PC2 to inspect; later SQLite/D1 like the directories |
| ClipRush, MM Payments, TF websites | **No change** | They do not use Supabase |

**First migration candidate: RV Dump Stations → SQLite on Hetzner.** (The two drafts disagreed; this one wins.)
Why: its data is public, so a mistake cannot leak anyone's personal data; it has no logins to break; it has 5 small
tables; it already runs on the Hetzner server, so nothing new is hosted and a SQLite file adds almost no memory; and it
lives in database B, so it is the first real step toward the only saving this plan offers (closing B, section 9). It
also removes B's main egress driver. Mission Control is lower-risk still (no customers), but it sits in database A,
which stays, so moving it proves the process without moving us toward the goal. It stays available as an optional
dry run if Muse or the owner wants one first.

RV Dump steps (following section 8): full export of its tables, Supabase left untouched as the fallback; SQLite build
behind a switch (`DB_BACKEND=sqlite|supabase`) on a branch; row counts and checksums per table must match, plus a
20-listing spot check; the site's tests and page checks on the top pages and the submission form; switch in a quiet
hour; Supabase copy read-only for 14 days; roll back by flipping the switch (minutes). It is a public site, so a bad
cutover is visible: that is why the switch and the 14-day fallback are required. UNVERIFIED before starting: that the
Hetzner copy is the live one, and the current table sizes.

## 8. Reusable migration checklist (every future move)

0. **Security precondition (blocks every move):** any database key known or suspected to be exposed for the app's
   database has been rotated, and the rotation verified. Rotate before removing a key from code, never after. Status
   is tracked privately, not in this repo. This is separate from migration and is not delayed by it.
1. **Owner-approved task** naming the app, the target and any spending. Risk tier stated (most data moves are High).
2. **Inventory**: tables, row counts, auth users, storage files, functions and jobs the app touches; who else shares them.
3. **Backup before anything**: full dump of the app's data plus a copy in R2 or offline; prove the restore works on a
   scratch copy before going on.
4. **Security**: new least-privilege credential for the new store, recorded in the credentials map; never reuse the
   Supabase service key; `git check-ignore -q` on every env file; no secrets in logs or posts.
5. **Build on a copy**: point a preview or local build at the new store; the production app stays on Supabase.
6. **Data validation**: row counts per table, checksums or sampled record comparison, auth user counts, file counts
   and sizes; results recorded in the engineering note.
7. **Tests**: the project's full CI set plus a browser walk of the golden path on the preview.
8. **Cutover**: in a quiet window, freeze writes, final sync, re-validate counts, switch the env var, deploy.
9. **Monitoring**: error logs, a health check and key-page checks for 48 hours; Muse verifies independently.
10. **Rollback**: Supabase data stays read-only and untouched for at least 14 days. Rollback = restore the old env var
    and redeploy, plus re-sync any writes made since cutover (plan this step before cutover).
11. **Close-out**: only after the 14 days and owner OK, remove the app's Supabase data; cancel nothing until the
    whole database is empty and the owner approves.
12. **Backups going forward**: add the new database to the server's nightly backup and its restore test before the
    rollback window ends. A backup that has never been restored does not count.

## 9. Money table (monthly)

One table for both drafts. Headline figure: **about $35.50/month** (ESTIMATE, PC1 cost review 2026-11-09: Pro $25 +
two micro computes − $10 compute credit; no invoice checked). The May 2026 bill ($35–45, LAST KNOWN) is the older
reading and agrees within the range. No number here is VERIFIED from an invoice.

| Stage | Supabase | Hetzner | Saving vs today | Status |
|---|---|---|---|---|
| Today | ~$35.50 (Pro $25 + compute A $9.97 + compute B $9.97 − $10 credit, plus B egress) | $9.99 or €32.49 (conflicting records) | baseline | ESTIMATE (Supabase); UNVERIFIED (Hetzner) |
| RV Dump Stations moved (first move) | ~$35.50 (egress may drop) | same; SQLite needs no upgrade | ~$0 | ESTIMATE |
| Database B emptied and removed (RV Dump, AGG map, AI Tools HQ, Wattz Up, Coaches Corner, PeptideFacts leftovers and Team Florida accounting all moved) | ~$25 | same, if they all fit SQLite/D1; Team Florida accounting may need more server (quote first) | **~$10/mo** | ESTIMATE |
| Small apps on A moved | ~$25 (Pro stays while HiddenBag is there) | same | ~$10/mo | ESTIMATE |
| New: Neon / D1 / R2 for moved apps | | | −$0–5 (free tiers; R2 backups a few cents) | ESTIMATE |
| A emptied (HiddenBag + DailyAI moved; separate owner decision) | $0 | + server upgrade or second box, about $8–15 (quote first, **no purchase without approval**) | ~$20–27/mo net | ESTIMATE |

Per-app split of today's bill is not possible: Supabase bills per project, not per app. Near-term saving while
HiddenBag and DailyAI stay: **$0–10 a month**.

## 10. DailyAI reporting

I could not find the current "restricted reporting solution" on the board or on PC2, so I could not check how it
works (UNVERIFIED). Guidance, so it does not grow Supabase use:
- If it already reads through a read-only, limited view or key, **keep it**. It adds no new Supabase service, and
  DailyAI is frozen anyway.
- A simpler option, if it is not built yet: a **scheduled export** (a nightly job on Hetzner writes the report numbers
  to a CSV or JSON file, or a private crosswalk file) that the reader opens. Supabase never gets a new user, view or
  key, and the report keeps working if DailyAI moves one day.
- Avoid: new Supabase auth users, new dashboards built on Supabase, or new edge functions for reporting.

## 11. What could not be verified in this run

1. The current Supabase bill, plan and usage. The connector needs sign-in, and the numbers above are from May 2026.
2. PC1 project folders (pickleballcourts, DailyAI Betting site, AI Tools HQ, RV Dump, Coaches Corner, older clip-ai).
3. Whether the live PeptideFacts site still reads Supabase at runtime.
4. Whether Supabase Realtime is really used anywhere. The pattern counts are mostly Discord channels.
5. Any `pg_cron` or scheduled jobs inside the databases.
6. Which of AI Calendar, AI stock research, Wattz Up and Coaches Corner are still live or used.
7. The DailyAI restricted reporting setup (section 10).
8. Current Neon, Cloudflare and Hetzner list prices. All prices in sections 5, 6 and 9 are estimates.
9. The Hetzner monthly price ($9.99 vs €32.49 in different records).
10. Whether PostgreSQL runs on Hetzner today (the two drafts disagree, section 5).
11. Which database PeptideFacts uses and whether the live site reads it (section 2).
12. What the leftover edge functions and scheduled jobs in database B call.
13. The status of the exposed-key rotation (tracked privately; raised to the owner by Muse).
14. PC1 draft facts not re-checked from PC2: AGG map, Archon, Every1Raise, HiddenBag size, RV Dump table count.

## 12. How the two drafts were reconciled

| Point | PC2 draft (PR #12 v1) | PC1 draft (board file v1) | Merged plan | Why |
|---|---|---|---|---|
| First move | Mission Control → SQLite | RV Dump Stations → SQLite | **RV Dump Stations** | Same low risk (public data, no logins, already on Hetzner), and it moves us toward closing database B, the only saving available; Mission Control is in A, which stays. Mission Control kept as an optional dry run |
| Money | $35–45 (May bill) | ~$35.50 (Nov 9 estimate) | One table, headline ~$35.50, May range kept as context | Nov 9 is the newer reading; both are unverified and both say the near-term saving is ~$0–10 |
| Security | not covered (public-repo rule) | two exposed admin keys, rotate first | Step 0 in the checklist + owner summary, details kept private | Rotation is urgent and separate from migration; the details must not be published in a public repo |
| Hetzner memory | 0.9 GB free (checked 11-25) | ~420 MB free (11-09) | 11-25 reading | Newer and checked directly; both say no room for a database server |
| Coverage | more PC2 apps (AI Calendar, AI stock research, LarsHomes detail) | AGG map, Archon, Every1Raise, B leftovers | Union of both | One inventory |

## 13. Owner decisions this plan will ask for (one at a time, plain English, after Muse's review)
1. Rotate the exposed admin keys (Muse is raising this now, separately; urgent).
2. Approve RV Dump Stations as the first move.
3. Later, and only with a price quote first: more server capacity before any large or sensitive app moves.
