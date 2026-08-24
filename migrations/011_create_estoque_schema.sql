-- Migration: Criar schema `estoque` (bruto + manipulado) via WhatsApp
-- Data: 2026-08-24
-- Motivo: Novo módulo de controle de estoque/manipulação (ver
--         SPEC-estoque-manipulacao.md e schema-estoque.sql na raiz do
--         projeto para o detalhamento das regras de negócio).
--         Schema isolado, no mesmo padrão de `financeiro` — não conflita
--         com o DRE nem com as tabelas do site do restaurante.
--
-- IMPORTANTE: depois de rodar esta migration, adicione `estoque` na lista
-- de "Exposed schemas" em Supabase → Settings → API (o mesmo que foi
-- feito para `financeiro`), senão o PostgREST não enxerga as tabelas.

BEGIN;

CREATE SCHEMA IF NOT EXISTS estoque;

-- 1) PRODUTOS
CREATE TABLE estoque.produtos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL UNIQUE,
  unidade TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('bruto', 'manipulado')),
  categoria TEXT,
  marca TEXT CHECK (marca IN ('basilico', 'populares')),

  preco_unitario NUMERIC(10,2),
  estoque_atual NUMERIC(10,3) NOT NULL DEFAULT 0,
  estoque_minimo NUMERIC(10,3) NOT NULL DEFAULT 0,

  fornecedor TEXT,
  formato_saida TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  observacoes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) PADRÕES DE EMBALAGEM
CREATE TABLE estoque.padroes_embalagem (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id UUID NOT NULL REFERENCES estoque.produtos(id) ON DELETE CASCADE,
  nome_padrao TEXT NOT NULL,
  unidades_por_padrao NUMERIC(10,3) NOT NULL,
  peso_ou_volume_por_unidade NUMERIC(10,3),
  multiplo_minimo NUMERIC(10,3),
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3) GRUPOS DE SUBSTITUIÇÃO (pool de insumos das marcas populares)
CREATE TABLE estoque.grupos_substituicao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL UNIQUE,
  categoria TEXT,
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE estoque.grupos_substituicao_membros (
  grupo_id UUID NOT NULL REFERENCES estoque.grupos_substituicao(id) ON DELETE CASCADE,
  produto_id UUID NOT NULL REFERENCES estoque.produtos(id) ON DELETE CASCADE,
  PRIMARY KEY (grupo_id, produto_id)
);

-- 4) FICHAS TÉCNICAS — transformação bruto → manipulado
CREATE TABLE estoque.fichas_tecnicas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_manipulado_id UUID NOT NULL REFERENCES estoque.produtos(id) ON DELETE CASCADE,
  produto_bruto_id UUID NOT NULL REFERENCES estoque.produtos(id) ON DELETE CASCADE,
  quantidade_bruto_por_unidade NUMERIC(10,4) NOT NULL,
  perda_pct NUMERIC(5,2),
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5) ITENS UNIVERSAIS (presentes em toda pizza salgada/doce)
CREATE TABLE estoque.itens_universais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  categoria TEXT NOT NULL CHECK (categoria IN ('salgada', 'doce', 'ambas')),
  produto_id UUID REFERENCES estoque.produtos(id) ON DELETE CASCADE,
  grupo_substituicao_id UUID REFERENCES estoque.grupos_substituicao(id) ON DELETE CASCADE,
  marca TEXT CHECK (marca IN ('basilico', 'populares')),
  quantidade NUMERIC(10,4) NOT NULL,
  unidade TEXT NOT NULL,
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_item_universal_ref CHECK (
    (produto_id IS NOT NULL AND grupo_substituicao_id IS NULL) OR
    (produto_id IS NULL AND grupo_substituicao_id IS NOT NULL)
  )
);

-- 6) SABORES
CREATE TABLE estoque.sabores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL UNIQUE,
  tipo TEXT NOT NULL CHECK (tipo IN ('ancora', 'piso_seguranca')),
  categoria TEXT NOT NULL CHECK (categoria IN ('salgada', 'doce')),
  piso_minimo_pizzas NUMERIC(10,1),
  queijo_override_kg NUMERIC(10,3),
  ativo BOOLEAN NOT NULL DEFAULT true,
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7) INGREDIENTES EXCLUSIVOS DO SABOR
CREATE TABLE estoque.sabores_ingredientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sabor_id UUID NOT NULL REFERENCES estoque.sabores(id) ON DELETE CASCADE,
  produto_id UUID REFERENCES estoque.produtos(id) ON DELETE CASCADE,
  grupo_substituicao_id UUID REFERENCES estoque.grupos_substituicao(id) ON DELETE CASCADE,
  quantidade NUMERIC(10,4) NOT NULL,
  unidade TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_sabor_ingrediente_ref CHECK (
    (produto_id IS NOT NULL AND grupo_substituicao_id IS NULL) OR
    (produto_id IS NULL AND grupo_substituicao_id IS NOT NULL)
  )
);

-- 8) METAS DE PRODUÇÃO (histórico da meta interativa via WhatsApp)
CREATE TABLE estoque.metas_producao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data DATE NOT NULL DEFAULT CURRENT_DATE,
  valido_ate DATE,
  qtd_pizzas_basilico NUMERIC(10,1) NOT NULL DEFAULT 0,
  qtd_pizzas_populares NUMERIC(10,1) NOT NULL DEFAULT 0,
  texto_original TEXT,
  chat_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9) MOVIMENTAÇÕES DE ESTOQUE
CREATE TABLE estoque.movimentacoes_estoque (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id UUID NOT NULL REFERENCES estoque.produtos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('contagem', 'entrada', 'saida', 'ajuste', 'producao')),
  quantidade NUMERIC(10,3) NOT NULL,
  estoque_resultante NUMERIC(10,3) NOT NULL,

  origem TEXT NOT NULL CHECK (origem IN ('foto_lista_impressa', 'foto_lista_manuscrita', 'foto_produto', 'manual', 'producao_manipulado')),
  confianca_ocr NUMERIC(3,2),
  confirmado_por TEXT,
  foto_url TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10) SUGESTÕES GERADAS (histórico dos relatórios)
CREATE TABLE estoque.sugestoes_compra (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id UUID NOT NULL REFERENCES estoque.produtos(id),
  meta_producao_id UUID REFERENCES estoque.metas_producao(id),
  tipo_acao TEXT NOT NULL CHECK (tipo_acao IN ('comprar', 'produzir')),
  quantidade_sugerida NUMERIC(10,3) NOT NULL,
  motivo TEXT,
  relatorio_data DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices
CREATE INDEX idx_produtos_tipo ON estoque.produtos(tipo);
CREATE INDEX idx_produtos_marca ON estoque.produtos(marca);
CREATE INDEX idx_movimentacoes_produto ON estoque.movimentacoes_estoque(produto_id, created_at DESC);
CREATE INDEX idx_fichas_manipulado ON estoque.fichas_tecnicas(produto_manipulado_id);
CREATE INDEX idx_itens_universais_categoria ON estoque.itens_universais(categoria, marca);
CREATE INDEX idx_sabores_ingredientes_sabor ON estoque.sabores_ingredientes(sabor_id);
CREATE INDEX idx_sugestoes_relatorio ON estoque.sugestoes_compra(relatorio_data DESC);

COMMIT;
