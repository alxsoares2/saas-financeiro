-- Seed de categorias operacionais para restaurante

-- ─── RECEITA BRUTA ───────────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Vendas - Dinheiro',          'receita_bruta', 'receita'),
  ('Vendas - Pix',               'receita_bruta', 'receita'),
  ('Vendas - Cartão de Débito',  'receita_bruta', 'receita'),
  ('Vendas - Cartão de Crédito', 'receita_bruta', 'receita'),
  ('Vendas - iFood',             'receita_bruta', 'receita'),
  ('Vendas - Vale Refeição',     'receita_bruta', 'receita'),
  ('Serviços - Eventos',         'receita_bruta', 'receita'),
  ('Outras Receitas',            'receita_bruta', 'receita')
ON CONFLICT DO NOTHING;

-- ─── DEDUÇÕES DA RECEITA ─────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Serviço 10%',  'deducoes_receita', 'despesa'),
  ('Cortesias',    'deducoes_receita', 'despesa'),
  ('Permuta',      'deducoes_receita', 'despesa'),
  ('Cancelamentos','deducoes_receita', 'despesa')
ON CONFLICT DO NOTHING;

-- ─── CMV — MATÉRIA-PRIMA / INGREDIENTES ──────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Bovinos',                    'cmv', 'despesa'),
  ('Suínos',                     'cmv', 'despesa'),
  ('Ovinos',                     'cmv', 'despesa'),
  ('Aves',                       'cmv', 'despesa'),
  ('Frutos do Mar',              'cmv', 'despesa'),
  ('FLV (Frutas, Legumes e Verduras)', 'cmv', 'despesa'),
  ('Laticínios e Frios',         'cmv', 'despesa'),
  ('Congelados',                 'cmv', 'despesa'),
  ('Grãos / Cereais / Farinhas', 'cmv', 'despesa'),
  ('Óleos / Azeites / Gorduras', 'cmv', 'despesa'),
  ('Café e Infusões',            'cmv', 'despesa'),
  ('Conservas',                  'cmv', 'despesa'),
  ('Condimentos / Temperos / Molhos', 'cmv', 'despesa'),
  ('Padaria / Confeitaria',      'cmv', 'despesa'),
  ('Outros Ingredientes',        'cmv', 'despesa')
ON CONFLICT DO NOTHING;

-- ─── MATERIAIS DE VENDA DIRETA (bebidas revendidas) ──────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Cervejas',               'materiais_venda_direta', 'despesa'),
  ('Destilados',             'materiais_venda_direta', 'despesa'),
  ('Vinhos',                 'materiais_venda_direta', 'despesa'),
  ('Bebidas Não Alcoólicas', 'materiais_venda_direta', 'despesa'),
  ('Água Mineral',           'materiais_venda_direta', 'despesa'),
  ('Energéticos / Sucos',    'materiais_venda_direta', 'despesa')
ON CONFLICT DO NOTHING;

-- ─── MATERIAIS DE APOIO ───────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Material de Limpeza e Higiene', 'materiais_apoio', 'despesa'),
  ('Embalagens e Descartáveis',     'materiais_apoio', 'despesa'),
  ('Uniformes / EPIs',              'materiais_apoio', 'despesa'),
  ('Gelo',                          'materiais_apoio', 'despesa')
ON CONFLICT DO NOTHING;

-- ─── CMO EVENTUAL (mão de obra variável) ─────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Mão de Obra Eventual / Freelancer', 'cmo_eventual', 'despesa'),
  ('Serviços de Terceiros - Produção',  'cmo_eventual', 'despesa')
ON CONFLICT DO NOTHING;

-- ─── TARIFAS DE CARTÃO E DELIVERY ────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Tarifa Cartão de Crédito', 'tarifas_cartao', 'despesa'),
  ('Tarifa Cartão de Débito',  'tarifas_cartao', 'despesa'),
  ('Tarifa iFood',             'tarifas_cartao', 'despesa'),
  ('Tarifa Pix',               'tarifas_cartao', 'despesa'),
  ('Tarifa Vale Refeição',     'tarifas_cartao', 'despesa')
ON CONFLICT DO NOTHING;

-- ─── IMPOSTOS VARIÁVEIS (sobre a receita) ────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('PIS',                    'impostos_variaveis', 'despesa'),
  ('COFINS',                 'impostos_variaveis', 'despesa'),
  ('ICMS',                   'impostos_variaveis', 'despesa'),
  ('ISS',                    'impostos_variaveis', 'despesa'),
  ('Simples Nacional (DAS)', 'impostos_variaveis', 'despesa'),
  ('FEEF / Outros impostos', 'impostos_variaveis', 'despesa')
ON CONFLICT DO NOTHING;

-- ─── OCUPAÇÃO (despesas fixas de espaço) ─────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Aluguel do Estabelecimento',    'ocupacao', 'despesa'),
  ('Condomínio',                    'ocupacao', 'despesa'),
  ('IPTU',                          'ocupacao', 'despesa'),
  ('TCR / Taxa de Coleta',          'ocupacao', 'despesa'),
  ('Outros Impostos de Ocupação',   'ocupacao', 'despesa')
ON CONFLICT DO NOTHING;

-- ─── UTILIDADES PÚBLICAS ──────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Conta de Luz',          'utilidades', 'despesa'),
  ('Conta de Água e Esgoto','utilidades', 'despesa'),
  ('Conta de Gás',          'utilidades', 'despesa'),
  ('Telefone / Internet',   'utilidades', 'despesa')
ON CONFLICT DO NOTHING;

-- ─── DESPESAS ADMINISTRATIVAS ────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Material de Escritório / Informática', 'despesas_admin', 'despesa'),
  ('Sistema PDV / ERP / Gestão',           'despesas_admin', 'despesa'),
  ('Contabilidade / Honorários',           'despesas_admin', 'despesa'),
  ('Alvará / Licenças / Taxas',            'despesas_admin', 'despesa'),
  ('Seguro',                               'despesas_admin', 'despesa'),
  ('Aluguel de Equipamentos',              'despesas_admin', 'despesa'),
  ('Manutenção de Equipamentos',           'despesas_admin', 'despesa'),
  ('Despesas com Veículos',                'despesas_admin', 'despesa'),
  ('Outras Despesas Administrativas',      'despesas_admin', 'despesa')
ON CONFLICT DO NOTHING;

-- ─── MARKETING ───────────────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Marketing Digital / Redes Sociais', 'marketing', 'despesa'),
  ('Patrocínios / Parcerias',           'marketing', 'despesa'),
  ('Material Gráfico / Impressos',      'marketing', 'despesa'),
  ('Eventos Promocionais',              'marketing', 'despesa')
ON CONFLICT DO NOTHING;

-- ─── PESSOAL FIXO ────────────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Salários CLT',                     'pessoal_fixo', 'despesa'),
  ('Pró-Labore',                       'pessoal_fixo', 'despesa'),
  ('Encargos Trabalhistas (FGTS/INSS)','pessoal_fixo', 'despesa'),
  ('Vale Transporte',                  'pessoal_fixo', 'despesa'),
  ('Vale Refeição / Alimentação',      'pessoal_fixo', 'despesa'),
  ('Plano de Saúde',                   'pessoal_fixo', 'despesa'),
  ('13º Salário / Férias (provisionado)', 'pessoal_fixo', 'despesa')
ON CONFLICT DO NOTHING;
