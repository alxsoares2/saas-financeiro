// Persistência do assistente Marcos: sessão de conversa por grupo e conta
// corrente entre lojas (tabelas da migration 014). Usa o banco da loja ativa
// (getClient lê o tenant do contexto do webhook), igual ao resto do app.
import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../../db/supabase.js";

// Conversa fica "aberta" (o Marcos ouve mensagens sem precisar do nome) até
// ficar esse tempo sem atividade.
export const JANELA_CONVERSA_MS = 10 * 60 * 1000;

export interface AcaoPendente {
  ferramenta: string;
  entrada: Record<string, unknown>;
  descricao: string; // texto gerado em código (não pela IA) — é o que o usuário confirma
}

export interface Conversa {
  id: string;
  chatId: string;
  mensagens: Anthropic.Beta.BetaMessageParam[];
  acoesPendentes: AcaoPendente[];
  ultimaAtividade: Date;
  custoUsd: number;
}

function linhaParaConversa(row: any): Conversa {
  return {
    id: row.id,
    chatId: row.chat_id,
    mensagens: JSON.parse(row.mensagens || "[]"),
    acoesPendentes: row.acoes_pendentes ? JSON.parse(row.acoes_pendentes) : [],
    ultimaAtividade: new Date(row.ultima_atividade),
    custoUsd: Number(row.custo_usd ?? 0),
  };
}

// Conversa aberta do grupo (não encerrada e com atividade dentro da janela), ou null.
export async function buscarConversaAtiva(chatId: string): Promise<Conversa | null> {
  const limite = new Date(Date.now() - JANELA_CONVERSA_MS).toISOString();
  const { data, error } = await getClient()
    .from("marcos_conversas")
    .select("*")
    .eq("chat_id", chatId)
    .eq("encerrada", false)
    .gte("ultima_atividade", limite)
    .order("ultima_atividade", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Erro ao buscar conversa do Marcos: ${error.message}`);
  return data && data.length ? linhaParaConversa(data[0]) : null;
}

export async function criarConversa(chatId: string): Promise<Conversa> {
  // Encerra qualquer conversa anterior do grupo (vencida ou não) — só uma aberta por vez.
  await getClient().from("marcos_conversas").update({ encerrada: true }).eq("chat_id", chatId).eq("encerrada", false);
  const { data, error } = await getClient().from("marcos_conversas").insert({ chat_id: chatId }).select().single();
  if (error) throw new Error(`Erro ao criar conversa do Marcos: ${error.message}`);
  return linhaParaConversa(data);
}

export async function salvarConversa(c: Conversa): Promise<void> {
  const { error } = await getClient()
    .from("marcos_conversas")
    .update({
      mensagens: JSON.stringify(c.mensagens),
      acoes_pendentes: c.acoesPendentes.length ? JSON.stringify(c.acoesPendentes) : null,
      ultima_atividade: new Date().toISOString(),
      custo_usd: Math.round(c.custoUsd * 10000) / 10000,
    })
    .eq("id", c.id);
  if (error) throw new Error(`Erro ao salvar conversa do Marcos: ${error.message}`);
}

export async function encerrarConversa(id: string): Promise<void> {
  await getClient().from("marcos_conversas").update({ encerrada: true }).eq("id", id);
}

// ── Conta corrente entre lojas ───────────────────────────────────────────────

export interface Acerto {
  id: string;
  tipo: "divida" | "pagamento";
  loja_devedora: string;
  loja_credora: string;
  valor: number;
  descricao: string;
  data: string;
  lancamento_id: string | null;
  criado_por: string | null;
}

export async function listarAcertos(lojaA: string, lojaB: string): Promise<Acerto[]> {
  const { data, error } = await getClient()
    .from("acertos_lojas")
    .select("*")
    .or(`and(loja_devedora.eq.${lojaA},loja_credora.eq.${lojaB}),and(loja_devedora.eq.${lojaB},loja_credora.eq.${lojaA})`)
    .order("data", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Erro ao listar acertos entre lojas: ${error.message}`);
  return (data ?? []).map((r: any) => ({ ...r, valor: Number(r.valor) }));
}

export async function criarAcerto(a: Omit<Acerto, "id">): Promise<Acerto> {
  const { data, error } = await getClient().from("acertos_lojas").insert(a).select().single();
  if (error) throw new Error(`Erro ao registrar acerto: ${error.message}`);
  return { ...data, valor: Number(data.valor) };
}

export async function excluirAcertosDoLancamento(lancamentoId: string): Promise<void> {
  const { error } = await getClient().from("acertos_lojas").delete().eq("lancamento_id", lancamentoId).eq("tipo", "divida");
  if (error) throw new Error(`Erro ao remover acerto do lançamento: ${error.message}`);
}

export async function definirPertenceA(lancamentoId: string, loja: string | null): Promise<void> {
  const { error } = await getClient().from("lancamentos").update({ pertence_a: loja }).eq("id", lancamentoId);
  if (error) throw new Error(`Erro ao marcar loja do lançamento: ${error.message}`);
}
