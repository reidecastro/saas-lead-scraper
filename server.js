require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

// Inicialização do Firebase Admin SDK
try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      : process.env.FIREBASE_SERVICE_ACCOUNT;
  }

  if (serviceAccount && serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }

  if (!admin.apps.length) {
    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    } else {
      admin.initializeApp();
    }
  }
} catch (error) {
  console.error('Erro ao inicializar Firebase Admin:', error.message);
}

// Middleware de Autenticação Token Firebase
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido ou malformado.' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Erro na verificação do token:', error.message);
    return res.status(403).json({ error: 'Token de autenticação inválido ou expirado.' });
  }
};

// Formatação de telefone e link de WhatsApp
function cleanAndFormatPhone(phoneStr) {
  if (!phoneStr) return { phone: '', whatsapp: '' };
  const digits = String(phoneStr).replace(/\D/g, '');
  let cleanDigits = digits;
  if (cleanDigits.length > 11 && cleanDigits.startsWith('55')) {
    cleanDigits = cleanDigits.substring(2);
  }
  const whatsapp = (cleanDigits.length === 10 || cleanDigits.length === 11) ? `https://wa.me/55${cleanDigits}` : '';
  return { phone: phoneStr, whatsapp };
}

// Extração de CNPJ e Sócios via BrasilAPI
async function fetchCnpjAndPartners(companyName, address, serperApiKey) {
  let cnpj = '', razaoSocial = '', socios = '';
  try {
    const locationHint = address ? address.split('-')[0].trim() : '';
    const query = `${companyName} ${locationHint} cnpj brasilapi`;
    
    const res = await axios.post('https://google.serper.dev/search', 
      { q: query, gl: 'br', hl: 'pt-br', num: 3 },
      { headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' }, timeout: 4000 }
    );

    const organic = res.data.organic || [];
    let textBlock = '';
    organic.forEach(item => { textBlock += ` ${item.snippet || ''} ${item.title || ''}`; });

    const cnpjMatches = textBlock.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g);
    if (cnpjMatches && cnpjMatches.length > 0) {
      const cnpjClean = cnpjMatches[0].replace(/\D/g, '');
      if (cnpjClean.length === 14) {
        cnpj = `${cnpjClean.substring(0,2)}.${cnpjClean.substring(2,5)}.${cnpjClean.substring(5,8)}/${cnpjClean.substring(8,12)}-${cnpjClean.substring(12)}`;
        
        try {
          const brasilApiRes = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${cnpjClean}`, { timeout: 4000 });
          if (brasilApiRes.status === 200) {
            razaoSocial = brasilApiRes.data.razao_social || '';
            const qsa = brasilApiRes.data.qsa || [];
            const sociosList = qsa.map(s => s.qualificacao_socio ? `${s.nome_socio} (${s.qualificacao_socio})` : s.nome_socio);
            socios = sociosList.join(', ');
          }
        } catch (e) {
          // Ignora se BrasilAPI falhar
        }
      }
    }
  } catch (err) {
    // Ignora falhas de enriquecimento de CNPJ
  }
  return { cnpj, razaoSocial, socios: socios || 'Não identificado' };
}

// Rota Principal de Raspagem integrando Serper.dev
app.post('/api/scrape', authenticateToken, async (req, res) => {
  try {
    const query = req.body.query || req.body.searchTerm || req.body.term || req.body.segmento;
    const limit = parseInt(req.body.limit || req.body.qtd_resultados || 10);
    const serperApiKey = process.env.SERPER_API_KEY || 'b7aa37b6091475c73a9bd6fdede31e0ab0c77df3';

    if (!query) {
      return res.status(400).json({ error: 'O termo de busca é obrigatório.' });
    }

    // Chamada à API da Serper Places
    const serperResponse = await axios.post(
      'https://google.serper.dev/places',
      { q: query, gl: 'br', hl: 'pt-br' },
      { headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' }, timeout: 12000 }
    );

    const places = serperResponse.data.places || [];
    const leadsList = [];

    for (let i = 0; i < Math.min(places.length, limit); i++) {
      const item = places[i];
      const companyName = item.title || '';
      const address = item.address || item.formattedAddress || item.vicinity || '';
      const phoneRaw = item.phoneNumber || item.phone || '';
      const category = item.category || 'Comércio Local / Empresa';
      const rating = item.rating || '';
      const ratingCount = item.ratingCount || '';
      const websiteUrl = item.website || '';
      const lat = item.latitude;
      const lng = item.longitude;

      const gmapsLink = (lat && lng) 
        ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
        : `https://www.google.com/maps/search/${encodeURIComponent(companyName + ' ' + address)}`;

      const { phone, whatsapp } = cleanAndFormatPhone(phoneRaw);
      const { cnpj, razaoSocial, socios } = await fetchCnpjAndPartners(companyName, address, serperApiKey);

      // Objeto padronizado com TODAS as variações de chaves esperadas (Frontend + Excel)
      const leadObj = {
        // Nomes de colunas idênticos ao app.py
        "Prompt": query,
        "Nome da Empresa": companyName,
        "Razão Social": razaoSocial,
        "CNPJ": cnpj,
        "Sócios / Decisores": socios,
        "Categoria": category,
        "Endereço": address,
        "Telefone": phone,
        "Whatsapp": whatsapp,
        "Email": "",
        "Redes Sociais": "",
        "Nota Google": rating,
        "Total Avaliações": ratingCount,
        "Status": "A Fazer",
        "Progressão": "1º Contato",
        "Tem Website": websiteUrl ? "Sim" : "Não",
        "Link Google Maps": gmapsLink,
        "Observações": websiteUrl ? `Site: ${websiteUrl}` : "Sem site oficial",

        // Compatibilidade de chaves em inglês/minúsculas para a tabela do frontend JS
        id: String(i + 1),
        empresa: companyName,
        nome: companyName,
        name: companyName,
        telefone: phone,
        phone: phone,
        whatsapp: whatsapp,
        email: "",
        website: websiteUrl,
        site: websiteUrl,
        endereco: address,
        address: address,
        rede_social: "",
        redes_sociais: "",
        instagram: "",
        rating: rating,
        reviews: ratingCount,
        gmaps_link: gmapsLink
      };

      leadsList.push(leadObj);
    }

    return res.status(200).json({
      success: true,
      query,
      count: leadsList.length,
      total: leadsList.length,
      leads: leadsList,
      results: leadsList,
      data: leadsList
    });

  } catch (error) {
    console.error('Erro ao realizar scraping via Serper:', error.message);
    return res.status(500).json({ error: 'Falha ao buscar leads na API Serper. Verifique a chave e tente novamente.' });
  }
});

// Rota Health Check
app.get('/', (req, res) => {
  res.send('API SaaS Lead Scraper ativa e operando com Serper.dev.');
});

// Porta Local / Serverless
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Servidor rodando localmente na porta ${PORT}`);
  });
}

module.exports = app;