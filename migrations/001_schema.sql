-- Schema isolado para não conflitar com as tabelas do site do restaurante
CREATE SCHEMA IF NOT EXISTS financeiro;

-- Categorias contábeis
CREATE TABLE IF NOT EXISTS financeiro.categorias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  grupo_dre TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('receita', 'despesa')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Lançamentos financeiros (receitas e despesas)
CREATE TABLE IF NOT EXISTS financeiro.lancamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id TEXT UNIQUE,
  tipo TEXT NOT NULL CHECK (tipo IN ('receita', 'despesa')),
  descricao TEXT NOT NULL,
  fornecedor TEXT,
  cnpj_cpf TEXT,
  valor NUMERIC(12,2) NOT NULL,
  data_emissao DATE,
  data_vencimento DATE,
  data_pagamento DATE,
  categoria_id UUID REFERENCES financeiro.categorias(id),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'pago')),
  url_arquivo TEXT,
  dados_brutos JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Controle de idempotência de mensagens do WhatsApp
CREATE TABLE IF NOT EXISTS financeiro.mensagens_processadas (
  message_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices úteis para o DRE
CREATE INDEX IF NOT EXISTS idx_fin_lancamentos_data_emissao ON financeiro.lancamentos(data_emissao);
CREATE INDEX IF NOT EXISTS idx_fin_lancamentos_tipo        ON financeiro.lancamentos(tipo);
CREATE INDEX IF NOT EXISTS idx_fin_lancamentos_status      ON financeiro.lancamentos(status);
CREATE INDEX IF NOT EXISTS idx_fin_lancamentos_categoria   ON financeiro.lancamentos(categoria_id);
