from google.cloud import bigquery
from google.oauth2 import service_account

credentials_path = 'credentials.json'
credentials = service_account.Credentials.from_service_account_file(credentials_path)
client = bigquery.Client(credentials=credentials, project='gen-lang-client-0471305973')

def check_dataset(project, dataset):
    try:
        ds = client.get_dataset(f"{project}.{dataset}")
        print(f"FOUND: {project}.{dataset}")
    except Exception as e:
        pass

projects = ['bigquery-public-data', 'patents-public-data']
datasets_to_try = ['fda', 'fda_drug', 'fda_drugs', 'orangebook', 'pubchem', 'ebi_chembl', 'chembl']

for p in projects:
    for d in datasets_to_try:
        check_dataset(p, d)
        
# also list datasets in patents-public-data
try:
    datasets = list(client.list_datasets('patents-public-data'))
    print("patents-public-data datasets:")
    for ds in datasets:
        print(ds.dataset_id)
except Exception as e:
    print(e)
    
try:
    # Just checking first 20 datasets in bigquery-public-data
    datasets = list(client.list_datasets('bigquery-public-data', max_results=20))
    print("bigquery-public-data sample datasets:")
    for ds in datasets:
        print(ds.dataset_id)
except Exception as e:
    print(e)
