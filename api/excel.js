import ExcelJS from 'exceljs';

export default async function handler(req, res) {
  // Configuração explícita de CORS
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
    const { leads = [] } = req.body;

    if (!leads || leads.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhum lead fornecido para exportação.' });
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Leads Extraídos');

    // Mapeamento das 18 colunas
    worksheet.columns = [
      { header: 'Prompt', key: 'prompt', width: 25 },
      { header: 'Nome da Empresa', key: 'nome_empresa', width: 30 },
      { header: 'Razão Social', key: 'razao_social', width: 30 },
      { header: 'CNPJ', key: 'cnpj', width: 20 },
      { header: 'Sócios / Decisores', key: 'socios_decisores', width: 35 },
      { header: 'Categoria', key: 'categoria', width: 20 },
      { header: 'Endereço', key: 'endereco', width: 35 },
      { header: 'Telefone', key: 'telefone', width: 18 },
      { header: 'Whatsapp', key: 'whatsapp', width: 25 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Redes Sociais', key: 'redes_sociais', width: 30 },
      { header: 'Nota Google', key: 'nota_google', width: 12 },
      { header: 'Total Avaliações', key: 'total_avaliacoes', width: 15 },
      { header: 'Status', key: 'status', width: 18 },
      { header: 'Progressão', key: 'progressao', width: 22 },
      { header: 'Tem Website', key: 'tem_website', width: 12 },
      { header: 'Link Google Maps', key: 'link_gmaps', width: 35 },
      { header: 'Observações', key: 'observacoes', width: 25 }
    ];

    // Estilização do Cabeçalho
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: '1E293B' }
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // Adiciona as linhas
    leads.forEach((lead) => {
      const row = worksheet.addRow({
        prompt: lead.prompt || 'N/A',
        nome_empresa: lead.nome_empresa || 'N/A',
        razao_social: lead.razao_social || 'N/A',
        cnpj: lead.cnpj || 'N/A',
        socios_decisores: lead.socios_decisores || 'Não identificado',
        categoria: lead.categoria || 'N/A',
        endereco: lead.endereco || 'N/A',
        telefone: lead.telefone || 'N/A',
        whatsapp: lead.whatsapp || 'N/A',
        email: lead.email || 'N/A',
        redes_sociais: lead.redes_sociais || 'N/A',
        nota_google: lead.nota_google || 'N/A',
        total_avaliacoes: lead.total_avaliacoes || 0,
        status: 'A Fazer', // Valor padrão inicial
        progressao: '1º Contato', // Valor padrão inicial
        tem_website: lead.tem_website || 'Não',
        link_gmaps: lead.link_gmaps || 'N/A',
        observacoes: lead.observacoes || 'N/A'
      });

      // Aplica Dropdown na Coluna Status (Coluna N / index 14)
      const cellStatus = row.getCell('status');
      cellStatus.dataValidation = {
        type: 'list',
        allowBlank: false,
        formulae: ['"A Fazer,Em Andamento,Concluído,Cancelado"'],
        showErrorMessage: true,
        errorTitle: 'Status Inválido',
        error: 'Por favor, selecione uma das opções da lista.'
      };

      // Aplica Dropdown na Coluna Progressão (Coluna O / index 15)
      const cellProgressao = row.getCell('progressao');
      cellProgressao.dataValidation = {
        type: 'list',
        allowBlank: false,
        formulae: ['"1º Contato,Em Negociação,Proposta Enviada,Fechado,Perdido"'],
        showErrorMessage: true,
        errorTitle: 'Progressão Inválida',
        error: 'Por favor, selecione uma das opções da lista.'
      };
    });

    // Configuração dos headers de download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=leads_extraidos.xlsx');

    const buffer = await workbook.xlsx.writeBuffer();
    return res.status(200).send(buffer);

  } catch (error) {
    console.error('Erro ao gerar Excel:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}