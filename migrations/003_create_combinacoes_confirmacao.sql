-- Migration: Criar tabela de confirmações de combinações
-- Data: 2026-08-01
-- Motivo: Implementar CASO 2 (um comprovante quitando múltiplos boletos)
-- IMPORTANTE: Confirmação é persistida em banco, não em memória

BEGIN;

CREATE TABLE financeiro.combinacoes_confirmacao (
  id VARCHAR(50) PRIMARY KEY DEFAULT 'COMB' || TO_CHAR(NOW(), 'YYMMDDHH24MISS') || LPAD(FLOOR(RANDOM() * 1000)::TEXT, 3, '0'),

  chat_id VARCHAR(255) NOT NULL,
  lancamento_ids UUID[] NOT NULL,
  valor_total DECIMAL(10, 2) NOT NULL,

  status VARCHAR(50) NOT NULL DEFAULT 'aguardando_confirmacao'
    CHECK (status IN ('aguardando_confirmacao', 'confirmada', 'cancelada')),

  created_at TIMESTAMP DEFAULT NOW(),
  confirmado_em TIMESTAMP DEFAULT NULL,

  CONSTRAINT confirmacao_check CHECK (
    (status = 'aguardando_confirmacao' AND confirmado_em IS NULL) OR
    (status IN ('confirmada', 'cancelada') AND confirmado_em IS NOT NULL)
  )
);

-- Índices
CREATE INDEX idx_combinacoes_status ON financeiro.combinacoes_confirmacao(status);
CREATE INDEX idx_combinacoes_chat ON financeiro.combinacoes_confirmacao(chat_id);
CREATE INDEX idx_combinacoes_created ON financeiro.combinacoes_confirmacao(created_at DESC);

-- Comentário para documentação
COMMENT ON TABLE financeiro.combinacoes_confirmacao IS
  'Confirmações de combinações exatas: um comprovante quitando múltiplos boletos. '
  'Persistida em banco (não em memória) pra resistir a restarts da Railway.';

COMMIT;
