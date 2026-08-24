# Spec: Sistema de Estoque e Manipulação (WhatsApp + Supabase)

Reaproveita o padrão do projeto `Saas Financeiro` (Z-API + Supabase + Puppeteer/pdfkit,
ver `src/services/dre.ts`, `grupo-dre.ts`, `pdf-dre.ts`, `relatorio.ts` como referência de estilo).

Sugestão de módulo: `src/services/estoque/`

---

## 1. Contexto do negócio

Pizzaria com múltiplas marcas vendidas em paralelo:
- **Basílico** — marca premium
- **Vai de Pizza, Casarão da Pizza, Esfiha** — marcas populares (mesma cozinha, insumos mais baratos em alguns itens)

Estoque em dois níveis:
- **Bruto**: comprado direto de fornecedor (ex: tomate, farinha, queijo em barra, frango cru)
- **Manipulado**: produzido internamente a partir de brutos (ex: molho, massa, queijo triturado, frango desfiado)

Fonte de dados existente: planilha `Contagemxcompras.xlsx` (produtos, unidades, preços) e
`FichaTécnicaPizza.xlsx` (fichas técnicas por sabor — usar como seed inicial dos dados).

---

## 2. Fluxo de contagem (entrada de dados)

Grupo do WhatsApp recebe fotos que podem ser:
1. **Lista impressa/digitada** — OCR direto, alta confiança
2. **Lista manuscrita** — OCR + sempre pedir confirmação no grupo antes de gravar
3. **Foto de produto físico** — visão computacional:
   - Se o item tem **padrão de caixa/embalagem cadastrado** (configurado por item, nunca assumido
     automaticamente pela IA) → conta unidades da embalagem e multiplica
     (ex: "5 caixas de queijo triturado = 100 pacotes de 200g")
   - Se não tem padrão → tenta contar direto, confiança mais baixa, sempre confirma no grupo

**Ordem do fluxo**: sempre contagem de estoque primeiro → depois gerar sugestão de compra.

---

## 3. Transformações bruto → manipulado (fichas técnicas base)

| Manipulado | Insumo bruto | Perda/rendimento | Formato de saída |
|---|---|---|---|
| Massa de pizza | Farinha + óleo + sal + açúcar + fermento | rende 15,4kg / 10kg farinha | unidades de 350g |
| Molho de tomate | Tomate + alho + cebola + sal + manjericão + açúcar + água | 10% de perda no cozimento (compra 11,11kg pra render 10kg útil) | a granel, kg (armazenado em pote) |
| Queijo triturado | Queijo mussarela em barra | **5% de perda padrão** (trituração) | bobina de 200g |
| Frango desfiado | Filé de peito de frango cru | **5% de perda padrão** (cozimento/desfiar) | bobina de 100g (meia pizza) / 200g (pizza inteira) |
| Calabresa fatiada | Linguiça calabresa | **5% de perda padrão** (fatiamento) | bobina de 100g (meia pizza) / 200g (pizza inteira) |

Regra geral: perda de 5% é a margem de segurança padrão pra queijo, calabresa e frango — erra
para mais (compra um pouco a mais) em vez de faltar.

---

## 4. Ficha técnica por pizza — itens universais

Presentes em toda pizza salgada:

| Item | Quantidade |
|---|---|
| Massa | 350g |
| Molho de tomate | 90g |
| Queijo triturado | 200g (**Mussarela: 250g**, intencional — único ingrediente principal) |
| Caixa de pizza | 1 un (Basílico usa caixa própria; populares compartilham caixa genérica — mas pode variar por disponibilidade, o time informa quando muda) |
| Lacre | 2 un |
| Orégano | 5g (padrão fixo pra todos os sabores — controle de estoque simples, sem entrar no cálculo fino de "quanto falta pra meta", só alerta quando estoque geral está baixo) |

## 5. Sabores-âncora (usados na meta principal de produção)

| Sabor | Extras (além do universal) |
|---|---|
| Frango Catupiry (= "Frango c/ requeijão" na ficha técnica) | Frango desfiado 200g + requeijão 90g |
| Calabresa com Cebola | Calabresa fatiada 200g + cebola 30g |
| Portuguesa | Presunto de peru 180g + ovo 1un + pimentão verde 20g + pimentão amarelo 20g + cebola 80g |
| Mussarela | Só o universal (queijo 250g) |

## 6. Piso de segurança — demais sabores do cardápio

Pra qualquer sabor ativo no cardápio que **não** seja âncora, garantir estoque mínimo dos
**ingredientes exclusivos daquele sabor** (não recontar os universais, que já são cobertos pela
meta principal) pra no mínimo **3-4 pizzas**.

Exemplos concretos discutidos:
- Lombo c/ Catupiry: requeijão já coberto pelo Frango Catupiry; só precisa checar **lombo canadense** pra 3-4 pizzas
- Royale Basílico: só precisa checar **geleia de amora** pra 3-4 pizzas (vem em unidade de 250g,
  arredonda pra cima — se passar do mínimo com 1 unidade, não compra mais, mesmo que sobre)
- Sabores de chocolate/doce (Chocolate ao Leite, Branco, Meio Amargo, Nutella/Creme de Avelã):
  piso mais alto, mínimo de **5 pizzas** (é o grupo doce que mais vende) — **a confirmar**: se é
  o mais vendido entre os 4 que recebe o piso de 5, ou se é a soma dos 4 juntos

---

## 7. Meta principal de produção (interativa via WhatsApp)

**Não é fixa.** O bot pergunta no grupo, antes de gerar a sugestão de compra:
1. Até quando é a compra (ex: até quarta / até o fim de semana)
2. Quantas pizzas Basílico (premium) garantir nesse período
3. Quantas pizzas das marcas populares garantir nesse período

A resposta pode ser texto livre (ex: "30 pra quarta") — o bot interpreta e roda o cálculo com
esses parâmetros. A distribuição entre os 4 sabores-âncora dentro da meta é o componente
"aleatório" — o sistema não tenta prever a proporção exata por sabor, só garante que os
universais cubram o total pedido.

---

## 8. Marcas populares — insumos substituíveis (pool compartilhado)

A maioria dos ingredientes é **idêntica** entre marca premium e populares (massa, molho, frango,
lombo, parmesão etc). Só um grupo pequeno varia conforme fornecedor/preço da semana:

- Queijo (às vezes mistura Mozzana + queijo normal, às vezes queijo mais barato)
- Requeijão (Genérico / Cheddar Genérico / Cheddar Puranata-Catupiry / Puranata-Tirolez — todos
  cadastrados como produtos distintos e **ativos simultaneamente**)
- Presunto → presuntado (marcas populares usam presuntado, não presunto)
- Calabresa (raramente varia — ~30% das vezes tem opção mais barata)

**Regra de cálculo**: tratar como **pool somado**, não estoques isolados por marca. Ex: se há 4
variantes de requeijão cadastradas, o sistema soma o estoque das 4 pra checar se cobre a
necessidade total (Basílico + populares). Não força qual variante comprar — só avisa
"falta X kg de requeijão no total pro volume de pizza pedido", e a decisão de qual variante
comprar fica com o time.

**Caixa de pizza é exceção**: não é pool — Basílico tem caixa própria fixa (`Caixa de Pizza
Basílico`), as populares compartilham uma caixa genérica (`Caixa de Pizza Genérica`).

---

## 9. Refrigerante (vinculado à quantidade de pizza, mas separado por marca)

- **Basílico**: sugerir refrigerante = **60% da quantidade de pizzas** pedida. Proporção
  normal/zero **assumida automaticamente pelo bot** (definir um padrão razoável, ex 2:1 — a
  confirmar valor exato com o cliente se necessário, ele indicou que "o bot já assume").
- **Marcas populares**: sugerir refrigerante = **70% da quantidade de pizzas** pedida, sempre o
  **mais barato disponível no momento** (Guaraná, Pepsi, Suquinho — tratados como pool genérico
  "refrigerante popular", sem distinção de marca na sugestão).

---

## 10. Regras de arredondamento de compra (embalagem do fornecedor)

A sugestão de compra **nunca** sugere quantidade fracionada abaixo do tamanho de embalagem do
fornecedor — sempre arredonda pra cima. É sugestão, a decisão final de acatar ou não é do time.

| Categoria | Tamanho de compra padrão | Regra |
|---|---|---|
| Queijo (barra) | 4kg | Múltiplos de 4 (4, 8, 12...) — comprar 6 sai caro, não é opção viável |
| Requeijão / Cheddar / Cream Cheese / Chocolate | bisnaga ~1,5-1,7kg | 1 bisnaga por vez, arredonda pra cima |
| Calabresa / Frango | pacote 2,5kg ou 5kg | 1 pacote por vez, arredonda pra cima |
| Itens soltos (tomate, cebola, farinha, hortifruti) | — | Fracionado normal, por peso ou unidade — sem arredondamento de embalagem |

Isso é modelado pela tabela `padroes_embalagem` (ver schema) — cada produto com embalagem fixa
tem seu tamanho cadastrado, e o motor de sugestão arredonda pra cima usando esse valor. Itens
sem padrão cadastrado seguem fracionado livre.

---

## 11. Schema Supabase (rascunho — ajustar durante implementação)

Ver `schema-estoque.sql` gerado anteriormente como ponto de partida. Ajustes necessários à luz
desta spec:
- `produtos` precisa de campo `marca` ou tabela de associação produto↔marca (Basílico vs
  populares), já que caixa de pizza é 1:1 com marca mas a maioria dos itens não é
- `fichas_tecnicas` precisa suportar "grupo de substituição" pro pool de requeijão/queijo/presunto
  das marcas populares — sugestão: tabela `grupos_substituicao` com produtos-membro, e a ficha
  técnica referencia o grupo em vez do produto individual quando aplicável
- `padroes_embalagem` já cobre o arredondamento de compra (embalagem de fornecedor), incluindo o
  caso "múltiplo de 4kg" do queijo (campo extra `multiplo_minimo` se necessário)
- Adicionar tabela ou campo pra registrar a **meta interativa** de cada rodada de sugestão
  (data, período, qtd pizzas Basílico, qtd pizzas populares) — histórico de "pedidos ao bot"

---

## 12. Import inicial de dados

Migrar de `Contagemxcompras.xlsx` (produtos base, nomes/unidades/preços) e
`FichaTécnicaPizza.xlsx` (fichas técnicas por sabor, já usada como fonte pras tabelas acima) —
ambos os arquivos já foram analisados e as regras de negócio extraídas estão nesta spec.

Correções já aplicadas em relação aos dados brutos da planilha original:
- Orégano: era 50g em quase toda ficha, correto é **5g padrão**
- Calabresa: remover azeitona (não usam mais)
- Portuguesa: adicionar pimentão amarelo 20g (além do verde 20g já existente)
