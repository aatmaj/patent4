# FormuGraph

A generics R&D workbench. Given a molecule, dosage form and strength, an
orchestrating agent coordinates seven sub-agents across patent, chemical and
regulatory data sources and emits a **Development Constraint Envelope** — a
machine-readable object describing what design space is available, what is
blocked, and what is unknown.

## Setup

```bash
cp .env.example .env.local   # then fill in GEMINI_API_KEY
npm install
npm run dev
```

Google Cloud credentials resolve in this order: `GCP_CREDENTIALS_JSON`
(inline service-account JSON, raw or base64) → `GOOGLE_APPLICATION_CREDENTIALS`
(path) → `../credentials.json` relative to this directory. Only the last works
without configuration, and only in local development — there is no repo
checkout to read a key file from on a serverless or container deployment.

**The key file must never be committed.** The repo-root `.gitignore` covers
`credentials.json`; if it was ever pushed, rotate the key rather than deleting
the commit.

```bash
npm test        # 112 unit tests, no external calls
npm run lint
npm run build
```

## Architecture

```
src/lib/
  config.js              model id, project id, cost/time ceilings
  bigquery.js            shared client; runQuery() with maximumBytesBilled + timeout
  gemini.js              Gemini transport behind an Anthropic-shaped createMessage()
  dates.js               patent-date normalisation (YYYYMMDD ints, ISO, BigQuery wrappers)
  strength.js            strength parsing; concentration vs content-per-volume
  patentText.js          per-document patent full text by publication number
  guard.js               optional bearer auth + per-IP rate limiting
  agents/                one module per agent, callable as plain functions
    rldProfile.js        RLD composition from the FDA label (openFDA SPL)
  orchestrator/
    prompt.js            system prompt (kept free of per-request values, so the cache holds)
    tools.js             tool definitions + in-process dispatcher
    harness.js           deterministic post-processing of the emitted envelope
    specification.js     deliverable selection; RLD-matched specification builder
    validate.js          envelope schema validation, including nested shapes
src/app/api/             thin route wrappers over the lib functions
tests/                   node --test, pure logic only
```

The orchestrator calls agents **in process**. It previously fetched its own
HTTP routes via `NEXT_PUBLIC_BASE_URL`, which doubled latency per tool call and
required the base URL to be right in every environment.

## Deliverable shape: corridors are not always the right output

FormuGraph's premise is emitting design corridors to seed a DOE. That premise
holds only where formulation design freedom exists.

For an **ANDA 505(j) parenteral solution it does not**. 21 CFR 314.94(a)(9)(iii)
requires Q1/Q2 sameness, so every excipient is fixed at the RLD's concentration
and every corridor collapses to a point. A DOE generator handed that receives a
specification with no factors to vary.

`src/lib/orchestrator/specification.js` detects this and switches the
deliverable rather than letting the schema degenerate into null bounds:

| Pathway + form | Design freedom | Deliverable |
|---|---|---|
| ANDA 505(j) parenteral | none | `rldSpecification` — RLD-matched composition + analytical/comparative/stability programme |
| ANDA 505(j) solid oral | limited | design corridors (no Q1/Q2 requirement) |
| 505(b)(2), NDA, non-US | full | design corridors |

On the specification pathway the DOE effort belongs in **process** design, which
the specification names explicitly under `developmentProgram.openToDesign`.

### Presentations are not interchangeable

A product's presentations can have different compositions — Ozempic's
multi-dose pen is preserved with phenol and propylene glycol; its single-dose
syringe uses sodium chloride and no preservative. They are therefore different
Q1/Q2 targets. The requested strength is resolved against the RLD's real
presentations (`src/lib/strength.js`), and a strength matching none of them is a
blocking finding rather than a silent substitution to the nearest one.

Note that `1 mg/mL` and `1 mg/0.5 mL` are different concentrations (1 vs
2 mg/mL), so a total-content-per-volume is never read as a concentration.

## Agent Topology view

`src/components/AgentTopology.js` is a **conceptual** view, not a wiring
diagram. Each band names one problem the system solves — blending structured
and unstructured data, multi-agent specialisation, loop engineering,
harnessing, and fitting the deliverable to the pathway. Per-agent wiring lives
in this README rather than on the canvas; an earlier version drew every agent,
source and edge and was accurate but unreadable.

Two layout constraints are load-bearing, so keep them in mind when editing it:

- The graph is authored to fit its canvas at **zoom 1** (content ~990x440 in a
  ~1040x568 box). Widening it past that makes the fit depend on React Flow's
  `fitView`, which measures the container before the flex row resolves and
  clips the rightmost nodes.
- The notes panel is an **overlay**, not a flex sibling, so toggling it never
  resizes the canvas and the graph never has to re-fit.

## The evidence taxonomy

Every value in the envelope carries an evidence class, and precedence runs
`S1 > S2 > U1 > U2 > I`:

| Class | Meaning |
|---|---|
| `S1` | A structured query returned this value **this session** |
| `S2` | Arithmetic derived from S1 (e.g. expiry = filing + 20y + PTE) |
| `U1` | Primary document text retrieved **this session** (patent claims, or FDA label text) |
| `U2` | LLM reasoning over documents |
| `I`  | Inferred, no source — must carry a falsification test |

### The harness has two distinct roles

Conflating them hid a whole class of error for a long time:

| Role | Question it answers | Rules |
|---|---|---|
| **Provenance auditor** | "Was this retrieved, and is it cited honestly?" | 1–10 |
| **Logic auditor** | "Does the stated conclusion follow from the numbers retrieved?" | 11+ |

The provenance half has always worked — it demotes inflated evidence classes,
strips expired citations, flags search truncation, cascades phase failures. It
**cannot** catch an arithmetic error, however rigorous it is about sources.

Across 16 recorded runs the `arithmetic` tool was invoked 17 times —
`patent_expiry` ×11, `eval` ×4, `earliest` ×2 — and **never once for a range or
bound check**, because no such operation existed. Every containment judgment
that actually drove a verdict (does the product concentration fall inside this
claimed range? does the requested strength equal a real presentation?) was
decided in prose, inside the same generation pass doing the legal reasoning.
That is the gap `in_range` / `compare` / `overlap` and rule 11 close.

**The model does not get to grade its own evidence.** `harness.js` verifies
each claim against the actual recorded tool outputs and corrects it:

| Rule | Effect | Severity |
|---|---|---|
| 1 | Expired patents removed from constraints and corridors | blocking |
| 2 | A design corridor is never S1 (it is interpretive) | blocking |
| 3 | U1 requires a cited patent that `document_reason` confirms it retrieved | advisory |
| 4 | S1 requires a source a structured query actually returned; a recalled CFR/USP citation is `I` | advisory |
| 5 | Q1/Q2 sameness gate for 505(j) parenterals (see below) | blocking |
| 6 | An FTO classification parse failure fails phase 1 | blocking |
| 7 | A search that hit its result cap raises an open question | advisory |
| 8 | Conditional risk strings normalised to the worst level mentioned | advisory |
| 8b | Deliverable selected; strength resolved; degenerate corridors replaced by a specification | mixed |
| 8c | A failed phase fails the phases that consume it (3 → 4 → 5), not just phase 6 | advisory |
| 9 | Phase 6 fails only on **blocking** findings or an upstream failure | — |
| 10 | A `GO` status is downgraded when verification fails | — |
| 11 | *(logic)* A corridor stating numeric bounds must be backed by an `in_range`/`compare`/`overlap` call **over those numbers** | blocking |
| 12 | *(scope)* Cost/infra limits that shrank the analysis are surfaced into `executiveSummary.rationale` and `scopeLimitations` | advisory |
| 13 | *(reproducibility)* Caveats that follow from tool coverage are **generated**, so a rerun cannot silently drop them | — |

The blocking/advisory split matters: an evidence downgrade records normal
uncertainty and should not read as a verification failure.

### Q1/Q2 sameness and `rldMatched`

21 CFR 314.94(a)(9)(iii) requires an ANDA parenteral to match the RLD's
inactive ingredients at the same concentrations. The rule is therefore about
*deviation from the RLD*, not about a parameter being an excipient — the
corridor that reproduces the RLD is the one the applicant **must** hit.

Excipient and pH corridors on a 505(j) parenteral must declare `rldMatched`:

| `rldMatched` | Harness action |
|---|---|
| `true` | Left `PERMITTED`; this is the compliant corridor |
| `false` | Flipped to `EXCLUDED` — that is a 505(b)(2) strategy |
| absent | Left alone, raised as an open question rather than guessed |

### Numeric verdicts are computed, not read

`in_range`, `compare` and `overlap` normalise units before comparing, so a
claim in `% w/v` and a label in `mg/mL` are answerable, while `% w/w` against a
concentration is **refused** — converting a mass fraction needs the solution
density, and assuming 1 g/mL is how a claim gets misread as covering (or not
covering) a product. A bare `%` compares against another bare `%` and nothing
else.

Rule 11 will not accept an unrelated comparison as backing: the recorded call
must operate on the corridor's own bounds (2% tolerance for label rounding),
and `patent_expiry` or `earliest` do not count.

### Scope limits are analytical limits

A market dropped or a sweep skipped for cost reasons changes what the answer
covers. Rule 12 derives those from tool coverage into `scopeLimitations` and
prefixes `executiveSummary.rationale` with a `[SCOPE]` banner, so a ceiling
that exists for engineering reasons cannot silently determine completeness
without the reader of the verdict seeing it.

### Caveats are derived, not authored

Model-written `openQuestions` are not reproducible — the same inputs produced a
PTA/PTE caveat in one run and dropped it in the next, unresolved. Anything that
follows deterministically from tool coverage (PTA/PTE not retrieved, an Orange
Book gap, no RLD call) is generated by rule 13 and merged in, so it cannot go
missing between reruns. The model may still add its own on top.

## Retrieval paths, and why they are what they are

`patents-public-data.patents.publications` is **2.81 TiB over 170M rows with no
partitioning and no clustering** (verified from table metadata). A `WHERE`
clause therefore prunes nothing — BigQuery reads every byte of each referenced
column. Measured dry runs:

| Query | Scanned |
|---|---|
| `claims_localized` for **one** publication | 116.6 GiB |
| title + abstract sweep | 222.5 GiB |
| same sweep + a `grant_date` range | 218.6 GiB (a date filter does not help) |
| title only, no abstract | 17.6 GiB |
| `google_patents_research` equivalent | 119.5 GiB (not cheaper) |

So column selection is the only lever, and per-document claim retrieval from
BigQuery is structurally wrong at ~117 GiB per patent. The split:

| Need | Source | Cost |
|---|---|---|
| Landscape discovery | BigQuery, **titles only** | ~18.9 GiB per sweep |
| Abstracts + claim text | Google Patents by document id (`src/lib/patentText.js`) | one HTTP GET each |
| Orange Book patents/exclusivities | openFDA `drug/orangebook` | free |
| RLD composition | openFDA `drug/label` (`src/lib/agents/rldProfile.js`) | free |

Title-only search loses recall on patents naming the molecule solely in the
abstract. That is **attested** in `coverageAttestation.gaps`, not hidden, and the
Orange Book seed recovers the set that matters most for a generic filing —
those are the patents the innovator listed against the RLD. Set
`FTO_SWEEP_ABSTRACTS=true` to opt back into the expensive sweep knowingly.

**Column budget is tight and enforced.** The mandated SELECT is
`publication_number, title, grant_date, country_code` (18.9 GiB). Adding
`assignee` and `application_number` takes the same query to 29.6 GiB and it is
refused. Assignees, filing dates and abstracts are retrieved per document
afterwards, so they cost nothing here. If the sweep is refused or fails, the
agent **degrades to the Orange Book seeds** rather than aborting — those are the
patents listed against the RLD and the most load-bearing evidence in the run.

### Picking the right product and presentation

Two silent-wrong-answer traps, both guarded:

- **A brand name is not unique across routes.** "Ozempic" matches both the
  subcutaneous injection (NDA209637) and an oral tablet (NDA213051). Always pass
  `dosageForm` to `rld_profile`; selection is route-aware and reports what it
  rejected.
- **Presentations differ in composition.** The label is parsed into
  presentation *blocks* keyed on container volume, so Ozempic's 3 mL multi-dose
  pen keeps its phenol and propylene glycol while the 0.5 mL single-dose syringe
  keeps sodium chloride. Attributing by prose proximity gave every presentation
  the syringe composition, which would have specified a Q1/Q2 target missing the
  preservative entirely.

## Where a run spends its time

Same input, measured across successive protocol fixes — Metformin / Tablet /
500mg / US+EP:

| | baseline | after |
| --- | --- | --- |
| wall clock | 280 s | **152 s** |
| orchestrator turns | 8 | **4** |
| `document_reason` | 2 calls, 73 s | **1 call, 35 s** |
| `arithmetic` | 3 calls, 3 turns | **4 calls, 1 turn** |
| `patent_fto_agent` | 70 s | 63 s |
| phases passing | 6 of 7 | **7 of 7** |
| harness blocking findings | — | **0** |
| summary status | REVIEW | **GO** |

**A turn costs ~20 s of model latency before any tool runs**, so the number of
turns dominates, not the number of calls. The run got faster while doing *more*
work because the turn structure changed, not because anything was skipped:

- `document_reason` takes a documents array and retrieves it concurrently. The
  protocol used to illustrate it with a single document, so the model issued one
  call per patent, paying a full turn for each.
- `arithmetic` returns in under a millisecond but had no assigned turn, so the
  model spent a turn per call on the cheapest tool in the system.
- `patent_fto_agent` and the Orange Book claim retrieval were run in sequence,
  though neither needs the other: the Orange Book numbers are in hand at the end
  of Turn 1. Issued together, 115 s of serial tool time becomes 63 s of wall.

One caution learned the hard way: an intermediate version made the arithmetic
step read as conditional ("Turn 4 (or 3)"), and the model dropped from seven
arithmetic calls to one. Every corridor lost its numeric backing, phase 6
failed, and the verdict fell to REVIEW — a faster run that was materially worse.
The arithmetic gate is now unconditional and states its own consequence. If you
edit this protocol, re-check `numericBacking` on the corridors before trusting
the wall clock.

### Model tier

Protocol work bottomed out around 150 s. The rest is model latency, so the
remaining lever is tier. Measured end to end with `scripts`-style in-process
runs of the real loop, one run each:

| tier | Metformin | Semaglutide | phases | blocking | schema errors |
| --- | --- | --- | --- | --- | --- |
| all Pro | 152-230 s | 169-204 s | 7/7 | 0 | 0 |
| Flash sub-agents, Pro orchestrator | 231 s | — | 7/7 | 0 | 0 |
| **all Flash** | **68 s** | **91 s** | 7/7 | 0 | 0 |

Set `GEMINI_MODEL`, `GEMINI_CLASSIFIER_MODEL` and `GEMINI_UTILITY_MODEL` all to
`gemini-3.7-flash` for the last row.

Two things that table does not say, and both matter:

- **These are single runs and the variance is large.** The same Pro
  configuration produced 152 s and 231 s on the same molecule. Treat the
  ordering as real and the individual numbers as approximate.
- **The columns are structural, not substantive.** Phase counts, schema
  validity and harness findings say the envelope is well-formed and internally
  grounded. They do not say the legal reasoning is right. The fabricated
  "> 6.4 mg/mL" bound that prompted rule 14 was caught by reading the claim
  extraction, and nothing in this table would have flagged it.

What is worth noting is *where* Pro spends its time: on one Metformin run the
emit turn alone took 61 s and the arithmetic turn 51 s, against 12 s and 8 s for
Flash. The cost is in generating the envelope, not in the tool work.

### The floor

At 152 s the remaining budget is roughly 72 s of model latency (4 turns × ~18 s)
and 63 s of `patent_fto_agent`, which dominates its turn. Four turns is close to
the real dependency floor: Orange Book seeds the sweep, the sweep yields the IDs
whose claims must be retrieved, and those claims yield the numbers arithmetic
checks. Collapsing further means giving something up rather than reordering it.

Getting materially below ~130 s therefore means changing model tier, not
protocol — `GEMINI_CLASSIFIER_MODEL` first (classification is 18-30 s of
`patent_fto_agent`), and below ~120 s the orchestrator itself, which is the
reasoning core and a genuine quality decision.

Batching arithmetic also *improved* the verdict. Harness rule 11 fails any
corridor whose bounds no `in_range` call covers; with three scattered calls most
corridors were unbacked, which failed phase 6 and downgraded the summary from GO
to REVIEW. With all seven issued together every corridor reports
`numericBacking: verified`. Fewer turns, stricter verification.

Remaining levers:

1. **Document fetch concurrency** — free, applied. Measurement table in
   `patentText.js`; nothing is dropped at the higher cap.
2. **Classifier model** — `GEMINI_CLASSIFIER_MODEL=gemini-3.7-flash` roughly
   halves classification, opt-in because it is a measurable quality trade rather
   than a free win. Numbers in `config.js`.

`maxDuration` on the orchestrator route is 300 s and most serverless platforms
cap well below it (Vercel Hobby is 60 s), so a ~250 s run still has little
headroom. The client abort is a backstop at 15 minutes and should never be the
thing that ends a run.

## BigQuery spend — where it actually comes from

A three-day audit of `INFORMATION_SCHEMA.JOBS_BY_PROJECT` on this project:

| source | jobs | billed | approx |
| --- | --- | --- | --- |
| jobs above the app's 25 GiB ceiling | 122 | **18.89 TiB** | **~Rs 10,400** |
| every job the webapp issued | 338 | 0.49 TiB | ~Rs 269 |

The webapp was **2.5%** of the bill. It cannot issue the expensive jobs at all:
`runQuery` sets `maximumBytesBilled` on every job, so anything over the ceiling
is rejected before it scans. The 18.89 TiB came from ad-hoc queries run outside
it — `SELECT ... abstract_localized ...` over `patents.publications` scans
222.5 GiB *per query*, because that table is 2.81 TiB, unpartitioned and
unclustered, so a `WHERE` clause and a `LIMIT` prune nothing.

Audit your own spend before optimising anything — the answer is often not where
it looks:

```sql
SELECT DATE(creation_time) AS day, COUNT(*) AS jobs,
       SUM(total_bytes_billed)/POW(1024,4) AS tib_billed
FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
  AND job_type = 'QUERY'
GROUP BY day ORDER BY day DESC
```

What is in place now:

- **`scripts/query_gbq.py` has the same guard as the app.** It dry-runs first
  (dry runs are free), prints the estimate in GiB and rupees, refuses anything
  over 25 GiB, and asks for confirmation above 5 GiB. `--dry-run` prices a query
  without running it; `--max-gib` raises the ceiling deliberately.
- **The sweep SQL is memoised per molecule/market.** BigQuery serves a
  byte-identical query from its result cache for 24 hours free, but the SQL is
  model-generated, so two runs of one molecule previously produced two different
  strings and two separate 18.9 GiB scans — 71 sweep jobs in a day against only
  12 cache hits. Verified: first run 18.91 GiB billed, identical rerun 0.00 GiB
  with `cacheHit=true`. Re-evaluating the same molecule is now free and faster.

Still worth doing, and it is the only guard that covers every path — the
console, notebooks, and any script written next week:

- Set a **custom quota** on query usage per day for the project
  (IAM & Admin → Quotas → "Query usage per day"). A ceiling of a few hundred GiB
  would have capped this at a few hundred rupees. Per-user quotas are available
  on the same page.
- Scope the service account read-only to the datasets in use, and consider a
  separate account for exploration so its spend is attributable.

## Cost controls

An orchestrator run fans out to roughly ten Gemini calls plus several BigQuery
jobs, so every route spends money.

- **BigQuery**: every job carries `maximumBytesBilled` and `jobTimeoutMs`.
  Model-generated SQL is additionally dry-run first and refused above the
  ceiling, and passes a structural read-only check (`assertReadOnlySelect`).
- **Prompt caching**: the ~5k-token system prompt and tool definitions are
  byte-stable within a process, which is what a cache needs. Gemini has no
  opt-in cache marker — it caches repeated prefixes implicitly — so there is
  nothing to configure. It does work: a full 8-iteration Metformin run reported
  `usage.cacheReadInputTokens: 183,586`. A two-turn probe reports zero, so
  judge this on a real run, not a short one. Explicit context caching
  (`cachedContents`) is the lever if you want it guaranteed rather than
  best-effort.
- **Reasoning tokens**: Gemini 3 Pro cannot run with thinking disabled, and
  reasoning is billed against the output ceiling. `THINKING_RESERVE_TOKENS`
  (default 8192) is added to every `max_tokens` the agents request. Truncated
  JSON envelopes mean the reserve is too small, not that the model failed —
  the mapped response reports `stop_reason: 'max_tokens'` when that happens.
- **Access control**: set `API_ACCESS_TOKEN` to require a bearer token, and
  `RATE_LIMIT_*_PER_MIN` to cap per-IP requests. Both are opt-in so local
  development is unaffected. The rate limiter is in-process; put a real
  limiter or an auth proxy in front before exposing this publicly.
- The service account should be scoped **read-only** to the datasets in use.
  The SQL guard is a second layer, not the only one.

## Deployment note

`maxDuration = 300` on the orchestrator route exceeds the limit on several
serverless tiers (Vercel Hobby caps at 60s). A full run takes 2–5 minutes, so
check your platform's ceiling before deploying.
