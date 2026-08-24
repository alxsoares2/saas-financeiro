-- ═══════════════════════════════════════════════════════════════
-- SCHEMA: Sistema de estoque (bruto + manipulado) via WhatsApp
-- Schema isolado `estoque`, no mesmo padrão de `financeiro`
-- (ver migrations/001_schema.sql) — não conflita com as tabelas
-- do DRE nem com as tabelas do site do restaurante.
--
-- Versão final, ajustada à luz da SPEC-estoque-manipulacao.md
-- (ver seção 11 da spec para o raciocínio de cada ajuste).
-- Aplicado via migrations/011_create_estoque_schema.sql.
-- ═══════════════════════════════════════════════════════════════

create schema if not exists estoque;

-- 1) PRODUTOS
-- Reflete as colunas: Item, Unidade, Valor (preço), Estoque, Compras
-- + campos novos necessários pro fluxo automatizado
create table estoque.produtos (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,               -- ex: "Queijo Mussarela"
  unidade text not null,                   -- kg, un, pct, bisnaga, balde, maço, bdj, rolo, pote, pouch, barra
  tipo text not null check (tipo in ('bruto', 'manipulado')),
  categoria text,                          -- opcional: "laticinios", "hortifruti", "bebidas" etc

  -- Só faz sentido pra tipo='manipulado': em qual marca esse produto é
  -- exclusivo. null = compartilhado (pool) entre Basílico e populares.
  -- Único caso real hoje é a caixa de pizza (ver grupos_substituicao pra
  -- pool de queijo/requeijão/presunto, que é uma modelagem diferente).
  marca text check (marca in ('basilico', 'populares')),

  preco_unitario numeric(10,2),            -- coluna "Valor"
  estoque_atual numeric(10,3) not null default 0,
  estoque_minimo numeric(10,3) not null default 0,  -- NÃO existe na planilha hoje — precisa ser preenchido

  fornecedor text,                         -- opcional, pra sugestão de compra por fornecedor
  formato_saida text,                      -- descritivo, ex: "bobina de 200g" (só documentação, não afeta cálculo)
  ativo boolean not null default true,
  observacoes text,                        -- equivalente à "Coluna 1" (ex: "tá usando de fiuza")

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2) PADRÕES DE EMBALAGEM
-- Regra de "5 caixas de queijo = 100 pacotes de 200g" e de arredondamento
-- de compra (embalagem do fornecedor). Configurado item por item — nunca
-- assumido automaticamente pela IA.
create table estoque.padroes_embalagem (
  id uuid primary key default gen_random_uuid(),
  produto_id uuid not null references estoque.produtos(id) on delete cascade,
  nome_padrao text not null,               -- ex: "caixa de queijo triturado 200g", "bisnaga de requeijão"
  unidades_por_padrao numeric(10,3) not null,  -- ex: 20 (pacotes por caixa), 30 (ovos por bandeja)
  peso_ou_volume_por_unidade numeric(10,3),    -- ex: 0.2 (kg por pacote), opcional
  multiplo_minimo numeric(10,3),           -- ex: 4 (queijo em barra só compra em múltiplos de 4kg)
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

-- 3) GRUPOS DE SUBSTITUIÇÃO (pool)
-- Marcas populares usam insumos intercambiáveis (queijo, requeijão,
-- presunto→presuntado, calabresa) — a checagem de estoque soma o pool
-- inteiro em vez de tratar cada variante isolada (ver spec seção 8).
create table estoque.grupos_substituicao (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,               -- ex: "Requeijão (populares)"
  categoria text,                          -- ex: "requeijao", "queijo", "presunto", "calabresa"
  observacoes text,
  created_at timestamptz not null default now()
);

create table estoque.grupos_substituicao_membros (
  grupo_id uuid not null references estoque.grupos_substituicao(id) on delete cascade,
  produto_id uuid not null references estoque.produtos(id) on delete cascade,
  primary key (grupo_id, produto_id)
);

-- 4) FICHAS TÉCNICAS — transformação bruto → manipulado
-- A "receita" de produção interna: quanto de insumo bruto vira 1 kg (ou 1
-- unidade, pra massa) de manipulado pronto. quantidade_bruto_por_unidade já
-- embute a perda/rendimento (ex: 1.05 kg de queijo em barra por 1 kg de
-- queijo triturado, considerando 5% de perda na trituração).
create table estoque.fichas_tecnicas (
  id uuid primary key default gen_random_uuid(),
  produto_manipulado_id uuid not null references estoque.produtos(id) on delete cascade,
  produto_bruto_id uuid not null references estoque.produtos(id) on delete cascade,
  quantidade_bruto_por_unidade numeric(10,4) not null,  -- kg (ou un) de bruto por 1 unidade de saída do manipulado
  perda_pct numeric(5,2),                  -- documentação: ex: 5.00 (5% de perda padrão)
  observacoes text,                        -- ex: "considera 5% de perda na trituração"
  created_at timestamptz not null default now()
);

-- 5) ITENS UNIVERSAIS — presentes em toda pizza de uma categoria
-- (salgada ou doce), independente do sabor. Evita repetir massa/molho/
-- queijo/caixa/lacre/orégano em cada linha de sabores_ingredientes.
-- Referencia produto OU grupo de substituição (nunca os dois) — quando
-- aponta pra um grupo, marca é obrigatória (pool varia por marca).
create table estoque.itens_universais (
  id uuid primary key default gen_random_uuid(),
  categoria text not null check (categoria in ('salgada', 'doce', 'ambas')),
  produto_id uuid references estoque.produtos(id) on delete cascade,
  grupo_substituicao_id uuid references estoque.grupos_substituicao(id) on delete cascade,
  marca text check (marca in ('basilico', 'populares')),  -- null = mesma regra pras duas marcas
  quantidade numeric(10,4) not null,
  unidade text not null,
  observacoes text,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint chk_item_universal_ref check (
    (produto_id is not null and grupo_substituicao_id is null) or
    (produto_id is null and grupo_substituicao_id is not null)
  )
);

-- 6) SABORES
-- 'ancora' = os 4 sabores da meta principal de produção (interativa via
-- WhatsApp, não tem piso fixo). 'piso_seguranca' = demais sabores do
-- cardápio, garante estoque mínimo dos ingredientes exclusivos.
create table estoque.sabores (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  tipo text not null check (tipo in ('ancora', 'piso_seguranca')),
  categoria text not null check (categoria in ('salgada', 'doce')),
  piso_minimo_pizzas numeric(10,1),        -- só pra tipo='piso_seguranca' (3-4 padrão, 5 pro grupo doce)
  -- Exceção pontual: Mussarela leva 250g de queijo (não os 200g universais)
  -- por ser o único ingrediente principal do sabor.
  queijo_override_kg numeric(10,3),
  ativo boolean not null default true,
  observacoes text,
  created_at timestamptz not null default now()
);

-- 7) INGREDIENTES EXCLUSIVOS DO SABOR (além dos itens universais)
create table estoque.sabores_ingredientes (
  id uuid primary key default gen_random_uuid(),
  sabor_id uuid not null references estoque.sabores(id) on delete cascade,
  produto_id uuid references estoque.produtos(id) on delete cascade,
  grupo_substituicao_id uuid references estoque.grupos_substituicao(id) on delete cascade,
  quantidade numeric(10,4) not null,
  unidade text not null,
  created_at timestamptz not null default now(),
  constraint chk_sabor_ingrediente_ref check (
    (produto_id is not null and grupo_substituicao_id is null) or
    (produto_id is null and grupo_substituicao_id is not null)
  )
);

-- 8) METAS DE PRODUÇÃO — histórico da meta interativa
-- O bot pergunta no grupo (até quando / quantas Basílico / quantas
-- populares) antes de gerar a sugestão de compra. Cada rodada fica
-- registrada aqui pra auditoria e comparação sugestão x realizado.
create table estoque.metas_producao (
  id uuid primary key default gen_random_uuid(),
  data date not null default current_date,
  valido_ate date,                         -- "até quarta" / "até o fim de semana", interpretado
  qtd_pizzas_basilico numeric(10,1) not null default 0,
  qtd_pizzas_populares numeric(10,1) not null default 0,
  texto_original text,                     -- a mensagem livre que o time mandou no grupo
  chat_id text,
  created_at timestamptz not null default now()
);

-- 9) MOVIMENTAÇÕES DE ESTOQUE
-- Histórico de toda contagem/ajuste, com origem (importante pra auditoria e pra
-- entender se veio de OCR de lista, foto de prateleira, ou ajuste manual)
create table estoque.movimentacoes_estoque (
  id uuid primary key default gen_random_uuid(),
  produto_id uuid not null references estoque.produtos(id),
  tipo text not null check (tipo in ('contagem', 'entrada', 'saida', 'ajuste', 'producao')),
  quantidade numeric(10,3) not null,
  estoque_resultante numeric(10,3) not null,

  origem text not null check (origem in ('foto_lista_impressa', 'foto_lista_manuscrita', 'foto_produto', 'manual', 'producao_manipulado')),
  confianca_ocr numeric(3,2),              -- 0.00 a 1.00, null se origem = manual
  confirmado_por text,                     -- quem confirmou no grupo, se aplicável
  foto_url text,                           -- referência à foto original, se houver

  created_at timestamptz not null default now()
);

-- 10) SUGESTÕES GERADAS (histórico dos relatórios)
-- Pra você poder comparar sugestão vs o que realmente foi comprado/produzido
create table estoque.sugestoes_compra (
  id uuid primary key default gen_random_uuid(),
  produto_id uuid not null references estoque.produtos(id),
  meta_producao_id uuid references estoque.metas_producao(id),
  tipo_acao text not null check (tipo_acao in ('comprar', 'produzir')),
  quantidade_sugerida numeric(10,3) not null,
  motivo text,                             -- ex: "abaixo do minimo" / "insumo insuficiente pra producao prevista"
  relatorio_data date not null default current_date,
  created_at timestamptz not null default now()
);

-- Índices úteis
create index idx_produtos_tipo on estoque.produtos(tipo);
create index idx_produtos_marca on estoque.produtos(marca);
create index idx_movimentacoes_produto on estoque.movimentacoes_estoque(produto_id, created_at desc);
create index idx_fichas_manipulado on estoque.fichas_tecnicas(produto_manipulado_id);
create index idx_itens_universais_categoria on estoque.itens_universais(categoria, marca);
create index idx_sabores_ingredientes_sabor on estoque.sabores_ingredientes(sabor_id);
create index idx_sugestoes_relatorio on estoque.sugestoes_compra(relatorio_data desc);
