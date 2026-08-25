import { Router, Request, Response } from "express";
import { ZAPIPayload, ExtracaoMultipla } from "../types.js";
import { processar } from "../services/extracao.js";
import { calcularDRE, formatarDREWhatsApp, formatarResumoWhatsApp } from "../services/dre.js";
import { gerarAnalise } from "../services/claude.js";
import { gerarPdfDRE } from "../services/pdf-dre.js";
import { gerarRelatorioContas } from "../services/relatorio.js";
import { inferirGrupoDre } from "../services/grupo-dre.js";
import { sendTextMessage, sendDocumentMessage, downloadMedia } from "../services/zapi.js";
import {
  isMessageProcessed,
  markMessageProcessed,
  findOrCreateCategoria,
  createLancamento,
  getLancamentosPendentes,
  getLancamentoPorCodigo,
  marcarComoPago,
  getResumoMes,
  buscarPendentesCorrespondentes,
  atualizarDataEmissao,
  atualizarDescricao,
  excluirLancamento,
  getLancamentosRecentes,
  atualizarCategoria,
  buscarExato,
  encontrarCombinacoes,
  buscarFuzzy,
  marcarComoPagoParcial,
  criarCombinacaoConfirmacao,
  confirmarCombinacao,
  cancelarCombinacao,
  criarNaoConciliado,
  listarNaoConciliados,
  conciliarNaoConciliado,
  descartarNaoConciliado,
  criarRecorrente,
  listarRecorrentes,
  pausarRecorrente,
  resumirRecorrente,
  excluirRecorrente,
  atualizarValorLancamento,
  ajustarValorLancamento,
  getLancamentosAConfirmar,
  listarAlertasConfig,
  atualizarMetaCMV,
  registrarHistoricoCompra,
  getComprasRastreadas,
  enterTenant,
  uploadDocument,
} from "../db/supabase.js";
import { findTenantByChat } from "../config/tenants.js";
import { handleComandoEstoque } from "../services/estoque/whatsapp-comandos.js";
import { handleFotoEstoque, handleRespostaConfirmacaoFoto } from "../services/estoque/whatsapp-fotos.js";

const router = Router();

// ── Estado de confirmações pendentes (in-memory) ──────────────────────────────

interface PendingConfirmation {
  multipla: ExtracaoMultipla;
  urlArquivo?: string;
  messageId: string;
}
const pendingConfirmations = new Map<string, PendingConfirmation>();

// Determina status baseado no tipo de documento
function determinarStatusDocumento(tipoDocumento: string): { status: "pendente" | "pago"; dataPagamento?: string } {
  const hoje = new Date().toISOString().substring(0, 10);
  // Documentos de compra já foram pagos no ato
  if (["comprovante", "nota_fiscal", "recibo"].includes(tipoDocumento)) {
    return { status: "pago", dataPagamento: hoje };
  }
  // Boletos e faturas são pendentes
  return { status: "pendente" };
}

// ── Utilitários ───────────────────────────────────────────────────────────────

function validarSegredo(req: Request): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true;
  // Aceita chamadas diretas do Z-API (sem header) ou com o secret correto
  const header = req.headers["x-webhook-secret"];
  if (!header) return true; // Z-API não envia header — confia na obscuridade da URL
  return header === secret;
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

// Separa por vírgula, mas ignora vírgulas que são DECIMAIS — necessário porque
// medidas em formato brasileiro usam vírgula como separador decimal e não
// podem ser confundidas com separador de produtos. Duas situações protegidas:
//   1. Vírgula dentro de parênteses, ex: "Queijo (6,070kg)"
//   2. Vírgula "nua" cercada de dígitos, ex: "Guaraná 1,5L" (tamanho no nome,
//      sem parênteses — a IA nem sempre embala isso).
function splitProdutos(descricao: string): string[] {
  const partes: string[] = [];
  let atual = "";
  let profundidade = 0;
  for (let i = 0; i < descricao.length; i++) {
    const ch = descricao[i];
    if (ch === "(") profundidade++;
    if (ch === ")") profundidade--;

    const ehVirgulaDecimal =
      ch === "," && /\d/.test(descricao[i - 1] ?? "") && /\d/.test(descricao[i + 1] ?? "");

    if (ch === "," && profundidade === 0 && !ehVirgulaDecimal) {
      partes.push(atual.trim());
      atual = "";
    } else {
      atual += ch;
    }
  }
  if (atual.trim()) partes.push(atual.trim());
  return partes.filter(Boolean);
}

// Itens da mesma categoria vêm agrupados numa descrição só, separada por vírgula.
// Quebra em lista numerada pra ficar legível em vez de um parágrafo gigante.
function listarProdutos(descricao: string): { multiplos: boolean; texto: string } {
  const produtos = splitProdutos(descricao);
  if (produtos.length <= 1) {
    return { multiplos: false, texto: descricao };
  }
  return {
    multiplos: true,
    texto: produtos.map((p, i) => `     ${i + 1}. ${p}`).join("\n"),
  };
}

// ── Confirmação de extração com dúvida ───────────────────────────────────────

function precisaConfirmacao(multipla: ExtracaoMultipla): string | null {
  const soma = multipla.itens.reduce((s, i) => s + i.valor, 0);
  const totalDoc = multipla.valor_total_documento;

  if (totalDoc != null && Math.abs(soma - totalDoc) > 0.50) {
    return `soma dos itens (R$ ${brl(soma)}) ≠ total no documento (R$ ${brl(totalDoc)})`;
  }
  if (!multipla.data_emissao) {
    return "data de emissão não identificada";
  }
  return null;
}

async function sendConfirmacaoPendente(chatId: string, multipla: ExtracaoMultipla, motivo: string): Promise<void> {
  const soma = multipla.itens.reduce((s, i) => s + i.valor, 0);
  const totalDoc = multipla.valor_total_documento;

  const linhasItens = multipla.itens
    .map((i) => {
      const { multiplos, texto } = listarProdutos(i.descricao);
      return multiplos
        ? `  • R$ ${brl(i.valor)}\n${texto}`
        : `  • ${texto}: R$ ${brl(i.valor)}`;
    })
    .join("\n");

  const linhas: (string | null)[] = [
    `⚠️ *Analisei o documento, mas tenho dúvida:*`,
    `_${motivo}_`,
    ``,
    multipla.fornecedor ? `🏪 ${multipla.fornecedor}` : null,
    multipla.data_emissao ? `📅 Data: ${formatarData(multipla.data_emissao)}` : `📅 Data: *não identificada*`,
    ``,
    `Itens identificados:`,
    linhasItens,
    `  Soma: *R$ ${brl(soma)}*`,
    totalDoc != null ? `  Total no documento: R$ ${brl(totalDoc)}` : null,
    ``,
    `Responda *sim* para registrar assim mesmo ou *não* para cancelar.`,
  ];

  await sendTextMessage(chatId, linhas.filter(Boolean).join("\n"));
}

async function registrarMultipla(
  chatId: string,
  multipla: ExtracaoMultipla,
  urlArquivo: string | undefined,
  messageId: string
): Promise<void> {
  const fornecedor = multipla.fornecedor ?? "Documento";
  const somaItens = multipla.itens.reduce((s, i) => s + i.valor, 0);
  const { status, dataPagamento } = determinarStatusDocumento(multipla.tipo_documento);

  // Se o total do documento (já com desconto do cupom aplicado) for diferente
  // da soma dos itens que a IA extraiu, ajusta o valor de cada item
  // proporcionalmente pra bater com o valor realmente pago. Sem isso, um
  // desconto no cupom (não distribuído item a item pela IA) fazia o sistema
  // registrar a mais do que o cliente pagou de fato.
  const totalDocumento = multipla.valor_total_documento;
  const fatorAjuste =
    totalDocumento != null && somaItens > 0 && Math.abs(somaItens - totalDocumento) > 0.01
      ? totalDocumento / somaItens
      : 1;
  const totalGeral = totalDocumento ?? somaItens;

  const criados: { descricao: string; valor: number; id: string; baixaConfianca: boolean; variacao?: number; quantidade?: number; unidade?: string; semCategoria?: boolean; categoriaNome?: string }[] = [];
  for (let idx = 0; idx < multipla.itens.length; idx++) {
    const item = multipla.itens[idx];
    const valorAjustado = Math.round(item.valor * fatorAjuste * 100) / 100;
    let categoriaId: string | undefined;
    let categoriaNome: string | undefined;
    let semCategoria = false;

    // Rede de segurança: nenhum item pode ser salvo sem categoria.
    // Se o Claude não classificou, usa um fallback por tipo e MARCA pra revisão.
    const catNome =
      item.categoria_sugerida ||
      (item.tipo_lancamento === "receita" ? "Outras Receitas" : "Outras despesas administrativas");
    if (!item.categoria_sugerida) semCategoria = true;

    try {
      const grupoDre = inferirGrupoDre(catNome, item.tipo_lancamento);
      const cat = await findOrCreateCategoria(catNome, grupoDre, item.tipo_lancamento);
      categoriaId = cat.id;
      categoriaNome = cat.nome;
    } catch {
      semCategoria = true; // falhou ao resolver categoria — marca pra revisão
    }
    const lancamento = await createLancamento(
      {
        tipo_documento: multipla.tipo_documento as any,
        fornecedor: multipla.fornecedor,
        cnpj_cpf: multipla.cnpj_cpf,
        descricao: item.descricao,
        valor_total: valorAjustado,
        data_emissao: multipla.data_emissao,
        data_vencimento: multipla.data_vencimento,
        categoria_sugerida: item.categoria_sugerida,
        subcategoria: item.subcategoria,
        tipo_lancamento: item.tipo_lancamento,
        confianca: item.confianca,
      },
      `${messageId}-${idx}`,
      urlArquivo,
      categoriaId,
      status,
      dataPagamento
    );

    let variacao: number | undefined;
    // Registrar histórico de compra se tem quantidade/unidade e é despesa
    if (item.quantidade && item.unidade && item.tipo_lancamento === "despesa") {
      try {
        const historico = await registrarHistoricoCompra(
          item.descricao,
          item.quantidade,
          item.unidade,
          valorAjustado,
          lancamento.id,
          multipla.fornecedor,
          multipla.data_emissao
        );
        variacao = historico.variacao_pct ?? undefined;
      } catch (err) {
        console.error("[Histórico] Erro ao registrar compra:", err);
      }
    }

    criados.push({
      descricao: item.descricao,
      valor: valorAjustado,
      id: lancamento.id,
      baixaConfianca: item.confianca !== "alta",
      variacao,
      quantidade: item.quantidade,
      unidade: item.unidade,
      semCategoria,
      categoriaNome,
    });
  }

  const linhasItens = criados
    .map((c) => {
      const { multiplos, texto } = listarProdutos(c.descricao);
      let linha: string;
      if (multiplos) {
        linha = `  • R$ ${brl(c.valor)} [${codigoCurto(c.id)}]${c.baixaConfianca ? " ⚠️" : ""}\n${texto}`;
      } else {
        linha = `  • ${texto}: R$ ${brl(c.valor)} [${codigoCurto(c.id)}]${c.baixaConfianca ? " ⚠️" : ""}`;
      }
      if (c.categoriaNome) {
        linha += `\n     🏷️ ${c.categoriaNome}`;
      }
      if (c.quantidade && c.unidade) {
        linha += ` (${c.quantidade}${c.unidade})`;
      }
      if (c.variacao !== undefined) {
        const sinal = c.variacao > 0 ? "📈 +" : c.variacao < 0 ? "📉 " : "➡️ ";
        linha += ` ${sinal}${Math.abs(c.variacao).toFixed(1)}%`;
      }
      if (c.semCategoria) {
        linha += `\n     🏷️ *categoria automática* — confira: categoria ${codigoCurto(c.id)} [nome]`;
      }
      return linha;
    })
    .join("\n");

  const temBaixaConfianca = criados.some((c) => c.baixaConfianca);
  const temSemCategoria = criados.some((c) => c.semCategoria);
  const confirmacao = [
    `📋 *${fornecedor}* — R$ ${brl(totalGeral)}`,
    `${criados.length} lançamento${criados.length > 1 ? "s" : ""} criado${criados.length > 1 ? "s" : ""}:`,
    "",
    linhasItens,
    temSemCategoria ? "\n🏷️ Itens marcados foram classificados no automático (provisório) — confira e ajuste se precisar." : null,
    temBaixaConfianca ? "\n⚠️ Itens com ⚠️ têm confiança baixa — confira os valores." : null,
    multipla.data_emissao ? `📅 Emissão: ${formatarData(multipla.data_emissao)}` : null,
    multipla.data_vencimento ? `⏰ Vencimento: ${formatarData(multipla.data_vencimento)}` : null,
  ].filter(Boolean).join("\n");

  await sendTextMessage(chatId, confirmacao);
}

// ── Handlers dos comandos ─────────────────────────────────────────────────────

function periodoAnterior(inicio: string, fim: string): { inicio: string; fim: string } {
  const [ano, mes] = inicio.split("-").map(Number);
  const mesAnt = mes === 1 ? 12 : mes - 1;
  const anoAnt = mes === 1 ? ano - 1 : ano;
  const mesStr = String(mesAnt).padStart(2, "0");
  const ultimoDia = new Date(anoAnt, mesAnt, 0).getDate();
  return {
    inicio: `${anoAnt}-${mesStr}-01`,
    fim: `${anoAnt}-${mesStr}-${String(ultimoDia).padStart(2, "0")}`,
  };
}

function dreParaTexto(dre: import("../types.js").DRE, label: string): string {
  const linhas: string[] = [`=== ${label.toUpperCase()} ===`];
  const add = (cat: string, val: number) => {
    if (val > 0.01) linhas.push(`${cat}: R$ ${brl(val)}`);
  };

  add("Receita Bruta", dre.total_receita_bruta);
  add("Receita Líquida", dre.receita_liquida);
  linhas.push(`Custos Variáveis Total: R$ ${brl(dre.total_custos_variaveis)} (${dre.total_custos_variaveis_pct}% da receita)`);
  [...dre.cmv, ...dre.materiais_venda_direta, ...dre.materiais_apoio, ...dre.cmo_eventual, ...dre.tarifas_cartao, ...dre.impostos_variaveis]
    .forEach((l) => add(`  ${l.categoria}`, l.valor));
  add("Margem de Contribuição", dre.margem_contribuicao);
  linhas.push(`Despesas Fixas Total: R$ ${brl(dre.total_despesas_fixas)} (${dre.total_despesas_fixas_pct}% da receita)`);
  [...dre.ocupacao, ...dre.utilidades, ...dre.pessoal_fixo, ...dre.despesas_admin, ...dre.marketing, ...dre.manutencao, ...dre.despesas_financeiras, ...dre.servicos_terceirizados, ...dre.retirada_socios]
    .forEach((l) => add(`  ${l.categoria}`, l.valor));
  linhas.push(`Resultado Operacional: R$ ${brl(dre.resultado_operacional)} (${dre.resultado_operacional_pct}%)`);
  return linhas.join("\n");
}

async function handleCategoria(chatId: string, msg: string): Promise<void> {
  const match = msg.match(/^categoria\s+([A-Za-z0-9]{4,8})\s+(.+)$/i);
  if (!match) {
    await sendTextMessage(
      chatId,
      "Formato: *categoria [código] [nome_da_categoria]*\nExemplo: *categoria ABC123 Salários CLT*"
    );
    return;
  }

  const codigo = match[1].toUpperCase();
  const categoriaNome = match[2].trim();
  const lancamento = await getLancamentoPorCodigo(codigo.toLowerCase());

  if (!lancamento) {
    await sendTextMessage(chatId, `Lançamento *${codigo}* não encontrado.`);
    return;
  }

  const grupoDre = inferirGrupoDre(categoriaNome, lancamento.tipo);
  const categoria = await findOrCreateCategoria(categoriaNome, grupoDre, lancamento.tipo);
  await atualizarCategoria(lancamento.id, categoria.id);

  await sendTextMessage(
    chatId,
    `✅ Categoria atualizada!\n📋 ${lancamento.descricao}\n🏷️ ${categoriaNome}\n_Código: ${codigo}_`
  );
}

async function handleCMV(chatId: string, msg: string): Promise<void> {
  const semCmv = msg.replace(/^cmv\s*/i, "").trim();
  const periodo = semCmv ? parsePeriodoDRE(`dre ${semCmv}`) : mesAtual();

  if (!periodo) {
    await sendTextMessage(chatId, "Formato inválido. Use: *cmv* ou *cmv julho*");
    return;
  }

  const dre = await calcularDRE(periodo.inicio, periodo.fim);
  const cmvLinhas = [
    ...dre.cmv,
    ...dre.materiais_venda_direta,
    ...dre.materiais_apoio,
    ...dre.cmo_eventual,
    ...dre.tarifas_cartao,
    ...dre.impostos_variaveis,
  ];

  const cmvTexto = cmvLinhas
    .filter((l) => l.valor > 0.01)
    .map((l) => `  • ${l.categoria}: R$ ${brl(l.valor)} (${l.pct}%)`)
    .join("\n");

  const linhas = [
    `*CMV — ${periodo.label}*`,
    "",
    cmvTexto || "  —",
    "",
    `*Total: R$ ${brl(dre.total_custos_variaveis)} (${dre.total_custos_variaveis_pct}% da receita)*`,
  ];

  await sendTextMessage(chatId, linhas.join("\n"));
}

async function handleRastreados(chatId: string, msg: string): Promise<void> {
  const semPrefixo = msg.replace(/^rastreados\s*/i, "").trim();
  const periodo = semPrefixo ? parsePeriodoDRE(`dre ${semPrefixo}`) : mesAtual();

  if (!periodo) {
    await sendTextMessage(chatId, "Formato inválido. Use: *rastreados* ou *rastreados julho*");
    return;
  }

  const [dre, rastreados] = await Promise.all([
    calcularDRE(periodo.inicio, periodo.fim),
    getComprasRastreadas(periodo.inicio, periodo.fim),
  ]);

  if (rastreados.length === 0) {
    await sendTextMessage(
      chatId,
      `*ITENS RASTREADOS — ${periodo.label}*\n\nNenhuma compra de item rastreado (Filé de Peito, Filé Mignon, Queijo Mussarela, Camarão, Óleo) nesse período.`
    );
    return;
  }

  // Todas as linhas de despesa do DRE, pra achar o total da categoria pai de cada subcategoria
  const todasLinhas = [
    ...dre.cmv,
    ...dre.materiais_venda_direta,
    ...dre.materiais_apoio,
    ...dre.cmo_eventual,
    ...dre.tarifas_cartao,
    ...dre.impostos_variaveis,
  ];

  const porCategoria = new Map<string, typeof rastreados>();
  for (const r of rastreados) {
    const lista = porCategoria.get(r.categoria_nome) ?? [];
    lista.push(r);
    porCategoria.set(r.categoria_nome, lista);
  }

  const blocos = Array.from(porCategoria.entries()).map(([categoriaNome, itens]) => {
    const totalCategoria = todasLinhas.find((l) => l.categoria === categoriaNome)?.valor ?? 0;
    const linhasItens = itens
      .map((it) => {
        const qtd = it.quantidade_total > 0 ? ` (${it.quantidade_total}${it.unidade})` : "";
        return `   • ${it.subcategoria}: R$ ${brl(it.valor_total)}${qtd}`;
      })
      .join("\n");

    return `🏷️ *${categoriaNome}* — Total categoria: R$ ${brl(totalCategoria)}\n${linhasItens}`;
  });

  const texto = [
    `*ITENS RASTREADOS — ${periodo.label}*`,
    "",
    blocos.join("\n\n"),
  ].join("\n");

  await sendTextMessage(chatId, texto);
}

async function handleAnalise(chatId: string, msg: string): Promise<void> {
  const semAnalise = msg.replace(/^analise\s*/i, "").trim();
  const periodo = semAnalise
    ? parsePeriodoDRE(`dre ${semAnalise}`)
    : mesAtual();

  if (!periodo) {
    await sendTextMessage(chatId, "Formato inválido. Use: *analise* ou *analise julho*");
    return;
  }

  await sendTextMessage(chatId, "🔍 Analisando as contas, aguarde...");

  const ant = periodoAnterior(periodo.inicio, periodo.fim);
  const [dre, dreAnt] = await Promise.all([
    calcularDRE(periodo.inicio, periodo.fim),
    calcularDRE(ant.inicio, ant.fim),
  ]);

  const textoAtual = dreParaTexto(dre, periodo.label);
  const textoAnt = dreParaTexto(dreAnt, ant.inicio.slice(0, 7));

  const analise = await gerarAnalise(textoAtual, textoAnt);
  await sendTextMessage(chatId, analise);
}

async function handleDRE(chatId: string, msg: string): Promise<void> {
  const pdf = /\bpdf\b/i.test(msg);
  // Remove "pdf" da string antes de parsear o período
  const semPdf = msg.replace(/\bpdf\b/i, "").trim();
  const periodo = parsePeriodoDRE(semPdf || "dre");
  if (!periodo) {
    await sendTextMessage(chatId, "Formato inválido. Use: *dre julho* ou *dre 2024-07*");
    return;
  }

  if (!pdf) {
    const dre = await calcularDRE(periodo.inicio, periodo.fim);
    await sendTextMessage(chatId, formatarDREWhatsApp(dre));
    return;
  }

  // PDF com comparativo do mês anterior
  await sendTextMessage(chatId, "⏳ Gerando PDF, aguarde...");
  try {
    const ant = periodoAnterior(periodo.inicio, periodo.fim);
    const [dre, dreAnt] = await Promise.all([
      calcularDRE(periodo.inicio, periodo.fim),
      calcularDRE(ant.inicio, ant.fim),
    ]);
    const pdfBuffer = await gerarPdfDRE(dre, dreAnt);
    const mesLabel = periodo.inicio.slice(0, 7); // YYYY-MM
    await sendDocumentMessage(chatId, pdfBuffer, `DRE-${mesLabel}.pdf`);
  } catch (err) {
    console.error("[PDF] erro:", err);
    await sendTextMessage(chatId, "❌ Erro ao gerar o PDF. Tente novamente.");
  }
}

async function handleResumo(chatId: string): Promise<void> {
  const { inicio, fim, label } = mesAtual();
  const { totalReceitas, totalDespesas, totalPendentes } = await getResumoMes(inicio, fim);
  await sendTextMessage(
    chatId,
    formatarResumoWhatsApp(totalReceitas, totalDespesas, totalPendentes, label)
  );
}

async function handleRelatorio(chatId: string, msg: string): Promise<void> {
  try {
    await sendTextMessage(chatId, "📋 Gerando relatório de contas...");

    // Extrai mês se especificado (ex: "relatorio agosto" ou "relatorio 08")
    const mesMatch = msg.match(/relatorio\s+(\w+|\d{1,2})/i);
    let mes: number | undefined;
    let ano: number | undefined;

    if (mesMatch) {
      const mesStr = mesMatch[1].toLowerCase();
      const meses: Record<string, number> = {
        janeiro: 1, jan: 1,
        fevereiro: 2, fev: 2,
        março: 3, mar: 3,
        abril: 4, abr: 4,
        maio: 5,
        junho: 6, jun: 6,
        julho: 7, jul: 7,
        agosto: 8, ago: 8,
        setembro: 9, set: 9,
        outubro: 10, out: 10,
        novembro: 11, nov: 11,
        dezembro: 12, dez: 12,
      };

      mes = meses[mesStr] || parseInt(mesStr);
      if (!isNaN(mes) && mes >= 1 && mes <= 12) {
        ano = new Date().getFullYear();
      } else {
        mes = undefined;
      }
    }

    // Gera PDF (geral se não especificar mês)
    const pdfBuffer = await gerarRelatorioContas(mes, ano);

    // Determina nome do arquivo
    const agora = new Date();
    let nomeArquivo = "relatorio_contas.pdf";
    if (mes && ano) {
      const mesNomes = [
        "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
        "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"
      ];
      nomeArquivo = `relatorio_${mesNomes[mes - 1]}_${ano}.pdf`;
    }

    // Envia via Z-API
    await sendDocumentMessage(chatId, pdfBuffer, nomeArquivo, "application/pdf");
  } catch (err) {
    console.error("Erro ao gerar relatório:", err);
    const detalhe = err instanceof Error ? err.message : String(err);
    await sendTextMessage(chatId, `❌ Erro ao gerar relatório: ${detalhe}`);
  }
}

async function handlePendentes(chatId: string): Promise<void> {
  const [pendentes, aConfirmar] = await Promise.all([
    getLancamentosPendentes(25),
    getLancamentosAConfirmar(25),
  ]);

  if (pendentes.length === 0 && aConfirmar.length === 0) {
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
  const confirmarValor: string[] = [];

  // Processa lançamentos com status "pendente"
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

  // Processa lançamentos com status "a_confirmar"
  for (const l of aConfirmar) {
    const codigo = codigoCurto(l.id);
    const cat = (l as any).categoria_nome ?? l.descricao;
    const dataStr = l.data_vencimento ? formatarData(l.data_vencimento) : "(sem data)";
    confirmarValor.push(`[${codigo}] ${cat} — vence ${dataStr}`);
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
  if (confirmarValor.length > 0) {
    linhas.push("❓ *A confirmar (aguardando valor):*");
    confirmarValor.forEach((l) => linhas.push(`• ${l}`));
    linhas.push("");
  }

  linhas.push(`Total com valor: *R$ ${brl(totalGeral)}* em ${pendentes.length} lançamento(s)`);
  if (aConfirmar.length > 0) {
    linhas.push(`Aguardando valor: ${aConfirmar.length} lançamento(s)`);
  }
  linhas.push("");
  linhas.push("_Para marcar como pago: *pago [código]*_");
  linhas.push("_Para confirmar valor: *valor [código] [R$]*_");
  linhas.push("_Exemplo: valor ABC123 320.50_");

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

// ── Handlers de recorrentes ───────────────────────────────────────────────────

async function handleListarRecorrentes(chatId: string): Promise<void> {
  const recorrentes = await listarRecorrentes();

  if (recorrentes.length === 0) {
    await sendTextMessage(chatId, "Nenhuma despesa recorrente cadastrada.\n\nUse: *criar recorrente [nome] [valor] [dia] [categoria]*");
    return;
  }

  const hoje = new Date();
  const linhas: string[] = ["*Despesas Recorrentes*", ""];

  for (const rec of recorrentes) {
    const codigo = rec.id; // formato R000001
    const status = rec.ativo ? "✅" : "⏸️";
    const valor = rec.valor ? `R$ ${brl(rec.valor)}` : "❓ (a confirmar)";
    const cat = rec.categoria_nome || rec.descricao;

    // Calcular próximo vencimento
    const mesAtual = hoje.getMonth() + 1;
    const anoAtual = hoje.getFullYear();
    let diaVenc = rec.dia_vencimento;
    const ultimoDia = new Date(anoAtual, mesAtual, 0).getDate();
    if (diaVenc > ultimoDia) diaVenc = ultimoDia;

    const proxVenc = new Date(anoAtual, mesAtual - 1, diaVenc);
    if (proxVenc < hoje) {
      proxVenc.setMonth(proxVenc.getMonth() + 1);
    }

    const dataStr = formatarData(proxVenc.toISOString().substring(0, 10));
    linhas.push(`${status} [${codigo}] ${rec.descricao} — ${valor}`);
    linhas.push(`   📅 ${cat} | Vence: ${dataStr}`);
  }

  linhas.push("");
  linhas.push("_Comandos:_");
  linhas.push("• *criar recorrente [nome] [valor] [dia] [categoria]* — nova despesa");
  linhas.push("• *pausar recorrente [R00001]* — pausar geração");
  linhas.push("• *resumir recorrente [R00001]* — retomar geração");
  linhas.push("• *excluir recorrente [R00001]* — deletar");

  await sendTextMessage(chatId, linhas.join("\n"));
}

async function handleCriarRecorrente(chatId: string, msg: string): Promise<void> {
  // Formato: criar recorrente [nome] [valor|null] [dia] [categoria]
  // Exemplos:
  // "criar recorrente Aluguel 3000 5 Ocupação"
  // "criar recorrente Luz null 10 Utilidades" ou "criar recorrente Luz a_confirmar 10 Utilidades"

  const match = msg.match(/^criar\s+recorrente\s+(.+)$/i);
  if (!match) {
    await sendTextMessage(
      chatId,
      "Formato: *criar recorrente [nome] [valor] [dia] [categoria]*\n\nExemplos:\n• *criar recorrente Aluguel 3000 5 Ocupação*\n• *criar recorrente Luz a_confirmar 15 Utilidades*"
    );
    return;
  }

  const partes = match[1].trim().split(/\s+/);
  if (partes.length < 4) {
    await sendTextMessage(
      chatId,
      "❌ Você precisa informar: nome, valor, dia do mês e categoria.\n\nExemplo: *criar recorrente Aluguel 3000 5 Ocupação*"
    );
    return;
  }

  const nome = partes[0];
  const valorStr = partes[1].toLowerCase();
  const diaStr = partes[2];
  const categoria = partes.slice(3).join(" ");

  // Validar dia
  const dia = Number(diaStr);
  if (isNaN(dia) || dia < 1 || dia > 31) {
    await sendTextMessage(chatId, `❌ Dia deve ser entre 1 e 31. Você informou: ${diaStr}`);
    return;
  }

  // Validar valor
  let valor: number | null = null;
  if (valorStr !== "null" && valorStr !== "a_confirmar" && valorStr !== "a confirmar") {
    valor = Number(valorStr);
    if (isNaN(valor) || valor <= 0) {
      await sendTextMessage(chatId, `❌ Valor deve ser um número positivo ou "a_confirmar". Você informou: ${valorStr}`);
      return;
    }
  }

  // Criar categoria se não existir
  let categoriaId: string | undefined;
  try {
    const grupoDre = inferirGrupoDre(categoria, "despesa");
    const cat = await findOrCreateCategoria(categoria, grupoDre, "despesa");
    categoriaId = cat.id;
  } catch (e) {
    await sendTextMessage(chatId, `❌ Erro ao processar categoria: ${categoria}`);
    return;
  }

  // Criar recorrente
  try {
    const rec = await criarRecorrente(nome, valor, categoriaId, null, dia, 5);
    const valorInfo = valor ? `R$ ${brl(valor)}` : "❓ (a confirmar)";
    await sendTextMessage(
      chatId,
      `✅ *Despesa recorrente criada!*\n[${rec}] ${nome}\n${valorInfo}\nVencimento: dia ${dia}\nCategoria: ${categoria}\n\n_Use *recorrentes* para listar todas._`
    );
  } catch (e: any) {
    await sendTextMessage(chatId, `❌ Erro ao criar: ${e.message}`);
  }
}

async function handlePausarRecorrente(chatId: string, msg: string): Promise<void> {
  const match = msg.match(/^pausar\s+recorrente\s+([A-Za-z0-9]+)$/i);
  if (!match) {
    await sendTextMessage(chatId, "Formato: *pausar recorrente [código]*\nExemplo: *pausar recorrente R000001*");
    return;
  }

  const codigo = match[1].toUpperCase();

  try {
    await pausarRecorrente(codigo);
    await sendTextMessage(chatId, `⏸️ *Recorrente pausada!*\nCódigo: ${codigo}\n_Use *resumir recorrente ${codigo}* para reativar._`);
  } catch (e: any) {
    await sendTextMessage(chatId, `❌ Erro: ${e.message}`);
  }
}

async function handleResumirRecorrente(chatId: string, msg: string): Promise<void> {
  const match = msg.match(/^resumir\s+recorrente\s+([A-Za-z0-9]+)$/i);
  if (!match) {
    await sendTextMessage(chatId, "Formato: *resumir recorrente [código]*\nExemplo: *resumir recorrente R000001*");
    return;
  }

  const codigo = match[1].toUpperCase();

  try {
    await resumirRecorrente(codigo);
    await sendTextMessage(chatId, `✅ *Recorrente reativada!*\nCódigo: ${codigo}`);
  } catch (e: any) {
    await sendTextMessage(chatId, `❌ Erro: ${e.message}`);
  }
}

async function handleExcluirRecorrente(chatId: string, msg: string): Promise<void> {
  const match = msg.match(/^excluir\s+recorrente\s+([A-Za-z0-9]+)$/i);
  if (!match) {
    await sendTextMessage(chatId, "Formato: *excluir recorrente [código]*\nExemplo: *excluir recorrente R000001*");
    return;
  }

  const codigo = match[1].toUpperCase();

  try {
    await excluirRecorrente(codigo);
    await sendTextMessage(chatId, `🗑️ *Recorrente deletada!*\nCódigo: ${codigo}`);
  } catch (e: any) {
    await sendTextMessage(chatId, `❌ Erro: ${e.message}`);
  }
}

async function handleValor(chatId: string, msg: string): Promise<void> {
  // Formato: valor [código] [valor]
  // Exemplo: "valor ABC123 320.50"
  const match = msg.match(/^valor\s+([A-Za-z0-9]{4,8})\s+([\d.]+)$/i);
  if (!match) {
    await sendTextMessage(
      chatId,
      "Formato: *valor [código] [valor]*\n\nExemplo: *valor ABC123 320.50*\n\n_Use *pendentes* para ver os códigos dos lançamentos com valor a confirmar._"
    );
    return;
  }

  const codigo = match[1].toUpperCase();
  const valorStr = match[2];
  const valor = Number(valorStr);

  if (isNaN(valor) || valor <= 0) {
    await sendTextMessage(chatId, `❌ Valor deve ser um número positivo. Você informou: ${valorStr}`);
    return;
  }

  const lancamento = await getLancamentoPorCodigo(codigo.toLowerCase());

  if (!lancamento) {
    await sendTextMessage(chatId, `Lançamento *${codigo}* não encontrado. Verifique o código.`);
    return;
  }

  if ((lancamento.status as any) !== "a_confirmar") {
    await sendTextMessage(
      chatId,
      `Este lançamento já tem valor definido.\n${lancamento.descricao}\nValor atual: R$ ${brl(Number(lancamento.valor))}`
    );
    return;
  }

  // Atualizar valor e mudar status para pendente
  try {
    await atualizarValorLancamento(lancamento.id, valor);

    await sendTextMessage(
      chatId,
      `✅ *Valor confirmado!*\n${lancamento.descricao}\nR$ ${brl(valor)}\n_Status: pendente_`
    );
  } catch (e: any) {
    await sendTextMessage(chatId, `❌ Erro ao atualizar: ${e.message}`);
  }
}

async function handleAjustarValor(chatId: string, msg: string): Promise<void> {
  // Formato: ajustar [código] [valor] — corrige o valor de um lançamento
  // JÁ REGISTRADO (pago ou pendente), sem mexer no status. Diferente de
  // "valor", que é só pro fluxo de "valor a confirmar".
  const match = msg.match(/^ajustar\s+([A-Za-z0-9]{4,8})\s+([\d.]+)$/i);
  if (!match) {
    await sendTextMessage(
      chatId,
      "Formato: *ajustar [código] [valor certo]*\n\nExemplo: *ajustar ABC123 35.22*\n\n_Use pra corrigir um valor que a IA leu errado num lançamento já registrado._"
    );
    return;
  }

  const codigo = match[1].toUpperCase();
  const valorStr = match[2];
  const valor = Number(valorStr);

  if (isNaN(valor) || valor <= 0) {
    await sendTextMessage(chatId, `❌ Valor deve ser um número positivo. Você informou: ${valorStr}`);
    return;
  }

  const lancamento = await getLancamentoPorCodigo(codigo.toLowerCase());
  if (!lancamento) {
    await sendTextMessage(chatId, `Lançamento *${codigo}* não encontrado. Verifique o código.`);
    return;
  }

  try {
    await ajustarValorLancamento(lancamento.id, valor);
    await sendTextMessage(
      chatId,
      `✅ *Valor ajustado!*\n${lancamento.descricao}\nDe: R$ ${brl(Number(lancamento.valor))}\nPara: R$ ${brl(valor)}`
    );
  } catch (e: any) {
    await sendTextMessage(chatId, `❌ Erro ao ajustar: ${e.message}`);
  }
}

// ── Handler de Alerta CMV ─────────────────────────────────────────────────

async function handleAlertaCMV(chatId: string, msg: string): Promise<void> {
  // Parse periodo: "alerta cmv", "alerta cmv julho", "alerta cmv 2026-07"
  const match = msg.match(/^alerta\s+cmv(?:\s+(.+))?$/i);
  if (!match) {
    await sendTextMessage(chatId, "Formato: *alerta cmv* ou *alerta cmv julho* ou *alerta cmv 2026-07*");
    return;
  }

  // Determinar período
  let periodo = mesAtual();
  if (match[1]) {
    const periodoParse = parsePeriodoDRE(`dre ${match[1]}`);
    if (periodoParse) periodo = periodoParse;
  }

  // Buscar config de alerta CMV
  const configs = await listarAlertasConfig("cmv_acima_meta");
  let config = configs.find((c) => c.chat_id === chatId);

  if (!config) {
    await sendTextMessage(
      chatId,
      "⚠️ Alerta de CMV não está configurado para este chat.\n\nPara configurar, use: *configar meta_cmv [%]*\nExemplo: *configar meta_cmv 32.5*"
    );
    return;
  }

  if (!config.ativo) {
    await sendTextMessage(chatId, "⚠️ Alerta de CMV está desativado neste chat.");
    return;
  }

  if (!config.cmv_meta) {
    await sendTextMessage(
      chatId,
      "⚠️ Meta de CMV não configurada. Use: *configar meta_cmv 32.5*"
    );
    return;
  }

  // Calcular DRE
  try {
    const dre = await calcularDRE(periodo.inicio, periodo.fim);
    const cmv_atual = dre.total_custos_variaveis_pct;
    const meta = config.cmv_meta;
    const diferenca = cmv_atual - meta;

    if (diferenca > 0) {
      const msg_alerta = [
        `⚠️ *CMV ACIMA DA META!*`,
        `Período: ${periodo.label}`,
        ``,
        `📊 CMV atual: *${cmv_atual}%*`,
        `🎯 Meta: ${meta}%`,
        `📈 Excesso: *+${diferenca.toFixed(2)}pp*`,
        ``,
        `Receita líquida: R$ ${brl(dre.receita_liquida)}`,
        `Custos variáveis: R$ ${brl(dre.total_custos_variaveis)}`,
      ].join("\n");
      await sendTextMessage(chatId, msg_alerta);
    } else {
      const margem = meta - cmv_atual;
      const msg_ok = [
        `✅ *CMV dentro da meta*`,
        `Período: ${periodo.label}`,
        ``,
        `📊 CMV atual: ${cmv_atual}%`,
        `🎯 Meta: ${meta}%`,
        `✅ Margem: ${margem.toFixed(2)}pp`,
        ``,
        `Receita líquida: R$ ${brl(dre.receita_liquida)}`,
        `Custos variáveis: R$ ${brl(dre.total_custos_variaveis)}`,
      ].join("\n");
      await sendTextMessage(chatId, msg_ok);
    }
  } catch (err) {
    await sendTextMessage(chatId, `❌ Erro ao calcular CMV: ${String(err)}`);
  }
}

async function handleConfigurarMetaCMV(chatId: string, msg: string): Promise<void> {
  const match = msg.match(/^configar\s+meta_cmv\s+([\d.]+)$/i);
  if (!match) {
    await sendTextMessage(
      chatId,
      "Formato: *configar meta_cmv [%]*\nExemplo: *configar meta_cmv 32.5*"
    );
    return;
  }

  const meta = Number(match[1]);
  if (isNaN(meta) || meta <= 0 || meta > 100) {
    await sendTextMessage(chatId, `❌ Meta deve ser um número entre 0 e 100. Você informou: ${match[1]}`);
    return;
  }

  try {
    await atualizarMetaCMV(chatId, meta);
    await sendTextMessage(
      chatId,
      `✅ *Meta de CMV configurada!*\n🎯 ${meta}%\n\n_Use: *alerta cmv* para verificar_`
    );
  } catch (err) {
    await sendTextMessage(chatId, `❌ Erro ao configurar meta: ${String(err)}`);
  }
}

async function handleRecentes(chatId: string): Promise<void> {
  const recentes = await getLancamentosRecentes(8);
  if (recentes.length === 0) {
    await sendTextMessage(chatId, "Nenhum lançamento encontrado.");
    return;
  }

  const linhas = recentes.map((l) => {
    const codigo = codigoCurto(l.id);
    const cat = (l as any).categoria_nome ?? l.descricao;
    const valor = `R$ ${brl(Number(l.valor))}`;
    const status = l.status === "pago" ? "✅" : "⏳";
    const data = formatarData(l.data_emissao);
    return `${status} [${codigo}] ${cat} — ${valor} — ${data}`;
  });

  await sendTextMessage(
    chatId,
    ["*Últimos lançamentos:*", "", ...linhas, "", "_Use *excluir [código]* para remover_"].join("\n")
  );
}

async function handleExcluir(chatId: string, msg: string): Promise<void> {
  const match = msg.match(/^excluir\s+([A-Za-z0-9]{4,8})/i);
  if (!match) {
    await sendTextMessage(chatId, "Formato: *excluir [código]*\nExemplo: *excluir 888BBB*");
    return;
  }

  const codigo = match[1].toUpperCase();
  const lancamento = await getLancamentoPorCodigo(codigo.toLowerCase());

  if (!lancamento) {
    await sendTextMessage(chatId, `Lançamento *${codigo}* não encontrado.`);
    return;
  }

  await excluirLancamento(lancamento.id);
  await sendTextMessage(
    chatId,
    `🗑️ *Excluído!*\n📋 ${lancamento.descricao}\n💰 R$ ${brl(Number(lancamento.valor))}\n_Código: ${codigo}_`
  );
}

async function handleData(chatId: string, msg: string): Promise<void> {
  // Formato: data ABC123 29/07/2026
  const match = msg.match(/^data\s+([A-Za-z0-9]{4,8})\s+(\d{2})\/(\d{2})\/(\d{4})/i);
  if (!match) {
    await sendTextMessage(chatId, "Formato: *data [código] DD/MM/AAAA*\nExemplo: *data 888BBB 29/07/2026*");
    return;
  }

  const codigo = match[1].toUpperCase();
  const dataIso = `${match[4]}-${match[3]}-${match[2]}`; // YYYY-MM-DD
  const lancamento = await getLancamentoPorCodigo(codigo.toLowerCase());

  if (!lancamento) {
    await sendTextMessage(chatId, `Lançamento *${codigo}* não encontrado.`);
    return;
  }

  await atualizarDataEmissao(lancamento.id, dataIso);
  await sendTextMessage(
    chatId,
    `✅ Data corrigida!\n📋 ${lancamento.descricao}\n📅 Emissão: ${formatarData(dataIso)}`
  );
}

async function handleCorrigirItem(chatId: string, msg: string): Promise<void> {
  // Formato: corrigir ABC123 2 Refrigerante Antarctica Guaraná 1,5L
  const match = msg.match(/^corrigir\s+([A-Za-z0-9]{4,8})\s+(\d+)\s+(.+)$/i);
  if (!match) {
    await sendTextMessage(
      chatId,
      "Formato: *corrigir [código] [número] [texto certo]*\nExemplo: *corrigir ABC123 2 Refrigerante Guaraná 1,5L*\n\n_O número é o da lista que apareceu quando o lançamento foi criado._"
    );
    return;
  }

  const [, codigoRaw, numeroStr, textoNovo] = match;
  const codigo = codigoRaw.toUpperCase();
  const numero = parseInt(numeroStr, 10);

  const lancamento = await getLancamentoPorCodigo(codigo.toLowerCase());
  if (!lancamento) {
    await sendTextMessage(chatId, `Lançamento *${codigo}* não encontrado. Use *recentes* pra ver os códigos.`);
    return;
  }

  const produtos = splitProdutos(lancamento.descricao);

  if (numero < 1 || numero > produtos.length) {
    await sendTextMessage(
      chatId,
      produtos.length > 1
        ? `O lançamento *${codigo}* tem ${produtos.length} itens. Escolha um número de 1 a ${produtos.length}.`
        : `O lançamento *${codigo}* tem só 1 item — use *corrigir ${codigo} 1 ${textoNovo}*.`
    );
    return;
  }

  produtos[numero - 1] = textoNovo.trim();
  const novaDescricao = produtos.join(", ");

  await atualizarDescricao(lancamento.id, novaDescricao);

  const listaAtualizada =
    produtos.length > 1
      ? produtos.map((p, i) => `     ${i === numero - 1 ? "✏️" : `${i + 1}.`} ${p}`).join("\n")
      : `  ${novaDescricao}`;

  await sendTextMessage(
    chatId,
    `✅ Item ${numero} corrigido!\n📋 *${codigo}*\n${listaAtualizada}`
  );
}

async function handleConfirmarCombinacao(chatId: string, msg: string): Promise<void> {
  const match = msg.match(/^confirmar\s+(COMB[A-Z0-9]+)/i);
  if (!match) {
    await sendTextMessage(chatId, "Formato: *confirmar [COMB###]*\nExemplo: *confirmar COMB001*");
    return;
  }

  const combId = match[1].toUpperCase();
  const success = await confirmarCombinacao(combId);

  if (success) {
    await sendTextMessage(
      chatId,
      `✅ *Combinação confirmada!*\n${combId}\nTodos os boletos foram marcados como pagos.`
    );
  } else {
    await sendTextMessage(chatId, `Combinação *${combId}* não encontrada.`);
  }
}

async function handleCancelarCombinacao(chatId: string, msg: string): Promise<void> {
  const match = msg.match(/^cancelar\s+(COMB[A-Z0-9]+)/i);
  if (!match) {
    await sendTextMessage(chatId, "Formato: *cancelar [COMB###]*\nExemplo: *cancelar COMB001*");
    return;
  }

  const combId = match[1].toUpperCase();
  const success = await cancelarCombinacao(combId);

  if (success) {
    await sendTextMessage(chatId, `✅ *Combinação cancelada!*\n${combId}`);
  } else {
    await sendTextMessage(chatId, `Combinação *${combId}* não encontrada.`);
  }
}

async function handleConciliar(chatId: string, msg: string): Promise<void> {
  const match = msg.match(/^conciliar\s+(NC[A-Z0-9]+)\s+(.+)$/i);
  if (!match) {
    await sendTextMessage(
      chatId,
      "Formato: *conciliar [NC###] [categoria]*\nExemplo: *conciliar NC001 Materiais de Apoio*"
    );
    return;
  }

  const ncId = match[1].toUpperCase();
  const categoriaNome = match[2].trim();

  try {
    const grupoDre = inferirGrupoDre(categoriaNome, "despesa");
    const categoria = await findOrCreateCategoria(categoriaNome, grupoDre, "despesa");
    const success = await conciliarNaoConciliado(ncId, categoria.id);

    if (success) {
      await sendTextMessage(
        chatId,
        `✅ *Comprovante conciliado!*\n${ncId}\n🏷️ ${categoriaNome}\nUm novo lançamento foi criado.`
      );
    } else {
      await sendTextMessage(chatId, `Comprovante *${ncId}* não encontrado.`);
    }
  } catch (err) {
    console.error("[Conciliar] Erro:", err);
    await sendTextMessage(chatId, `❌ Erro ao conciliar. Tente novamente.`);
  }
}

async function handleDescartar(chatId: string, msg: string): Promise<void> {
  const match = msg.match(/^descartar\s+(NC[A-Z0-9]+)/i);
  if (!match) {
    await sendTextMessage(chatId, "Formato: *descartar [NC###]*\nExemplo: *descartar NC001*");
    return;
  }

  const ncId = match[1].toUpperCase();
  const success = await descartarNaoConciliado(ncId);

  if (success) {
    await sendTextMessage(chatId, `✅ *Comprovante descartado!*\n${ncId}`);
  } else {
    await sendTextMessage(chatId, `Comprovante *${ncId}* não encontrado.`);
  }
}

async function handleListarNaoConciliados(chatId: string): Promise<void> {
  const ncs = await listarNaoConciliados();

  if (ncs.length === 0) {
    await sendTextMessage(chatId, "Nenhum comprovante aguardando conciliação.");
    return;
  }

  const linhas = ncs.map((nc) => {
    const data = formatarData(nc.data_recebimento);
    const fornec = nc.fornecedor || "Desconhecido";
    return `• ${nc.id}: R$ ${brl(Number(nc.valor))} — ${fornec} (${data})`;
  });

  await sendTextMessage(
    chatId,
    [
      `*Comprovantes não conciliados:*`,
      ``,
      ...linhas,
      ``,
      `Para conciliar: *conciliar [NC###] [categoria]*`,
      `Para descartar: *descartar [NC###]*`,
    ].join("\n")
  );
}

// ── PASSO 1: Matching EXATO ──────────────────────────────────────────────────
async function matchExato(
  valor: number,
  categoriaId?: string,
  fornecedor?: string
): Promise<{ lancamento: any; tipo: "exato" } | null> {
  const lanc = await buscarExato(valor, fornecedor, categoriaId);
  if (lanc) return { lancamento: lanc, tipo: "exato" };
  return null;
}

// ── PASSO 2: Matching COMBINAÇÃO (soma exata de múltiplos) ───────────────────
async function matchCombinacao(
  valor: number,
  categoriaId?: string,
  fornecedor?: string
): Promise<{ lancamentos: any[]; tipo: "combinacao"; combId: string } | null> {
  const pendentes = await encontrarCombinacoes(valor, fornecedor, categoriaId, 8);
  if (pendentes.length < 2) return null;

  // Busca subconjuntos que somem exatamente o valor (brute force simples)
  for (let i = 1; i < Math.min(4, pendentes.length); i++) {
    const combinacoes = combinationsOf(pendentes, i);
    for (const comb of combinacoes) {
      const soma = comb.reduce((s, l) => s + l.saldo, 0);
      if (Math.abs(soma - valor) < 0.01) {
        const combId = await criarCombinacaoConfirmacao(
          comb.map((l) => l.id),
          valor,
          ""
        );
        return { lancamentos: comb, tipo: "combinacao", combId };
      }
    }
  }

  return null;
}

function combinationsOf<T>(arr: T[], size: number): T[][] {
  if (size === 1) return arr.map((x) => [x]);
  const result: T[][] = [];
  for (let i = 0; i < arr.length - size + 1; i++) {
    const head = arr[i];
    const tailCombos = combinationsOf(arr.slice(i + 1), size - 1);
    for (const tail of tailCombos) {
      result.push([head, ...tail]);
    }
  }
  return result;
}

// ── PASSO 3: Matching FUZZY (±25% no saldo) ──────────────────────────────────
async function matchFuzzy(
  valor: number,
  categoriaId?: string,
  fornecedor?: string
): Promise<{ lancamentos: any[]; tipo: "fuzzy" } | null> {
  const fuzzy = await buscarFuzzy(valor, fornecedor, categoriaId, 5);
  if (fuzzy.length > 0) return { lancamentos: fuzzy, tipo: "fuzzy" };
  return null;
}

// ── Matching automático de comprovante com pendente ───────────────────────────

async function handleComprovante(
  chatId: string,
  valor: number,
  categoriaId: string | undefined,
  categoriaNome: string | undefined,
  urlArquivo: string | undefined,
  messageId: string
): Promise<boolean> {
  // PASSO 1: Exato
  const exato = await matchExato(valor, categoriaId);
  if (exato) {
    const p = exato.lancamento;
    await marcarComoPagoParcial(p.id, valor, messageId);
    const cat = p.categoria_nome ?? p.descricao;
    const hoje = new Date().toISOString().substring(0, 10);

    const linhas: (string | null)[] = [
      `✅ *Pagamento registrado!*`,
      `📋 ${cat}`,
      `💰 R$ ${brl(valor)}`,
      p.data_vencimento ? `📅 Vencia: ${formatarData(p.data_vencimento)}` : null,
      `🔑 Código: *${codigoCurto(p.id)}*`,
    ];

    const juros = valor - Number(p.valor);
    if (juros > 0.01) {
      try {
        const catJuros = await findOrCreateCategoria("Juros e Multas", "despesas_financeiras", "despesa");
        await createLancamento(
          {
            tipo_documento: "outro",
            descricao: `Juros/Multa — ${cat}`,
            valor_total: juros,
            data_emissao: hoje,
            tipo_lancamento: "despesa",
            confianca: "alta",
          },
          `${messageId}-juros`,
          undefined,
          catJuros.id,
          "pago",
          hoje
        );
        linhas.push(``, `💸 Juros/Multa: R$ ${brl(juros)}`);
      } catch (err) {
        console.error("[Comprovante] Erro ao registrar juros:", err);
      }
    }

    await sendTextMessage(chatId, linhas.filter(Boolean).join("\n"));
    return true;
  }

  // PASSO 2: Combinação exata
  const comb = await matchCombinacao(valor, categoriaId);
  if (comb) {
    const opcoes = comb.lancamentos
      .map((l) => {
        const cat = l.categoria_nome ?? l.descricao;
        const saldo = `R$ ${brl(l.saldo)}`;
        return `• ${cat}: ${saldo}`;
      })
      .join("\n");

    await sendTextMessage(
      chatId,
      [
        `🔍 *Encontrei uma combinação exata!*`,
        ``,
        `Este comprovante (R$ ${brl(valor)}) pode pagar estes ${comb.lancamentos.length} boletos:`,
        ``,
        opcoes,
        ``,
        `Confirme: *confirmar ${comb.combId}*`,
        `Ou cancele: *cancelar ${comb.combId}*`,
      ].join("\n")
    );
    return true;
  }

  // PASSO 3: Fuzzy
  const fuzzy = await matchFuzzy(valor, categoriaId);
  if (fuzzy && fuzzy.lancamentos.length === 1) {
    // Único match fuzzy → auto-baixa
    const p = fuzzy.lancamentos[0];
    await marcarComoPagoParcial(p.id, valor, messageId);
    const cat = p.categoria_nome ?? p.descricao;

    await sendTextMessage(
      chatId,
      [
        `✅ *Pagamento registrado! (aproximado)*`,
        `📋 ${cat}`,
        `💰 Comprovante: R$ ${brl(valor)} → Saldo: R$ ${brl(p.saldo)}`,
        `🔑 Código: *${codigoCurto(p.id)}*`,
      ].join("\n")
    );
    return true;
  } else if (fuzzy && fuzzy.lancamentos.length > 1) {
    // Múltiplos matches fuzzy → pede confirmação
    const opcoes = fuzzy.lancamentos
      .map((l) => {
        const cat = l.categoria_nome ?? l.descricao;
        const diff = Math.abs(valor - l.saldo);
        const sinal = valor > l.saldo ? "+" : "-";
        return `• [${codigoCurto(l.id)}] ${cat}: R$ ${brl(l.saldo)} (${sinal}R$ ${brl(diff)})`;
      })
      .join("\n");

    await sendTextMessage(
      chatId,
      [
        `🔍 Encontrei ${fuzzy.lancamentos.length} contas com valor próximo:`,
        ``,
        opcoes,
        ``,
        `_Qual era? Responda com *pago [código]*_`,
      ].join("\n")
    );
    return true;
  }

  // PASSO 4: Sem match → fila de não conciliados
  const ncId = await criarNaoConciliado(valor, undefined, categoriaNome, undefined, urlArquivo);
  await sendTextMessage(
    chatId,
    [
      `❓ *Comprovante não conciliado*`,
      `Não encontrei nenhum boleto correspondente.`,
      ``,
      `💰 R$ ${brl(valor)}`,
      `🏷️ ${categoriaNome || "Sem categoria"}`,
      ``,
      `Para conciliar manualmente, use:`,
      `*conciliar ${ncId} [nome_categoria]*`,
      `Exemplo: *conciliar ${ncId} Materiais de Apoio*`,
      ``,
      `Ou descartar: *descartar ${ncId}*`,
    ].join("\n")
  );
  return true;
}

// ── Dispatcher central de comandos ───────────────────────────────────────────

async function handleComando(chatId: string, msg: string): Promise<boolean> {
  const trimmed = msg.trim();

  // Confirmação de extração com dúvida
  if (/^sim\s*$/i.test(trimmed)) {
    const pending = pendingConfirmations.get(chatId);
    if (pending) {
      pendingConfirmations.delete(chatId);
      await registrarMultipla(chatId, pending.multipla, pending.urlArquivo, pending.messageId);
      return true;
    }
    return false;
  }

  if (/^n[aã]o\s*$/i.test(trimmed)) {
    const pending = pendingConfirmations.get(chatId);
    if (pending) {
      pendingConfirmations.delete(chatId);
      await sendTextMessage(
        chatId,
        [
          "❌ Registro cancelado.",
          "",
          "Para registrar com os valores corretos, envie uma mensagem de texto:",
          `_Exemplo: "${pending.multipla.fornecedor ?? "Fornecedor"} [categoria] [DD/MM/AAAA] R$ [valor]"_`,
        ].join("\n")
      );
      return true;
    }
    return false;
  }

  if (/^cmv\b/i.test(trimmed)) {
    await handleCMV(chatId, trimmed);
    return true;
  }

  if (/^rastreados\b/i.test(trimmed)) {
    await handleRastreados(chatId, trimmed);
    return true;
  }

  if (/^analise\b/i.test(trimmed)) {
    await handleAnalise(chatId, trimmed);
    return true;
  }

  if (/^dre\b/i.test(trimmed)) {
    await handleDRE(chatId, trimmed);
    return true;
  }

  if (/^resumo\b/i.test(trimmed)) {
    await handleResumo(chatId);
    return true;
  }

  if (/^relatorio\b/i.test(trimmed)) {
    await handleRelatorio(chatId, trimmed);
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

  if (/^recorrentes\b/i.test(trimmed)) {
    await handleListarRecorrentes(chatId);
    return true;
  }

  if (/^criar\s+recorrente\b/i.test(trimmed)) {
    await handleCriarRecorrente(chatId, trimmed);
    return true;
  }

  if (/^pausar\s+recorrente\b/i.test(trimmed)) {
    await handlePausarRecorrente(chatId, trimmed);
    return true;
  }

  if (/^resumir\s+recorrente\b/i.test(trimmed)) {
    await handleResumirRecorrente(chatId, trimmed);
    return true;
  }

  if (/^excluir\s+recorrente\b/i.test(trimmed)) {
    await handleExcluirRecorrente(chatId, trimmed);
    return true;
  }

  if (/^valor\b/i.test(trimmed)) {
    await handleValor(chatId, trimmed);
    return true;
  }

  if (/^ajustar\b/i.test(trimmed)) {
    await handleAjustarValor(chatId, trimmed);
    return true;
  }

  if (/^alerta\s+cmv\b/i.test(trimmed)) {
    await handleAlertaCMV(chatId, trimmed);
    return true;
  }

  if (/^configar\s+meta_cmv\b/i.test(trimmed)) {
    await handleConfigurarMetaCMV(chatId, trimmed);
    return true;
  }

  if (/^data\b/i.test(trimmed)) {
    await handleData(chatId, trimmed);
    return true;
  }

  if (/^categoria\b/i.test(trimmed)) {
    await handleCategoria(chatId, trimmed);
    return true;
  }

  if (/^corrigir\b/i.test(trimmed)) {
    await handleCorrigirItem(chatId, trimmed);
    return true;
  }

  if (/^excluir\b/i.test(trimmed)) {
    await handleExcluir(chatId, trimmed);
    return true;
  }

  if (/^recentes\b/i.test(trimmed)) {
    await handleRecentes(chatId);
    return true;
  }

  if (/^confirmar\s+comb/i.test(trimmed)) {
    await handleConfirmarCombinacao(chatId, trimmed);
    return true;
  }

  if (/^cancelar\s+comb/i.test(trimmed)) {
    await handleCancelarCombinacao(chatId, trimmed);
    return true;
  }

  if (/^conciliar\s+nc/i.test(trimmed)) {
    await handleConciliar(chatId, trimmed);
    return true;
  }

  if (/^descartar\s+nc/i.test(trimmed)) {
    await handleDescartar(chatId, trimmed);
    return true;
  }

  if (/^nao_conciliados\b/i.test(trimmed) || /^não_conciliados\b/i.test(trimmed)) {
    await handleListarNaoConciliados(chatId);
    return true;
  }

  if (/^(ajuda|help|\?)\s*$/i.test(trimmed)) {
    const ajuda = [
      "*📋 Como usar o Financeiro*",
      "",
      "*1. Registrar despesa*",
      "Mande foto de nota, boleto ou cupom — o sistema lê e classifica automaticamente.",
      "Adicione uma legenda para ajudar: _\"gás\"_, _\"fornecedor de carne\"_",
      "Ou descreva em texto: _\"conta de luz R$ 320\"_, _\"gás R$ 180\"_",
      "",
      "*2. Registrar receita*",
      "Descreva em texto: _\"caixa do dia R$ 4.500 pix\"_",
      "",
      "*3. Dar baixa em conta a pagar*",
      "Mande o comprovante com legenda — o sistema identifica e dá baixa automática.",
      "Ou use: *pago ABC123*",
      "",
      "*4. Reconciliação de pagamentos*",
      "O sistema tenta automaticamente conciliar comprovantes com contas pendentes.",
      "Se encontrar uma combinação exata (1 comprovante = múltiplos boletos):",
      "• *confirmar COMB001* — confirma a combinação",
      "• *cancelar COMB001* — cancela a confirmação",
      "",
      "Se não conseguir conciliar automaticamente:",
      "• *nao_conciliados* — lista comprovantes aguardando reconciliação",
      "• *conciliar NC001 Materiais de Apoio* — reconcilia manualmente com categoria",
      "• *descartar NC001* — descarta um comprovante",
      "",
      "*5. Consultas*",
      "• *resumo* — saldo rápido do mês",
      "• *pendentes* — contas em aberto com códigos",
      "• *recentes* — últimos 8 lançamentos com códigos",
      "• *cmv* — custos variáveis com percentual",
      "• *cmv julho* — CMV de mês específico",
      "• *rastreados* — compras de itens rastreados (Filé de Peito, Filé Mignon, Queijo Mussarela, Camarão, Óleo) vs total da categoria",
      "• *rastreados julho* — rastreados de mês específico",
      "• *dre* — resultado operacional completo",
      "• *dre pdf* — relatório PDF com comparativo",
      "• *dre julho* — resultado de mês específico",
      "• *analise* — análise consultiva: o que subiu, o que preocupa, ações sugeridas",
      "• *analise julho* — análise de mês específico",
      "",
      "*6. Corrigir erros*",
      "• *excluir ABC123* — remove lançamento errado",
      "• *data ABC123 29/07/2026* — corrige data de emissão",
      "• *categoria ABC123 Salários CLT* — muda categoria de um lançamento",
      "• *corrigir ABC123 2 Guaraná 1,5L* — corrige só o item 2 da lista de um lançamento com vários produtos",
      "• *ajustar ABC123 35.22* — corrige o valor de um lançamento já registrado (pago ou não), sem mexer no status",
      "_Use *recentes* para ver os códigos dos últimos lançamentos_",
      "",
      "*7. Despesas Recorrentes (aluguel, salários, etc)*",
      "Configure despesas fixas para gerar automaticamente a cada mês:",
      "• *recorrentes* — lista todas as recorrentes",
      "• *criar recorrente [nome] [valor] [dia] [categoria]* — nova",
      "  Exemplos: *criar recorrente Aluguel 3000 5 Ocupação*",
      "           *criar recorrente Luz a_confirmar 15 Utilidades*",
      "• *pausar recorrente [R000001]* — pausa geração daquela despesa",
      "• *resumir recorrente [R000001]* — retoma geração",
      "• *excluir recorrente [R000001]* — remove",
      "",
      "*8. Confirmar valores de despesas variáveis*",
      "Quando gera uma despesa com valor \"a confirmar\" (ex: luz, água):",
      "• *valor [código] [valor]* — confirma o valor e marca como pendente",
      "  Exemplo: *valor ABC123 320.50*",
      "",
      "*9. Confirmar documentos com dúvida*",
      "Se o sistema tiver dúvida (total divergente ou data não encontrada), ele pergunta antes de registrar.",
      "• *sim* — confirma e registra",
      "• *não* — cancela",
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

    console.log("[Webhook] payload recebido:", JSON.stringify({
      fromMe: payload.fromMe,
      phone: payload.phone,
      chatId: payload.chatId,
      messageId: payload.messageId,
      text: payload.text?.message?.slice(0, 50),
      imageKeys: payload.image ? Object.keys(payload.image) : null,
      imageUrl: (payload.image as any)?.imageUrl ?? payload.image?.url ?? null,
      documentUrl: (payload.document as any)?.documentUrl ?? payload.document?.url ?? null,
      GRUPO_FINANCEIRO_ID: process.env.GRUPO_FINANCEIRO_ID,
    }));

    // Identifica de qual LOJA é a mensagem (multi-tenant) e ativa o banco dela.
    const tenant = findTenantByChat(payload.chatId, payload.phone);
    if (!tenant) {
      // Não é grupo de nenhuma loja — encaminha se houver webhook configurado
      const forwardUrl = process.env.FORWARD_WEBHOOK_URL;
      if (forwardUrl) {
        fetch(forwardUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
        }).catch((err) => console.error("[Forward] Erro ao encaminhar:", err));
      }
      return;
    }
    // A partir daqui, todas as funções de banco usam o banco desta loja.
    enterTenant({ url: tenant.url, key: tenant.key, schema: tenant.schema });
    console.log(`[Webhook] loja identificada: ${tenant.id}`);

    if (payload.fromMe) { console.log("[Webhook] ignorado: fromMe"); return; }

    const messageId = payload.messageId;
    if (!messageId) return;

    if (await isMessageProcessed(messageId)) return;
    await markMessageProcessed(messageId);

    const chatId = payload.chatId ?? payload.phone;

    // Grupo dedicado de estoque (TENANTS com id terminando em "-estoque") —
    // desvia inteiramente do fluxo financeiro. Usa o MESMO schema do
    // tenant (financeiro) só pra dedup de mensagem acima; o módulo de
    // estoque sempre força schema='estoque' internamente (ver
    // services/estoque/db.ts), então isso não mistura os dados.
    if (tenant.id.endsWith("-estoque")) {
      if (payload.text?.message) {
        // Resposta de confirmação de uma foto pendente ("sim"/"não") tem
        // prioridade sobre o roteador de comandos normal — senão "sim"
        // cairia no "Não entendi" do handleComandoEstoque.
        const foiConfirmacao = await handleRespostaConfirmacaoFoto(chatId, payload.text.message, payload.senderName);
        if (!foiConfirmacao) await handleComandoEstoque(chatId, payload.text.message);
        return;
      }

      const imageUrlEstoque = payload.image?.imageUrl ?? payload.image?.url;
      if (imageUrlEstoque) {
        const buffer = await downloadMedia(imageUrlEstoque);
        const mimeType = (payload.image!.mimeType || "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
        const urlArquivo = await uploadDocument(buffer, `estoque_${payload.messageId}.jpg`, mimeType);
        await handleFotoEstoque(chatId, buffer, mimeType, payload.image!.caption, urlArquivo);
        return;
      }

      await sendTextMessage(
        chatId,
        "Ainda não processo esse tipo de mensagem neste grupo — manda uma foto (lista ou produto) ou um comando de texto.\nDigite *ajuda* pra ver os comandos disponíveis."
      );
      return;
    }

    // Verifica comandos antes de tentar extrair dados financeiros
    if (payload.text?.message) {
      try {
        const isComando = await handleComando(chatId, payload.text.message);
        if (isComando) return;
      } catch (err) {
        console.error("[Webhook] Erro ao processar comando:", err);
        const detalhe = err instanceof Error ? err.message : String(err);
        await sendTextMessage(chatId, `❌ Erro ao processar comando: ${detalhe}`).catch((e) =>
          console.error("[Webhook] Falha ao notificar erro de comando:", e)
        );
        return;
      }
    }

    // Avisa que está processando quando recebe imagem ou documento
    const temMidia = !!(payload.image?.imageUrl ?? payload.image?.url ?? payload.document?.documentUrl ?? payload.document?.url);
    if (temMidia) {
      await sendTextMessage(chatId, "⏳ Analisando documento...");
    }

    try {
    // Extrai dados financeiros do documento ou texto livre
    const resultado = await processar(payload);
    if (!resultado) return;

    const { urlArquivo } = resultado;

    // ── Múltiplos itens (imagem/PDF com vários produtos) ─────────────────────
    if (resultado.multipla) {
      const { multipla } = resultado;

      // Comprovante de pagamento único via imagem (ex: PIX enviado + legenda "gás")
      if (multipla.tipo_documento === "comprovante" && multipla.itens.length === 1) {
        const item = multipla.itens[0];
        let categoriaId: string | undefined;
        if (item.categoria_sugerida) {
          try {
            const grupoDre = inferirGrupoDre(item.categoria_sugerida, item.tipo_lancamento);
            const cat = await findOrCreateCategoria(item.categoria_sugerida, grupoDre, item.tipo_lancamento);
            categoriaId = cat.id;
          } catch { /* ignora */ }
        }

        // Conciliação (bater com boleto pendente) só faz sentido pra DESPESA —
        // uma receita não tem "boleto a pagar" pra procurar. Sem essa checagem,
        // todo comprovante de venda/recebimento caía na fila de "não conciliado"
        // à toa, mesmo já tendo sido classificado corretamente como receita.
        if (item.tipo_lancamento === "despesa") {
          const resolvido = await handleComprovante(chatId, item.valor, categoriaId, item.categoria_sugerida, urlArquivo, messageId);
          if (resolvido) return;
        }

        // Receita, ou despesa sem match — registra direto.
        const lanc = await createLancamento(
          { tipo_documento: "comprovante", fornecedor: multipla.fornecedor, cnpj_cpf: multipla.cnpj_cpf, descricao: item.descricao, valor_total: item.valor, data_emissao: multipla.data_emissao, categoria_sugerida: item.categoria_sugerida, subcategoria: item.subcategoria, tipo_lancamento: item.tipo_lancamento, confianca: item.confianca },
          messageId, urlArquivo, categoriaId, "pago", new Date().toISOString().substring(0, 10)
        );
        const rotulo = item.tipo_lancamento === "receita" ? "registrada" : "registrado como pago";
        await sendTextMessage(chatId, `✅ *${item.descricao}* ${rotulo}\n💰 R$ ${brl(item.valor)}\n🔑 Código: *${codigoCurto(lanc.id)}*`);
        return;
      }

      // Verifica se há dúvida antes de registrar
      const duvida = precisaConfirmacao(multipla);
      if (duvida) {
        pendingConfirmations.set(chatId, { multipla, urlArquivo, messageId });
        await sendConfirmacaoPendente(chatId, multipla, duvida);
        return;
      }

      await registrarMultipla(chatId, multipla, urlArquivo, messageId);
      return;
    }

    // ── Entrada única (texto ou XML NF-e) ────────────────────────────────────
    const extracted = resultado.extracted!;

    // Rede de segurança: sempre resolve uma categoria (fallback por tipo se preciso)
    let categoriaId: string | undefined;
    let semCategoriaUnica = false;
    const catNomeUnica =
      extracted.categoria_sugerida ||
      (extracted.tipo_lancamento === "receita" ? "Outras Receitas" : "Outras despesas administrativas");
    if (!extracted.categoria_sugerida) semCategoriaUnica = true;
    try {
      const grupoDre = inferirGrupoDre(catNomeUnica, extracted.tipo_lancamento);
      const cat = await findOrCreateCategoria(catNomeUnica, grupoDre, extracted.tipo_lancamento);
      categoriaId = cat.id;
    } catch (err) {
      console.warn("[Webhook] Não foi possível resolver categoria:", err);
      semCategoriaUnica = true;
    }

    // Se for comprovante, tenta dar baixa em pendente existente
    if (extracted.tipo_documento === "comprovante" && extracted.tipo_lancamento === "despesa") {
      const resolvido = await handleComprovante(chatId, extracted.valor_total, categoriaId, extracted.categoria_sugerida, urlArquivo, messageId);
      if (resolvido) return;
      // Sem pendente correspondente — registra como pago
      const lancPago = await createLancamento(extracted, messageId, urlArquivo, categoriaId, "pago", new Date().toISOString().substring(0, 10));
      await sendTextMessage(chatId, `✅ *${extracted.descricao}* registrado como pago\n💰 R$ ${brl(extracted.valor_total)}\n🔑 Código: *${codigoCurto(lancPago.id)}*`);
      return;
    }

    const { status, dataPagamento } = determinarStatusDocumento(extracted.tipo_documento);
    const lancamento = await createLancamento(extracted, messageId, urlArquivo, categoriaId, status, dataPagamento);

    const emoji = extracted.tipo_lancamento === "receita" ? "📈" : "📉";
    const catNome = (lancamento as any).categoria_nome ?? catNomeUnica;
    const confirmacao = [
      `${emoji} *${extracted.tipo_lancamento === "receita" ? "Receita" : "Despesa"} registrada!*`,
      `📋 ${extracted.descricao}`,
      `💰 R$ ${brl(Number(extracted.valor_total))}`,
      extracted.data_emissao ? `📅 Emissão: ${formatarData(extracted.data_emissao)}` : null,
      extracted.data_vencimento ? `⏰ Vencimento: ${formatarData(extracted.data_vencimento)}` : null,
      `🏷️ ${catNome}${semCategoriaUnica ? " _(automática — confira)_" : ""}`,
      `🔑 Código: *${codigoCurto(lancamento.id)}*`,
      semCategoriaUnica ? `🏷️ Categoria no automático — ajuste com: categoria ${codigoCurto(lancamento.id)} [nome]` : null,
      extracted.confianca !== "alta" ? `⚠️ Confiança *${extracted.confianca}* — confira os dados.` : null,
    ].filter(Boolean).join("\n");

    await sendTextMessage(chatId, confirmacao);
    } catch (err) {
      // Qualquer erro na leitura/registro do documento (IA, banco, categoria etc.)
      // cai aqui — antes disso, uma falha nesse trecho deixava o usuário travado
      // no "⏳ Analisando documento..." pra sempre, sem nenhuma resposta.
      console.error("[Webhook] Erro ao processar documento:", err);
      const detalhe = err instanceof Error ? err.message : String(err);
      await sendTextMessage(chatId, `❌ Não consegui processar o documento: ${detalhe}`).catch((e) =>
        console.error("[Webhook] Falha ao notificar erro de documento:", e)
      );
    }
  } catch (err) {
    console.error("[Webhook] Erro não tratado:", err);
  }
});

export default router;
