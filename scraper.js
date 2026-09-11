// scraper.js - Gerenciador de requisições de raspagem e manipulação do DOM

// Utiliza a rota relativa para passar pelo proxy do Firebase Hosting e evitar CORS
const SCRAPE_API_URL = '/api/scrape';

/**
 * Função responsável por disparar a busca de leads na API Serverless
 * @param {string} term - O termo de busca (ex: "Academias em Campinas")
 * @param {number} limit - Quantidade limite de resultados
 */
async function realizarScraping(term, limit = 10) {
  try {
    const response = await fetch(SCRAPE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ term, limit })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Erro ao processar a raspagem dos leads.');
    }

    return data.data; // Retorna o array de leads
  } catch (error) {
    console.error('Falha no scraping:', error.message);
    throw error;
  }
}

// Vincula a ação de envio do formulário no frontend (se aplicável ao seu formulário)
document.addEventListener('DOMContentLoaded', () => {
  const formSearch = document.getElementById('formSearch');
  if (formSearch) {
    formSearch.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const termInput = document.getElementById('searchTerm');
      const limitInput = document.getElementById('searchLimit');
      const statusText = document.getElementById('statusText');
      
      if (!termInput || !termInput.value.trim()) return;

      if (statusText) statusText.textContent = "Buscando leads no Google Maps...";

      try {
        const leads = await realizarScraping(termInput.value.trim(), limitInput ? parseInt(limitInput.value) : 10);
        
        if (statusText) statusText.textContent = `✅ ${leads.length} leads encontrados com sucesso!`;
        
        // Se houver uma função no seu código para renderizar a tabela, chame-a aqui
        if (typeof renderizarTabelaLeads === 'function') {
          renderizarTabelaLeads(leads);
        }
      } catch (err) {
        if (statusText) statusText.textContent = `❌ Erro: ${err.message}`;
      }
    });
  }
});