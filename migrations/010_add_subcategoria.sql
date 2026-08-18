-- Adiciona rastreamento de subcategoria (produto específico dentro de uma
-- categoria) para itens de alto volume que o cliente quer acompanhar
-- individualmente: Filé de Peito (Aves), Filé Mignon (Bovinos), Queijo
-- Mussarela (Latícinios), Camarão (Frutos do Mar), Óleo (Óleos/Azeites/Gordura).
--
-- Fica NULL pra tudo que não é rastreado — não muda o comportamento de nada
-- que já existe, é aditivo.
--
-- Rodar no SQL Editor dos DOIS projetos Supabase (Mano e Basílico).

ALTER TABLE financeiro.lancamentos
ADD COLUMN IF NOT EXISTS subcategoria TEXT;

CREATE INDEX IF NOT EXISTS idx_lancamentos_subcategoria
  ON financeiro.lancamentos(subcategoria)
  WHERE subcategoria IS NOT NULL;
