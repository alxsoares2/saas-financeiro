// Comandos de WhatsApp do módulo de estoque — roteados a partir de um
// grupo dedicado (diferente do grupo financeiro), ver src/routes/webhook.ts.
//
// Escopo desta primeira versão: só comandos de TEXTO estruturado
// ("sugestao 30 20"). NÃO inclui ainda:
//   - Interpretação de texto livre pra meta interativa (spec seção 7,
//     ex: "30 pra quarta") — precisaria de uma chamada à IA (Claude) pra
//     extrair os números, tipo o que services/claude.ts já faz pro
//     financeiro. Por enquanto o formato é sempre "sugestao [basílico]
//     [populares]".
//   - Contagem por foto (OCR de lista impressa/manuscrita/produto —
//     spec seção 2). Isso é uma feature bem maior (visão computacional +
//     fluxo de confirmação no grupo) — fica pra uma próxima etapa.
import { calcularSugestaoCompra, formatarSugestaoWhatsApp } from "./sugestao-compra.js";
import { gerarPdfEstoque, gerarPdfSugestaoCompra } from "./pdf-relatorio.js";
import { listProdutos } from "./db.js";
import { sendDocumentMessage, sendTextMessage } from "../zapi.js";

const AJUDA = [
  "*Comandos de estoque:*",
  "",
  "• *sugestao [qtd Basílico] [qtd populares]* — gera a sugestão de compra",
  "   Exemplo: *sugestao 30 20*",
  "• *sugestao [qtd Basílico] [qtd populares] ate DD/MM* — com prazo",
  "   Exemplo: *sugestao 30 20 ate 27/08*",
  "• Adicione *pdf* no final de qualquer um dos dois acima pra receber em PDF",
  "   Exemplo: *sugestao 30 20 pdf*",
  "• *estoque* — lista o estoque atual (texto)",
  "• *estoque pdf* — lista o estoque atual em PDF",
  "",
  "_Contagem por foto ainda não está disponível neste grupo — em breve._",
].join("\n");

function parseSugestao(texto: string): { basilico: number; populares: number; validoAte?: string; pdf: boolean } | null {
  // "sugestao 30 20" / "sugestao 30 20 ate 27/08" / com "pdf" no final de qualquer uma das formas
  const pdf = /\bpdf\b/i.test(texto);
  const semPdf = texto.replace(/\bpdf\b/i, "").trim();

  const match = semPdf.match(/^sugest[aã]o\s+(\d+)\s+(\d+)(?:\s+at[eé]\s+(\d{1,2})\/(\d{1,2}))?/i);
  if (!match) return null;

  const [, basStr, popStr, diaStr, mesStr] = match;
  const basilico = Number(basStr);
  const populares = Number(popStr);
  if (isNaN(basilico) || isNaN(populares)) return null;

  let validoAte: string | undefined;
  if (diaStr && mesStr) {
    const ano = new Date().getFullYear();
    validoAte = `${ano}-${mesStr.padStart(2, "0")}-${diaStr.padStart(2, "0")}`;
  }

  return { basilico, populares, validoAte, pdf };
}

function brl(v: number): string {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatarEstoqueWhatsApp(produtos: Awaited<ReturnType<typeof listProdutos>>): string {
  const ativos = produtos.filter((p) => p.ativo).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  const abaixoDoMinimo = ativos.filter((p) => Number(p.estoque_atual) < Number(p.estoque_minimo));

  const linhas = ativos.map((p) => {
    const baixo = Number(p.estoque_atual) < Number(p.estoque_minimo);
    return `${baixo ? "🔴" : "•"} ${p.nome}: ${brl(Number(p.estoque_atual))} ${p.unidade}${baixo ? ` _(mín. ${brl(Number(p.estoque_minimo))})_` : ""}`;
  });

  return [
    `*ESTOQUE ATUAL*`,
    `${ativos.length} produtos${abaixoDoMinimo.length > 0 ? ` · 🔴 ${abaixoDoMinimo.length} abaixo do mínimo` : ""}`,
    "",
    ...linhas,
  ].join("\n");
}

async function handleSugestao(chatId: string, textoOriginal: string): Promise<void> {
  const parsed = parseSugestao(textoOriginal);
  if (!parsed) {
    await sendTextMessage(
      chatId,
      "Formato: *sugestao [qtd Basílico] [qtd populares]*\nExemplo: *sugestao 30 20*\nCom prazo: *sugestao 30 20 ate 27/08*\nEm PDF: *sugestao 30 20 pdf*"
    );
    return;
  }

  try {
    const resultado = await calcularSugestaoCompra({
      qtdPizzasBasilico: parsed.basilico,
      qtdPizzasPopulares: parsed.populares,
      validoAte: parsed.validoAte,
      textoOriginal,
      chatId,
    });

    if (!parsed.pdf) {
      await sendTextMessage(chatId, formatarSugestaoWhatsApp(resultado));
      return;
    }

    await sendTextMessage(chatId, "⏳ Gerando PDF, aguarde...");
    const pdf = await gerarPdfSugestaoCompra(resultado);
    const hoje = new Date().toISOString().substring(0, 10);
    await sendDocumentMessage(chatId, pdf, `sugestao-compra-${hoje}.pdf`);
  } catch (err) {
    console.error("[estoque whatsapp] erro ao calcular sugestão:", err);
    const detalhe = err instanceof Error ? err.message : String(err);
    await sendTextMessage(chatId, `❌ Erro ao gerar sugestão: ${detalhe}`);
  }
}

async function handleEstoque(chatId: string, textoOriginal: string): Promise<void> {
  const pdf = /\bpdf\b/i.test(textoOriginal);

  try {
    const produtos = await listProdutos({ ativo: true });

    if (!pdf) {
      await sendTextMessage(chatId, formatarEstoqueWhatsApp(produtos));
      return;
    }

    await sendTextMessage(chatId, "⏳ Gerando PDF, aguarde...");
    const doc = await gerarPdfEstoque(produtos);
    const hoje = new Date().toISOString().substring(0, 10);
    await sendDocumentMessage(chatId, doc, `estoque-${hoje}.pdf`);
  } catch (err) {
    console.error("[estoque whatsapp] erro ao consultar estoque:", err);
    const detalhe = err instanceof Error ? err.message : String(err);
    await sendTextMessage(chatId, `❌ Erro ao consultar estoque: ${detalhe}`);
  }
}

// Retorna true se a mensagem foi tratada como comando de estoque (o
// chamador não deve processar mais nada pra essa mensagem).
export async function handleComandoEstoque(chatId: string, textoOriginal: string): Promise<boolean> {
  const texto = textoOriginal.trim();

  if (/^(ajuda|comandos|help)$/i.test(texto)) {
    await sendTextMessage(chatId, AJUDA);
    return true;
  }

  if (/^sugest[aã]o\b/i.test(texto)) {
    await handleSugestao(chatId, texto);
    return true;
  }

  if (/^estoque\b/i.test(texto)) {
    await handleEstoque(chatId, texto);
    return true;
  }

  // Mensagem não reconhecida como comando — orienta em vez de ficar mudo.
  await sendTextMessage(chatId, `Não entendi. ${AJUDA}`);
  return true;
}
