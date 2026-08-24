-- Migration: Conceder permissões no schema `estoque` pra role da API
-- Data: 2026-08-24
-- Motivo: schema novo criado via SQL não herda GRANT automático pras
--         roles do PostgREST — "Exposed schemas" só diz que o schema
--         PODE ser servido, não concede acesso às tabelas dentro dele
--         (erro visto: "permission denied for schema estoque").
--
-- Só concede pra `service_role` (a app usa exclusivamente
-- SUPABASE_SERVICE_ROLE_KEY, nunca a anon key) — evita expor dados de
-- estoque via API pública sem RLS configurada, diferente do que pode ter
-- sido feito manualmente pra `financeiro` no passado.

BEGIN;

GRANT USAGE ON SCHEMA estoque TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA estoque TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA estoque TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA estoque GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA estoque GRANT ALL ON SEQUENCES TO service_role;

COMMIT;
