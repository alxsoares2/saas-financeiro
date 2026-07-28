import { createClient } from "@supabase/supabase-js";
import { Categoria, ExtractedDocument, Lancamento } from "../types.js";

// SDK do Supabase não infere tipos corretamente com schemas customizados sem um
// arquivo de tipos gerado — usamos any aqui e tipamos os retornos manualmente.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getClient(): any {
  if (!_client) {
    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    if (!url || !key) throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios");
    _client = createClient(url, key, { db: { schema: "financeiro" } });
  }
  return _client;
}

export async function isMessageProcessed(messageId: string): Promise<boolean> {
  const { data } = await getClient()
    .from("mensagens_processadas")
    .select("message_id")
    .eq("message_id", messageId)
    .maybeSingle();
  return data !== null;
}

export async function markMessageProcessed(messageId: string): Promise<void> {
  await getClient()
    .from("mensagens_processadas")
    .insert({ message_id: messageId });
}

export async function findCategoria(nome: string): Promise<Categoria | null> {
  const { data } = await getClient()
    .from("categorias")
    .select("*")
    .ilike("nome", `%${nome}%`)
    .limit(1)
    .maybeSingle();
  return data as Categoria | null;
}

export async function findOrCreateCategoria(
  nome: string,
  grupoDre: string,
  tipo: "receita" | "despesa"
): Promise<Categoria> {
  const existing = await findCategoria(nome);
  if (existing) return existing;

  const { data, error } = await getClient()
    .from("categorias")
    .insert({ nome, grupo_dre: grupoDre, tipo })
    .select()
    .single();

  if (error) throw new Error(`Erro ao criar categoria: ${error.message}`);
  return data as Categoria;
}

export async function createLancamento(
  extracted: ExtractedDocument,
  messageId: string,
  urlArquivo?: string,
  categoriaId?: string
): Promise<Lancamento> {
  const { data, error } = await getClient()
    .from("lancamentos")
    .insert({
      message_id: messageId,
      tipo: extracted.tipo_lancamento,
      descricao: extracted.descricao,
      fornecedor: extracted.fornecedor,
      cnpj_cpf: extracted.cnpj_cpf,
      valor: extracted.valor_total,
      data_emissao: extracted.data_emissao ?? null,
      data_vencimento: extracted.data_vencimento ?? null,
      categoria_id: categoriaId ?? null,
      status: "pendente",
      url_arquivo: urlArquivo ?? null,
      dados_brutos: extracted,
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao criar lançamento: ${error.message}`);
  return data as Lancamento;
}

export async function getLancamentos(
  inicio: string,
  fim: string
): Promise<(Lancamento & { categoria_nome?: string; grupo_dre?: string })[]> {
  const { data, error } = await getClient()
    .from("lancamentos")
    .select(`
      *,
      categorias (
        nome,
        grupo_dre
      )
    `)
    .gte("data_emissao", inicio)
    .lte("data_emissao", fim)
    .order("data_emissao", { ascending: true });

  if (error) throw new Error(`Erro ao buscar lançamentos: ${error.message}`);

  return (data ?? []).map((row: any) => ({
    ...row,
    categoria_nome: row.categorias?.nome,
    grupo_dre: row.categorias?.grupo_dre,
  }));
}

export async function getLancamentosPendentes(limite = 30): Promise<
  (Lancamento & { categoria_nome?: string })[]
> {
  const { data, error } = await getClient()
    .from("lancamentos")
    .select("*, categorias(nome)")
    .eq("status", "pendente")
    .eq("tipo", "despesa")
    .order("data_vencimento", { ascending: true, nullsFirst: false })
    .limit(limite);

  if (error) throw new Error(`Erro ao buscar pendentes: ${error.message}`);

  return (data ?? []).map((row: any) => ({
    ...row,
    categoria_nome: row.categorias?.nome,
  }));
}

export async function marcarComoPago(id: string): Promise<boolean> {
  const hoje = new Date().toISOString().substring(0, 10);
  const { error, count } = await getClient()
    .from("lancamentos")
    .update({ status: "pago", data_pagamento: hoje })
    .eq("id", id)
    .eq("status", "pendente");

  if (error) throw new Error(`Erro ao marcar pago: ${error.message}`);
  return (count ?? 0) > 0;
}

// Busca lançamento pelo prefixo curto do UUID (primeiros 6 chars)
export async function getLancamentoPorCodigo(codigo: string): Promise<Lancamento | null> {
  const { data } = await getClient()
    .from("lancamentos")
    .select("*")
    .ilike("id", `${codigo.toLowerCase()}%`)
    .maybeSingle();

  return data as Lancamento | null;
}

export async function getResumoMes(
  inicio: string,
  fim: string
): Promise<{ totalReceitas: number; totalDespesas: number; totalPendentes: number }> {
  const { data } = await getClient()
    .from("lancamentos")
    .select("tipo, valor, status")
    .or(`data_emissao.gte.${inicio},data_emissao.lte.${fim}`);

  let totalReceitas = 0;
  let totalDespesas = 0;
  let totalPendentes = 0;

  for (const l of data ?? []) {
    if (l.tipo === "receita") totalReceitas += Number(l.valor);
    else totalDespesas += Number(l.valor);
    if (l.status === "pendente" && l.tipo === "despesa") totalPendentes += Number(l.valor);
  }

  return { totalReceitas, totalDespesas, totalPendentes };
}

export async function uploadDocument(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  const path = `${Date.now()}_${filename}`;

  const { error } = await getClient()
    .storage
    .from("documentos")
    .upload(path, buffer, { contentType: mimeType, upsert: false });

  if (error) throw new Error(`Erro ao fazer upload: ${error.message}`);

  const { data } = getClient()
    .storage
    .from("documentos")
    .getPublicUrl(path);

  return data.publicUrl;
}
