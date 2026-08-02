-- Migration: Criar tabela de configuração de alertas
-- Data: 2026-08-01
-- Motivo: Implementar sistema de alertas proativos (vencimentos, CMV)
-- Risco: BAIXO — tabela nova, sem dependências de dados existentes

BEGIN;

-- Tabela de configuração de alertas
-- Permite ativar/desativar cada tipo de alerta por destino (chat_id)
-- Suporta multi-loja (loja_id) para quando Umami entrar
CREATE TABLE IF NOT EXISTS financeiro.alertas_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tipo de alerta
  tipo_alerta TEXT NOT NULL CHECK (tipo_alerta IN (
    'vencimento_proximo',   -- Boleto vence hoje/amanhã/depois de amanhã
    'vencido_5dias',        -- Boleto vencido há 5+ dias sem pagar
    'cmv_acima_meta'        -- Custos variáveis acima da meta
  )),

  -- Destino (chat/grupo do WhatsApp)
  chat_id TEXT NOT NULL,  -- ex: "5511999999999-group@g.us" ou número

  -- Loja/tenant (hoje 'basilico', futuro 'umami', etc)
  loja_id TEXT DEFAULT 'basilico',

  -- Estado
  ativo BOOLEAN DEFAULT true,

  -- Configurações específicas por tipo de alerta
  cmv_meta NUMERIC(5,2) DEFAULT NULL,  -- ex: 32.50 (32.5% CMV meta)

  -- Auditoria
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraint: um tipo de alerta por (chat_id, loja_id)
  UNIQUE(tipo_alerta, chat_id, loja_id)
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_alertas_config_tipo_ativo
  ON financeiro.alertas_config(tipo_alerta, ativo);

CREATE INDEX IF NOT EXISTS idx_alertas_config_loja
  ON financeiro.alertas_config(loja_id);

-- Comentários de documentação
COMMENT ON TABLE financeiro.alertas_config IS
  'Configuração de alertas proativos. '
  'Cada tipo de alerta (vencimento, CMV) pode ser ativado/desativado independentemente. '
  'loja_id permite metas de CMV diferentes por loja (hoje Basílico, futuro Umami).';

COMMENT ON COLUMN financeiro.alertas_config.tipo_alerta IS
  'vencimento_proximo: alerta 0-2 dias antes de vencer. '
  'vencido_5dias: alerta quando passa de 5 dias em atraso. '
  'cmv_acima_meta: dispara manual via comando de chat.';

COMMENT ON COLUMN financeiro.alertas_config.chat_id IS
  'Destino do alerta (número WhatsApp ou grupo). Permite enviar alertas diferentes para chats diferentes.';

COMMENT ON COLUMN financeiro.alertas_config.loja_id IS
  'Identificador da loja. Hoje sempre "basilico". Quando Umami entrar, adiciona "umami" com metas diferentes.';

COMMENT ON COLUMN financeiro.alertas_config.cmv_meta IS
  'Meta de CMV em %. Ex: 32.50 significa 32.5%. Usado por alerta tipo "cmv_acima_meta".';

COMMIT;
