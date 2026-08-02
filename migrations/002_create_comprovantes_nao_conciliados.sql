-- Migration: Criar tabela de comprovantes não conciliados
-- Data: 2026-08-01
-- Motivo: Implementar CASO 3 (fila de não conciliado)
-- IMPORTANTE: Esta tabela NÃO entra no DRE até ser conciliada

BEGIN;

CREATE TABLE financeiro.comprovantes_nao_conciliados (
  id VARCHAR(50) PRIMARY KEY DEFAULT 'NC' || TO_CHAR(NOW(), 'YYMMDDHH24MISS') || LPAD(FLOOR(RANDOM() * 1000)::TEXT, 3, '0'),

  valor DECIMAL(10, 2) NOT NULL,
  fornecedor VARCHAR(255) DEFAULT NULL,
  categoria_sugerida VARCHAR(255) DEFAULT NULL,

  data_recebimento DATE NOT NULL DEFAULT CURRENT_DATE,
  url_arquivo VARCHAR(500) DEFAULT NULL,
  dados_brutos JSONB DEFAULT NULL,

  status VARCHAR(50) NOT NULL DEFAULT 'nao_conciliado'
    CHECK (status IN ('nao_conciliado', 'conciliado', 'descartado')),

  lancamento_conciliado_id UUID DEFAULT NULL REFERENCES financeiro.lancamentos(id) ON DELETE SET NULL,

  created_at TIMESTAMP DEFAULT NOW(),
  resolvido_em TIMESTAMP DEFAULT NULL,

  CONSTRAINT status_resolvido_check CHECK (
    (status = 'nao_conciliado' AND resolvido_em IS NULL) OR
    (status IN ('conciliado', 'descartado') AND resolvido_em IS NOT NULL)
  )
);

-- Índices
CREATE INDEX idx_comprovantes_status ON financeiro.comprovantes_nao_conciliados(status);
CREATE INDEX idx_comprovantes_valor ON financeiro.comprovantes_nao_conciliados(valor);
CREATE INDEX idx_comprovantes_created ON financeiro.comprovantes_nao_conciliados(created_at DESC);

-- Comentário para documentação
COMMENT ON TABLE financeiro.comprovantes_nao_conciliados IS
  'Fila de comprovantes que não conseguiram ser conciliados automaticamente. '
  'NÃO entra no DRE até ser manualmente conciliado e gerar lançamento em lancamentos.';

COMMIT;
