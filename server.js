require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const ExcelJS = require('exceljs');
const admin = require('firebase-admin');

const app = express();

// Middlewares
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
    // Trata quebras de linha enviadas como string na Vercel
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

// Middleware de Autenticação
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

// Rota Principal de Raspagem de Leads
app.post('/api/scrape', authenticateToken, async (req, res) => {
  try {
    // Suporte flexível para diferentes nomes de parâmetros do frontend
    const query = req.body.query || req.body.searchTerm || req.body.term || req.body.segmento;
    const limit = req.body.limit || 10;
    const filters = req.body.filters || {};

    if (!query) {
      return res.status(400).json({ error: 'O termo de busca é obrigatório.' });
    }

    const leads = [
      {
        nome: "Empresa Exemplo Cambuí",
        telefone: "(19) 99999-8888",
        email: "contato@exemplo.com.br",
        endereco: "Rua Cambuí, Campinas - SP",
        redes_sociais: "@exemplo_cambui"
      }
    ];

    return res.status(200).json({
      success: true,
      query,
      count: leads.length,
      leads
    });
  } catch (error) {
    console.error('Erro no processamento da busca:', error);
    return res.status(500).json({ error: 'Falha interna ao processar raspagem de leads.' });
  }
});

// Rota de Teste/Health Check
app.get('/', (req, res) => {
  res.send('API SaaS Lead Scraper ativa e operando.');
});

// Escuta em ambiente local
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Servidor rodando localmente na porta ${PORT}`);
  });
}

module.exports = app;