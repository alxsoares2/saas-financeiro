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
  categoriaId?: string,
  status: "pendente" | "pago" = "pendente",
  dataPagamento?: string
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
      status,
      data_pagamento: dataPagamento ?? null,
      url_arquivo: urlArquivo ?? null,
      dados_brutos: extracted,
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao criar lançamento: ${error.message}`);
  return data as Lancamento;
}

async function getCategoriaMap(): Promise<Map<string, { nome: string; grupo_dre: string }>> {
  const { data } = await getClient().from("categorias").select("id, nome, grupo_dre");
  const map = new Map<string, { nome: string; grupo_dre: string }>();
  for (const c of data ?? []) map.set(c.id, { nome: c.nome, grupo_dre: c.grupo_dre });
  return map;
}

export async function getLancamentos(
  inicio: string,
  fim: string
): Promise<(Lancamento & { categoria_nome?: string; grupo_dre?: string })[]> {
  // Usa .filter() em vez de .gte/.lte para compatibilidade com schema customizado
  const { data, error } = await getClient()
    .from("lancamentos")
    .select("id, tipo, descricao, fornecedor, valor, data_emissao, data_vencimento, data_pagamento, categoria_id, status")
    .filter("data_emissao", "gte", inicio)
    .filter("data_emissao", "lte", fim);

  if (error) throw new Error(`Erro ao buscar lançamentos: ${error.message}`);

  const cats = await getCategoriaMap().catch(() => new Map());

  return (data ?? [])
    .sort((a: any, b: any) => (a.data_emissao ?? "").localeCompare(b.data_emissao ?? ""))
    .map((row: any) => ({
      ...row,
      categoria_nome: cats.get(row.categoria_id)?.nome,
      grupo_dre: cats.get(row.categoria_id)?.grupo_dre,
    }));
}

export async function getLancamentosPendentes(limite = 30): Promise<
  (Lancamento & { categoria_nome?: string })[]
> {
  const [{ data, error }, cats] = await Promise.all([
    getClient()
      .from("lancamentos")
      .select("*")
      .eq("status", "pendente")
      .eq("tipo", "despesa")
      .order("data_vencimento", { ascending: true, nullsFirst: false })
      .limit(limite),
    getCategoriaMap(),
  ]);

  if (error) throw new Error(`Erro ao buscar pendentes: ${error.message}`);

  return (data ?? []).map((row: any) => ({
    ...row,
    categoria_nome: cats.get(row.categoria_id)?.nome,
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
export async function getLancamentosRecentes(limite = 8): Promise<
  (Lancamento & { categoria_nome?: string })[]
> {
  const [{ data, error }, cats] = await Promise.all([
    getClient()
      .from("lancamentos")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limite),
    getCategoriaMap(),
  ]);

  if (error) throw new Error(`Erro ao buscar recentes: ${error.message}`);
  return (data ?? []).map((row: any) => ({
    ...row,
    categoria_nome: cats.get(row.categoria_id)?.nome,
  }));
}

export async function excluirLancamento(id: string): Promise<boolean> {
  const { error, count } = await getClient()
    .from("lancamentos")
    .delete()
    .eq("id", id);

  if (error) throw new Error(`Erro ao excluir: ${error.message}`);
  return (count ?? 1) >= 0;
}

export async function atualizarDataEmissao(id: string, dataEmissao: string): Promise<boolean> {
  const { error, count } = await getClient()
    .from("lancamentos")
    .update({ data_emissao: dataEmissao })
    .eq("id", id);

  if (error) throw new Error(`Erro ao atualizar data: ${error.message}`);
  return (count ?? 1) >= 0;
}

export async function getLancamentoPorCodigo(codigo: string): Promise<Lancamento | null> {
  const prefix = codigo.toLowerCase();
  // ilike em coluna UUID não funciona direto — filtra nos últimos 200 e compara em JS
  const { data } = await getClient()
    .from("lancamentos")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (!data) return null;
  return (data.find((row: any) =>
    (row.id as string).replace(/-/g, "").toLowerCase().startsWith(prefix)
  ) ?? null) as Lancamento | null;
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

// Busca pendentes que podem corresponder a um comprovante de pagamento
// Filtra por categoria (se disponível) e valor próximo (±25%)
export async function buscarPendentesCorrespondentes(
  categoriaId: string | undefined,
  valor: number,
  limite = 5
): Promise<(Lancamento & { categoria_nome?: string })[]> {
  const min = valor * 0.75;
  const max = valor * 1.25;

  let query = getClient()
    .from("lancamentos")
    .select("*")
    .eq("status", "pendente")
    .eq("tipo", "despesa")
    .gte("valor", min)
    .lte("valor", max)
    .order("data_vencimento", { ascending: true, nullsFirst: false })
    .limit(limite);

  if (categoriaId) query = query.eq("categoria_id", categoriaId);

  const { data, error } = await query;
  if (error) throw new Error(`Erro ao buscar pendentes: ${error.message}`);

  const cats = await getCategoriaMap().catch(() => new Map());
  return (data ?? []).map((row: any) => ({
    ...row,
    categoria_nome: cats.get(row.categoria_id)?.nome,
  }));
}

export async function atualizarCategoria(id: string, categoriaId: string): Promise<boolean> {
  const { error, count } = await getClient()
    .from("lancamentos")
    .update({ categoria_id: categoriaId })
    .eq("id", id);

  if (error) throw new Error(`Erro ao atualizar categoria: ${error.message}`);
  return (count ?? 1) >= 0;
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

// ============================================================================
// MATCHING FUNCTIONS (PASSO 1, 2, 3)
// ============================================================================

interface LancamentoComSaldo extends Lancamento {
  saldo: number;
  categoria_nome?: string;
}

export async function buscarExato(
  saldo: number,
  fornecedor?: string,
  categoriaId?: string
): Promise<LancamentoComSaldo | null> {
  let query = getClient()
    .from("lancamentos")
    .select("*")
    .eq("status", "pendente")
    .eq("tipo", "despesa")
    .eq("valor", saldo);

  if (fornecedor) query = query.eq("fornecedor", fornecedor);
  if (categoriaId) query = query.eq("categoria_id", categoriaId);

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error(`Erro ao buscar exato: ${error.message}`);

  if (!data) return null;

  const cats = await getCategoriaMap().catch(() => new Map());
  return {
    ...data,
    saldo: Number(data.valor) - Number(data.valor_pago || 0),
    categoria_nome: cats.get(data.categoria_id)?.nome,
  };
}

export async function encontrarCombinacoes(
  valor: number,
  fornecedor?: string,
  categoriaId?: string,
  limite = 8
): Promise<LancamentoComSaldo[]> {
  let query = getClient()
    .from("lancamentos")
    .select("*")
    .eq("status", "pendente")
    .eq("tipo", "despesa")
    .lte("valor", valor)
    .order("valor", { ascending: false })
    .limit(limite * 2);

  if (fornecedor) query = query.eq("fornecedor", fornecedor);
  if (categoriaId) query = query.eq("categoria_id", categoriaId);

  const { data, error } = await query;
  if (error) throw new Error(`Erro ao buscar combinações: ${error.message}`);

  const cats = await getCategoriaMap().catch(() => new Map());
  return (data ?? []).map((l: any) => ({
    ...l,
    saldo: Number(l.valor) - Number(l.valor_pago || 0),
    categoria_nome: cats.get(l.categoria_id)?.nome,
  }));
}

export async function buscarFuzzy(
  saldo: number,
  fornecedor?: string,
  categoriaId?: string,
  limite = 5
): Promise<LancamentoComSaldo[]> {
  const min = saldo * 0.75;
  const max = saldo * 1.25;

  let query = getClient()
    .from("lancamentos")
    .select("*")
    .eq("status", "pendente")
    .eq("tipo", "despesa")
    .gte("valor", min)
    .lte("valor", max)
    .order("data_vencimento", { ascending: true, nullsFirst: false })
    .limit(limite);

  if (fornecedor) query = query.eq("fornecedor", fornecedor);
  if (categoriaId) query = query.eq("categoria_id", categoriaId);

  const { data, error } = await query;
  if (error) throw new Error(`Erro ao buscar fuzzy: ${error.message}`);

  const cats = await getCategoriaMap().catch(() => new Map());
  return (data ?? []).map((l: any) => ({
    ...l,
    saldo: Number(l.valor) - Number(l.valor_pago || 0),
    categoria_nome: cats.get(l.categoria_id)?.nome,
  }));
}

// ============================================================================
// PARTIAL PAYMENT FUNCTIONS
// ============================================================================

export async function marcarComoPagoParcial(
  id: string,
  valorPago: number,
  messageId?: string
): Promise<boolean> {
  const { data: lancamento, error: fetchError } = await getClient()
    .from("lancamentos")
    .select("valor, valor_pago, data_primeiro_pagamento")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) throw new Error(`Erro ao buscar lançamento: ${fetchError.message}`);
  if (!lancamento) return false;

  const novoValorPago = Number(lancamento.valor_pago || 0) + valorPago;
  const saldoAnterior = Number(lancamento.valor) - Number(lancamento.valor_pago || 0);
  const saldoNovo = saldoAnterior - valorPago;
  const hoje = new Date().toISOString().substring(0, 10);

  const novoStatus = novoValorPago >= Number(lancamento.valor) ? "pago" : "pago_parcialmente";

  const { error: updateError } = await getClient()
    .from("lancamentos")
    .update({
      valor_pago: novoValorPago,
      status: novoStatus,
      data_pagamento: hoje,
      data_primeiro_pagamento: lancamento.data_primeiro_pagamento || hoje,
    })
    .eq("id", id);

  if (updateError) throw new Error(`Erro ao atualizar lançamento: ${updateError.message}`);

  const { error: auditError } = await getClient()
    .from("baixas_parciais")
    .insert({
      lancamento_id: id,
      valor_pago: valorPago,
      saldo_anterior: saldoAnterior,
      saldo_novo: saldoNovo,
      data_pagamento: hoje,
      message_id: messageId || null,
    });

  if (auditError) throw new Error(`Erro ao registrar auditoria: ${auditError.message}`);
  return true;
}

export async function marcarComoPagoMultiplo(
  ids: string[],
  messageId?: string
): Promise<boolean> {
  const hoje = new Date().toISOString().substring(0, 10);

  const { error: updateError } = await getClient()
    .from("lancamentos")
    .update({
      status: "pago",
      valor_pago: 0,
      data_pagamento: hoje,
    })
    .in("id", ids)
    .eq("status", "pendente");

  if (updateError) throw new Error(`Erro ao marcar múltiplos como pago: ${updateError.message}`);

  for (const id of ids) {
    const { data: lancamento } = await getClient()
      .from("lancamentos")
      .select("valor, valor_pago")
      .eq("id", id)
      .maybeSingle();

    if (lancamento) {
      const valor = Number(lancamento.valor);
      const valorPago = Number(lancamento.valor_pago || 0);

      await getClient()
        .from("baixas_parciais")
        .insert({
          lancamento_id: id,
          valor_pago: valor - valorPago,
          saldo_anterior: valor - valorPago,
          saldo_novo: 0,
          data_pagamento: hoje,
          message_id: messageId || null,
        });
    }
  }

  return true;
}

// ============================================================================
// COMBINATION CONFIRMATION FUNCTIONS
// ============================================================================

export async function criarCombinacaoConfirmacao(
  lancamentoIds: string[],
  valorTotal: number,
  chatId: string
): Promise<string> {
  const { data, error } = await getClient()
    .from("combinacoes_confirmacao")
    .insert({
      chat_id: chatId,
      lancamento_ids: lancamentoIds,
      valor_total: valorTotal,
      status: "aguardando_confirmacao",
    })
    .select("id")
    .single();

  if (error) throw new Error(`Erro ao criar confirmação: ${error.message}`);
  return data.id;
}

export async function confirmarCombinacao(combId: string): Promise<boolean> {
  const { data: comb, error: fetchError } = await getClient()
    .from("combinacoes_confirmacao")
    .select("lancamento_ids")
    .eq("id", combId)
    .maybeSingle();

  if (fetchError) throw new Error(`Erro ao buscar combinação: ${fetchError.message}`);
  if (!comb) return false;

  const hoje = new Date().toISOString().substring(0, 10);

  const { error: updateError } = await getClient()
    .from("combinacoes_confirmacao")
    .update({
      status: "confirmada",
      confirmado_em: new Date().toISOString(),
    })
    .eq("id", combId);

  if (updateError) throw new Error(`Erro ao confirmar: ${updateError.message}`);

  await marcarComoPagoMultiplo(comb.lancamento_ids);

  return true;
}

export async function cancelarCombinacao(combId: string): Promise<boolean> {
  const { error } = await getClient()
    .from("combinacoes_confirmacao")
    .update({
      status: "cancelada",
      confirmado_em: new Date().toISOString(),
    })
    .eq("id", combId);

  if (error) throw new Error(`Erro ao cancelar: ${error.message}`);
  return true;
}

// ============================================================================
// NON-RECONCILED COMPROVANTES FUNCTIONS
// ============================================================================

export async function criarNaoConciliado(
  valor: number,
  fornecedor?: string,
  categoriaSugerida?: string,
  dadosBrutos?: any,
  urlArquivo?: string
): Promise<string> {
  const { data, error } = await getClient()
    .from("comprovantes_nao_conciliados")
    .insert({
      valor,
      fornecedor: fornecedor || null,
      categoria_sugerida: categoriaSugerida || null,
      dados_brutos: dadosBrutos || null,
      url_arquivo: urlArquivo || null,
      status: "nao_conciliado",
      data_recebimento: new Date().toISOString().substring(0, 10),
    })
    .select("id")
    .single();

  if (error) throw new Error(`Erro ao criar não conciliado: ${error.message}`);
  return data.id;
}

export async function listarNaoConciliados(): Promise<any[]> {
  const { data, error } = await getClient()
    .from("comprovantes_nao_conciliados")
    .select("*")
    .eq("status", "nao_conciliado")
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Erro ao listar não conciliados: ${error.message}`);
  return data ?? [];
}

export async function conciliarNaoConciliado(
  ncId: string,
  categoriaId: string,
  messageId?: string
): Promise<boolean> {
  const { data: nc, error: fetchError } = await getClient()
    .from("comprovantes_nao_conciliados")
    .select("valor, fornecedor, dados_brutos, url_arquivo")
    .eq("id", ncId)
    .maybeSingle();

  if (fetchError) throw new Error(`Erro ao buscar não conciliado: ${fetchError.message}`);
  if (!nc) return false;

  const hoje = new Date().toISOString().substring(0, 10);

  const extracted: ExtractedDocument = {
    tipo_lancamento: "despesa",
    valor_total: nc.valor,
    descricao: `Conciliado de ${ncId}`,
    fornecedor: nc.fornecedor || "Não informado",
    cnpj_cpf: null,
    data_emissao: hoje,
    data_vencimento: null,
    ...(nc.dados_brutos || {}),
  };

  const lancamento = await createLancamento(
    extracted,
    messageId || `nc-${ncId}`,
    nc.url_arquivo || undefined,
    categoriaId,
    "pago",
    hoje
  );

  const { error: updateError } = await getClient()
    .from("comprovantes_nao_conciliados")
    .update({
      status: "conciliado",
      lancamento_conciliado_id: lancamento.id,
      resolvido_em: new Date().toISOString(),
    })
    .eq("id", ncId);

  if (updateError) throw new Error(`Erro ao atualizar status: ${updateError.message}`);
  return true;
}

export async function descartarNaoConciliado(ncId: string): Promise<boolean> {
  const { error } = await getClient()
    .from("comprovantes_nao_conciliados")
    .update({
      status: "descartado",
      resolvido_em: new Date().toISOString(),
    })
    .eq("id", ncId);

  if (error) throw new Error(`Erro ao descartar: ${error.message}`);
  return true;
}
