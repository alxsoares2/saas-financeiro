-- Migration: Criar tabela de auditoria de pagamentos parciais
-- Data: 2026-08-01
-- Motivo: Rastrear cada pagamento parcial com histórico completo

BEGIN;

CREATE TABLE financeiro.baixas_parciais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  lancamento_id UUID NOT NULL REFERENCES financeiro.lancamentos(id) ON DELETE CASCADE,
  valor_pago DECIMAL(10, 2) NOT NULL,
  saldo_anterior DECIMAL(10, 2) NOT NULL,
  saldo_novo DECIMAL(10, 2) NOT NULL,

  data_pagamento DATE NOT NULL,
  message_id VARCHAR(255) DEFAULT NULL,

  created_at TIMESTAMP DEFAULT NOW(),

  -- Verificar integridade: saldo_novo = saldo_anterior + valor_pago
  CONSTRAINT saldo_check CHECK (saldo_novo = saldo_anterior + valor_pago),

  -- valor_pago nunca é negativo
  CONSTRAINT valor_positivo CHECK (valor_pago > 0)
);

-- Índices
CREATE INDEX idx_baixas_lancamento ON financeiro.baixas_parciais(lancamento_id);
CREATE INDEX idx_baixas_data ON financeiro.baixas_parciais(data_pagamento DESC);
CREATE INDEX idx_baixas_created ON financeiro.baixas_parciais(created_at DESC);

-- Comentário para documentação
COMMENT ON TABLE financeiro.baixas_parciais IS
  'Auditoria de pagamentos parciais. Cada linha é um pagamento recebido. '
  'Rastreia: quanto foi pago, qual era o saldo antes, qual é agora, quando foi. '
  'Permite reproduzir histórico completo de conciliação de qualquer lançamento.';

COMMIT;
