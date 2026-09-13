require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const ExcelJS = require('exceljs');

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

// ==============================================================================
// 1. INICIALIZAÇÃO DO FIREBASE ADMIN SDK
// ==============================================================================
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

// ==============================================================================
// 2. FUNÇÕES AUXILIARES DE ENRIQUECIMENTO DE DADOS
// ==============================================================================

// Limpeza e formatação de telefone e link de WhatsApp
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

// Busca fallback na Serper Organic para recuperar telefone, e-mail e redes faltantes
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

    const emailMatches = textBlock.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    if (emailMatches) {
      const validEmails = emailMatches.filter(e => !e.match(/\.(png|jpg|jpeg|webp|js|css|svg)$/i));
      if (validEmails.length > 0) {
        email = validEmails[0];
      }
    }
  } catch (e) {
    // Ignora erros silenciosos no fallback
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

// ==============================================================================
// 3. ROTAS DA API
// ==============================================================================

// Rota Principal de Raspagem integrando Serper.dev
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

      const fallbackData = await fallbackSearch(companyName, address, serperApiKey);
      if (!phoneRaw && fallbackData.phone) phoneRaw = fallbackData.phone;
      if (fallbackData.email) email = fallbackData.email;
      if (fallbackData.social) social = fallbackData.social;

      const { phone, whatsapp } = cleanAndFormatPhone(phoneRaw);
      const { cnpj, razaoSocial, socios } = await fetchCnpjAndPartners(companyName, address, serperApiKey);

      const gmapsLink = (lat && lng) 
        ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
        : `https://www.google.com/maps/search/${encodeURIComponent(companyName + ' ' + address)}`;

      const leadObj = {
        // Compatibilidade com a tabela HTML/JS do frontend
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

        // Compatibilidade exata com as colunas da planilha Python (openpyxl)
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

// Rota Nativa para Exportar Excel (.xlsx) Estilizado
app.post('/api/export-excel', async (req, res) => {
  try {
    const leads = req.body.leads || [];

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'Nenhum lead fornecido para exportação.' });
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Leads B2B', {
      views: [{ showGridLines: true }]
    });

    const columns = [
      { header: 'Prompt', key: 'Prompt', width: 30 },
      { header: 'Nome da Empresa', key: 'Nome da Empresa', width: 30 },
      { header: 'Razão Social', key: 'Razão Social', width: 30 },
      { header: 'CNPJ', key: 'CNPJ', width: 20 },
      { header: 'Sócios / Decisores', key: 'Sócios / Decisores', width: 35 },
      { header: 'Categoria', key: 'Categoria', width: 25 },
      { header: 'Endereço', key: 'Endereço', width: 40 },
      { header: 'Telefone', key: 'Telefone', width: 18 },
      { header: 'Whatsapp', key: 'Whatsapp', width: 18 },
      { header: 'Email', key: 'Email', width: 30 },
      { header: 'Redes Sociais', key: 'Redes Sociais', width: 30 },
      { header: 'Nota Google', key: 'Nota Google', width: 15 },
      { header: 'Total Avaliações', key: 'Total Avaliações', width: 15 },
      { header: 'Status', key: 'Status', width: 15 },
      { header: 'Progressão', key: 'Progressão', width: 18 },
      { header: 'Tem Website', key: 'Tem Website', width: 15 },
      { header: 'Link Google Maps', key: 'Link Google Maps', width: 25 },
      { header: 'Observações', key: 'Observações', width: 30 }
    ];

    worksheet.columns = columns;

    // Estilização do Cabeçalho Azul escuro
    const headerRow = worksheet.getRow(1);
    headerRow.height = 26;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: '1F4E79' }
      };
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Adição de Linhas de Dados com Alternância de Cores (Zebra)
    leads.forEach((lead, index) => {
      const isZebra = index % 2 === 1;

      const rowValues = {
        'Prompt': lead['Prompt'] || lead.query || '',
        'Nome da Empresa': lead['Nome da Empresa'] || lead.empresa || lead.nome || '',
        'Razão Social': lead['Razão Social'] || lead.razaoSocial || '',
        'CNPJ': lead['CNPJ'] || lead.cnpj || '',
        'Sócios / Decisores': lead['Sócios / Decisores'] || lead.socios || 'Não identificado',
        'Categoria': lead['Categoria'] || lead.categoria || '',
        'Endereço': lead['Endereço'] || lead.endereco || '',
        'Telefone': lead['Telefone'] || lead.telefone || '',
        'Whatsapp': lead['Whatsapp'] || lead.whatsapp || '',
        'Email': lead['Email'] || lead.email || '',
        'Redes Sociais': lead['Redes Sociais'] || lead.rede_social || '',
        'Nota Google': lead['Nota Google'] || lead.rating || '',
        'Total Avaliações': lead['Total Avaliações'] || lead.reviews || '',
        'Status': lead['Status'] || 'A Fazer',
        'Progressão': lead['Progressão'] || '1º Contato',
        'Tem Website': lead['Tem Website'] || (lead.website ? 'Sim' : 'Não'),
        'Link Google Maps': lead['Link Google Maps'] || lead.gmaps_link || '',
        'Observações': lead['Observações'] || (lead.website ? `Site: ${lead.website}` : 'Sem site oficial')
      };

      const row = worksheet.addRow(rowValues);
      row.height = 20;

      row.eachCell((cell, colNumber) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: isZebra ? 'F2F5F9' : 'FFFFFF' }
        };
        cell.font = { name: 'Calibri', size: 10, color: { argb: '000000' } };
        cell.border = {
          top: { style: 'thin', color: { argb: 'D9D9D9' } },
          left: { style: 'thin', color: { argb: 'D9D9D9' } },
          bottom: { style: 'thin', color: { argb: 'D9D9D9' } },
          right: { style: 'thin', color: { argb: 'D9D9D9' } }
        };

        const colKey = columns[colNumber - 1].key;
        const valStr = String(cell.value || '');

        if ((colKey === 'Whatsapp' || colKey === 'Link Google Maps' || colKey === 'Redes Sociais') && valStr.startsWith('http')) {
          let label = 'Acessar Link';
          if (colKey === 'Whatsapp') label = 'Abrir WhatsApp';
          if (colKey === 'Link Google Maps') label = 'Ver no Google Maps';
          if (colKey === 'Redes Sociais') label = 'Acessar Perfil';

          cell.value = { text: label, hyperlink: valStr };
          cell.font = { name: 'Calibri', size: 10, color: { argb: '0563C1' }, underline: true };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else if (['Nota Google', 'Total Avaliações', 'Status', 'Progressão', 'Tem Website', 'CNPJ'].includes(colKey)) {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else {
          cell.alignment = { horizontal: 'left', vertical: 'middle' };
        }
      });
    });

    worksheet.views = [{ state: 'frozen', ySplit: 1 }];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_extraidos.xlsx"');

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Erro ao gerar Excel:', error.message);
    return res.status(500).json({ error: 'Erro interno ao gerar a planilha Excel.' });
  }
});

// Rota Health Check
app.get('/', (req, res) => {
  res.send('API SaaS Lead Scraper ativa e operando.');
});

// ==============================================================================
// 4. INICIALIZAÇÃO DO SERVIDOR
// ==============================================================================
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Servidor rodando localmente na porta ${PORT}`);
  });
}

module.exports = app;