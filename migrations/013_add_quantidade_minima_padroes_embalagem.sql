-- Migration: Adiciona quantidade_minima em estoque.padroes_embalagem
-- Data: 2026-08-25
-- Motivo: Alguns itens têm uma compra MÍNIMA diferente do incremento
--         normal (ex: Pepperoni — mínimo de 1kg, depois sobe de 0,5 em
--         0,5kg: 1 / 1,5 / 2 / 2,5kg...). Os campos existentes
--         (peso_ou_volume_por_unidade + multiplo_minimo) só expressam
--         "múltiplos uniformes desde zero", não um piso diferente do
--         passo. Campo opcional — null preserva o comportamento atual
--         (arredonda direto pro múltiplo de peso_ou_volume_por_unidade).

BEGIN;

ALTER TABLE estoque.padroes_embalagem
  ADD COLUMN quantidade_minima NUMERIC(10,3);

COMMENT ON COLUMN estoque.padroes_embalagem.quantidade_minima IS
  'Piso de compra (mesma unidade de peso_ou_volume_por_unidade) — se a falta for <= isso, sugere exatamente esse mínimo; acima disso, soma incrementos de peso_ou_volume_por_unidade em cima do mínimo. Null = sem piso especial (comportamento padrão).';

COMMIT;
