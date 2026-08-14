const { BigQuery } = require('@google-cloud/bigquery');
const path = require('path');
const bq = new BigQuery({ projectId: 'gen-lang-client-0471305973', keyFilename: path.join(__dirname, '../credentials.json') });

async function check() {
  try {
    const [datasets] = await bq.getDatasets();
    console.log("Datasets in gen-lang-client-0471305973:");
    for (const d of datasets) {
      console.log(d.id);
      const [tables] = await d.getTables();
      tables.forEach(t => console.log("  - " + t.id));
    }
  } catch(e) {
    console.error(e.message);
  }
}
check();
