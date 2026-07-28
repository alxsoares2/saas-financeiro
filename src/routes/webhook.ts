import { Router, Request, Response } from "express";
import { ZAPIPayload } from "../types.js";
import { processar } from "../services/extracao.js";
import { calcularDRE, formatarDREWhatsApp, formatarResumoWhatsApp } from "../services/dre.js";
import { inferirGrupoDre } from "../services/grupo-dre.js";
import { sendTextMessage } from "../services/zapi.js";
import {
  isMessageProcessed,
  markMessageProcessed,
  findOrCreateCategoria,
  createLancamento,
  getLancamentosPendentes,
  getLancamentoPorCodigo,
  marcarComoPago,
  getResumoMes,
} from "../db/supabase.js";

const router = Router();

// ── Utilitários ───────────────────────────────────────────────────────────────

function validarSegredo(req: Request): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true;
  return req.headers["x-webhook-secret"] === secret;
}

function mesAtual(): { inicio: string; fim: string; label: string } {
  const now = new Date();
  const ano = now.getFullYear();
  const mes = now.getMonth() + 1;
  const inicio = `${ano}-${String(mes).padStart(2, "0")}-01`;
  const ultimo = new Date(ano, mes, 0).getDate();
  const fim = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimo).padStart(2, "0")}`;
  const label = now.toLocaleString("pt-BR", { month: "long", year: "numeric" });
  return { inicio, fim, label };
}

function parsePeriodoDRE(msg: string): { inicio: string; fim: string; label: string } | null {
  // Formato YYYY-MM
  const isoMatch = msg.match(/dre\s+(\d{4}-\d{2})/i);
  if (isoMatch) {
    const [ano, mesStr] = isoMatch[1].split("-");
    const mes = Number(mesStr);
    const inicio = `${ano}-${mesStr}-01`;
    const ultimo = new Date(Number(ano), mes, 0).getDate();
    const fim = `${ano}-${mesStr}-${String(ultimo).padStart(2, "0")}`;
    const label = new Date(Number(ano), mes - 1).toLocaleString("pt-BR", {
      month: "long",
      year: "numeric",
    });
    return { inicio, fim, label };
  }

  // Nome do mês em pt-BR
  const MESES: Record<string, string> = {
    janeiro: "01", fevereiro: "02", março: "03", marco: "03",
    abril: "04", maio: "05", junho: "06", julho: "07",
    agosto: "08", setembro: "09", outubro: "10", novembro: "11", dezembro: "12",
  };
  const nomeMes = msg.match(/dre\s+(\w+)/i)?.[1]?.toLowerCase();
  if (nomeMes && MESES[nomeMes]) {
    const ano = new Date().getFullYear();
    const mesStr = MESES[nomeMes];
    const mes = Number(mesStr);
    const inicio = `${ano}-${mesStr}-01`;
    const ultimo = new Date(ano, mes, 0).getDate();
    const fim = `${ano}-${mesStr}-${String(ultimo).padStart(2, "0")}`;
    const label = `${nomeMes} de ${ano}`;
    return { inicio, fim, label };
  }

  // Sem parâmetro → mês atual
  if (/^dre\s*$/i.test(msg.trim())) return mesAtual();

  return null;
}

function formatarData(iso?: string | null): string {
  if (!iso) return "sem data";
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

function brl(valor: number): string {
  return valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Código curto de 6 chars para identificar lançamentos no chat
function codigoCurto(id: string): string {
  return id.replace(/-/g, "").substring(0, 6).toUpperCase();
}

// ── Handlers dos comandos ─────────────────────────────────────────────────────

async function handleDRE(chatId: string, msg: string): Promise<void> {
  const periodo = parsePeriodoDRE(msg);
  if (!periodo) {
    await sendTextMessage(chatId, "Formato inválido. Use: *dre julho* ou *dre 2024-07*");
    return;
  }
  const dre = await calcularDRE(periodo.inicio, periodo.fim);
  await sendTextMessage(chatId, formatarDREWhatsApp(dre));
}

async function handleResumo(chatId: string): Promise<void> {
  const { inicio, fim, label } = mesAtual();
  const { totalReceitas, totalDespesas, totalPendentes } = await getResumoMes(inicio, fim);
  await sendTextMessage(
    chatId,
    formatarResumoWhatsApp(totalReceitas, totalDespesas, totalPendentes, label)
  );
}

async function handlePendentes(chatId: string): Promise<void> {
  const pendentes = await getLancamentosPendentes(25);

  if (pendentes.length === 0) {
    await sendTextMessage(chatId, "Nenhum lançamento pendente.");
    return;
  }

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const em7Dias = new Date(hoje);
  em7Dias.setDate(hoje.getDate() + 7);

  const vencidos: string[] = [];
  const proximos: string[] = [];
  const semData: string[] = [];

  for (const l of pendentes) {
    const codigo = codigoCurto(l.id);
    const cat = (l as any).categoria_nome ?? l.descricao;
    const valor = `R$ ${brl(Number(l.valor))}`;

    if (!l.data_vencimento) {
      semData.push(`[${codigo}] ${cat} — ${valor}`);
    } else {
      const venc = new Date(l.data_vencimento + "T00:00:00");
      const dataStr = formatarData(l.data_vencimento);
      if (venc < hoje) {
        vencidos.push(`[${codigo}] ${cat} — ${valor} — venceu ${dataStr}`);
      } else if (venc <= em7Dias) {
        proximos.push(`[${codigo}] ${cat} — ${valor} — vence ${dataStr}`);
      } else {
        semData.push(`[${codigo}] ${cat} — ${valor} — vence ${dataStr}`);
      }
    }
  }

  const totalGeral = pendentes.reduce((s, l) => s + Number(l.valor), 0);
  const linhas: string[] = ["*Contas Pendentes*", ""];

  if (vencidos.length > 0) {
    linhas.push("🔴 *Vencidos:*");
    vencidos.forEach((l) => linhas.push(`• ${l}`));
    linhas.push("");
  }
  if (proximos.length > 0) {
    linhas.push("🟡 *Vencem nos próximos 7 dias:*");
    proximos.forEach((l) => linhas.push(`• ${l}`));
    linhas.push("");
  }
  if (semData.length > 0) {
    linhas.push("🔵 *Outros:*");
    semData.forEach((l) => linhas.push(`• ${l}`));
    linhas.push("");
  }

  linhas.push(`Total: *R$ ${brl(totalGeral)}* em ${pendentes.length} lançamento(s)`);
  linhas.push("");
  linhas.push("_Para marcar como pago: *pago [código]*_");
  linhas.push("_Exemplo: pago ABC123_");

  await sendTextMessage(chatId, linhas.join("\n"));
}

async function handlePago(chatId: string, msg: string): Promise<void> {
  const match = msg.match(/^pago\s+([A-Za-z0-9]{4,8})/i);
  if (!match) {
    await sendTextMessage(
      chatId,
      "Informe o código do lançamento. Use *pendentes* para ver os códigos.\nExemplo: *pago ABC123*"
    );
    return;
  }

  const codigo = match[1].toUpperCase();
  const lancamento = await getLancamentoPorCodigo(codigo.toLowerCase());

  if (!lancamento) {
    await sendTextMessage(chatId, `Lançamento *${codigo}* não encontrado. Verifique o código.`);
    return;
  }

  if (lancamento.status === "pago") {
    await sendTextMessage(
      chatId,
      `Este lançamento já estava marcado como pago em ${formatarData(lancamento.data_pagamento)}.`
    );
    return;
  }

  await marcarComoPago(lancamento.id);

  await sendTextMessage(
    chatId,
    `✅ *Pago!*\n${lancamento.descricao}\nR$ ${brl(Number(lancamento.valor))}\nPago em: ${formatarData(new Date().toISOString().substring(0, 10))}`
  );
}

// ── Dispatcher central de comandos ───────────────────────────────────────────

async function handleComando(chatId: string, msg: string): Promise<boolean> {
  const trimmed = msg.trim();

  if (/^dre\b/i.test(trimmed)) {
    await handleDRE(chatId, trimmed);
    return true;
  }

  if (/^resumo\b/i.test(trimmed)) {
    await handleResumo(chatId);
    return true;
  }

  if (/^pendentes\b/i.test(trimmed)) {
    await handlePendentes(chatId);
    return true;
  }

  if (/^pago\b/i.test(trimmed)) {
    await handlePago(chatId, trimmed);
    return true;
  }

  if (/^(ajuda|help|\?)\s*$/i.test(trimmed)) {
    const ajuda = [
      "*Comandos disponíveis:*",
      "",
      "*Consultas:*",
      "• *resumo* — saldo rápido do mês atual",
      "• *dre* — DRE operacional do mês atual",
      "• *dre julho* — DRE de um mês específico",
      "• *dre 2024-07* — DRE por competência",
      "• *pendentes* — contas a pagar em aberto",
      "",
      "*Ações:*",
      "• *pago ABC123* — marca lançamento como pago",
      "",
      "*Lançamentos:*",
      "• Envie foto de nota fiscal, boleto ou cupom",
      "• Envie o XML da NF-e como documento",
      "• Descreva em texto: _\"paguei aluguel R$ 3.200\"_",
    ].join("\n");
    await sendTextMessage(chatId, ajuda);
    return true;
  }

  return false;
}

// ── Rota principal do webhook ─────────────────────────────────────────────────

router.post("/zapi", async (req: Request, res: Response) => {
  // Webhook SEMPRE responde 200 primeiro — erros são apenas logados
  res.status(200).json({ ok: true });

  try {
    if (!validarSegredo(req)) {
      console.warn("[Webhook] Segredo inválido, request ignorado");
      return;
    }

    const payload = req.body as ZAPIPayload;

    if (payload.fromMe) return;

    const grupoId = process.env.GRUPO_FINANCEIRO_ID;
    if (grupoId && payload.phone !== grupoId && payload.chatId !== grupoId) return;

    const messageId = payload.messageId;
    if (!messageId) return;

    if (await isMessageProcessed(messageId)) {
      console.log(`[Webhook] ${messageId} já processado`);
      return;
    }
    await markMessageProcessed(messageId);

    const chatId = payload.chatId ?? payload.phone;

    // Verifica comandos antes de tentar extrair dados financeiros
    if (payload.text?.message) {
      const isComando = await handleComando(chatId, payload.text.message);
      if (isComando) return;
    }

    // Extrai dados financeiros do documento ou texto livre
    const resultado = await processar(payload);
    if (!resultado) return;

    const { extracted, urlArquivo } = resultado;

    // Resolve categoria: busca no banco por nome; se não achar, cria com grupo inferido
    let categoriaId: string | undefined;
    if (extracted.categoria_sugerida) {
      try {
        const grupoDre = inferirGrupoDre(
          extracted.categoria_sugerida,
          extracted.tipo_lancamento
        );
        const cat = await findOrCreateCategoria(
          extracted.categoria_sugerida,
          grupoDre,
          extracted.tipo_lancamento
        );
        categoriaId = cat.id;
      } catch (err) {
        console.warn("[Webhook] Não foi possível resolver categoria:", err);
      }
    }

    const lancamento = await createLancamento(extracted, messageId, urlArquivo, categoriaId);

    const emoji = extracted.tipo_lancamento === "receita" ? "📈" : "📉";
    const confirmacao = [
      `${emoji} *${extracted.tipo_lancamento === "receita" ? "Receita" : "Despesa"} registrada!*`,
      `📋 ${extracted.descricao}`,
      `💰 R$ ${brl(Number(extracted.valor_total))}`,
      extracted.data_emissao ? `📅 Emissão: ${formatarData(extracted.data_emissao)}` : null,
      extracted.data_vencimento ? `⏰ Vencimento: ${formatarData(extracted.data_vencimento)}` : null,
      extracted.categoria_sugerida ? `🏷️ ${extracted.categoria_sugerida}` : null,
      `🔑 Código: *${codigoCurto(lancamento.id)}*`,
      extracted.confianca !== "alta"
        ? `⚠️ Confiança *${extracted.confianca}* — confira os dados.`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    await sendTextMessage(chatId, confirmacao);
  } catch (err) {
    console.error("[Webhook] Erro não tratado:", err);
  }
});

export default router;
