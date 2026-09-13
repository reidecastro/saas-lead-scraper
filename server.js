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

// Limpeza e formatação de telefone
function cleanAndFormatPhone(phoneStr) {
  if (!phoneStr) return { phone: '', whatsapp: '' };
  const digits = String(phoneStr).replace(/\D/g, '');
  let cleanDigits = digits;
  if (cleanDigits.length > 11 && cleanDigits.startsWith('55')) {
    cleanDigits = cleanDigits.substring(2);
  }
  const whatsapp = (cleanDigits.length === 10 || cleanDigits.length === 11) ? `https://wa.me/55${cleanDigits}` : '';
  return { phone: String(phoneStr), whatsapp };
}

// Busca fallback na Serper Organic para pegar telefone, e-mail e rede social
async function fallbackSearch(companyName, address, serperApiKey) {
  let phone = '', email = '', social = '';
  try {
    const query = `${companyName} ${address} telefone contato email`;
    const res = await axios.post(
      'https://google.serper.dev/search',
      { q: query, gl: 'br', hl: 'pt-br', num: 3 },
      { headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' }, timeout: 4000 }
    );

    const organic = res.data.organic || [];
    let textBlock = '';

    organic.forEach(item => {
      const title = item.title || '';
      const snippet = item.snippet || '';
      const link = item.link || '';

      textBlock += ` ${title} ${snippet}`;

      if ((link.includes('instagram.com') || link.includes('facebook.com')) && !social) {
        social = link;
      }
    });

    // Procura padrão de telefone
    const phoneMatches = textBlock.match(/(?:\(?\d{2}\)?\s*)?(?:9?\d{4}[-\s]?\d{4})/g);
    if (phoneMatches) {
      for (const match of phoneMatches) {
        const cleanM = match.replace(/\D/g, '');
        if (cleanM.length === 10 || cleanM.length === 11) {
          phone = match;
          break;
        }
      }
    }

    // Procura padrão de e-mail
    const emailMatches = textBlock.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    if (emailMatches) {
      const validEmails = emailMatches.filter(e => !e.match(/\.(png|jpg|jpeg|webp|js|css|svg)$/i));
      if (validEmails.length > 0) {
        email = validEmails[0];
      }
    }
  } catch (e) {
    // Ignora erros no fallback
  }

  return { phone, email, social };
}

// Extração de CNPJ e Sócios via BrasilAPI
async function fetchCnpjAndPartners(companyName, address, serperApiKey) {
  let cnpj = '', razaoSocial = '', socios = '';
  try {
    const locationHint = address ? address.split('-')[0].trim() : '';
    const query = `${companyName} ${locationHint} cnpj brasilapi`;
    
    const res = await axios.post(
      'https://google.serper.dev/search', 
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
        } catch (e) {}
      }
    }
  } catch (err) {}
  return { cnpj, razaoSocial, socios: socios || 'Não identificado' };
}

// Rota Principal de Raspagem
app.post('/api/scrape', authenticateToken, async (req, res) => {
  try {
    const query = req.body.query || req.body.searchTerm || req.body.term || req.body.segmento;
    const limit = parseInt(req.body.limit || req.body.qtd_resultados || 10);
    const serperApiKey = process.env.SERPER_API_KEY || 'b7aa37b6091475c73a9bd6fdede31e0ab0c77df3';

    if (!query) {
      return res.status(400).json({ error: 'O termo de busca é obrigatório.' });
    }

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
      let phoneRaw = item.phoneNumber || item.phone || '';
      const category = item.category || 'Comércio Local / Empresa';
      const rating = item.rating || '';
      const ratingCount = item.ratingCount || '';
      const websiteUrl = item.website || '';
      const lat = item.latitude;
      const lng = item.longitude;

      let email = '';
      let social = '';

      // Executa busca fallback para recuperar telefone, email e redes faltantes
      const fallbackData = await fallbackSearch(companyName, address, serperApiKey);
      if (!phoneRaw && fallbackData.phone) phoneRaw = fallbackData.phone;
      if (fallbackData.email) email = fallbackData.email;
      if (fallbackData.social) social = fallbackData.social;

      const { phone, whatsapp } = cleanAndFormatPhone(phoneRaw);
      const { cnpj, razaoSocial, socios } = await fetchCnpjAndPartners(companyName, address, serperApiKey);

      const gmapsLink = (lat && lng) 
        ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
        : `https://www.google.com/maps/search/${encodeURIComponent(companyName + ' ' + address)}`;

      // Objeto com TODAS as combinações de chaves possíveis para garantir que o frontend leia sem "N/A"
      const leadObj = {
        // Chaves da interface web (HTML/JS)
        id: String(i + 1),
        empresa: companyName,
        nome: companyName,
        name: companyName,
        telefone: phone || 'N/A',
        phone: phone || 'N/A',
        whatsapp: whatsapp,
        email: email || 'N/A',
        mail: email || 'N/A',
        website: websiteUrl,
        site: websiteUrl,
        rede_social: social || (websiteUrl ? websiteUrl : 'N/A'),
        redes_sociais: social || (websiteUrl ? websiteUrl : 'N/A'),
        social: social || (websiteUrl ? websiteUrl : 'N/A'),
        instagram: social,
        endereco: address,
        address: address,
        rating: rating,
        reviews: ratingCount,

        // Chaves idênticas à planilha Excel do app.py
        "Prompt": query,
        "Nome da Empresa": companyName,
        "Razão Social": razaoSocial,
        "CNPJ": cnpj,
        "Sócios / Decisores": socios,
        "Categoria": category,
        "Endereço": address,
        "Telefone": phone,
        "Whatsapp": whatsapp,
        "Email": email,
        "Redes Sociais": social,
        "Nota Google": rating,
        "Total Avaliações": ratingCount,
        "Status": "A Fazer",
        "Progressão": "1º Contato",
        "Tem Website": websiteUrl ? "Sim" : "Não",
        "Link Google Maps": gmapsLink,
        "Observações": websiteUrl ? `Site: ${websiteUrl}` : "Sem site oficial"
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
    return res.status(500).json({ error: 'Falha ao buscar leads na API Serper.' });
  }
});

// Rota Health Check
app.get('/', (req, res) => {
  res.send('API SaaS Lead Scraper ativa e operando.');
});

// Porta Local / Serverless
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Servidor rodando localmente na porta ${PORT}`);
  });
}

module.exports = app;