// Import inicial do módulo de estoque a partir de Contagemxcompras.xlsx e
// FichaTécnicaPizza.xlsx (ver SPEC-estoque-manipulacao.md seção 12).
//
// Uso:
//   npm run import-estoque
//   npm run import-estoque -- --contagem="C:\caminho\Contagemxcompras.xlsx" --fichas="C:\caminho\FichaTécnicaPizza.xlsx"
//
// Por padrão usa SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY do .env deste
// projeto. Pra apontar pra OUTRO projeto Supabase (ex: o schema `estoque`
// mora no projeto de um site diferente, não no deste backend), use
// --env-file, que sobrescreve as duas env vars antes de tudo:
//   npm run import-estoque -- --env-file="C:\projetos\basilico-site\.env.local"
// (nesse caso as vars devem se chamar SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// ou NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY — ambos os nomes
// são aceitos, ver resolverCredenciaisSupabase abaixo).
//
// Idempotente: pode rodar de novo com segurança.
//   - produtos: upsert por nome. Em produtos JÁ EXISTENTES, preserva
//     estoque_atual (não sobrescreve contagem real feita depois do
//     import inicial) — só atualiza preço/unidade/observações.
//   - relações derivadas (fichas_tecnicas, itens_universais,
//     sabores_ingredientes, grupos_substituicao_membros): recriadas do
//     zero a cada run, porque são inteiramente derivadas da planilha/spec
//     (não há edição manual esperada nelas).
//
// IMPORTANTE — premissas assumidas na falta de dado explícito na spec ou
// nas planilhas (revisar com o time se algo não bater com a realidade):
//   1. "Fiambre" = presunto tipo "presuntado" das marcas populares (spec
//      seção 8 menciona "presuntado" mas a planilha de contagem não tem
//      produto com esse nome — Fiambre é o candidato mais próximo).
//   2. Basílico usa Coca-Cola/Coca-Cola Zero como refrigerante (não
//      cadastrado explicitamente na spec, mas é a única marca "premium"
//      distinta do pool populares Guaraná/Pepsi mencionado na seção 9).
//   3. Piso mínimo de segurança: 4 pizzas pros sabores salgados comuns
//      ("3-4" na spec, seção 6), 5 pro grupo doce (Chocolate ao Leite,
//      Chocolate Branco, Chocolate Meio Amargo, Nutella/Creme de Avelã).
//   4. Queijo triturado / frango desfiado / calabresa fatiada usam a
//      perda padrão de 5% da spec (seção 3) — NÃO o rendimento de
//      custeio da planilha original (que mistura perda de cozimento com
//      perda de apara/osso e dá números bem diferentes, ex: frango
//      desfiado ~25% na planilha de custo vs 5% da regra simplificada
//      de contagem).
//   5. Lacre fica de fora do cálculo automático de itens universais: a
//      spec pede 2 un/pizza, mas o produto só é contado em "rolo" e não
//      sabemos quantos lacres saem de 1 rolo — cadastrar
//      padroes_embalagem pra "Lacre" antes de incluir no motor de
//      sugestão (ver README-import-estoque.md).
import "dotenv/config";
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import * as XLSX from "xlsx";
import { getClientForSchema } from "../src/db/supabase.js";

function argValor(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found?.slice(prefix.length);
}

// Aponta pra um projeto Supabase diferente do padrão do .env deste
// backend, sobrescrevendo SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY antes de
// abrir o client — precisa rodar antes de getClientForSchema() ser chamado.
function resolverCredenciaisSupabase(): void {
  const envFile = argValor("env-file");
  if (!envFile) return;

  const parsed = loadDotenv({ path: envFile }).parsed ?? {};
  const url = parsed.SUPABASE_URL ?? parsed.NEXT_PUBLIC_SUPABASE_URL;
  const key = parsed.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(`--env-file="${envFile}" não tem SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY`);
  }
  process.env.SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  console.log(`[supabase] usando projeto de "${envFile}" (${new URL(url).host})`);
}

resolverCredenciaisSupabase();
const client = getClientForSchema("estoque");

// ── Localização dos arquivos-fonte ──────────────────────────────────────

const CAMINHO_CONTAGEM =
  argValor("contagem") ??
  process.env.ESTOQUE_CONTAGEM_XLSX ??
  path.join(process.env.USERPROFILE ?? "", "Downloads", "Contagemxcompras.xlsx");

const CAMINHO_FICHAS =
  argValor("fichas") ??
  process.env.ESTOQUE_FICHAS_XLSX ??
  path.join(process.env.USERPROFILE ?? "", "Downloads", "FichaTécnicaPizza.xlsx");

// ── Normalização de nomes (mesmo espírito de matching.ts) ───────────────

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ═══════════════════════════════════════════════════════════════════════
// PASSO 1 — Produtos base (Contagemxcompras.xlsx)
// ═══════════════════════════════════════════════════════════════════════

interface LinhaContagem {
  item: string;
  unidade: string;
  valor: number | null;
  estoque: number;
  observacoes: string | null;
}

// Produtos que a planilha de contagem já rastreia, mas que na verdade são
// o resultado de uma transformação bruto→manipulado (ver spec seção 3) —
// marcados aqui pra não ficarem com tipo='bruto' por padrão.
const MANIPULADOS_NA_CONTAGEM = new Set([
  "molho de tomate",
  "file de peito de frango desfiado",
  "linguica calabresa fatiada",
  "peito de peru c cream cheese", // pré-mistura produzida internamente (peito + cream cheese) — ver FICHAS_SEED
]);

function lerContagem(caminho: string): LinhaContagem[] {
  const wb = XLSX.readFile(caminho);
  // A segunda aba é uma cópia com data mais recente (19/08 vs 14/08) —
  // usa ela como fonte de verdade do estoque_atual inicial.
  const nomeAba = wb.SheetNames.find((n) => normalizar(n).includes("copia")) ?? wb.SheetNames[0];
  const ws = wb.Sheets[nomeAba];
  const linhas: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

  const headerIdx = linhas.findIndex((l) => l[0] === "Item");
  const resultado: LinhaContagem[] = [];

  for (let i = headerIdx + 1; i < linhas.length; i++) {
    const [item, unidade, valor, estoqueRaw, , , coluna1] = linhas[i] ?? [];
    if (!item || typeof item !== "string") continue;
    if (normalizar(item) === "responsavel") break;

    // "Estoque" às vezes vem como texto livre ("5 und maduras", "ainda tem")
    // em vez de número — nesses casos guarda 0 e deixa a observação
    // registrada, pra alguém confirmar a contagem real depois.
    let estoque = 0;
    let obsExtra: string | null = null;
    if (typeof estoqueRaw === "number") {
      estoque = estoqueRaw;
    } else if (typeof estoqueRaw === "string" && estoqueRaw.trim()) {
      obsExtra = `estoque original da planilha: "${estoqueRaw.trim()}" (confirmar contagem)`;
    }

    const observacoes = [coluna1, obsExtra].filter(Boolean).join(" — ") || null;

    resultado.push({
      item: item.trim(),
      unidade: String(unidade ?? "un").trim(),
      valor: typeof valor === "number" ? valor : null,
      estoque,
      observacoes,
    });
  }

  return resultado;
}

async function importarProdutosBase(linhas: LinhaContagem[]): Promise<Map<string, string>> {
  const idPorNomeNormalizado = new Map<string, string>();

  for (const linha of linhas) {
    const nomeFinal = RENOMEAR_PRODUTOS[linha.item] ?? linha.item;
    const chaveNormalizada = normalizar(nomeFinal);
    const tipo = MANIPULADOS_NA_CONTAGEM.has(chaveNormalizada) ? "manipulado" : "bruto";
    const id = await upsertProdutoPreservandoEstoque({
      nome: nomeFinal,
      unidade: linha.unidade,
      tipo,
      preco_unitario: linha.valor,
      estoque_atual: linha.estoque,
      observacoes: linha.observacoes,
      ativo: !PRODUTOS_DESATIVADOS.has(chaveNormalizada),
    });
    idPorNomeNormalizado.set(chaveNormalizada, id);
  }

  console.log(`[produtos] ${linhas.length} produtos importados de Contagemxcompras.xlsx`);
  return idPorNomeNormalizado;
}

// Upsert que preserva estoque_atual em produtos já existentes (não
// sobrescreve contagem real feita depois do import inicial).
async function upsertProdutoPreservandoEstoque(produto: {
  nome: string;
  unidade: string;
  tipo: "bruto" | "manipulado";
  preco_unitario?: number | null;
  estoque_atual?: number;
  estoque_minimo?: number;
  categoria?: string | null;
  marca?: "basilico" | "populares" | null;
  formato_saida?: string | null;
  observacoes?: string | null;
  ativo?: boolean; // default true — false pra produto fora do cardápio (ver PRODUTOS_DESATIVADOS)
}): Promise<string> {
  const { data: existente } = await client.from("produtos").select("id").ilike("nome", produto.nome).maybeSingle();

  if (existente) {
    const { error } = await client
      .from("produtos")
      .update({
        unidade: produto.unidade,
        tipo: produto.tipo,
        preco_unitario: produto.preco_unitario ?? null,
        categoria: produto.categoria ?? null,
        marca: produto.marca ?? null,
        formato_saida: produto.formato_saida ?? null,
        observacoes: produto.observacoes ?? null,
        ativo: produto.ativo ?? true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existente.id);
    if (error) throw new Error(`Erro ao atualizar produto "${produto.nome}": ${error.message}`);
    return existente.id;
  }

  const { data, error } = await client
    .from("produtos")
    .insert({
      nome: produto.nome,
      unidade: produto.unidade,
      tipo: produto.tipo,
      preco_unitario: produto.preco_unitario ?? null,
      estoque_atual: produto.estoque_atual ?? 0,
      estoque_minimo: produto.estoque_minimo ?? 0,
      categoria: produto.categoria ?? null,
      marca: produto.marca ?? null,
      formato_saida: produto.formato_saida ?? null,
      observacoes: produto.observacoes ?? null,
      ativo: produto.ativo ?? true,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Erro ao criar produto "${produto.nome}": ${error.message}`);
  return data.id;
}

// Produtos renomeados desde a primeira importação — roda ANTES de tudo
// (mesmo antes de ler a planilha), pra renomear a linha já existente no
// banco em vez de criar uma duplicata órfã. Chave = nome antigo (como
// ainda aparece em Contagemxcompras.xlsx), valor = nome novo.
const RENOMEAR_PRODUTOS: Record<string, string> = {
  "Caldo de Galinha 1kg": "Caldo de Galinha", // peso tirado do nome, agora vive em padroes_embalagem (confirmado: 1,01kg)
};

async function renomearProdutosLegado(): Promise<void> {
  for (const [antigo, novo] of Object.entries(RENOMEAR_PRODUTOS)) {
    const { data: existente } = await client.from("produtos").select("id, nome").ilike("nome", antigo).maybeSingle();
    if (!existente || existente.nome === novo) continue;
    const { error } = await client.from("produtos").update({ nome: novo }).eq("id", existente.id);
    if (error) throw new Error(`Erro ao renomear produto "${antigo}" -> "${novo}": ${error.message}`);
    console.log(`[produtos] renomeado: "${antigo}" -> "${novo}"`);
  }
}

// Produtos vindos de Contagemxcompras.xlsx que saíram de uso — continuam
// cadastrados (histórico) mas com ativo=false. Chave = nome normalizado.
const PRODUTOS_DESATIVADOS = new Set([
  "massa de pizza pronta", // não é mais usada como backup
  "camarao eviscerado 41 50", // sabor Camarão saiu do cardápio (confirmado)
]);

// ═══════════════════════════════════════════════════════════════════════
// PASSO 2 — Produtos novos que a planilha de contagem não tinha
// ═══════════════════════════════════════════════════════════════════════

async function importarProdutosNovos(): Promise<void> {
  const novos: Parameters<typeof upsertProdutoPreservandoEstoque>[0][] = [
    { nome: "Alho", unidade: "kg", tipo: "bruto", categoria: "hortifruti", observacoes: "criado automaticamente via import — não estava em Contagemxcompras.xlsx" },
    { nome: "Azeitona Preta sem Caroço", unidade: "kg", tipo: "bruto", categoria: "mercearia", observacoes: "criado automaticamente via import — DESATIVADO, não é mais usado (removido de todas as fichas técnicas)", ativo: false },
    { nome: "Molho Barbecue", unidade: "kg", tipo: "bruto", categoria: "molhos", observacoes: "criado automaticamente via import" },
    { nome: "Pimentão Amarelo", unidade: "kg", tipo: "bruto", categoria: "hortifruti", observacoes: "criado automaticamente via import — correção da spec (Portuguesa leva verde + amarelo)" },
    { nome: "Linguiça Calabresa", unidade: "kg", tipo: "bruto", categoria: "frios", observacoes: "insumo bruto (não fatiado) — input da transformação pra Linguiça Calabresa Fatiada" },
    { nome: "Massa de Pizza", unidade: "un", tipo: "manipulado", formato_saida: "unidade de 350g", observacoes: "manipulado — ver fichas_tecnicas. Distinto de 'Massa de Pizza Pronta' (comprada pronta como backup)" },
    { nome: "Queijo Triturado", unidade: "kg", tipo: "manipulado", formato_saida: "bobina de 200g", observacoes: "manipulado — ver fichas_tecnicas (5% de perda na trituração)" },
  ];

  for (const p of novos) {
    await upsertProdutoPreservandoEstoque(p);
  }
  console.log(`[produtos] ${novos.length} produtos novos garantidos (manipulados + insumos ausentes da planilha)`);
}

// ═══════════════════════════════════════════════════════════════════════
// PASSO 3 — Fichas técnicas (bruto → manipulado), spec seção 3
// ═══════════════════════════════════════════════════════════════════════

interface FichaSeed {
  manipulado: string;
  bruto: string;
  quantidade: number; // kg (ou un) de bruto por 1 kg (ou 1 un) de manipulado
  perdaPct?: number;
  observacoes?: string;
}

// Massa e Molho: ratios extraídos direto da ficha técnica original
// (sheets "Massa de Pizza" / "Molho de Tomate" da planilha de custo),
// batendo exatamente com os números da spec (15,4kg/10kg farinha;
// 11,11kg tomate pra 10kg útil).
const FICHAS_SEED: FichaSeed[] = [
  // Massa de Pizza — rende 44 unidades de 350g a partir de 10kg de farinha
  { manipulado: "Massa de Pizza", bruto: "Farinha de Trigo", quantidade: 10 / 44, observacoes: "10kg farinha rende 15,4kg de massa = 44 unidades de 350g" },
  { manipulado: "Massa de Pizza", bruto: "Óleo de Soja 900ml", quantidade: 0.3 / 44 },
  { manipulado: "Massa de Pizza", bruto: "Sal Moído", quantidade: 0.25 / 44 },
  { manipulado: "Massa de Pizza", bruto: "Açúcar Triturado", quantidade: 0.2 / 44 },
  { manipulado: "Massa de Pizza", bruto: "Fermento Biológico 500g", quantidade: 0.03 / 44 },

  // Molho de Tomate — rende 18kg por batelada; tomate com 10% de perda no cozimento
  { manipulado: "Molho de Tomate", bruto: "Tomate", quantidade: 11.111 / 18, perdaPct: 10, observacoes: "10% de perda no cozimento — compra 11,11kg pra render 10kg útil de tomate" },
  { manipulado: "Molho de Tomate", bruto: "Alho", quantidade: 0.1 / 18 },
  { manipulado: "Molho de Tomate", bruto: "Cebola Branca", quantidade: 0.3 / 18 },
  { manipulado: "Molho de Tomate", bruto: "Sal Moído", quantidade: 0.075 / 18 },
  { manipulado: "Molho de Tomate", bruto: "Manjericão", quantidade: 0.06 / 18 },
  { manipulado: "Molho de Tomate", bruto: "Açúcar Triturado", quantidade: 0.075 / 18 },
  // (a receita original também leva 2L de água — sem custo/estoque, não entra na ficha)

  // Perda padrão de 5% (spec seção 3) — trituração/fatiamento/desfiar
  { manipulado: "Queijo Triturado", bruto: "Queijo Mussarela", quantidade: 1 / 0.95, perdaPct: 5, observacoes: "5% de perda padrão na trituração" },
  { manipulado: "Filé de Peito de Frango Desfiado", bruto: "Filé de Peito de Frango", quantidade: 1 / 0.95, perdaPct: 5, observacoes: "5% de perda padrão no cozimento/desfiar (simplificado — planilha de custeio original usa outro rendimento, que mistura perda de apara/osso)" },
  { manipulado: "Linguiça Calabresa Fatiada", bruto: "Linguiça Calabresa", quantidade: 1 / 0.95, perdaPct: 5, observacoes: "5% de perda padrão no fatiamento" },

  // Peito de peru c/ cream cheese — pré-mistura produzida internamente,
  // reclassificada de bruto pra manipulado. Proporção tirada da própria
  // ficha técnica do sabor "Peito peru c/ Cream Cheese" (0,14kg peito +
  // 0,17kg cream cheese por pizza = 0,31kg da mistura), normalizada pra
  // "por 1kg de mistura pronta".
  { manipulado: "Peito de peru c/ cream cheese", bruto: "Peito de Peru Fatiado", quantidade: 0.14 / 0.31, observacoes: "proporção da ficha técnica do sabor Peito peru c/ Cream Cheese (0,14kg peito + 0,17kg cream cheese = 0,31kg de mistura)" },
  { manipulado: "Peito de peru c/ cream cheese", bruto: "Cream Cheese Polenghi/Catupiry", quantidade: 0.17 / 0.31, observacoes: "proporção da ficha técnica do sabor Peito peru c/ Cream Cheese (0,14kg peito + 0,17kg cream cheese = 0,31kg de mistura)" },
];

async function importarFichasTecnicas(idPorNome: Map<string, string>): Promise<void> {
  await client.from("fichas_tecnicas").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  const linhas = FICHAS_SEED.map((f) => {
    const manipuladoId = idPorNome.get(normalizar(f.manipulado));
    const brutoId = idPorNome.get(normalizar(f.bruto));
    if (!manipuladoId || !brutoId) {
      throw new Error(`Ficha técnica: produto não encontrado — "${f.manipulado}" ou "${f.bruto}"`);
    }
    return {
      produto_manipulado_id: manipuladoId,
      produto_bruto_id: brutoId,
      quantidade_bruto_por_unidade: round4(f.quantidade),
      perda_pct: f.perdaPct ?? null,
      observacoes: f.observacoes ?? null,
    };
  });

  const { error } = await client.from("fichas_tecnicas").insert(linhas);
  if (error) throw new Error(`Erro ao inserir fichas técnicas: ${error.message}`);
  console.log(`[fichas_tecnicas] ${linhas.length} transformações bruto→manipulado criadas`);
}

// ═══════════════════════════════════════════════════════════════════════
// PASSO 4 — Grupos de substituição (pool), spec seção 8 e 9
// ═══════════════════════════════════════════════════════════════════════

interface GrupoSeed {
  nome: string;
  categoria: string;
  membros: string[];
  observacoes?: string;
}

const GRUPOS_SEED: GrupoSeed[] = [
  {
    nome: "Queijo (populares)",
    categoria: "queijo",
    membros: ["Mozzana Pizza", "Queijo Mussarela"],
    observacoes: "às vezes mistura Mozzana + queijo normal, conforme fornecedor/preço da semana (spec seção 8)",
  },
  {
    nome: "Requeijão (populares)",
    categoria: "requeijao",
    membros: [
      "Requeijão 1,5kg (Genérico)",
      "Requeijão Cheddar Bisnaga Genérico 1,5kg",
      "Requeijão Cheddar Bisnaga Puranata/Catupiry 1,5kg",
      "Requeijão Puranata/Tirolez Bisnaga 1,5kg",
    ],
  },
  {
    nome: "Presunto (populares)",
    categoria: "presunto",
    membros: ["Presunto de Peru Fatiado", "Fiambre"],
    observacoes: "ASSUMIDO: Fiambre = presunto tipo \"presuntado\" citado na spec seção 8 (não há produto com esse nome exato na planilha) — confirmar com o time",
  },
  {
    nome: "Calabresa (populares)",
    categoria: "calabresa",
    membros: ["Linguiça Calabresa Fatiada"],
    observacoes: "raramente varia (spec seção 8) — hoje só 1 variante cadastrada, pool pronto pra receber uma segunda opção mais barata quando existir",
  },
  {
    nome: "Refrigerante Popular",
    categoria: "refrigerante_popular",
    membros: ["Guaraná 1L", "Pepsi 1L"],
    observacoes: "spec seção 9 cita também \"Suquinho\", que não está cadastrado em Contagemxcompras.xlsx — adicionar como membro quando existir",
  },
];

async function importarGruposSubstituicao(idPorNome: Map<string, string>): Promise<void> {
  await client.from("grupos_substituicao_membros").delete().neq("grupo_id", "00000000-0000-0000-0000-000000000000");

  for (const g of GRUPOS_SEED) {
    const { data: grupo, error } = await client
      .from("grupos_substituicao")
      .upsert({ nome: g.nome, categoria: g.categoria, observacoes: g.observacoes ?? null }, { onConflict: "nome" })
      .select("id")
      .single();
    if (error) throw new Error(`Erro ao criar grupo "${g.nome}": ${error.message}`);

    for (const nomeMembro of g.membros) {
      const produtoId = idPorNome.get(normalizar(nomeMembro));
      if (!produtoId) {
        console.warn(`  ⚠ grupo "${g.nome}": membro "${nomeMembro}" não encontrado, pulando`);
        continue;
      }
      const { error: errMembro } = await client
        .from("grupos_substituicao_membros")
        .upsert({ grupo_id: grupo.id, produto_id: produtoId }, { onConflict: "grupo_id,produto_id" });
      if (errMembro) throw new Error(`Erro ao adicionar membro "${nomeMembro}" ao grupo "${g.nome}": ${errMembro.message}`);
    }
  }
  console.log(`[grupos_substituicao] ${GRUPOS_SEED.length} pools criados`);
}

// ═══════════════════════════════════════════════════════════════════════
// PASSO 5 — Padrões de embalagem, spec seção 10
// ═══════════════════════════════════════════════════════════════════════

interface PadraoSeed {
  produto: string;
  nomePadrao: string;
  pesoOuVolumePorUnidade: number;
  multiploMinimo?: number;
  quantidadeMinima?: number; // piso de compra diferente do incremento (ex: Pepperoni — mín. 1kg, passos de 0,5kg)
  unidadesPorPadrao?: number; // pra conversão de contagem (ex: ovos por bandeja), não usado no arredondamento de compra
}

const PADROES_SEED: PadraoSeed[] = [
  { produto: "Queijo Mussarela", nomePadrao: "Barra de queijo (múltiplos de 4kg)", pesoOuVolumePorUnidade: 4, unidadesPorPadrao: 1 },
  { produto: "Requeijão 1,5kg (Genérico)", nomePadrao: "Bisnaga 1,5kg", pesoOuVolumePorUnidade: 1.5, unidadesPorPadrao: 1 },
  { produto: "Requeijão Cheddar Bisnaga Genérico 1,5kg", nomePadrao: "Bisnaga 1,5kg", pesoOuVolumePorUnidade: 1.5, unidadesPorPadrao: 1 },
  { produto: "Requeijão Cheddar Bisnaga Puranata/Catupiry 1,5kg", nomePadrao: "Bisnaga 1,5kg", pesoOuVolumePorUnidade: 1.5, unidadesPorPadrao: 1 },
  { produto: "Requeijão Puranata/Tirolez Bisnaga 1,5kg", nomePadrao: "Bisnaga 1,5kg", pesoOuVolumePorUnidade: 1.5, unidadesPorPadrao: 1 },
  { produto: "Chocolate ao Leite Harald 1,01kg", nomePadrao: "Bisnaga 1,01kg", pesoOuVolumePorUnidade: 1.01, unidadesPorPadrao: 1 },
  { produto: "Chocolate Branco Harald 1,01kg", nomePadrao: "Bisnaga 1,01kg", pesoOuVolumePorUnidade: 1.01, unidadesPorPadrao: 1 },
  { produto: "Creme de Avelã Harald 1,01kg", nomePadrao: "Bisnaga 1,01kg", pesoOuVolumePorUnidade: 1.01, unidadesPorPadrao: 1 },
  { produto: "Goiabada Pouch 2,5kg", nomePadrao: "Pouch 2,5kg", pesoOuVolumePorUnidade: 2.5, unidadesPorPadrao: 1 },
  { produto: "Linguiça Calabresa", nomePadrao: "Pacote 2,5kg (ou 5kg)", pesoOuVolumePorUnidade: 2.5, unidadesPorPadrao: 1 },
  { produto: "Filé de Peito de Frango", nomePadrao: "Pacote 2,5kg (ou 5kg)", pesoOuVolumePorUnidade: 2.5, unidadesPorPadrao: 1 },
  { produto: "Ovos (Bandeja c/30)", nomePadrao: "Bandeja com 30 ovos", pesoOuVolumePorUnidade: 30, unidadesPorPadrao: 30 },

  // Levantados em auditoria (scripts/_audit_padroes2.ts): produtos usados em
  // fichas técnicas/sabores com a necessidade expressa em kg, mas contados
  // em estoque numa unidade de embalagem — sem isso, o motor de sugestão
  // comparava kg de receita contra contagem de embalagem (ex: "0,36" vindo
  // de kg sendo lido como se já fosse bisnaga). Tamanho tirado do próprio
  // nome do produto quando disponível (ex: "900ml", "500g", "Barra 1kg").
  { produto: "Óleo de Soja 900ml", nomePadrao: "Garrafa 900ml (~0,9kg)", pesoOuVolumePorUnidade: 0.9, unidadesPorPadrao: 1 },
  { produto: "Fermento Biológico 500g", nomePadrao: "Pacote 500g", pesoOuVolumePorUnidade: 0.5, unidadesPorPadrao: 1 },
  { produto: "Tomate Seco Balde 2kg", nomePadrao: "Balde 2kg", pesoOuVolumePorUnidade: 2, unidadesPorPadrao: 1 },
  { produto: "Champignon Fatiado Balde 2kg", nomePadrao: "Balde 2kg", pesoOuVolumePorUnidade: 2, unidadesPorPadrao: 1 },
  { produto: "Salaminho 100g", nomePadrao: "Pacote 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Geleia de Amora Queensberry 320g", nomePadrao: "Pote 320g", pesoOuVolumePorUnidade: 0.32, unidadesPorPadrao: 1 },
  { produto: "Creme de Leite 200g", nomePadrao: "Caixinha 200g", pesoOuVolumePorUnidade: 0.2, unidadesPorPadrao: 1 },
  { produto: "Chocolate Meio Amargo Barra 1kg", nomePadrao: "Barra 1kg", pesoOuVolumePorUnidade: 1, unidadesPorPadrao: 1 },

  // ESTIMATIVAS — sem peso na embalagem original nem no nome do produto,
  // então o tamanho abaixo é um chute razoável (revisar com o time e
  // corrigir peso_ou_volume_por_unidade se o pacote real for diferente):
  { produto: "Manjericão", nomePadrao: "Maço (estimado ~50g — CONFIRMAR)", pesoOuVolumePorUnidade: 0.05, unidadesPorPadrao: 1 },
  { produto: "Rúcula", nomePadrao: "Maço (estimado ~50g — CONFIRMAR)", pesoOuVolumePorUnidade: 0.05, unidadesPorPadrao: 1 },

  // CONFIRMADO por pesquisa de mercado (linha de food service): "Cream
  // Cheese Polenghi" é vendido em bag de 1,5kg ou balde de 3,6kg — nunca
  // em pote pequeno. O preço já cadastrado (R$74,90) bate muito melhor
  // com o bag de 1,5kg (~R$50/kg, plausível) do que com os 300g chutados
  // antes (que dariam ~R$250/kg, preço absurdo) — usando 1,5kg.
  { produto: "Cream Cheese Polenghi/Catupiry", nomePadrao: "Bag 1,5kg (confirmado — pesquisa de mercado)", pesoOuVolumePorUnidade: 1.5, unidadesPorPadrao: 1 },

  // BASEADO EM HISTÓRICO REAL — coluna "Compras" da própria
  // Contagemxcompras.xlsx mostra a última quantidade comprada desses itens
  // fracionada bem abaixo de 1kg (achado ao investigar por que o motor de
  // sugestão estava forçando compra de 1kg inteiro pra itens caros usados
  // em quantidade mínima, ex: 25g de canela virando "comprar 1kg" =
  // R$49,90 em vez de ~R$5 — não é chute, é o que o time já compra).
  { produto: "Canela em Pó", nomePadrao: "Fração 0,1kg (histórico de compra)", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Chimichurri", nomePadrao: "Fração 0,1kg (histórico de compra)", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Peito de Peru Fatiado", nomePadrao: "Fração 0,3kg (histórico de compra)", pesoOuVolumePorUnidade: 0.3, unidadesPorPadrao: 1 },
  { produto: "Queijo Parmesão", nomePadrao: "Fração 0,2kg (histórico de compra)", pesoOuVolumePorUnidade: 0.2, unidadesPorPadrao: 1 },

  // Itens de açougue/hortifruti soltos — fracionado livre, mínimo 100g
  // (revisão manual do time, seção "Levantar itens sem padrão").
  { produto: "Queijo Gorgonzola", nomePadrao: "Fracionado, mínimo 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Castanha de Caju", nomePadrao: "Fracionado, mínimo 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Lombinho Canadense Fatiado", nomePadrao: "Fracionado, mínimo 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Bacon em Cubos", nomePadrao: "Fracionado, mínimo 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Morango", nomePadrao: "Fracionado, mínimo 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Banana Pacovan", nomePadrao: "Fracionado, mínimo 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Milho", nomePadrao: "Fracionado, mínimo 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Brócolis", nomePadrao: "Fracionado, mínimo 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Alho", nomePadrao: "Fracionado, mínimo 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Coloral", nomePadrao: "Fracionado, mínimo 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Pimentão Verde", nomePadrao: "Fracionado, mínimo 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },
  { produto: "Pimentão Amarelo", nomePadrao: "Fracionado, mínimo 100g", pesoOuVolumePorUnidade: 0.1, unidadesPorPadrao: 1 },

  // Itens de mercearia soltos — fracionado livre, mínimo 1kg (documenta
  // explicitamente o que já era o comportamento padrão pra item sem
  // padrão cadastrado — deixa de aparecer como "sem padrão" na auditoria).
  { produto: "Cebola Branca", nomePadrao: "Fracionado, mínimo 1kg", pesoOuVolumePorUnidade: 1, unidadesPorPadrao: 1 },
  { produto: "Farinha de Trigo", nomePadrao: "Fracionado, mínimo 1kg", pesoOuVolumePorUnidade: 1, unidadesPorPadrao: 1 },
  { produto: "Açúcar Triturado", nomePadrao: "Fracionado, mínimo 1kg", pesoOuVolumePorUnidade: 1, unidadesPorPadrao: 1 },
  { produto: "Sal Moído", nomePadrao: "Fracionado, mínimo 1kg", pesoOuVolumePorUnidade: 1, unidadesPorPadrao: 1 },
  { produto: "Fiambre", nomePadrao: "Fracionado, mínimo 1kg", pesoOuVolumePorUnidade: 1, unidadesPorPadrao: 1 },

  // Pepperoni: nunca compra menos de 1kg; acima disso sobe de 0,5 em
  // 0,5kg (1 / 1,5 / 2 / 2,5kg...) — precisa do campo quantidade_minima
  // (migration 013), os outros campos sozinhos não expressam "piso
  // diferente do passo".
  { produto: "Pepperoni", nomePadrao: "Mínimo 1kg, passos de 0,5kg", pesoOuVolumePorUnidade: 0.5, quantidadeMinima: 1, unidadesPorPadrao: 1 },

  // Manjericão: unidade fechada, sempre 1 maço inteiro por vez — já é o
  // comportamento padrão pra unidade discreta (maço) sem múltiplos, esse
  // registro só documenta/confirma (peso estimado ~50g, mesmo caveat de
  // antes, ver bloco ESTIMATIVAS acima — Manjericão já está lá).

  // Embalagens fechadas de tamanho fixo — arredonda pra unidades inteiras
  // da embalagem (spec seção 10).
  { produto: "Molho Barbecue", nomePadrao: "Frasco 300g", pesoOuVolumePorUnidade: 0.3, unidadesPorPadrao: 1 },
  { produto: "Mozzana Pizza", nomePadrao: "Embalagem 2kg", pesoOuVolumePorUnidade: 2, unidadesPorPadrao: 1 },
  { produto: "Doce de Leite Bisnaga 1,001kg", nomePadrao: "Bisnaga ~1kg", pesoOuVolumePorUnidade: 1.001, unidadesPorPadrao: 1 },
  { produto: "Leite Condensado 320g", nomePadrao: "Lata 320g", pesoOuVolumePorUnidade: 0.32, unidadesPorPadrao: 1 },
  {
    // renomeado de "Caldo de Galinha 1kg" (ver RENOMEAR_PRODUTOS) — CONFIRMADO
    // por pesquisa de mercado: praticamente toda marca de food service
    // (Knorr, Maggi, Tecnutri, Fazmax, Alinutri) vende caldo de galinha
    // em pacote de 1,01kg — o nome antigo já estava certo, só tirado do
    // nome do produto por preferência de cadastro.
    produto: "Caldo de Galinha",
    nomePadrao: "Pacote 1,01kg (confirmado — pesquisa de mercado)",
    pesoOuVolumePorUnidade: 1.01,
    unidadesPorPadrao: 1,
  },
  { produto: "Bobina de Impressão Fiscal", nomePadrao: "Rolo inteiro", pesoOuVolumePorUnidade: 1, unidadesPorPadrao: 1 },
];

async function importarPadroesEmbalagem(idPorNome: Map<string, string>): Promise<void> {
  await client.from("padroes_embalagem").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  const linhas = PADROES_SEED.map((p) => {
    const produtoId = idPorNome.get(normalizar(p.produto));
    if (!produtoId) throw new Error(`Padrão de embalagem: produto "${p.produto}" não encontrado`);
    return {
      produto_id: produtoId,
      nome_padrao: p.nomePadrao,
      unidades_por_padrao: p.unidadesPorPadrao ?? 1,
      peso_ou_volume_por_unidade: p.pesoOuVolumePorUnidade,
      multiplo_minimo: p.multiploMinimo ?? null,
      quantidade_minima: p.quantidadeMinima ?? null,
    };
  });

  const { error } = await client.from("padroes_embalagem").insert(linhas);
  if (error) throw new Error(`Erro ao inserir padrões de embalagem: ${error.message}`);
  console.log(`[padroes_embalagem] ${linhas.length} padrões criados`);
}

// ═══════════════════════════════════════════════════════════════════════
// PASSO 6 — Itens universais, spec seção 4
// ═══════════════════════════════════════════════════════════════════════

interface ItemUniversalSeed {
  categoria: "salgada" | "doce" | "ambas";
  refProduto?: string;
  refGrupo?: string;
  marca?: "basilico" | "populares";
  quantidade: number;
  unidade: string;
  observacoes?: string;
}

const ITENS_UNIVERSAIS_SEED: ItemUniversalSeed[] = [
  { categoria: "ambas", refProduto: "Massa de Pizza", quantidade: 1, unidade: "un", observacoes: "350g por pizza, salgada ou doce" },
  { categoria: "salgada", refProduto: "Molho de Tomate", quantidade: 0.09, unidade: "kg" },
  { categoria: "ambas", refProduto: "Queijo Triturado", marca: "basilico", quantidade: 0.2, unidade: "kg", observacoes: "Mussarela usa 250g — ver sabores.queijo_override_kg (não aplicado automaticamente, ver premissa 1 do motor de sugestão)" },
  // grupo populares preenchido depois de criar os grupos (ver ligarItensUniversaisAosPools)
  { categoria: "ambas", refProduto: "Caixa de Pizza Basílico", marca: "basilico", quantidade: 1, unidade: "un" },
  { categoria: "ambas", refProduto: "Caixa de Pizza Genérica", marca: "populares", quantidade: 1, unidade: "un" },
  { categoria: "salgada", refProduto: "Orégano", quantidade: 0.005, unidade: "kg", observacoes: "5g padrão fixo — correção da spec (planilha original tinha 50g)" },
];

async function importarItensUniversais(idPorNome: Map<string, string>): Promise<void> {
  await client.from("itens_universais").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  const { data: grupoQueijoPopulares, error: errGrupo } = await client
    .from("grupos_substituicao")
    .select("id")
    .eq("nome", "Queijo (populares)")
    .maybeSingle();
  if (errGrupo || !grupoQueijoPopulares) throw new Error("Grupo 'Queijo (populares)' não encontrado — rode importarGruposSubstituicao antes");

  const linhas = [
    ...ITENS_UNIVERSAIS_SEED.map((item) => {
      const produtoId = item.refProduto ? idPorNome.get(normalizar(item.refProduto)) : null;
      if (item.refProduto && !produtoId) throw new Error(`Item universal: produto "${item.refProduto}" não encontrado`);
      return {
        categoria: item.categoria,
        produto_id: produtoId ?? null,
        grupo_substituicao_id: null,
        marca: item.marca ?? null,
        quantidade: item.quantidade,
        unidade: item.unidade,
        observacoes: item.observacoes ?? null,
      };
    }),
    {
      categoria: "ambas",
      produto_id: null,
      grupo_substituicao_id: grupoQueijoPopulares.id,
      marca: "populares",
      quantidade: 0.2,
      unidade: "kg",
      observacoes: "pool de queijo das marcas populares (spec seção 8)",
    },
  ];

  const { error } = await client.from("itens_universais").insert(linhas);
  if (error) throw new Error(`Erro ao inserir itens universais: ${error.message}`);
  console.log(`[itens_universais] ${linhas.length} itens criados (Lacre ficou de fora — ver premissa 5 no topo do arquivo)`);
}

// ═══════════════════════════════════════════════════════════════════════
// PASSO 7 — Sabores-âncora, spec seção 5 (valores fixos, com as correções
// já aplicadas: sem azeitona na Calabresa, pimentão amarelo na Portuguesa)
// ═══════════════════════════════════════════════════════════════════════

interface IngredienteSeed {
  produto?: string;
  grupo?: string;
  quantidade: number;
  unidade: string;
}

interface SaborSeed {
  nome: string;
  tipo: "ancora" | "piso_seguranca";
  categoria: "salgada" | "doce";
  pisoMinimoPizzas?: number;
  queijoOverrideKg?: number;
  ativo?: boolean; // default true — false pra sabor fora do cardápio (ver SHEETS_DESATIVADAS)
  ingredientes: IngredienteSeed[];
}

const ANCORAS_SEED: SaborSeed[] = [
  {
    nome: "Frango Catupiry",
    tipo: "ancora",
    categoria: "salgada",
    ingredientes: [
      { produto: "Filé de Peito de Frango Desfiado", quantidade: 0.2, unidade: "kg" },
      { produto: "Requeijão 1,5kg (Genérico)", quantidade: 0.09, unidade: "kg" },
    ],
  },
  {
    nome: "Calabresa com Cebola",
    tipo: "ancora",
    categoria: "salgada",
    ingredientes: [
      { produto: "Linguiça Calabresa Fatiada", quantidade: 0.2, unidade: "kg" },
      { produto: "Cebola Branca", quantidade: 0.03, unidade: "kg" },
      // sem azeitona — correção explícita da spec seção 12 ("não usam mais")
    ],
  },
  {
    nome: "Portuguesa",
    tipo: "ancora",
    categoria: "salgada",
    ingredientes: [
      { produto: "Presunto de Peru Fatiado", quantidade: 0.18, unidade: "kg" },
      { produto: "Ovos (Bandeja c/30)", quantidade: 1, unidade: "und" },
      { produto: "Pimentão Verde", quantidade: 0.02, unidade: "kg" },
      { produto: "Pimentão Amarelo", quantidade: 0.02, unidade: "kg" }, // adicionado — correção da spec seção 12
      { produto: "Cebola Branca", quantidade: 0.08, unidade: "kg" },
    ],
  },
  {
    nome: "Mussarela",
    tipo: "ancora",
    categoria: "salgada",
    queijoOverrideKg: 0.25,
    ingredientes: [], // só o universal, com queijo em 250g em vez de 200g
  },
];

// ═══════════════════════════════════════════════════════════════════════
// PASSO 8 — Sabores piso_seguranca, extraídos de FichaTécnicaPizza.xlsx
// ═══════════════════════════════════════════════════════════════════════

// Nomes de ingrediente considerados "universais" (já cobertos por
// itens_universais) — filtrados na hora de extrair os ingredientes
// EXCLUSIVOS de cada sabor piso_seguranca (spec seção 6: "não recontar os
// universais").
const NOMES_UNIVERSAIS = new Set(["massa de pizza", "molho de tomate da casa", "queijo mussarela argentina", "oregano"]);

// Sheets da planilha que não são sabores de pizza (fichas de custeio
// auxiliares) ou que já foram seedados como transformação bruto→manipulado.
const SHEETS_IGNORADAS = new Set([
  "legenda de cores",
  "planilha de custo",
  "resumo",
  "precificacao detalhada",
  "molho de tomate",
  "massa de pizza",
  "file de peito de frango desfiad", // nome truncado da aba (limite de 31 caracteres do Excel)
  "copy of calabresa", // cópia com erro de digitação (linha "Caixa de Pizza" no meio da receita)
]);

// Sheets que correspondem aos sabores-âncora (já seedados no passo 7) —
// não duplicar como piso_seguranca.
const SHEETS_ANCORA = new Set(["frango c requeijao", "calabresa", "portuguesa", "mussarela"]);

const CATEGORIA_DOCE = new Set([
  "nutella",
  "dois amores",
  "banana com nutella",
  "banana nevada",
  "romeu e julieta",
  "morango c nutella",
  "chocolate branco",
  "chocolate ao leite",
  "chocolate meio amargo",
]);

const PISO_5_PIZZAS = new Set(["chocolate branco", "chocolate ao leite", "chocolate meio amargo", "nutella"]);

// Sabores que saíram do cardápio — continuam cadastrados (histórico/
// auditoria) mas com ativo=false, o que já os exclui automaticamente do
// motor de sugestão (listSabores() só busca ativo=true). Adicionar aqui
// em vez de simplesmente pular a aba, senão um re-import reativaria.
const SHEETS_DESATIVADAS = new Set(["camarao"]); // Camarão não é mais vendido

// Override pontual: em vez da extração genérica (ingrediente por
// ingrediente via ALIAS_INGREDIENTES), esses sabores usam uma lista fixa
// de ingredientes — caso do "Peito peru c/ Cream Cheese", cujos dois
// ingredientes exclusivos (peito + cream cheese) viraram um manipulado só
// ("Peito de peru c/ cream cheese", ver FICHAS_SEED), então o sabor passa
// a consumir 1 ingrediente (a mistura) em vez de 2 (os componentes brutos).
const INGREDIENTES_OVERRIDE: Record<string, IngredienteSeed[]> = {
  "peito peru c cream cheese": [{ produto: "Peito de peru c/ cream cheese", quantidade: 0.14 + 0.17, unidade: "kg" }],
};

// Alias: nome do ingrediente como aparece na ficha técnica (normalizado)
// → nome do produto cadastrado (como aparece em Contagemxcompras.xlsx ou
// nos produtos novos do passo 2). Curado manualmente (não é fuzzy-match)
// porque esses dados alimentam sugestão de compra real — precisão importa
// mais que automação aqui.
const ALIAS_INGREDIENTES: Record<string, string> = {
  "alho": "Alho",
  "azeitona preta s caroco": "", // DESATIVADO — não usam mais, removido de todas as fichas
  "acucar triturado": "Açúcar Triturado",
  "bacon em cubos": "Bacon em Cubos",
  "banana": "Banana Pacovan",
  "brocolis": "Brócolis",
  "caldo de galinha": "Caldo de Galinha", // renomeado — era "Caldo de Galinha 1kg" (ver RENOMEAR_PRODUTOS)
  "camarao eviscerado 41 50": "Camarão Eviscerado 41/50",
  "canela": "Canela em Pó",
  "cebola": "Cebola Branca",
  "cebola caramelizada": "Cebola Caramelizada",
  "champignon fatiado": "Champignon Fatiado Balde 2kg",
  "chimichurry": "Chimichurri",
  "chocolate ao leite": "Chocolate ao Leite Harald 1,01kg",
  "chocolate branco": "Chocolate Branco Harald 1,01kg",
  "chocolate meio amargo": "Chocolate Meio Amargo Barra 1kg",
  "coloral": "Coloral",
  "cream cheese polenghi": "Cream Cheese Polenghi/Catupiry",
  "creme de avela": "Creme de Avelã Harald 1,01kg",
  "creme de leite": "Creme de Leite 200g",
  "geleia de amora": "Geleia de Amora Queensberry 320g",
  "goiabada": "Goiabada Pouch 2,5kg",
  "linguica calabresa sadia": "Linguiça Calabresa Fatiada",
  "lombinho canadense": "Lombinho Canadense Fatiado",
  "milho": "Milho",
  "molho barbecue": "Molho Barbecue",
  "morango": "Morango",
  "ovos": "Ovos (Bandeja c/30)",
  "peito de peru sadia": "Peito de Peru Fatiado",
  "pepperoni": "Pepperoni",
  "pimentao": "Pimentão Verde",
  "presunto de peru": "Presunto de Peru Fatiado",
  "queijo gorgonzola": "Queijo Gorgonzola",
  "queijo parmesao": "Queijo Parmesão",
  "requeijao bisnaga": "Requeijão 1,5kg (Genérico)",
  "requeijao cheddar bisnaga": "Requeijão Cheddar Bisnaga Genérico 1,5kg",
  "rucula": "Rúcula",
  "salaminho": "Salaminho 100g",
  "tomate seco": "Tomate Seco Balde 2kg",
  // ingredientes que só aparecem em sheets ignoradas (base recipes) —
  // mantidos aqui só por completude, não afetam o import de sabores:
  "farinha de trigo": "Farinha de Trigo",
  "fermento biologico": "Fermento Biológico 500g",
  "file de peito de frango": "Filé de Peito de Frango",
  "file de peito de frango desfiado": "Filé de Peito de Frango Desfiado",
  "manjericao": "Manjericão",
  "sal": "Sal Moído",
  "tomate para molho": "Tomate",
  "oleo de soja": "Óleo de Soja 900ml",
  // ignorado — só aparece na sheet "Copy of Calabresa" (excluída)
  "caixa de pizza": "",
};

interface IngredienteExtraido {
  produto: string;
  qtd: number;
  unidade: string;
}

// Lê uma célula por endereço explícito (linha/coluna 1-indexados, como no
// Excel/openpyxl: A=1, B=2, C=3...). NÃO usar sheet_to_json({header:1}) pra
// esse layout: quando a coluna A de uma aba está inteiramente vazia (é o
// caso de quase toda aba de sabor nessa planilha — o conteúdo começa na
// coluna B), o SheetJS recorta a coluna A do array retornado em vez de
// preencher com null, o que desalinha todos os índices de coluna.
function celula(ws: XLSX.WorkSheet, linha: number, coluna: number): any {
  const endereco = XLSX.utils.encode_cell({ r: linha - 1, c: coluna - 1 });
  const c = ws[endereco];
  return c ? c.v : undefined;
}

function extrairSaboresDaPlanilha(caminho: string): Map<string, { referencia: string; itens: IngredienteExtraido[] }> {
  const wb = XLSX.readFile(caminho);
  const resultado = new Map<string, { referencia: string; itens: IngredienteExtraido[] }>();

  for (const nomeAba of wb.SheetNames) {
    if (SHEETS_IGNORADAS.has(normalizar(nomeAba))) continue;

    const ws = wb.Sheets[nomeAba];
    if (!ws["!ref"]) continue;
    const maxLinha = XLSX.utils.decode_range(ws["!ref"]).e.r + 1;

    // Acha a primeira linha "Referência" (bloco "Salão", a receita base —
    // ignora o bloco "Delivery" logo abaixo, que só adiciona embalagem)
    let refRow = -1;
    for (let r = 1; r <= Math.min(15, maxLinha); r++) {
      if (celula(ws, r, 2) === "Referência") {
        refRow = r;
        break;
      }
    }
    if (refRow === -1) {
      console.warn(`  ⚠ aba "${nomeAba}": não encontrou linha "Referência", pulando`);
      continue;
    }
    const referencia = String(celula(ws, refRow, 3) ?? nomeAba);

    // O cabeçalho "Cod / Produto / Quantidade Liq. / Unidade..." fica
    // algumas linhas abaixo da "Referência" — procura por segurança em
    // vez de assumir o offset fixo.
    let headerRow = -1;
    for (let r = refRow; r <= Math.min(refRow + 10, maxLinha); r++) {
      if (celula(ws, r, 3) === "Produto") {
        headerRow = r;
        break;
      }
    }
    if (headerRow === -1) {
      console.warn(`  ⚠ aba "${nomeAba}": não encontrou cabeçalho "Produto", pulando`);
      continue;
    }

    const itens: IngredienteExtraido[] = [];
    for (let r = headerRow + 1; r <= maxLinha; r++) {
      const produto = celula(ws, r, 3);
      if (produto === undefined || produto === null || String(produto).trim() === "") break;
      const qtd = celula(ws, r, 4);
      const unidade = celula(ws, r, 5);
      itens.push({ produto: String(produto).trim(), qtd: typeof qtd === "number" ? qtd : 0, unidade: String(unidade ?? "kg") });
    }

    resultado.set(nomeAba, { referencia, itens });
  }

  return resultado;
}

async function importarSaboresAncora(idPorNome: Map<string, string>): Promise<void> {
  for (const sabor of ANCORAS_SEED) {
    await criarSaborComIngredientes(sabor, idPorNome, new Map());
  }
  console.log(`[sabores] ${ANCORAS_SEED.length} sabores-âncora criados`);
}

async function importarSaboresPisoSeguranca(idPorNome: Map<string, string>, caminhoFichas: string): Promise<void> {
  const extraidos = extrairSaboresDaPlanilha(caminhoFichas);
  let criados = 0;
  let ignoradosSemMatch = 0;

  for (const [nomeAba, { referencia, itens }] of extraidos) {
    const chaveAba = normalizar(nomeAba);
    if (SHEETS_ANCORA.has(chaveAba)) continue; // já seedado no passo 7, com valores corrigidos

    const categoria: "salgada" | "doce" = CATEGORIA_DOCE.has(chaveAba) ? "doce" : "salgada";
    const nomeSabor = referencia.replace(/\s*Sal[aã]o\s*$/i, "").trim();

    const ingredientes: IngredienteSeed[] = INGREDIENTES_OVERRIDE[chaveAba] ?? [];
    if (!INGREDIENTES_OVERRIDE[chaveAba]) {
      for (const item of itens) {
        const chaveIngrediente = normalizar(item.produto);
        if (NOMES_UNIVERSAIS.has(chaveIngrediente)) continue; // já coberto por itens_universais

        const nomeProduto = ALIAS_INGREDIENTES[chaveIngrediente];
        if (nomeProduto === undefined) {
          console.warn(`  ⚠ sabor "${nomeSabor}": ingrediente "${item.produto}" sem alias cadastrado, pulando`);
          ignoradosSemMatch++;
          continue;
        }
        if (nomeProduto === "") continue; // alias marcado explicitamente pra ignorar (ex: "Caixa de Pizza")

        const produtoId = idPorNome.get(normalizar(nomeProduto));
        if (!produtoId) {
          console.warn(`  ⚠ sabor "${nomeSabor}": produto "${nomeProduto}" (alias de "${item.produto}") não encontrado na base, pulando`);
          ignoradosSemMatch++;
          continue;
        }
        ingredientes.push({ produto: nomeProduto, quantidade: item.qtd, unidade: item.unidade });
      }
    }

    const sabor: SaborSeed = {
      nome: nomeSabor,
      tipo: "piso_seguranca",
      categoria,
      pisoMinimoPizzas: PISO_5_PIZZAS.has(chaveAba) ? 5 : undefined,
      ativo: !SHEETS_DESATIVADAS.has(chaveAba),
      ingredientes,
    };

    await criarSaborComIngredientes(sabor, idPorNome, new Map());
    criados++;
  }

  console.log(`[sabores] ${criados} sabores piso_seguranca criados a partir de FichaTécnicaPizza.xlsx`);
  if (ignoradosSemMatch > 0) console.warn(`  ⚠ ${ignoradosSemMatch} ingredientes ignorados por falta de alias/match — revisar acima`);
}

async function criarSaborComIngredientes(
  sabor: SaborSeed,
  idPorNomeProduto: Map<string, string>,
  idPorNomeGrupo: Map<string, string>
): Promise<void> {
  const { data: saborRow, error } = await client
    .from("sabores")
    .upsert(
      {
        nome: sabor.nome,
        tipo: sabor.tipo,
        categoria: sabor.categoria,
        piso_minimo_pizzas: sabor.pisoMinimoPizzas ?? null,
        queijo_override_kg: sabor.queijoOverrideKg ?? null,
        ativo: sabor.ativo ?? true,
      },
      { onConflict: "nome" }
    )
    .select("id")
    .single();
  if (error) throw new Error(`Erro ao criar sabor "${sabor.nome}": ${error.message}`);

  await client.from("sabores_ingredientes").delete().eq("sabor_id", saborRow.id);

  const linhas = sabor.ingredientes.map((ing) => {
    const produtoId = ing.produto ? idPorNomeProduto.get(normalizar(ing.produto)) : null;
    const grupoId = ing.grupo ? idPorNomeGrupo.get(normalizar(ing.grupo)) : null;
    if (!produtoId && !grupoId) throw new Error(`Sabor "${sabor.nome}": ingrediente sem produto/grupo válido`);
    return {
      sabor_id: saborRow.id,
      produto_id: produtoId ?? null,
      grupo_substituicao_id: grupoId ?? null,
      quantidade: ing.quantidade,
      unidade: ing.unidade,
    };
  });

  if (linhas.length > 0) {
    const { error: errIng } = await client.from("sabores_ingredientes").insert(linhas);
    if (errIng) throw new Error(`Erro ao inserir ingredientes do sabor "${sabor.nome}": ${errIng.message}`);
  }
}

// ── Utilitário ───────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`Contagem: ${CAMINHO_CONTAGEM}`);
  console.log(`Fichas:   ${CAMINHO_FICHAS}`);
  console.log("");

  await renomearProdutosLegado();

  const linhasContagem = lerContagem(CAMINHO_CONTAGEM);
  const idPorNome = await importarProdutosBase(linhasContagem);
  await importarProdutosNovos();

  // Recarrega o mapa nome→id incluindo os produtos novos do passo 2
  const { data: todosProdutos, error } = await client.from("produtos").select("id, nome");
  if (error) throw new Error(`Erro ao recarregar produtos: ${error.message}`);
  const idPorNomeCompleto = new Map<string, string>((todosProdutos ?? []).map((p: any) => [normalizar(p.nome), p.id]));

  await importarFichasTecnicas(idPorNomeCompleto);
  await importarGruposSubstituicao(idPorNomeCompleto);
  await importarPadroesEmbalagem(idPorNomeCompleto);
  await importarItensUniversais(idPorNomeCompleto);
  await importarSaboresAncora(idPorNomeCompleto);
  await importarSaboresPisoSeguranca(idPorNomeCompleto, CAMINHO_FICHAS);

  console.log("\n✅ Import concluído.");
}

main().catch((err) => {
  console.error("\n❌ Import falhou:", err);
  process.exit(1);
});
