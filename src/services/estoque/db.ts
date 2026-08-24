// Camada de acesso a dados do módulo de estoque — mesmo padrão de
// src/db/supabase.ts, mas isolada no schema `estoque` (ver getClientForSchema).
import { getClientForSchema } from "../../db/supabase.js";
import {
  FichaTecnica,
  GrupoSubstituicao,
  ItemUniversal,
  MetaProducao,
  MovimentacaoEstoque,
  OrigemMovimentacao,
  PadraoEmbalagem,
  Produto,
  Sabor,
  SaborIngrediente,
  SugestaoCompra,
  TipoMovimentacao,
} from "./types.js";

function client() {
  return getClientForSchema("estoque");
}

// ── Produtos ─────────────────────────────────────────────────────────────

export async function listProdutos(filtro?: { tipo?: "bruto" | "manipulado"; ativo?: boolean }): Promise<Produto[]> {
  let query = client().from("produtos").select("*").order("nome", { ascending: true });
  if (filtro?.tipo) query = query.eq("tipo", filtro.tipo);
  if (filtro?.ativo !== undefined) query = query.eq("ativo", filtro.ativo);

  const { data, error } = await query;
  if (error) throw new Error(`Erro ao listar produtos: ${error.message}`);
  return (data ?? []) as Produto[];
}

export async function getProdutoPorId(id: string): Promise<Produto | null> {
  const { data, error } = await client().from("produtos").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Erro ao buscar produto: ${error.message}`);
  return data as Produto | null;
}

export async function getProdutoPorNome(nome: string): Promise<Produto | null> {
  const { data, error } = await client()
    .from("produtos")
    .select("*")
    .ilike("nome", nome)
    .maybeSingle();
  if (error) throw new Error(`Erro ao buscar produto por nome: ${error.message}`);
  return data as Produto | null;
}

export async function buscarProdutosPorNomeParcial(termo: string): Promise<Produto[]> {
  const { data, error } = await client()
    .from("produtos")
    .select("*")
    .ilike("nome", `%${termo}%`)
    .eq("ativo", true);
  if (error) throw new Error(`Erro ao buscar produtos: ${error.message}`);
  return (data ?? []) as Produto[];
}

export async function upsertProduto(produto: Partial<Produto> & { nome: string; unidade: string; tipo: string }): Promise<Produto> {
  const { data, error } = await client()
    .from("produtos")
    .upsert(produto, { onConflict: "nome" })
    .select()
    .single();
  if (error) throw new Error(`Erro ao criar/atualizar produto "${produto.nome}": ${error.message}`);
  return data as Produto;
}

export async function atualizarEstoqueAtual(produtoId: string, novoEstoque: number): Promise<void> {
  const { error } = await client()
    .from("produtos")
    .update({ estoque_atual: novoEstoque, updated_at: new Date().toISOString() })
    .eq("id", produtoId);
  if (error) throw new Error(`Erro ao atualizar estoque: ${error.message}`);
}

// ── Movimentações ────────────────────────────────────────────────────────

// Registra a movimentação E atualiza produtos.estoque_atual, mantendo os
// dois sempre em sincronia (evita ter que fazer isso em dois lugares
// diferentes na hora de gravar uma contagem via WhatsApp).
export async function registrarMovimentacao(params: {
  produtoId: string;
  tipo: TipoMovimentacao;
  quantidade: number;
  estoqueResultante: number;
  origem: OrigemMovimentacao;
  confiancaOcr?: number;
  confirmadoPor?: string;
  fotoUrl?: string;
}): Promise<MovimentacaoEstoque> {
  const { data, error } = await client()
    .from("movimentacoes_estoque")
    .insert({
      produto_id: params.produtoId,
      tipo: params.tipo,
      quantidade: params.quantidade,
      estoque_resultante: params.estoqueResultante,
      origem: params.origem,
      confianca_ocr: params.confiancaOcr ?? null,
      confirmado_por: params.confirmadoPor ?? null,
      foto_url: params.fotoUrl ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`Erro ao registrar movimentação: ${error.message}`);

  await atualizarEstoqueAtual(params.produtoId, params.estoqueResultante);

  return data as MovimentacaoEstoque;
}

// ── Padrões de embalagem ─────────────────────────────────────────────────

export async function getPadraoEmbalagem(produtoId: string): Promise<PadraoEmbalagem | null> {
  const { data, error } = await client()
    .from("padroes_embalagem")
    .select("*")
    .eq("produto_id", produtoId)
    .eq("ativo", true)
    .maybeSingle();
  if (error) throw new Error(`Erro ao buscar padrão de embalagem: ${error.message}`);
  return data as PadraoEmbalagem | null;
}

// Busca todos de uma vez (evita N round-trips quando o motor de sugestão
// precisa checar conversão de unidade pra vários produtos durante o cálculo).
export async function listPadroesEmbalagem(): Promise<PadraoEmbalagem[]> {
  const { data, error } = await client().from("padroes_embalagem").select("*").eq("ativo", true);
  if (error) throw new Error(`Erro ao listar padrões de embalagem: ${error.message}`);
  return (data ?? []) as PadraoEmbalagem[];
}

export async function upsertPadraoEmbalagem(padrao: Omit<PadraoEmbalagem, "id" | "ativo"> & { ativo?: boolean }): Promise<void> {
  const { error } = await client().from("padroes_embalagem").insert({ ...padrao, ativo: padrao.ativo ?? true });
  if (error) throw new Error(`Erro ao criar padrão de embalagem: ${error.message}`);
}

// ── Grupos de substituição (pool) ────────────────────────────────────────

export async function listGruposSubstituicao(): Promise<GrupoSubstituicao[]> {
  const { data, error } = await client().from("grupos_substituicao").select("*").order("nome");
  if (error) throw new Error(`Erro ao listar grupos de substituição: ${error.message}`);
  return (data ?? []) as GrupoSubstituicao[];
}

export async function getMembrosGrupo(grupoId: string): Promise<Produto[]> {
  const { data, error } = await client()
    .from("grupos_substituicao_membros")
    .select("produtos:produto_id(*)")
    .eq("grupo_id", grupoId);
  if (error) throw new Error(`Erro ao buscar membros do grupo: ${error.message}`);
  return (data ?? []).map((r: any) => r.produtos) as Produto[];
}

export async function upsertGrupoSubstituicao(nome: string, categoria?: string, observacoes?: string): Promise<GrupoSubstituicao> {
  const { data, error } = await client()
    .from("grupos_substituicao")
    .upsert({ nome, categoria: categoria ?? null, observacoes: observacoes ?? null }, { onConflict: "nome" })
    .select()
    .single();
  if (error) throw new Error(`Erro ao criar grupo de substituição "${nome}": ${error.message}`);
  return data as GrupoSubstituicao;
}

export async function adicionarMembroGrupo(grupoId: string, produtoId: string): Promise<void> {
  const { error } = await client()
    .from("grupos_substituicao_membros")
    .upsert({ grupo_id: grupoId, produto_id: produtoId }, { onConflict: "grupo_id,produto_id" });
  if (error) throw new Error(`Erro ao adicionar membro ao grupo: ${error.message}`);
}

// ── Fichas técnicas (bruto → manipulado) ─────────────────────────────────

export async function listFichasTecnicas(): Promise<FichaTecnica[]> {
  const { data, error } = await client().from("fichas_tecnicas").select("*");
  if (error) throw new Error(`Erro ao listar fichas técnicas: ${error.message}`);
  return (data ?? []) as FichaTecnica[];
}

export async function criarFichaTecnica(ficha: Omit<FichaTecnica, "id">): Promise<void> {
  const { error } = await client().from("fichas_tecnicas").insert(ficha);
  if (error) throw new Error(`Erro ao criar ficha técnica: ${error.message}`);
}

// ── Itens universais ─────────────────────────────────────────────────────

export async function listItensUniversais(): Promise<ItemUniversal[]> {
  const { data, error } = await client().from("itens_universais").select("*").eq("ativo", true);
  if (error) throw new Error(`Erro ao listar itens universais: ${error.message}`);
  return (data ?? []) as ItemUniversal[];
}

export async function criarItemUniversal(item: Omit<ItemUniversal, "id" | "ativo">): Promise<void> {
  const { error } = await client().from("itens_universais").insert({ ...item, ativo: true });
  if (error) throw new Error(`Erro ao criar item universal: ${error.message}`);
}

// ── Sabores ──────────────────────────────────────────────────────────────

export async function listSabores(filtro?: { tipo?: "ancora" | "piso_seguranca" }): Promise<Sabor[]> {
  let query = client().from("sabores").select("*").eq("ativo", true).order("nome");
  if (filtro?.tipo) query = query.eq("tipo", filtro.tipo);
  const { data, error } = await query;
  if (error) throw new Error(`Erro ao listar sabores: ${error.message}`);
  return (data ?? []) as Sabor[];
}

export async function criarSabor(sabor: Omit<Sabor, "id" | "ativo">): Promise<Sabor> {
  const { data, error } = await client()
    .from("sabores")
    .upsert({ ...sabor, ativo: true }, { onConflict: "nome" })
    .select()
    .single();
  if (error) throw new Error(`Erro ao criar sabor "${sabor.nome}": ${error.message}`);
  return data as Sabor;
}

export async function listIngredientesPorSabor(saborId: string): Promise<SaborIngrediente[]> {
  const { data, error } = await client().from("sabores_ingredientes").select("*").eq("sabor_id", saborId);
  if (error) throw new Error(`Erro ao listar ingredientes do sabor: ${error.message}`);
  return (data ?? []) as SaborIngrediente[];
}

export async function listTodosIngredientesSabores(): Promise<SaborIngrediente[]> {
  const { data, error } = await client().from("sabores_ingredientes").select("*");
  if (error) throw new Error(`Erro ao listar ingredientes de sabores: ${error.message}`);
  return (data ?? []) as SaborIngrediente[];
}

export async function criarIngredienteSabor(ingrediente: Omit<SaborIngrediente, "id">): Promise<void> {
  const { error } = await client().from("sabores_ingredientes").insert(ingrediente);
  if (error) throw new Error(`Erro ao criar ingrediente do sabor: ${error.message}`);
}

// ── Metas de produção ────────────────────────────────────────────────────

export async function criarMetaProducao(meta: {
  validoAte?: string;
  qtdPizzasBasilico: number;
  qtdPizzasPopulares: number;
  textoOriginal?: string;
  chatId?: string;
}): Promise<MetaProducao> {
  const { data, error } = await client()
    .from("metas_producao")
    .insert({
      valido_ate: meta.validoAte ?? null,
      qtd_pizzas_basilico: meta.qtdPizzasBasilico,
      qtd_pizzas_populares: meta.qtdPizzasPopulares,
      texto_original: meta.textoOriginal ?? null,
      chat_id: meta.chatId ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`Erro ao registrar meta de produção: ${error.message}`);
  return data as MetaProducao;
}

export async function getUltimaMetaProducao(chatId?: string): Promise<MetaProducao | null> {
  let query = client().from("metas_producao").select("*").order("created_at", { ascending: false }).limit(1);
  if (chatId) query = query.eq("chat_id", chatId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Erro ao buscar última meta de produção: ${error.message}`);
  return data as MetaProducao | null;
}

// ── Sugestões de compra (histórico) ──────────────────────────────────────

export async function registrarSugestoes(sugestoes: SugestaoCompra[]): Promise<void> {
  if (sugestoes.length === 0) return;
  const { error } = await client().from("sugestoes_compra").insert(sugestoes);
  if (error) throw new Error(`Erro ao registrar sugestões de compra: ${error.message}`);
}
