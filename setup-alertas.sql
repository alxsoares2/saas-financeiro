-- Setup: Configurar alertas no Supabase
-- Cole essas queries no SQL Editor do Supabase pra ativar os alertas

-- ============================================================================
-- 1. ALERTA DE VENCIMENTO PRÓXIMO (0-2 dias)
-- ============================================================================
INSERT INTO financeiro.alertas_config (tipo_alerta, chat_id, loja_id, ativo, cmv_meta)
VALUES ('vencimento_proximo', '5511999999999-group@g.us', 'basilico', true, NULL)
ON CONFLICT (tipo_alerta, chat_id, loja_id) DO NOTHING;

-- ============================================================================
-- 2. ALERTA DE VENCIDO (5+ dias)
-- ============================================================================
INSERT INTO financeiro.alertas_config (tipo_alerta, chat_id, loja_id, ativo, cmv_meta)
VALUES ('vencido_5dias', '5511999999999-group@g.us', 'basilico', true, NULL)
ON CONFLICT (tipo_alerta, chat_id, loja_id) DO NOTHING;

-- ============================================================================
-- 3. ALERTA DE CMV ACIMA DA META (com meta configurada)
-- ============================================================================
INSERT INTO financeiro.alertas_config (tipo_alerta, chat_id, loja_id, ativo, cmv_meta)
VALUES ('cmv_acima_meta', '5511999999999-group@g.us', 'basilico', true, 32.50)
ON CONFLICT (tipo_alerta, chat_id, loja_id) DO NOTHING;

-- ============================================================================
-- VERIFICAÇÃO: Listar todas as configs de alerta
-- ============================================================================
SELECT id, tipo_alerta, chat_id, ativo, cmv_meta
FROM financeiro.alertas_config
ORDER BY tipo_alerta, chat_id;
