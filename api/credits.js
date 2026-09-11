const axios = require('axios');

async function getSerperKey() {
  try {
    const projectId = process.env.FIREBASE_PROJECT_ID || 'saas-lead-scraper'; 
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/configuracoes/scrapconfig`;
    const response = await axios.get(url);
    return response.data.fields?.serper?.stringValue || 'b7aa37b6091475c73a9bd6fdede31e0ab0c77df3';
  } catch (e) {
    return 'b7aa37b6091475c73a9bd6fdede31e0ab0c77df3';
  }
}

module.exports = async (req, res) => {
  // Injeção manual irrestrita de CORS no nível da função Serverless
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const serperKey = await getSerperKey();
    const response = await axios.get('https://google.serper.dev/account', {
      headers: { 'X-API-KEY': serperKey }
    });
    return res.status(200).json({ success: true, credits: response.data.credits });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};