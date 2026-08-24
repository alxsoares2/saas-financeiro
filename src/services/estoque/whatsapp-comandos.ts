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
import { sendTextMessage } from "../zapi.js";

const AJUDA = [
  "*Comandos de estoque:*",
  "",
  "• *sugestao [qtd Basílico] [qtd populares]* — gera a sugestão de compra",
  "   Exemplo: *sugestao 30 20*",
  "• *sugestao [qtd Basílico] [qtd populares] ate DD/MM* — com prazo",
  "   Exemplo: *sugestao 30 20 ate 27/08*",
  "",
  "_Contagem por foto ainda não está disponível neste grupo — em breve._",
].join("\n");

function parseSugestao(texto: string): { basilico: number; populares: number; validoAte?: string } | null {
  // "sugestao 30 20" ou "sugestao 30 20 ate 27/08"
  const match = texto.match(/^sugest[aã]o\s+(\d+)\s+(\d+)(?:\s+at[eé]\s+(\d{1,2})\/(\d{1,2}))?/i);
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

  return { basilico, populares, validoAte };
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
    const parsed = parseSugestao(texto);
    if (!parsed) {
      await sendTextMessage(
        chatId,
        "Formato: *sugestao [qtd Basílico] [qtd populares]*\nExemplo: *sugestao 30 20*\nCom prazo: *sugestao 30 20 ate 27/08*"
      );
      return true;
    }

    try {
      const resultado = await calcularSugestaoCompra({
        qtdPizzasBasilico: parsed.basilico,
        qtdPizzasPopulares: parsed.populares,
        validoAte: parsed.validoAte,
        textoOriginal,
        chatId,
      });
      await sendTextMessage(chatId, formatarSugestaoWhatsApp(resultado));
    } catch (err) {
      console.error("[estoque whatsapp] erro ao calcular sugestão:", err);
      const detalhe = err instanceof Error ? err.message : String(err);
      await sendTextMessage(chatId, `❌ Erro ao gerar sugestão: ${detalhe}`);
    }
    return true;
  }

  // Mensagem não reconhecida como comando — orienta em vez de ficar mudo.
  await sendTextMessage(chatId, `Não entendi. ${AJUDA}`);
  return true;
}
