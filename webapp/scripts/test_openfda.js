const https = require('https');

https.get('https://api.fda.gov/drug/orangebook.json?search=products.active_ingredients.name:"SEMAGLUTIDE"+OR+products.brand_name:"SEMAGLUTIDE"&limit=100', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      console.log(JSON.stringify(parsed.results[0], null, 2));
      console.log("Total records:", parsed.meta?.results?.total || 0);
    } catch(e) { console.error(e.message); }
  });
});
