-- Migration: Criar tabela de histórico de compras
-- Data: 2026-08-02
-- Motivo: Rastrear variação de preço em itens de compra (CMV)

BEGIN;

-- Tabela de histórico de compras
-- Rastreia cada item comprado (quantidade, unidade, preço) para detectar variações
CREATE TABLE IF NOT EXISTS financeiro.historico_compras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificação do item
  produto_nome TEXT NOT NULL,  -- ex: "Tomate", "Carne Vermelha"
  quantidade NUMERIC(10,2) NOT NULL,
  unidade TEXT NOT NULL,  -- ex: "kg", "un", "l"

  -- Preço
  preco_total NUMERIC(10,2) NOT NULL,
  preco_unitario NUMERIC(10,2) NOT NULL,  -- preco_total / quantidade

  -- Contexto
  lancamento_id UUID REFERENCES financeiro.lancamentos(id) ON DELETE CASCADE,
  fornecedor TEXT,
  data_compra DATE NOT NULL,

  -- Variação vs última compra (calculada ao registrar)
  variacao_pct NUMERIC(5,2) DEFAULT NULL,  -- ex: 10.50 (10.5% mais caro)
  ultima_compra_id UUID REFERENCES financeiro.historico_compras(id) ON DELETE SET NULL,

  -- Auditoria
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_historico_compras_produto
  ON financeiro.historico_compras(produto_nome, data_compra DESC);

CREATE INDEX IF NOT EXISTS idx_historico_compras_lancamento
  ON financeiro.historico_compras(lancamento_id);

CREATE INDEX IF NOT EXISTS idx_historico_compras_data
  ON financeiro.historico_compras(data_compra);

-- Comentários
COMMENT ON TABLE financeiro.historico_compras IS
  'Rastreamento de itens de compra com quantidade, unidade e preço. '
  'Permite detectar variações de preço (ex: tomate subiu 10% vs última compra). '
  'Usado para monitorar desempenho de comprador.';

COMMENT ON COLUMN financeiro.historico_compras.produto_nome IS
  'Nome do produto (ex: "Tomate", "Carne Vermelha"). Normalizado para matching com histórico.';

COMMENT ON COLUMN financeiro.historico_compras.preco_unitario IS
  'Preço por unidade = preco_total / quantidade. Ex: R$ 10/kg.';

COMMENT ON COLUMN financeiro.historico_compras.variacao_pct IS
  'Percentual de variação vs última compra do mesmo produto. Positivo = mais caro, negativo = mais barato.';

COMMIT;
