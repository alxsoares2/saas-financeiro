-- Migration: Adicionar flags de alertas aos lançamentos
-- Data: 2026-08-01
-- Motivo: Rastrear se alerta de vencimento/vencido já foi enviado (anti-spam)
-- Risco: CRÍTICO — ALTER em tabela com dados do Basílico em produção
--
-- Operações:
--   1. Adiciona duas colunas BOOLEAN (default false) — reverível se necessário
--   2. Bootstrap: marca boletos antigos como "já alertados" SEM enviar mensagem
--      (evita enxurrada de alertas na primeira execução do cron)
--   3. Criar índices para performance do cron
--
-- TESTE RECOMENDADO ANTES:
--   SELECT COUNT(*) FROM financeiro.lancamentos
--     WHERE status='pendente' AND data_vencimento < CURRENT_DATE - INTERVAL '5 days';
--   (quantos boletos antigos serão marcados no bootstrap?)

BEGIN;

-- ── Adicionar flags anti-repetição ────────────────────────────────────────

-- Flag 1: alerta de vencimento próximo já foi enviado?
ALTER TABLE financeiro.lancamentos
ADD COLUMN alerta_vencimento_enviado BOOLEAN DEFAULT false;

COMMENT ON COLUMN financeiro.lancamentos.alerta_vencimento_enviado IS
  'true = alerta de "vence hoje/amanhã" já foi enviado. '
  'Previne que o mesmo boleto seja alertado múltiplas vezes se cron falhar.';

-- Flag 2: alerta de vencido (5+ dias) já foi enviado?
ALTER TABLE financeiro.lancamentos
ADD COLUMN alerta_vencido_enviado BOOLEAN DEFAULT false;

COMMENT ON COLUMN financeiro.lancamentos.alerta_vencido_enviado IS
  'true = alerta de "venceu há 5+ dias" já foi enviado. '
  'Previne que o mesmo boleto seja alertado múltiplas vezes.';

-- ── Bootstrap: Marcar boletos antigos como "já avisados" ──────────────────
--
-- LÓGICA: Na primeira execução do cron, poderia haver boletos vencidos há
-- semanas. Sem esse bootstrap, todos disparariam alerta no mesmo dia.
-- Este UPDATE silenciosamente marca-os como "já avisado" (sem enviar mensagem).
-- A partir daí, apenas novos boletos que cruzarem 5 dias disparam.

UPDATE financeiro.lancamentos
SET alerta_vencido_enviado = true
WHERE status = 'pendente'
  AND tipo = 'despesa'
  AND data_vencimento < CURRENT_DATE - INTERVAL '5 days'
  AND alerta_vencido_enviado = false;

-- Log: quantos foram marcados (comentário apenas)
-- Se esta query afetar >50 linhas, avise — pode indicar volume inesperado de atrasos

-- ── Índices para performance do cron ──────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_lancamentos_alerta_vencimento
  ON financeiro.lancamentos(
    data_vencimento,
    status,
    tipo,
    alerta_vencimento_enviado
  )
  WHERE status = 'pendente' AND tipo = 'despesa';

CREATE INDEX IF NOT EXISTS idx_lancamentos_alerta_vencido
  ON financeiro.lancamentos(
    data_vencimento,
    status,
    tipo,
    alerta_vencido_enviado
  )
  WHERE status = 'pendente' AND tipo = 'despesa';

-- Comentário de auditoria
COMMENT ON INDEX idx_lancamentos_alerta_vencimento IS
  'Índice para cron buscar lançamentos com vencimento próximo sem alerta enviado. '
  'Filtro: status=pendente AND tipo=despesa (compostos no índice).';

COMMENT ON INDEX idx_lancamentos_alerta_vencido IS
  'Índice para cron buscar lançamentos vencidos há 5+ dias sem alerta enviado. '
  'Filtro: status=pendente AND tipo=despesa (compostos no índice).';

COMMIT;
