const { BigQuery } = require('@google-cloud/bigquery');
const path = require('path');
const bq = new BigQuery({ projectId: 'gen-lang-client-0471305973', keyFilename: path.join(__dirname, '../credentials.json') });

async function tryQuery(q) {
  try {
    const [rows] = await bq.query(q);
    console.log(`✅ EXISTS: ${q}`);
  } catch (e) {
    console.log(`❌ MISSING: ${q} (${e.message.split('\n')[0]})`);
  }
}

async function check() {
  const queries = [
    'SELECT 1 FROM `patents-public-data.patents.publications` LIMIT 1',
    'SELECT 1 FROM `bigquery-public-data.ebi_chembl.molecule_dictionary` LIMIT 1',
    'SELECT 1 FROM `patents-public-data.ebi_chembl.molecule_dictionary` LIMIT 1',
    'SELECT 1 FROM `bigquery-public-data.ebi_chembl.compound_properties` LIMIT 1',
    'SELECT 1 FROM `patents-public-data.ebi_chembl.compound_properties` LIMIT 1',
    'SELECT 1 FROM `bigquery-public-data.ebi_chembl.compound_structures` LIMIT 1',
    'SELECT 1 FROM `patents-public-data.ebi_chembl.compound_structures` LIMIT 1',
    'SELECT 1 FROM `bigquery-public-data.ebi_chembl.molecule_synonyms` LIMIT 1',
    'SELECT 1 FROM `patents-public-data.ebi_chembl.molecule_synonyms` LIMIT 1',
    'SELECT 1 FROM `bigquery-public-data.fda_drug.drug_label` LIMIT 1',
    'SELECT 1 FROM `bigquery-public-data.fda_drug.application` LIMIT 1',
    'SELECT 1 FROM `bigquery-public-data.fda_drug.product` LIMIT 1',
    'SELECT 1 FROM `bigquery-public-data.fda.drug_products` LIMIT 1'
  ];

  for (const q of queries) {
    await tryQuery(q);
  }
}
check();
