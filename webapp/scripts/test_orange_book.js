fetch('http://localhost:3000/api/agents/orange-book', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ molecule: 'SEMAGLUTIDE' })
})
.then(res => res.json())
.then(data => {
  console.log("Response:", JSON.stringify(data, null, 2));
})
.catch(err => console.error(err));
