require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const ExcelJS = require('exceljs');
const admin = require('firebase-admin');

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

// ==========================================
// INICIALIZAÇÃO DO FIREBASE ADMIN SDK
// ==========================================
if (!admin.apps.length) {
  // Inicializa utilizando as credenciais padrão do ambiente Google Cloud Shell/Functions
  admin.initializeApp();
}

const db = admin.firestore();

// Chave Padrão Serper API (usada como fallback caso não configurada no Firestore)
const DEFAULT_SERPER_API_KEY = "b7aa37b6091475c73a9bd6fdede31e0ab0c77df3";

// ==========================================
// MIDDLEWARE DE AUTENTICAÇÃO (JWT Firebase)
// ==========================================
async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Token de autenticação não fornecido.' });
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Erro na verificação do token:', error.message);
    return res.status(403).json({ success: false, error: 'Token de autenticação inválido ou expirado.' });
  }
}

// ==========================================
// FUNÇÕES UTILITÁRIAS & SCRAPING
// ==========================================

function cleanAndFormatPhone(phoneStr) {
  if (!phoneStr) return { formatted: "", whatsapp: "" };
  let digits = phoneStr.toString().replace(/\D/g, '');
  if (digits.length > 11 && digits.startsWith("55")) digits = digits.substring(2);
  if (digits.length < 8) return { formatted: phoneStr.toString(), whatsapp: "" };
  
  let whatsapp = "";
  if (digits.length === 10 || digits.length === 11) {
    whatsapp = `https://wa.me/55${digits}`;
  }
  return { formatted: phoneStr.toString(), whatsapp };
}

async function scrapeWebsiteDetails(websiteUrl) {
  let email = "";
  let social = "";
  if (!websiteUrl || !websiteUrl.toString().startsWith("http")) return { email, social };

  try {
    const response = await axios.get(websiteUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 5000
    });
    
    if (response.status === 200) {
      const html = response.data;
      const $ = cheerio.load(html);
      
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const emails = html.match(emailRegex);
      if (emails) {
        const validEmails = emails.filter(e => !/\.(png|jpg|webp|js|css|svg)$/i.test(e));
        if (validEmails.length > 0) email = validEmails[0];
      }
      
      $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        if (href && (href.includes('instagram.com') || href.includes('facebook.com')) && !social) {
          social = href;
        }
      });
    }
  } catch (error) {
    // Silencia falhas de scraping no site de destino
  }
  return { email, social };
}

async function fallbackSearchPhoneEmail(companyName, address, apiKey) {
  let phone = "";
  let email = "";
  let social = "";
  
  const query = `${companyName} ${address} telefone contato email`;
  const url = "https://google.serper.dev/search";
  const payload = { q: query, gl: "br", hl: "pt-br", num: 3 };
  const headers = { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' };
  
  try {
    const res = await axios.post(url, payload, { headers, timeout: 8000 });
    if (res.status === 200 && res.data.organic) {
      let textBlock = "";
      res.data.organic.forEach(item => {
        textBlock += " " + (item.title || "") + " " + (item.snippet || "");
        const link = item.link || "";
        if ((link.includes("instagram.com") || link.includes("facebook.com")) && !social) {
          social = link;
        }
      });

      const phoneRegex = /(\(?\d{2}\)?\s*)?(?:9?\d{4}[-\s]?\d{4})/g;
      const phoneMatches = textBlock.match(phoneRegex);
      if (phoneMatches) {
        for (const match of phoneMatches) {
          const cleanM = match.replace(/\D/g, '');
          if (cleanM.length === 10 || cleanM.length === 11) {
            phone = match;
            break;
          }
        }
      }

      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const emailMatches = textBlock.match(emailRegex);
      if (emailMatches) {
        const validE = emailMatches.filter(e => !/\.(png|jpg|webp|js|css)$/i.test(e));
        if (validE.length > 0) email = validE[0];
      }
    }
  } catch (error) {
    // Silencia erros de fallback
  }

  return { phone, email, social };
}

// ==========================================
// ROTAS DE ADMINISTRAÇÃO FIRESTORE
// ==========================================

app.get('/api/admin/config', authenticateUser, async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('api_keys').get();
    const apiKey = doc.exists ? (doc.data().google || DEFAULT_SERPER_API_KEY) : DEFAULT_SERPER_API_KEY;

    return res.status(200).json({
      success: true,
      api_key: apiKey
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/config', authenticateUser, async (req, res) => {
  try {
    const { api_key } = req.body;
    if (!api_key) return res.status(400).json({ success: false, error: "Chave API é obrigatória." });

    await db.collection('settings').doc('api_keys').set({
      google: api_key,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.status(200).json({ success: true, message: "Configuração salva no Firestore!" });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// ROTA DE RASPAGEM COM DEDUÇÃO DE CRÉDITOS
// ==========================================

app.post('/api/scrape', authenticateUser, async (req, res) => {
  try {
    const { term, limit = 10 } = req.body;
    const userId = req.user.uid;

    if (!term) return res.status(400).json({ success: false, error: "O termo de busca é obrigatório." });

    // 1. Checar saldo de créditos no Firestore
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) return res.status(404).json({ success: false, error: "Usuário não encontrado." });

    const currentCredits = userDoc.data().credits || 0;
    const requestedLimit = parseInt(limit, 10);

    if (currentCredits < requestedLimit) {
      return res.status(402).json({
        success: false,
        error: `Saldo insuficiente. Você possui ${currentCredits} créditos e tentou buscar ${requestedLimit}.`
      });
    }

    // 2. Buscar Chave API
    const keysDoc = await db.collection('settings').doc('api_keys').get();
    const apiKey = keysDoc.exists ? (keysDoc.data().google || DEFAULT_SERPER_API_KEY) : DEFAULT_SERPER_API_KEY;

    // 3. Executar Chamada Serper API
    console.log(`[+] Buscando "${term}" no Serper API para o usuário: ${userId}`);
    const serpRes = await axios.post('https://google.serper.dev/places', {
      q: term,
      gl: 'br',
      hl: 'pt-br'
    }, {
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      timeout: 25000
    });

    if (!serpRes.data || !serpRes.data.places) {
      return res.status(200).json({ success: true, count: 0, data: [] });
    }

    const placesRaw = serpRes.data.places.slice(0, requestedLimit);
    const leads = [];

    for (let i = 0; i < placesRaw.length; i++) {
      const place = placesRaw[i];
      const companyName = place.title || 'N/A';
      const address = place.address || place.formattedAddress || 'N/A';
      let phoneRaw = place.phoneNumber || place.phone || '';
      const websiteUrl = place.website || '';

      let realEmail = "";
      let realSocial = "";

      if (websiteUrl) {
        const scraped = await scrapeWebsiteDetails(websiteUrl);
        realEmail = scraped.email;
        realSocial = scraped.social;
      }

      if (!phoneRaw || !realEmail) {
        const fallback = await fallbackSearchPhoneEmail(companyName, address, apiKey);
        if (!phoneRaw && fallback.phone) phoneRaw = fallback.phone;
        if (!realEmail && fallback.email) realEmail = fallback.email;
        if (!realSocial && fallback.social) realSocial = fallback.social;
      }

      const phoneFormatted = cleanAndFormatPhone(phoneRaw);

      leads.push({
        prompt: term,
        nome: companyName,
        categoria: place.category || 'N/A',
        responsavel: "",
        endereco: address,
        telefone: phoneFormatted.formatted || 'N/A',
        whatsapp: phoneFormatted.whatsapp || '',
        email: realEmail || 'N/A',
        redes_sociais: realSocial || 'N/A',
        nota_google: place.rating || 'N/A',
        total_avaliacoes: place.ratingCount || 0,
        status: "A Fazer",
        progressao: "1º Contato",
        tem_website: websiteUrl ? "Sim" : "Não",
        link_gmaps: place.cid ? `https://www.google.com/maps?cid=${place.cid}` : `https://www.google.com/maps/search/${encodeURIComponent(companyName + ' ' + address)}`,
        observacoes: websiteUrl ? `Site: ${websiteUrl}` : "Sem site oficial"
      });
    }

    // 4. Debitar créditos e registrar busca no Firestore
    const actualDebited = leads.length;
    if (actualDebited > 0) {
      await db.runTransaction(async (transaction) => {
        const freshUser = await transaction.get(userRef);
        const newBalance = (freshUser.data().credits || 0) - actualDebited;
        transaction.update(userRef, { credits: Math.max(0, newBalance) });
      });

      await userRef.collection('searches').add({
        query: term,
        leadCount: actualDebited,
        creditsUsed: actualDebited,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return res.status(200).json({
      success: true,
      count: leads.length,
      creditsDebited: actualDebited,
      remainingCredits: currentCredits - actualDebited,
      data: leads
    });

  } catch (error) {
    console.error("Erro na rota /api/scrape:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// ROTA PARA GERAR EXCEL
// ==========================================

app.post('/api/download/excel', authenticateUser, async (req, res) => {
  try {
    const { leads, term } = req.body;
    if (!leads || !leads.length) return res.status(400).json({ success: false, error: "Nenhum lead fornecido." });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Leads B2B');

    const columns = [
      { header: 'Prompt', key: 'prompt', width: 25 },
      { header: 'Nome da Empresa', key: 'nome', width: 35 },
      { header: 'Categoria', key: 'categoria', width: 20 },
      { header: 'Responsável', key: 'responsavel', width: 20 },
      { header: 'Endereço', key: 'endereco', width: 40 },
      { header: 'Telefone', key: 'telefone', width: 20 },
      { header: 'Whatsapp', key: 'whatsapp', width: 20 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Redes Sociais', key: 'redes_sociais', width: 30 },
      { header: 'Nota Google', key: 'nota_google', width: 12 },
      { header: 'Total Avaliações', key: 'total_avaliacoes', width: 15 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Progressão', key: 'progressao', width: 20 },
      { header: 'Tem Website', key: 'tem_website', width: 12 },
      { header: 'Link Google Maps', key: 'link_gmaps', width: 20 },
      { header: 'Observações', key: 'observacoes', width: 35 }
    ];

    worksheet.columns = columns;

    const headerRow = worksheet.getRow(1);
    headerRow.height = 26;
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E79' } };
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    const dataFont = { name: 'Calibri', size: 10, color: { argb: '000000' } };
    const linkFont = { name: 'Calibri', size: 10, color: { argb: '0563C1' }, underline: true };
    const zebraFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F2F5F9' } };
    const whiteFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF' } };
    const thinBorder = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

    leads.forEach((lead, index) => {
      const row = worksheet.addRow(lead);
      row.height = 20;
      const fill = index % 2 === 1 ? zebraFill : whiteFill;

      row.eachCell((cell, colNumber) => {
        cell.font = dataFont;
        cell.fill = fill;
        cell.border = thinBorder;
        
        const headerKey = columns[colNumber - 1].key;
        
        if (headerKey === 'link_gmaps' && lead.link_gmaps && lead.link_gmaps.startsWith('http')) {
          cell.value = { text: 'Ver no Google Maps', hyperlink: lead.link_gmaps };
          cell.font = linkFont;
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else if (headerKey === 'whatsapp' && lead.whatsapp && lead.whatsapp.startsWith('http')) {
          cell.value = { text: 'Abrir WhatsApp', hyperlink: lead.whatsapp };
          cell.font = linkFont;
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else if (headerKey === 'redes_sociais' && lead.redes_sociais && lead.redes_sociais.startsWith('http')) {
          cell.value = { text: 'Acessar Perfil', hyperlink: lead.redes_sociais };
          cell.font = linkFont;
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else if (['nota_google', 'total_avaliacoes', 'status', 'progressao', 'tem_website'].includes(headerKey)) {
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else {
          cell.alignment = { horizontal: 'left', vertical: 'middle' };
        }
      });
    });

    const maxRow = leads.length + 1;
    worksheet.dataValidations.add('L2:L' + maxRow, {
      type: 'list',
      allowBlank: true,
      formulae: ['"A Fazer, Em Andamento, Concluído, Cancelado"']
    });

    worksheet.dataValidations.add('M2:M' + maxRow, {
      type: 'list',
      allowBlank: true,
      formulae: ['"1º Contato, Em Negociação, Proposta Enviada, Fechado, Perdido"']
    });

    worksheet.views = [{ state: 'frozen', ySplit: 1 }];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const termLimpo = (term || 'leads').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename=${dateStr}-leads-${termLimpo}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error("Erro ao gerar Excel:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Backend Admin & Scraper rodando na porta ${PORT}`);
});