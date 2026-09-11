import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Inicialização segura do Firebase Admin
if (!getApps().length) {
  initializeApp({ projectId: 'saas-lead-scraper' });
}

const db = getFirestore();

// Função para buscar dados da empresa na BrasilAPI via CNPJ
async function fetchBrasilAPI(cnpjNumerico) {
  try {
    const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpjNumerico}`);
    if (!res.ok) return null;
    const data = await res.json();
    
    const socios = data.qsa && data.qsa.length > 0 
      ? data.qsa.map(s => `${s.nome_socio} (${s.qualificacao_socio || 'Sócio'})`).join(', ')
      : 'Não identificado';

    return {
      razao_social: data.razao_social || 'N/A',
      cnpj: data.cnpj || cnpjNumerico,
      socios: socios
    };
  } catch (err) {
    return null;
  }
}

// Função para pesquisar o CNPJ da empresa no Google via Serper
async function findCnpjBySerper(companyName, location, serperKey) {
  try {
    const query = `CNPJ "${companyName}" ${location || ''}`;
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': serperKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: query, num: 3 })
    });
    
    const data = await res.json();
    const textToSearch = JSON.stringify(data);
    
    // Procura padrão de CNPJ mascarado (XX.XXX.XXX/XXXX-XX)
    const cnpjMatch = textToSearch.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
    return cnpjMatch ? cnpjMatch[0] : null;
  } catch (err) {
    return null;
  }
}

export default async function handler(req, res) {
  // Configuração Total de CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido.' });
  }

  try {
    const { term, limit = 10, enrichEmails = true, enrichCnpj = true } = req.body;

    if (!term) {
      return res.status(400).json({ success: false, error: 'O termo de busca é obrigatório.' });
    }

    // Tenta ler as chaves das variáveis de ambiente da Vercel primeiro
    let serperKey = process.env.SERPER_API_KEY || '';
    let hunterKey = process.env.HUNTER_API_KEY || '';

    // Fallback de leitura no Firestore caso não estejam em env
    if (!serperKey) {
      try {
        const docSnap = await db.collection('configuracoes').doc('scrapconfig').get();
        if (docSnap.exists) {
          const data = docSnap.data();
          serperKey = data.serper || '';
          if (!hunterKey) hunterKey = data.hunter || '';
        }
      } catch (e) {
        console.warn('Erro ao consultar Firestore:', e.message);
      }
    }

    if (!serperKey) {
      return res.status(500).json({ success: false, error: 'Chave Serper API não configurada.' });
    }

    // 1. Busca Principal no Google Places
    const serperResponse = await fetch('https://google.serper.dev/places', {
      method: 'POST',
      headers: {
        'X-API-KEY': serperKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: term, num: parseInt(limit) })
    });

    const serperData = await serperResponse.json();
    const places = serperData.places || [];

    // 2. Processamento e Enriquecimento Paralelo
    const leads = await Promise.all(places.map(async (place) => {
      // Ajuste de DDI único para o WhatsApp
      const rawPhone = place.phoneNumber ? place.phoneNumber.replace(/\D/g, '') : '';
      const formattedPhone = rawPhone ? (rawPhone.startsWith('55') ? rawPhone : `55${rawPhone}`) : '';
      const whatsappLink = formattedPhone ? `https://wa.me/${formattedPhone}` : null;

      const website = place.website || null;
      let emailFound = 'N/A';
      let cnpjFormatted = 'N/A';
      let razaoSocial = 'N/A';
      let sociosDecisores = 'Não identificado';

      // Enriquecimento 1: Hunter.io para E-mails
      if (enrichEmails && website && hunterKey) {
        try {
          const domain = new URL(website).hostname.replace('www.', '');
          const hunterRes = await fetch(`https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${hunterKey}&limit=1`);
          const hunterData = await hunterRes.json();
          if (hunterData.data?.emails?.length > 0) {
            emailFound = hunterData.data.emails[0].value;
          }
        } catch (err) {
          // Ignora silenciosamente se o domínio não responder
        }
      }

      // Enriquecimento 2: Busca de CNPJ + BrasilAPI para Razão Social e Sócios
      if (enrichCnpj) {
        const foundCnpj = await findCnpjBySerper(place.title, term, serperKey);
        if (foundCnpj) {
          cnpjFormatted = foundCnpj;
          const cnpjOnlyNumbers = foundCnpj.replace(/\D/g, '');
          const brasilData = await fetchBrasilAPI(cnpjOnlyNumbers);
          
          if (brasilData) {
            razaoSocial = brasilData.razao_social;
            sociosDecisores = brasilData.socios;
          }
        }
      }

      // Estrutura completa de 18 colunas alinhada com a planilha
      return {
        prompt: term,
        nome_empresa: place.title || 'N/A',
        razao_social: razaoSocial,
        cnpj: cnpjFormatted,
        socios_decisores: sociosDecisores,
        categoria: place.category || 'N/A',
        endereco: place.address || 'N/A',
        telefone: place.phoneNumber || 'N/A',
        whatsapp: whatsappLink || 'N/A',
        email: emailFound,
        redes_sociais: website || 'N/A',
        nota_google: place.rating ? String(place.rating) : 'N/A',
        total_avaliacoes: place.ratingCount || 0,
        status: 'A Fazer',
        progressao: '1º Contato',
        tem_website: website ? 'Sim' : 'Não',
        link_gmaps: place.cid ? `https://maps.google.com/?cid=${place.cid}` : (place.link || 'N/A'),
        observacoes: website ? 'OK' : 'Sem site oficial'
      };
    }));

    return res.status(200).json({ success: true, data: leads });

  } catch (error) {
    console.error('Erro na extração de leads:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}