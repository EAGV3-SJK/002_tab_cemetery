const https = require('https');

const API_KEY = process.argv[2];
if (!API_KEY) {
  console.error("Usage: node test-models.js YOUR_API_KEY");
  process.exit(1);
}

const MODELS = [
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-1.5-flash"
];

async function testModel(modelName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${API_KEY}`;
  
  const payload = JSON.stringify({
    contents: [{ parts: [{ text: "Respond with exactly the word 'OK' if you can hear me." }] }],
    generationConfig: { maxOutputTokens: 5, temperature: 0.1 }
  });

  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`✅ ${modelName}: SUCCESS`);
          resolve(true);
        } else {
          try {
            const err = JSON.parse(data);
            console.log(`❌ ${modelName}: FAILED (${res.statusCode}) - ${err.error?.message || 'Unknown error'}`);
          } catch (e) {
            console.log(`❌ ${modelName}: FAILED (${res.statusCode})`);
          }
          resolve(false);
        }
      });
    });

    req.on('error', (e) => {
      console.log(`❌ ${modelName}: NETWORK ERROR - ${e.message}`);
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

(async () => {
  console.log("Starting model verification...\n");
  for (const model of MODELS) {
    await testModel(model);
  }
  console.log("\nVerification complete.");
})();
