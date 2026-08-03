-- ============================================================================
-- SCHEMA COMPLETO — Projeto Basílico (banco separado)
-- ============================================================================
-- Cria TODA a estrutura do zero, num arquivo só, na ordem correta.
-- Corrige o bug das migrations incrementais: aqui o "status" é TEXT aceitando
-- os 4 valores que o código usa (pendente, pago, pago_parcialmente, a_confirmar).
--
-- Rode isto no SQL Editor do projeto Supabase do Basílico (alxsoares).
-- Depois: Settings -> API -> Exposed schemas -> adicionar "financeiro".
-- ============================================================================

BEGIN;

-- Schema
CREATE SCHEMA IF NOT EXISTS financeiro;

-- ── Categorias ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financeiro.categorias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  grupo_dre TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('receita', 'despesa')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Lançamentos (estrutura FINAL, já com todas as colunas) ──────────────────
CREATE TABLE IF NOT EXISTS financeiro.lancamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id TEXT UNIQUE,
  tipo TEXT NOT NULL CHECK (tipo IN ('receita', 'despesa')),
  descricao TEXT NOT NULL,
  fornecedor TEXT,
  cnpj_cpf TEXT,
  valor NUMERIC(12,2) NOT NULL,
  valor_pago DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
  data_emissao DATE,
  data_vencimento DATE,
  data_pagamento DATE,
  data_primeiro_pagamento DATE DEFAULT NULL,
  categoria_id UUID REFERENCES financeiro.categorias(id),
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'pago', 'pago_parcialmente', 'a_confirmar')),
  alerta_vencimento_enviado BOOLEAN DEFAULT false,
  alerta_vencido_enviado BOOLEAN DEFAULT false,
  url_arquivo TEXT,
  dados_brutos JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Idempotência de mensagens ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financeiro.mensagens_processadas (
  message_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Comprovantes não conciliados ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financeiro.comprovantes_nao_conciliados (
  id VARCHAR(50) PRIMARY KEY DEFAULT 'NC' || TO_CHAR(NOW(), 'YYMMDDHH24MISS') || LPAD(FLOOR(RANDOM() * 1000)::TEXT, 3, '0'),
  valor DECIMAL(10,2) NOT NULL,
  fornecedor VARCHAR(255) DEFAULT NULL,
  categoria_sugerida VARCHAR(255) DEFAULT NULL,
  data_recebimento DATE NOT NULL DEFAULT CURRENT_DATE,
  url_arquivo VARCHAR(500) DEFAULT NULL,
  dados_brutos JSONB DEFAULT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'nao_conciliado'
    CHECK (status IN ('nao_conciliado', 'conciliado', 'descartado')),
  lancamento_conciliado_id UUID DEFAULT NULL REFERENCES financeiro.lancamentos(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  resolvido_em TIMESTAMP DEFAULT NULL,
  CONSTRAINT status_resolvido_check CHECK (
    (status = 'nao_conciliado' AND resolvido_em IS NULL) OR
    (status IN ('conciliado', 'descartado') AND resolvido_em IS NOT NULL)
  )
);

-- ── Combinações de confirmação ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financeiro.combinacoes_confirmacao (
  id VARCHAR(50) PRIMARY KEY DEFAULT 'COMB' || TO_CHAR(NOW(), 'YYMMDDHH24MISS') || LPAD(FLOOR(RANDOM() * 1000)::TEXT, 3, '0'),
  chat_id VARCHAR(255) NOT NULL,
  lancamento_ids UUID[] NOT NULL,
  valor_total DECIMAL(10,2) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'aguardando_confirmacao'
    CHECK (status IN ('aguardando_confirmacao', 'confirmada', 'cancelada')),
  created_at TIMESTAMP DEFAULT NOW(),
  confirmado_em TIMESTAMP DEFAULT NULL,
  CONSTRAINT confirmacao_check CHECK (
    (status = 'aguardando_confirmacao' AND confirmado_em IS NULL) OR
    (status IN ('confirmada', 'cancelada') AND confirmado_em IS NOT NULL)
  )
);

-- ── Baixas parciais (auditoria) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financeiro.baixas_parciais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lancamento_id UUID NOT NULL REFERENCES financeiro.lancamentos(id) ON DELETE CASCADE,
  valor_pago DECIMAL(10,2) NOT NULL,
  saldo_anterior DECIMAL(10,2) NOT NULL,
  saldo_novo DECIMAL(10,2) NOT NULL,
  data_pagamento DATE NOT NULL,
  message_id VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT saldo_check CHECK (saldo_novo = saldo_anterior + valor_pago),
  CONSTRAINT valor_positivo CHECK (valor_pago > 0)
);

-- ── Recorrentes de despesas ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financeiro.recorrentes_despesas (
  id VARCHAR(20) PRIMARY KEY DEFAULT 'R' || LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0'),
  descricao VARCHAR(255) NOT NULL,
  valor DECIMAL(10,2) DEFAULT NULL,
  categoria_id UUID NOT NULL REFERENCES financeiro.categorias(id) ON DELETE RESTRICT,
  fornecedor VARCHAR(255) DEFAULT NULL,
  dia_vencimento INTEGER NOT NULL CHECK (dia_vencimento BETWEEN 1 AND 31),
  dias_antecedencia INTEGER DEFAULT 5,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  ultima_geracao VARCHAR(7) DEFAULT NULL,
  UNIQUE(descricao, categoria_id)
);

-- ── Config de alertas ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financeiro.alertas_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_alerta TEXT NOT NULL CHECK (tipo_alerta IN ('vencimento_proximo', 'vencido_5dias', 'cmv_acima_meta')),
  chat_id TEXT NOT NULL,
  loja_id TEXT DEFAULT 'basilico',
  ativo BOOLEAN DEFAULT true,
  cmv_meta NUMERIC(5,2) DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tipo_alerta, chat_id, loja_id)
);

-- ── Histórico de compras (variação de preço) ────────────────────────────────
CREATE TABLE IF NOT EXISTS financeiro.historico_compras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_nome TEXT NOT NULL,
  quantidade NUMERIC(10,2) NOT NULL,
  unidade TEXT NOT NULL,
  preco_total NUMERIC(10,2) NOT NULL,
  preco_unitario NUMERIC(10,2) NOT NULL,
  lancamento_id UUID REFERENCES financeiro.lancamentos(id) ON DELETE CASCADE,
  fornecedor TEXT,
  data_compra DATE NOT NULL,
  variacao_pct NUMERIC(5,2) DEFAULT NULL,
  ultima_compra_id UUID REFERENCES financeiro.historico_compras(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Índices ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fin_lancamentos_data_emissao ON financeiro.lancamentos(data_emissao);
CREATE INDEX IF NOT EXISTS idx_fin_lancamentos_tipo        ON financeiro.lancamentos(tipo);
CREATE INDEX IF NOT EXISTS idx_fin_lancamentos_status      ON financeiro.lancamentos(status);
CREATE INDEX IF NOT EXISTS idx_fin_lancamentos_categoria   ON financeiro.lancamentos(categoria_id);
CREATE INDEX IF NOT EXISTS idx_lancamentos_saldo ON financeiro.lancamentos((valor - valor_pago) DESC, categoria_id, status);
CREATE INDEX IF NOT EXISTS idx_lancamentos_alerta_vencimento ON financeiro.lancamentos(data_vencimento, status, tipo, alerta_vencimento_enviado) WHERE status = 'pendente' AND tipo = 'despesa';
CREATE INDEX IF NOT EXISTS idx_lancamentos_alerta_vencido    ON financeiro.lancamentos(data_vencimento, status, tipo, alerta_vencido_enviado) WHERE status = 'pendente' AND tipo = 'despesa';

CREATE INDEX IF NOT EXISTS idx_comprovantes_status  ON financeiro.comprovantes_nao_conciliados(status);
CREATE INDEX IF NOT EXISTS idx_comprovantes_valor   ON financeiro.comprovantes_nao_conciliados(valor);
CREATE INDEX IF NOT EXISTS idx_comprovantes_created ON financeiro.comprovantes_nao_conciliados(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_combinacoes_status  ON financeiro.combinacoes_confirmacao(status);
CREATE INDEX IF NOT EXISTS idx_combinacoes_chat    ON financeiro.combinacoes_confirmacao(chat_id);
CREATE INDEX IF NOT EXISTS idx_combinacoes_created ON financeiro.combinacoes_confirmacao(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_baixas_lancamento ON financeiro.baixas_parciais(lancamento_id);
CREATE INDEX IF NOT EXISTS idx_baixas_data       ON financeiro.baixas_parciais(data_pagamento DESC);
CREATE INDEX IF NOT EXISTS idx_baixas_created    ON financeiro.baixas_parciais(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recorrentes_ativo          ON financeiro.recorrentes_despesas(ativo);
CREATE INDEX IF NOT EXISTS idx_recorrentes_vencimento     ON financeiro.recorrentes_despesas(dia_vencimento);
CREATE INDEX IF NOT EXISTS idx_recorrentes_ultima_geracao ON financeiro.recorrentes_despesas(ultima_geracao);

CREATE INDEX IF NOT EXISTS idx_alertas_config_tipo_ativo ON financeiro.alertas_config(tipo_alerta, ativo);
CREATE INDEX IF NOT EXISTS idx_alertas_config_loja       ON financeiro.alertas_config(loja_id);

CREATE INDEX IF NOT EXISTS idx_historico_compras_produto    ON financeiro.historico_compras(produto_nome, data_compra DESC);
CREATE INDEX IF NOT EXISTS idx_historico_compras_lancamento ON financeiro.historico_compras(lancamento_id);
CREATE INDEX IF NOT EXISTS idx_historico_compras_data       ON financeiro.historico_compras(data_compra);

COMMIT;

-- ── Seed: plano de contas (categorias) ──────────────────────────────────────
INSERT INTO financeiro.categorias (nome, grupo_dre, tipo) VALUES
  ('Vendas - Dinheiro',          'receita_bruta', 'receita'),
  ('Vendas - Pix',               'receita_bruta', 'receita'),
  ('Vendas - Cartão de Débito',  'receita_bruta', 'receita'),
  ('Vendas - Cartão de Crédito', 'receita_bruta', 'receita'),
  ('Vendas - iFood',             'receita_bruta', 'receita'),
  ('Vendas - Vale Refeição',     'receita_bruta', 'receita'),
  ('Serviços - Eventos',         'receita_bruta', 'receita'),
  ('Outras Receitas',            'receita_bruta', 'receita'),
  ('Serviço 10%',  'deducoes_receita', 'despesa'),
  ('Cortesias',    'deducoes_receita', 'despesa'),
  ('Permuta',      'deducoes_receita', 'despesa'),
  ('Cancelamentos','deducoes_receita', 'despesa'),
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
  ('Outros Ingredientes',        'cmv', 'despesa'),
  ('Cervejas',               'materiais_venda_direta', 'despesa'),
  ('Destilados',             'materiais_venda_direta', 'despesa'),
  ('Vinhos',                 'materiais_venda_direta', 'despesa'),
  ('Bebidas Não Alcoólicas', 'materiais_venda_direta', 'despesa'),
  ('Água Mineral',           'materiais_venda_direta', 'despesa'),
  ('Energéticos / Sucos',    'materiais_venda_direta', 'despesa'),
  ('Material de Limpeza e Higiene', 'materiais_apoio', 'despesa'),
  ('Embalagens e Descartáveis',     'materiais_apoio', 'despesa'),
  ('Uniformes / EPIs',              'materiais_apoio', 'despesa'),
  ('Gelo',                          'materiais_apoio', 'despesa'),
  ('Mão de Obra Eventual / Freelancer', 'cmo_eventual', 'despesa'),
  ('Serviços de Terceiros - Produção',  'cmo_eventual', 'despesa'),
  ('Tarifa Cartão de Crédito', 'tarifas_cartao', 'despesa'),
  ('Tarifa Cartão de Débito',  'tarifas_cartao', 'despesa'),
  ('Tarifa iFood',             'tarifas_cartao', 'despesa'),
  ('Tarifa Pix',               'tarifas_cartao', 'despesa'),
  ('Tarifa Vale Refeição',     'tarifas_cartao', 'despesa'),
  ('PIS',                    'impostos_variaveis', 'despesa'),
  ('COFINS',                 'impostos_variaveis', 'despesa'),
  ('ICMS',                   'impostos_variaveis', 'despesa'),
  ('ISS',                    'impostos_variaveis', 'despesa'),
  ('Simples Nacional (DAS)', 'impostos_variaveis', 'despesa'),
  ('FEEF / Outros impostos', 'impostos_variaveis', 'despesa'),
  ('Aluguel do Estabelecimento',    'ocupacao', 'despesa'),
  ('Condomínio',                    'ocupacao', 'despesa'),
  ('IPTU',                          'ocupacao', 'despesa'),
  ('TCR / Taxa de Coleta',          'ocupacao', 'despesa'),
  ('Outros Impostos de Ocupação',   'ocupacao', 'despesa'),
  ('Conta de Luz',          'utilidades', 'despesa'),
  ('Conta de Água e Esgoto','utilidades', 'despesa'),
  ('Conta de Gás',          'utilidades', 'despesa'),
  ('Telefone / Internet',   'utilidades', 'despesa'),
  ('Material de Escritório / Informática', 'despesas_admin', 'despesa'),
  ('Sistema PDV / ERP / Gestão',           'despesas_admin', 'despesa'),
  ('Contabilidade / Honorários',           'despesas_admin', 'despesa'),
  ('Alvará / Licenças / Taxas',            'despesas_admin', 'despesa'),
  ('Seguro',                               'despesas_admin', 'despesa'),
  ('Aluguel de Equipamentos',              'despesas_admin', 'despesa'),
  ('Manutenção de Equipamentos',           'despesas_admin', 'despesa'),
  ('Despesas com Veículos',                'despesas_admin', 'despesa'),
  ('Outras Despesas Administrativas',      'despesas_admin', 'despesa'),
  ('Marketing Digital / Redes Sociais', 'marketing', 'despesa'),
  ('Patrocínios / Parcerias',           'marketing', 'despesa'),
  ('Material Gráfico / Impressos',      'marketing', 'despesa'),
  ('Eventos Promocionais',              'marketing', 'despesa'),
  ('Salários CLT',                     'pessoal_fixo', 'despesa'),
  ('Pró-Labore',                       'pessoal_fixo', 'despesa'),
  ('Encargos Trabalhistas (FGTS/INSS)','pessoal_fixo', 'despesa'),
  ('Vale Transporte',                  'pessoal_fixo', 'despesa'),
  ('Vale Refeição / Alimentação',      'pessoal_fixo', 'despesa'),
  ('Plano de Saúde',                   'pessoal_fixo', 'despesa'),
  ('13º Salário / Férias (provisionado)', 'pessoal_fixo', 'despesa')
ON CONFLICT DO NOTHING;
