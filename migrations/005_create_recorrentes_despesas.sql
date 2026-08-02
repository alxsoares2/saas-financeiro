-- Migration: Criar tabela de despesas recorrentes
-- Data: 2026-08-01
-- Motivo: Implementar geração automática de pendentes para despesas fixas (aluguel, salários, etc)

BEGIN;

-- Criar tabela de recorrentes
CREATE TABLE financeiro.recorrentes_despesas (
  id VARCHAR(20) PRIMARY KEY DEFAULT 'R' || LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0'),

  -- Dados do recorrente
  descricao VARCHAR(255) NOT NULL,
  valor DECIMAL(10, 2) DEFAULT NULL,  -- NULL = "a confirmar" quando gerar
  categoria_id UUID NOT NULL REFERENCES financeiro.categorias(id) ON DELETE RESTRICT,
  fornecedor VARCHAR(255) DEFAULT NULL,

  -- Vencimento e geração
  dia_vencimento INTEGER NOT NULL CHECK (dia_vencimento BETWEEN 1 AND 31),
  dias_antecedencia INTEGER DEFAULT 5,  -- Gerar 5 dias antes do vencimento

  -- Estado
  ativo BOOLEAN DEFAULT true,

  -- Auditoria e idempotência
  created_at TIMESTAMP DEFAULT NOW(),
  ultima_geracao VARCHAR(7) DEFAULT NULL,  -- Formato: "YYYY-MM" (ex: "2026-08") — chave anti-duplicação

  -- Constraint: não repetir mesma descrição na mesma categoria
  UNIQUE(descricao, categoria_id)
);

-- Índices para performance
CREATE INDEX idx_recorrentes_ativo
  ON financeiro.recorrentes_despesas(ativo);

CREATE INDEX idx_recorrentes_vencimento
  ON financeiro.recorrentes_despesas(dia_vencimento);

CREATE INDEX idx_recorrentes_ultima_geracao
  ON financeiro.recorrentes_despesas(ultima_geracao);

-- Comentários para documentação
COMMENT ON TABLE financeiro.recorrentes_despesas IS
  'Despesas recorrentes (aluguel, salários, assinaturas, etc). '
  'Sistema gera automaticamente lançamento pendente quando vencer. '
  'Valor NULL = "a confirmar" (você preenche quando receber a conta). '
  'Idempotência via ultima_geracao (YYYY-MM): nunca duplica no mesmo mês.';

COMMENT ON COLUMN financeiro.recorrentes_despesas.id IS
  'Código curto: R000001, R000002, etc — mesmo padrão de outros IDs do sistema.';

COMMENT ON COLUMN financeiro.recorrentes_despesas.valor IS
  'NULL = valor variável (luz, água). Você preenche quando receber. '
  'Valor fixo (aluguel) = número. Lançamento entra no DRE só com valor preenchido.';

COMMENT ON COLUMN financeiro.recorrentes_despesas.dia_vencimento IS
  'Dia do mês (1-31). Se dia 31 em mês curto (fevereiro), usa último dia real.';

COMMENT ON COLUMN financeiro.recorrentes_despesas.dias_antecedencia IS
  'Gerar pendente N dias antes do vencimento. Padrão: 5 dias. Configurável por recorrente.';

COMMENT ON COLUMN financeiro.recorrentes_despesas.ultima_geracao IS
  'Última vez que gerou: "2026-08". Previne duplicação. Se já gerou em agosto/2026, não gera de novo.';

COMMIT;
