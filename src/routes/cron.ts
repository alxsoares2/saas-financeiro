import { Router, Request, Response } from "express";
import * as supabase from "../db/supabase.js";

const router = Router();

// ============================================================================
// HELPERS
// ============================================================================

function obterUltimoDiaDoMes(ano: number, mes: number): number {
  return new Date(ano, mes + 1, 0).getDate();
}

function calcularVencimento(ano: number, mes: number, diaDesejado: number): Date {
  const ultimoDia = obterUltimoDiaDoMes(ano, mes);
  const diaReal = Math.min(diaDesejado, ultimoDia);
  return new Date(ano, mes, diaReal);
}

// ============================================================================
// MIDDLEWARE: Validar CRON_SECRET
// ============================================================================

function validarCronSecret(req: Request, res: Response, next: () => void): void {
  const headerAuth = req.headers.authorization;
  const secret = process.env.CRON_SECRET;

  if (!secret || headerAuth !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized — invalid or missing CRON_SECRET" });
    return;
  }

  next();
}

// ============================================================================
// ENDPOINT: Gerar Recorrentes
// ============================================================================

async function gerarRecorrentes() {
  const hoje = new Date();
  const mes = String(hoje.getMonth() + 1).padStart(2, "0");
  const ano = hoje.getFullYear();
  const mesMarcador = `${ano}-${mes}`;  // "2026-08"

  // Buscar todos os recorrentes ativos
  const recorrentes = await supabase.listarRecorrentes();
  const ativosApenas = recorrentes.filter((r) => r.ativo);

  const gerados = [];
  const jaExistiam = [];
  const erros = [];

  for (const rec of ativosApenas) {
    try {
      // ✅ CORRIGIDO: Usar função que respeita fim de mês
      const proxVencimento = calcularVencimento(ano, hoje.getMonth(), rec.dia_vencimento);
      const dataGeracao = new Date(proxVencimento);
      dataGeracao.setDate(dataGeracao.getDate() - rec.dias_antecedencia);

      // Se a data de geração for HOJE (ou passou), e ainda não gerou este mês
      if (dataGeracao <= hoje && rec.ultima_geracao !== mesMarcador) {
        // ✅ Criar lançamento com status conforme valor
        const status = rec.valor ? "pendente" : "a_confirmar";
        const dataPagamento = rec.valor ? proxVencimento.toISOString().substring(0, 10) : undefined;

        const lancamento = await supabase.createLancamento(
          {
            tipo_documento: "outro" as any,  // recorrente (usar "outro" pois recorrente não é tipo válido)
            tipo_lancamento: "despesa",
            valor_total: rec.valor ?? 0,  // NULL → 0 (será ignorado no DRE por status a_confirmar)
            descricao: rec.descricao,
            fornecedor: rec.fornecedor || undefined,
            data_emissao: dataGeracao.toISOString().substring(0, 10),
            data_vencimento: proxVencimento.toISOString().substring(0, 10),
            categoria_sugerida: rec.descricao,
            confianca: "alta",
          },
          `recorrente-${rec.id}-${mesMarcador}`,
          undefined,
          rec.categoria_id,
          status as any,
          dataPagamento
        );

        // ✅ Atualizar ultima_geracao para marcar como gerado neste mês
        await supabase.atualizarUltimaGeracao(rec.id, mesMarcador);

        gerados.push({
          id: rec.id,
          descricao: rec.descricao,
          valor: rec.valor,
          status,
          lancamento_id: lancamento.id,
          vencimento: proxVencimento.toISOString().substring(0, 10),
        });
      } else if (rec.ultima_geracao === mesMarcador) {
        // Já gerou este mês
        jaExistiam.push(rec.id);
      }
    } catch (err) {
      erros.push({
        recorrente_id: rec.id,
        descricao: rec.descricao,
        erro: String(err),
      });
    }
  }

  return {
    status: "ok",
    data_execucao: new Date().toISOString(),
    mes_marcador: mesMarcador,
    gerados: gerados.length,
    jaExistiam: jaExistiam.length,
    erros: erros.length,
    detalhes: {
      criados: gerados,
      erros: erros.length > 0 ? erros : undefined,
    },
  };
}

router.post("/gerar-recorrentes", validarCronSecret, async (req: Request, res: Response) => {
  try {
    const resultado = await gerarRecorrentes();
    res.json(resultado);

    // Log de sucesso
    console.log(
      `[CRON] Recorrentes: ${resultado.gerados} criados, ${resultado.jaExistiam} já existiam, ${resultado.erros} erros`
    );
  } catch (err) {
    console.error("[CRON] Erro ao gerar recorrentes:", err);
    res.status(500).json({
      error: "Failed to generate recurrentes",
      message: String(err),
    });
  }
});

// ============================================================================
// ENDPOINT: Alertas de Vencimentos
// ============================================================================

import { sendTextMessage } from "../services/zapi.js";

function brl(valor: number): string {
  return valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function enviarAlertas() {
  const hoje = new Date().toISOString().substring(0, 10);
  const alertas = [];
  const erros = [];

  try {
    // ── Alertas de VENCIMENTO PRÓXIMO (hoje, amanhã, depois de amanhã) ──────────
    const configsVencimento = await supabase.listarAlertasConfig("vencimento_proximo");

    for (const config of configsVencimento) {
      try {
        const lancamentos = await supabase.buscarLancamentosVencimentoProximo();

        for (const lance of lancamentos) {
          const dias = lance.data_vencimento
            ? Math.floor(
                (new Date(lance.data_vencimento + "T00:00:00").getTime() - new Date(hoje + "T00:00:00").getTime()) /
                  86400000
              )
            : null;

          const quando = dias === 0 ? "HOJE" : dias === 1 ? "amanhã" : `em ${dias} dias`;

          const msg = `📅 *Vence ${quando}*\n${lance.fornecedor || lance.descricao}\nR$ ${brl(Number(lance.valor))}`;

          await sendTextMessage(config.chat_id, msg);
          await supabase.marcarAlertaVencimentoEnviado(lance.id);

          alertas.push({
            tipo: "vencimento_proximo",
            lancamento_id: lance.id,
            quando,
          });
        }
      } catch (err) {
        erros.push({
          config_id: config.id,
          tipo: "vencimento_proximo",
          erro: String(err),
        });
      }
    }

    // ── Alertas de VENCIDO (5+ dias) ──────────────────────────────────────────
    const configsVencido = await supabase.listarAlertasConfig("vencido_5dias");

    for (const config of configsVencido) {
      try {
        const lancamentos = await supabase.buscarLancamentosVencido5Dias();

        for (const lance of lancamentos) {
          const dias = Math.floor(
            (new Date(hoje + "T00:00:00").getTime() - new Date(lance.data_vencimento + "T00:00:00").getTime()) /
              86400000
          );

          const msg = `🔴 *VENCIDO HÁ ${dias} DIAS*\n${lance.fornecedor || lance.descricao}\nR$ ${brl(Number(lance.valor))}\n\n_Use: *pago [código]* para registrar pagamento_`;

          await sendTextMessage(config.chat_id, msg);
          await supabase.marcarAlertaVencidoEnviado(lance.id);

          alertas.push({
            tipo: "vencido_5dias",
            lancamento_id: lance.id,
            dias,
          });
        }
      } catch (err) {
        erros.push({
          config_id: config.id,
          tipo: "vencido_5dias",
          erro: String(err),
        });
      }
    }
  } catch (err) {
    console.error("[CRON] Erro geral ao enviar alertas:", err);
    throw err;
  }

  return {
    status: "ok",
    data_execucao: new Date().toISOString(),
    alertas_enviados: alertas.length,
    erros: erros.length,
    detalhes: {
      alertas: alertas.length > 0 ? alertas : undefined,
      erros: erros.length > 0 ? erros : undefined,
    },
  };
}

router.post("/alertas-vencimentos", validarCronSecret, async (req: Request, res: Response) => {
  try {
    const resultado = await enviarAlertas();
    res.json(resultado);

    console.log(`[CRON] Alertas: ${resultado.alertas_enviados} enviados, ${resultado.erros} erros`);
  } catch (err) {
    console.error("[CRON] Erro ao enviar alertas:", err);
    res.status(500).json({
      error: "Failed to send alerts",
      message: String(err),
    });
  }
});

export default router;
