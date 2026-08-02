-- Migration: Adicionar suporte a pagamentos parciais na tabela lancamentos
-- Data: 2026-08-01
-- Motivo: Implementar CASO 1 (pagamento parcial)

BEGIN;

-- 1. Adicionar coluna valor_pago (acumula pagamentos parciais)
ALTER TABLE financeiro.lancamentos
ADD COLUMN valor_pago DECIMAL(10, 2) DEFAULT 0.00 NOT NULL;

-- 2. Adicionar coluna data_primeiro_pagamento (rastreabilidade)
ALTER TABLE financeiro.lancamentos
ADD COLUMN data_primeiro_pagamento DATE DEFAULT NULL;

-- 3. Atualizar enum de status para incluir "pago_parcialmente"
ALTER TYPE financeiro.status_lancamento RENAME TO status_lancamento_old;

CREATE TYPE financeiro.status_lancamento AS ENUM ('pendente', 'pago', 'pago_parcialmente');

ALTER TABLE financeiro.lancamentos
ALTER COLUMN status TYPE financeiro.status_lancamento USING
  CASE
    WHEN status::text = 'pendente' THEN 'pendente'::financeiro.status_lancamento
    WHEN status::text = 'pago' THEN 'pago'::financeiro.status_lancamento
    ELSE 'pendente'::financeiro.status_lancamento
  END;

DROP TYPE financeiro.status_lancamento_old;

-- 4. MIGRAÇÃO DE DADOS: Lançamentos já pagos têm valor_pago = valor
UPDATE financeiro.lancamentos
SET valor_pago = valor,
    data_primeiro_pagamento = data_pagamento
WHERE status = 'pago';

-- 5. Adicionar índice para buscas rápidas por saldo
CREATE INDEX idx_lancamentos_saldo ON financeiro.lancamentos(
  (valor - valor_pago) DESC,
  categoria_id,
  status
);

COMMIT;
