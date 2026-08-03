-- Plano de contas REAL do cliente (Basílico/Mano)
-- Mapeia cada categoria para o grupo do DRE.
-- Rodar no SQL Editor. INSERT idempotente (ON CONFLICT DO NOTHING).

-- ── RECEITAS (mantidas — necessárias para lançar faturamento) ────────────────
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

-- ── CMV — Custo da Mercadoria Vendida ───────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Bovinos',                        'cmv', 'despesa'),
  ('Suínos',                         'cmv', 'despesa'),
  ('Ovinos',                         'cmv', 'despesa'),
  ('Aves',                           'cmv', 'despesa'),
  ('Frutos do Mar',                  'cmv', 'despesa'),
  ('Frutas, legumes e verduras FLV', 'cmv', 'despesa'),
  ('Doces industrializados',         'cmv', 'despesa'),
  ('Latícinios',                     'cmv', 'despesa'),
  ('Congelados',                     'cmv', 'despesa'),
  ('Grãos/Cereais/Farinha',          'cmv', 'despesa'),
  ('Óleos/Azeites/Gordura',          'cmv', 'despesa'),
  ('Café',                           'cmv', 'despesa'),
  ('Conservas',                      'cmv', 'despesa'),
  ('Condimentos/Temperos/Molhos',    'cmv', 'despesa'),
  ('Embalagens e Descartáveis',      'cmv', 'despesa'),
  ('Etiquetas',                      'cmv', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Materiais de Venda Direta (bebidas revendidas) ──────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Cervejas',               'materiais_venda_direta', 'despesa'),
  ('Destilados',             'materiais_venda_direta', 'despesa'),
  ('Bebidas Não alcoólicas', 'materiais_venda_direta', 'despesa'),
  ('Vinhos',                 'materiais_venda_direta', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Materiais de Apoio ──────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Material de limpeza e higiene', 'materiais_apoio', 'despesa')
ON CONFLICT DO NOTHING;

-- ── CMO Eventual (mão de obra variável) ─────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Mão de Obra Eventual / Freelancer', 'cmo_eventual', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Tarifas de Cartões / Delivery ───────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Cartão de Crédito', 'tarifas_cartao', 'despesa'),
  ('Cartão de Débito',  'tarifas_cartao', 'despesa'),
  ('Ifood',             'tarifas_cartao', 'despesa'),
  ('Pix',               'tarifas_cartao', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Impostos ────────────────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('PIS',                          'impostos_variaveis', 'despesa'),
  ('COFINS',                       'impostos_variaveis', 'despesa'),
  ('FUNCEP',                       'impostos_variaveis', 'despesa'),
  ('FEEF',                         'impostos_variaveis', 'despesa'),
  ('Simples Nacional Consultoria', 'impostos_variaveis', 'despesa'),
  ('ICMS bebida quente',           'impostos_variaveis', 'despesa'),
  ('ICMS fronteira',               'impostos_variaveis', 'despesa'),
  ('ICMS normal',                  'impostos_variaveis', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Ocupação ────────────────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Aluguel do estabelecimento',      'ocupacao', 'despesa'),
  ('IPTU',                            'ocupacao', 'despesa'),
  ('TCR',                             'ocupacao', 'despesa'),
  ('Outros impostos e taxas',         'ocupacao', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Utilidades Públicas ─────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Conta de Luz',   'utilidades', 'despesa'),
  ('Conta de Água',  'utilidades', 'despesa'),
  ('Telefone',       'utilidades', 'despesa'),
  ('Conta de Gás',   'utilidades', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Despesas Administrativas ────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Material de Escritório / informática',              'despesas_admin', 'despesa'),
  ('Sistema Gerencial',                                 'despesas_admin', 'despesa'),
  ('Internet',                                          'despesas_admin', 'despesa'),
  ('Seguro',                                            'despesas_admin', 'despesa'),
  ('Aluguel de maquinetas',                             'despesas_admin', 'despesa'),
  ('Aluguel de Equipamentos',                           'despesas_admin', 'despesa'),
  ('Despesas de Locomoção',                             'despesas_admin', 'despesa'),
  ('Assinaturas digitais/Apps/Softwares',               'despesas_admin', 'despesa'),
  ('Sindicato',                                         'despesas_admin', 'despesa'),
  ('Despesas com veículos (comb., manut., IPVA, outros)','despesas_admin', 'despesa'),
  ('Outras despesas administrativas',                   'despesas_admin', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Marketing ───────────────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Anúncios',                        'marketing', 'despesa'),
  ('Criação de conteúdo/Influencers', 'marketing', 'despesa'),
  ('Divulgação',                      'marketing', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Manutenção ──────────────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Predial',                        'manutencao', 'despesa'),
  ('Reparos Máquinas e Equipamentos','manutencao', 'despesa'),
  ('Preventiva',                     'manutencao', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Despesas de Aquisição ───────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Equipamentos',                'despesas_aquisicao', 'despesa'),
  ('Utensílios cozinha e salão',  'despesas_aquisicao', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Serviços Terceirizados ──────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Contabilidade',                     'servicos_terceirizados', 'despesa'),
  ('Segurança',                         'servicos_terceirizados', 'despesa'),
  ('Segurança eletrônica',              'servicos_terceirizados', 'despesa'),
  ('Transportadora',                    'servicos_terceirizados', 'despesa'),
  ('Serviços gráficos',                 'servicos_terceirizados', 'despesa'),
  ('Dedetização',                       'servicos_terceirizados', 'despesa'),
  ('Advocacia',                         'servicos_terceirizados', 'despesa'),
  ('Músicos/bandas',                    'servicos_terceirizados', 'despesa'),
  ('Agência de Marketing',              'servicos_terceirizados', 'despesa'),
  ('Jardinagem/Paisagismo/Decoração',   'servicos_terceirizados', 'despesa'),
  ('Consultoria Gastronomia',           'servicos_terceirizados', 'despesa'),
  ('Assessoria Nutricional',            'servicos_terceirizados', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Despesas com Pessoal ────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Salários',                            'pessoal_fixo', 'despesa'),
  ('Vale-Transporte',                     'pessoal_fixo', 'despesa'),
  ('Férias',                              'pessoal_fixo', 'despesa'),
  ('INSS',                                'pessoal_fixo', 'despesa'),
  ('FGTS',                                'pessoal_fixo', 'despesa'),
  ('Despesas com admissão e demissão',    'pessoal_fixo', 'despesa'),
  ('Assistência médica',                  'pessoal_fixo', 'despesa'),
  ('Medicina do Trabalho',                'pessoal_fixo', 'despesa'),
  ('Seguro de Vida',                      'pessoal_fixo', 'despesa'),
  ('13º salário',                         'pessoal_fixo', 'despesa'),
  ('Rescisões',                           'pessoal_fixo', 'despesa'),
  ('Extras',                              'pessoal_fixo', 'despesa'),
  ('Gratificação',                        'pessoal_fixo', 'despesa'),
  ('Contribuição sindical / assistencial','pessoal_fixo', 'despesa'),
  ('Retenção IRPF',                       'pessoal_fixo', 'despesa'),
  ('Salário Família',                     'pessoal_fixo', 'despesa'),
  ('Bolsa Auxilio Estágio',              'pessoal_fixo', 'despesa'),
  ('Cursos profissionalizantes',          'pessoal_fixo', 'despesa'),
  ('Uniformes',                           'pessoal_fixo', 'despesa'),
  ('Ajuda de custo (Moradia)',            'pessoal_fixo', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Retirada de Lucro de Sócios ─────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Retirada de lucro de Sócios', 'retirada_socios', 'despesa')
ON CONFLICT DO NOTHING;

-- ── Despesas Financeiras ────────────────────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Despesas Bancárias', 'despesas_financeiras', 'despesa'),
  ('IOF',                'despesas_financeiras', 'despesa'),
  ('Empréstimos/Giro',   'despesas_financeiras', 'despesa'),
  ('Juros',              'despesas_financeiras', 'despesa')
ON CONFLICT DO NOTHING;
