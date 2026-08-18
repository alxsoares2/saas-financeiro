-- Adiciona a categoria "Ovos" ao plano de contas (grupo CMV).
-- Não existia nenhuma categoria pra ovos, então a IA não tinha onde
-- classificar corretamente compras de ovos, e acabava usando o fallback
-- errado (caindo em "Outras Receitas" — que é receita, não despesa).
--
-- Idempotente sem depender de UNIQUE constraint em "nome" (a tabela
-- categorias não tem uma) — usa NOT EXISTS em vez de ON CONFLICT.
--
-- Rodar no SQL Editor de CADA projeto Supabase (Mano e Basílico usam o
-- mesmo plano de contas).

INSERT INTO financeiro.categorias (nome, grupo_dre, tipo)
SELECT 'Ovos', 'cmv', 'despesa'
WHERE NOT EXISTS (
  SELECT 1 FROM financeiro.categorias WHERE nome = 'Ovos'
);
