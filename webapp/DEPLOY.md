# Deploying to Cloud Run

Verified against Next.js 16 standalone output. The build, the standalone server
and the auth guard were each exercised locally before these steps were written;
the gcloud commands themselves have not been run against your project.

## Read this first

Every API route in this app spends money — an orchestrator run makes ~10 Gemini
calls and several BigQuery jobs, and a single unguarded BigQuery query over
`patents.publications` can scan 222 GiB. A Cloud Run service deployed with
`--allow-unauthenticated` and no `API_ACCESS_TOKEN` is a public endpoint that
bills your account on request.

## Pick an auth model before you deploy — they are not interchangeable

`API_ACCESS_TOKEN` guards the API against machine clients. It does **not** make
the web UI usable, because the browser sends no `Authorization` header: see the
`fetch('/api/orchestrator')` call in `src/components/FormuGraph.js`. Deploy with
the token set and the page loads fine, then every click returns 401.

So choose by who is calling:

| audience | use | UI works? |
| --- | --- | --- |
| A few named humans in a browser | **IAP** (below), no token | yes |
| Scripts, notebooks, another service | `API_ACCESS_TOKEN` | no (API only) |
| Both | IAP for the UI, token for machines | yes |

### IAP — the right answer for sharing with a handful of people

Identity-Aware Proxy puts Google sign-in in front of the whole service and
checks each visitor against an allowlist, so the browser is authenticated at the
edge and the app needs no changes, no login screen and no shared secret to pass
around. Revoking somebody is removing one IAM binding.

Deploy without `--allow-unauthenticated`, enable IAP on the service, then grant
each person access:

```bash
gcloud run services add-iam-policy-binding formugraph \
  --region asia-south1 \
  --member="user:colleague@example.com" \
  --role="roles/run.invoker"
```

Check the current IAP-on-Cloud-Run setup in the console before scripting it —
the feature has moved between a load-balancer-fronted setup and direct support
on the service, and the console reflects whichever your project has.

A shared bearer token is the thing to avoid here: it cannot be revoked per
person, it ends up pasted into chats, and everyone's spend looks identical in
the logs.

Verified token behaviour, for the machine-client case: no token → 401, wrong
token → 401, correct token → the request proceeds.

## Why Cloud Run rather than Vercel

Vercel is the obvious quick answer for a Next.js app, and it is the wrong one
here, for two specific reasons rather than as a general preference:

- **Runtime.** Measured runs are 150-280 s, and one has exceeded 360 s. Vercel
  caps a function at 60 s on Hobby and 300 s on Pro. Runs would be killed near
  the finish line. Cloud Run allows up to 3600 s (`--timeout 900` below).
- **Credentials.** Off-GCP, BigQuery needs a service-account private key pasted
  into an environment variable. On Cloud Run the app uses Application Default
  Credentials from the attached service account, so no key material exists at
  all. Given a key already sits in this repo's parent directory, not creating a
  second copy of it is worth something.

Keeping the app in the same project as BigQuery also keeps spend, quotas and
audit logs in one place — which matters after a Rs 10,000 day.

## 0. Prerequisites

```bash
gcloud auth login
gcloud config set project gen-lang-client-0471305973
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com bigquery.googleapis.com
```

## 1. A dedicated runtime service account

The app authenticates to BigQuery with Application Default Credentials, which on
Cloud Run means the attached service account — no key file is built into the
image and none needs to exist. A separate account also makes this service's
BigQuery spend attributable, which matters given how the last bill happened.

```bash
gcloud iam service-accounts create formugraph-run \
  --display-name="FormuGraph Cloud Run runtime"

# Permission to run query jobs billed to this project. Public datasets
# (patents-public-data, bigquery-public-data) are readable without extra grants.
gcloud projects add-iam-policy-binding gen-lang-client-0471305973 \
  --member="serviceAccount:formugraph-run@gen-lang-client-0471305973.iam.gserviceaccount.com" \
  --role="roles/bigquery.jobUser"
```

## 2. Secrets

Keep the Gemini key and the access token out of `--set-env-vars`, where they are
visible in the service description and in deploy logs.

```bash
printf '%s' 'YOUR_GEMINI_API_KEY' | \
  gcloud secrets create gemini-api-key --data-file=-

# Generate a strong access token and keep a copy for your clients.
openssl rand -base64 32 | tr -d '\n' | \
  gcloud secrets create formugraph-api-token --data-file=-

for s in gemini-api-key formugraph-api-token; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:formugraph-run@gen-lang-client-0471305973.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

## 3. Deploy

Run from `webapp/` — the Dockerfile and `.dockerignore` live there.

No local tooling required: the repo is on GitHub, so you can open
[Cloud Shell](https://shell.cloud.google.com), `git clone
git@github.com:aatmaj/patent4.git`, `cd patent4/webapp` and run the command
below. `gcloud`, `docker` and `git` are all preinstalled there. `--source .`
builds with Cloud Build, so nothing needs Docker on your Mac.

For the IAP setup described above, drop `--allow-unauthenticated` and omit the
`API_ACCESS_TOKEN` secret.

```bash
gcloud run deploy formugraph \
  --source . \
  --region asia-south1 \
  --service-account formugraph-run@gen-lang-client-0471305973.iam.gserviceaccount.com \
  --timeout 900 \
  --memory 2Gi \
  --cpu 2 \
  --concurrency 4 \
  --min-instances 1 \
  --max-instances 3 \
  --set-env-vars "GCP_PROJECT_ID=gen-lang-client-0471305973,NODE_ENV=production" \
  --set-secrets "GEMINI_API_KEY=gemini-api-key:latest,API_ACCESS_TOKEN=formugraph-api-token:latest" \
  --allow-unauthenticated
```

Why these flags, since the defaults are wrong for this workload:

| flag | reason |
| --- | --- |
| `--timeout 900` | The default is 300 s. Measured runs are 150-280 s on Pro and a slower molecule has exceeded 300 s. At the default, Cloud Run would kill a run that was about to succeed. |
| `--concurrency 4` | The default is 80. Each run holds a full execution trace and tool outputs in memory; 80 at once would OOM. |
| `--memory 2Gi` | Next server plus the BigQuery client plus several concurrent runs. |
| `--min-instances 1` | Not just cold starts: the generated-SQL cache is in-process, and it is what makes a repeat sweep a free BigQuery cache hit instead of another 18.9 GiB scan. Scaling to zero throws that away. |
| `--max-instances 3` | A spend ceiling. Each instance can run concurrent BigQuery jobs. |

`--allow-unauthenticated` is safe **only** because `API_ACCESS_TOKEN` is set in
the same command. If you would rather not expose it publicly at all, drop that
flag and grant `roles/run.invoker` to specific principals instead.

## 4. Verify

```bash
URL=$(gcloud run services describe formugraph --region asia-south1 --format='value(status.url)')
TOKEN=$(gcloud secrets versions access latest --secret=formugraph-api-token)

# Expect 401 — proves the guard is live before you send anything expensive.
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL/api/orchestrator" \
  -H 'content-type: application/json' -d '{"molecule":"x","strength":"1mg"}'

# Cheapest authenticated route that touches both Gemini and an external API.
curl -s -X POST "$URL/api/agents/physchem" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"moleculeName":"metformin"}'
```

Then a full run (expect 2-5 minutes):

```bash
curl -s -X POST "$URL/api/orchestrator" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"molecule":"Metformin","dosageForm":"Tablet","strength":"500mg","targetMarkets":["US"],"objective":"Generic development"}'
```

## 5. Cap the spend

Do this before sharing the URL, not after. Neither the app's per-job ceiling nor
the rate limiter caps a *daily total*.

- **BigQuery**: IAM & Admin → Quotas → "Query usage per day", set a project
  ceiling. A few hundred GiB/day would have capped the last incident at a few
  hundred rupees.
- **Billing**: a budget alert on the project.
- **Gemini**: quota limits in AI Studio / the API console.

## Known limitations

- **The rate limiter is per-instance.** `RATE_LIMIT_PER_MIN` counts in process
  memory, so with `--max-instances 3` the effective ceiling is three times what
  you configured. `API_ACCESS_TOKEN` is the real control; the limiter only
  blunts accidental loops. For a shared limit, put an API Gateway or Cloud
  Armor policy in front.
- **The SQL and patent-text caches are per-instance and lost on restart.** They
  are an optimisation, not a correctness dependency.
- **`export const maxDuration = 300`** in the orchestrator route is a Vercel
  directive and does nothing on Cloud Run. The `--timeout` flag is what governs.
- **The browser holds the connection for the whole run.** A proxy or corporate
  network that idles out long-lived requests will drop it. The client backstop
  is 15 minutes; if this becomes a problem the fix is a job/polling API rather
  than a longer timeout.

## What was changed to make this deployable

Two things would have failed at runtime in a container and were fixed:

1. `nlq.js` read `src/lib/semanticModel.json` from `process.cwd()`. Standalone
   output contains no `src/` directory — verified — so NLQ and the
   orchestrator's `structured_query` tool would have thrown on first use. It is
   now a traced JSON import.
2. `bigquery.js` threw when it found no inline JSON, no
   `GOOGLE_APPLICATION_CREDENTIALS` and no `../credentials.json`. That is
   exactly the Cloud Run case, where the correct answer is Application Default
   Credentials from the attached service account. It now falls through to ADC.
