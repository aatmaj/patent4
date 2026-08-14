"""Ad-hoc BigQuery CLI, with the cost guard the webapp has always had.

Why this file grew a guard
--------------------------
`patents-public-data.patents.publications` is 2.81 TiB, unpartitioned and
unclustered, so a WHERE clause prunes nothing: BigQuery reads every byte of
every column the query names. Selecting the abstract alongside the title scans
222.5 GiB *per query*, and a run of exploratory variations bills that each time.

Measured over three days on this project: 122 jobs exceeded the webapp's 25 GiB
ceiling and billed 18.89 TiB (~Rs 10,400), while all 338 jobs issued by the
webapp together billed 0.49 TiB (~Rs 269). Every one of the expensive jobs came
through an unguarded script like this one, because the webapp physically cannot
issue them — `runQuery` sets maximumBytesBilled on every job.

So this script now does what the webapp does: estimate first, refuse what is
over budget, and make the number visible before anything is billed.
"""

import argparse
import os
import sys

from google.cloud import bigquery
from google.oauth2 import service_account

PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "gen-lang-client-0471305973")

GIB = 1024 ** 3
TIB = 1024 ** 4

# Matches BQ_MAX_BYTES_BILLED in webapp/src/lib/config.js. A query over this is
# refused rather than run, so a mistake costs nothing instead of a lot.
DEFAULT_MAX_GIB = float(os.environ.get("BQ_MAX_GIB", "25"))

# On-demand analysis pricing, US multi-region. Only used to print an estimate.
USD_PER_TIB = 6.25
INR_PER_USD = 88.0


def _client(credentials_path):
    credentials = service_account.Credentials.from_service_account_file(credentials_path)
    return bigquery.Client(credentials=credentials, project=PROJECT_ID)


def estimate(client, query_string):
    """Bytes this query would process. Dry runs are free and are never billed."""
    job = client.query(
        query_string,
        job_config=bigquery.QueryJobConfig(dry_run=True, use_query_cache=False),
    )
    return int(job.total_bytes_processed or 0)


def describe(num_bytes):
    tib = num_bytes / TIB
    usd = tib * USD_PER_TIB
    return (
        f"{num_bytes / GIB:,.2f} GiB (~${usd:,.2f}, ~Rs {usd * INR_PER_USD:,.0f})"
    )


def query_bigquery(query_string, credentials_path="credentials.json",
                   max_gib=DEFAULT_MAX_GIB, yes=False, dry_run_only=False):
    client = _client(credentials_path)

    try:
        billed = estimate(client, query_string)
    except Exception as exc:  # noqa: BLE001 - surface the real BigQuery error
        print(f"Could not estimate the query (it may be invalid): {exc}", file=sys.stderr)
        return 1

    print(f"Estimated scan: {describe(billed)}")
    if dry_run_only:
        return 0

    ceiling = int(max_gib * GIB)
    if billed > ceiling:
        print(
            f"REFUSED: this query would scan {describe(billed)}, over the "
            f"{max_gib:g} GiB ceiling.\n"
            "  - Name fewer columns. On patents.publications the abstract and claims\n"
            "    columns are hundreds of GiB each and cannot be filtered down, because\n"
            "    the table has no partitioning or clustering.\n"
            "  - Raise the ceiling deliberately with --max-gib if you truly mean it.",
            file=sys.stderr,
        )
        return 2

    # A large-but-permitted scan still costs real money, so make the human say so.
    if billed > 5 * GIB and not yes:
        answer = input(f"Run it and bill {describe(billed)}? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Aborted.")
            return 0

    job_config = bigquery.QueryJobConfig(maximum_bytes_billed=ceiling)
    try:
        print(f"Executing query on project: {PROJECT_ID}...")
        query_job = client.query(query_string, job_config=job_config)
        results = query_job.result()
        for row in results:
            print(dict(row))
        actual = int(query_job.total_bytes_billed or 0)
        cached = bool(query_job.cache_hit)
        print(
            f"\nBilled: {describe(actual)}"
            + ("  [served from cache — free]" if cached else "")
        )
    except Exception as exc:  # noqa: BLE001
        print(f"An error occurred: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Query BigQuery using a service account, with a cost ceiling.",
    )
    parser.add_argument("query", help="The SQL query string to execute.")
    parser.add_argument("--credentials", default="credentials.json",
                        help="Path to the service account JSON file.")
    parser.add_argument("--max-gib", type=float, default=DEFAULT_MAX_GIB,
                        help=f"Refuse queries scanning more than this (default {DEFAULT_MAX_GIB:g}).")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print the estimated scan and exit without running.")
    parser.add_argument("-y", "--yes", action="store_true",
                        help="Skip the confirmation prompt for scans over 5 GiB.")

    args = parser.parse_args()
    sys.exit(
        query_bigquery(args.query, args.credentials, args.max_gib, args.yes, args.dry_run)
    )
