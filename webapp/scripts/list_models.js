const { GoogleGenerativeAI } = require("@google/generative-ai");

async function run() {
  // Use the API key from the environment
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  
  try {
    // Wait, the SDK doesn't natively expose listModels in all versions. 
    // It's usually exposed in the REST API. Let's just use fetch to hit the REST API directly to be safe.
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.models) {
      console.log("AVAILABLE MODELS:");
      data.models.forEach(m => {
        if (m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent")) {
          console.log(`- ${m.name}`);
        }
      });
    } else {
      console.log("Error fetching models:", data);
    }
  } catch(e) {
    console.error(e);
  }
}

run();
