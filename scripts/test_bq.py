from google.cloud import bigquery
from google.oauth2 import service_account

credentials_path = 'credentials.json'
credentials = service_account.Credentials.from_service_account_file(credentials_path)
project_id = 'gen-lang-client-0471305973'
client = bigquery.Client(credentials=credentials, project=project_id)

datasets_to_check = [
    'patents-public-data.patents',
    'bigquery-public-data.fda_food'
]

for ds in datasets_to_check:
    try:
        query = f"SELECT * FROM `{ds}.INFORMATION_SCHEMA.TABLES` LIMIT 5"
        job = client.query(query)
        res = list(job.result())
        print(f"Success accessing {ds}: {len(res)} tables found.")
    except Exception as e:
        print(f"Error accessing {ds}: {e}")
