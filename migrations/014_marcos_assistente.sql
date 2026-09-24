-- Migration: assistente "Marcos" no grupo financeiro + conta corrente entre lojas
-- Data: 2026-09-24
--
-- 1. lancamentos.pertence_a — quando uma loja compra algo PRA OUTRA (ex: o
--    Fiuza/Mano compra insumo pra Basílico), o lançamento continua no banco
--    de quem pagou, mas marcado com a loja dona de verdade. O DRE ignora
--    lançamentos com pertence_a preenchido (não é custo de quem pagou — é
--    valor a receber da outra loja). NULL = é da própria loja (padrão).
--
-- 2. acertos_lojas — conta corrente entre lojas. Cada linha é uma dívida
--    (loja_devedora deve valor à loja_credora) ou um pagamento (loja_devedora
--    pagou valor à loja_credora). Saldo = soma das dívidas - soma dos
--    pagamentos, por par de lojas.
--
-- 3. marcos_conversas — sessão de conversa com o assistente por grupo.
--    `mensagens` é TEXT (JSON serializado), não JSONB, de propósito: o
--    histórico é reenviado à API da Anthropic exatamente como foi recebido
--    (inclui blocos de raciocínio que precisam voltar sem alteração), e o
--    JSONB reordena chaves.

BEGIN;

ALTER TABLE financeiro.lancamentos
  ADD COLUMN IF NOT EXISTS pertence_a TEXT;

CREATE TABLE IF NOT EXISTS financeiro.acertos_lojas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo TEXT NOT NULL CHECK (tipo IN ('divida', 'pagamento')),
  loja_devedora TEXT NOT NULL,
  loja_credora TEXT NOT NULL,
  valor NUMERIC(12,2) NOT NULL CHECK (valor > 0),
  descricao TEXT NOT NULL,
  data DATE NOT NULL DEFAULT CURRENT_DATE,
  lancamento_id UUID REFERENCES financeiro.lancamentos(id) ON DELETE SET NULL,
  criado_por TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fin_acertos_lojas_par ON financeiro.acertos_lojas(loja_devedora, loja_credora);
CREATE INDEX IF NOT EXISTS idx_fin_acertos_lojas_lancamento ON financeiro.acertos_lojas(lancamento_id);

CREATE TABLE IF NOT EXISTS financeiro.marcos_conversas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL,
  mensagens TEXT NOT NULL DEFAULT '[]',
  acoes_pendentes TEXT,
  ultima_atividade TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  encerrada BOOLEAN NOT NULL DEFAULT false,
  custo_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fin_marcos_conversas_chat ON financeiro.marcos_conversas(chat_id, ultima_atividade DESC);

GRANT ALL ON financeiro.acertos_lojas TO service_role;
GRANT ALL ON financeiro.marcos_conversas TO service_role;

COMMIT;
