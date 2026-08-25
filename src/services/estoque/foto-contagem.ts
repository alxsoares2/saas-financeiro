// Chamadas de IA (visão) do pipeline de contagem por foto — SPEC seção 2.
// Mesmo padrão de integração já usado em services/claude.ts (que, apesar
// do nome, usa o SDK da OpenAI — mesmo client singleton, mesmo jeito de
// montar a mensagem com image_url em base64, mesmo parse com tratamento
// de erro). Reaproveitado aqui de propósito, pra manter só um padrão de
// chamada de IA com imagem no projeto inteiro.
//
// Modelo: gpt-4o-mini em todas as 3 chamadas (pedido explicitamente —
// "modelo mini com visão"). Se a OCR de lista manuscrita se mostrar
// imprecisa na prática, o mesmo upgrade já usado pro cupom fiscal
// (gpt-4o sem "mini" + detail:"high", ver transcreverCupom em claude.ts)
// é o caminho natural — trocar seria uma linha, não redesenho.
import OpenAI from "openai";

type MimeTypeImagem = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 45_000,
      maxRetries: 2,
    });
  }
  return _client;
}

function paraDataUri(imageBuffer: Buffer, mimeType: MimeTypeImagem): string {
  return `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
}

function limparJson(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
}

async function chamarVisao(system: string, imageBuffer: Buffer, mimeType: MimeTypeImagem, textoUsuario: string, maxTokens = 1024): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: paraDataUri(imageBuffer, mimeType) } },
          { type: "text", text: textoUsuario },
        ],
      },
    ],
  } as any);
  const textContent = response.choices[0]?.message?.content;
  if (!textContent) throw new Error("OpenAI não retornou texto");
  return typeof textContent === "string" ? textContent : "";
}

// ── 1) Triagem — que tipo de foto é essa? ──────────────────────────────────

export type TipoFotoEstoque = "lista_impressa" | "lista_manuscrita" | "produto_fisico" | "indefinido";

export interface ResultadoTriagem {
  tipo: TipoFotoEstoque;
  confianca: "alta" | "media" | "baixa";
}

const TRIAGEM_SYSTEM = `Você faz a triagem de fotos enviadas num grupo de WhatsApp de controle de estoque de uma pizzaria.
Classifique a imagem em UMA destas categorias e retorne SOMENTE JSON válido, sem markdown:

{"tipo": "lista_impressa" | "lista_manuscrita" | "produto_fisico", "confianca": "alta" | "media" | "baixa"}

Definições:
- "lista_impressa": planilha, tabela ou lista de produtos DIGITADA/IMPRESSA (print de celular, papel impresso, etc), com nomes de produto e quantidades organizados em linhas/colunas.
- "lista_manuscrita": lista de produtos escrita à MÃO (caderno, papel, quadro branco) — mesmo que organizada em linhas, foi escrita à mão.
- "produto_fisico": foto de um produto/embalagem/caixa/prateleira física (não é uma lista de texto) — ex: pilha de caixas de queijo, geladeira com produtos, bisnagas empilhadas.

Se a imagem não se encaixar claramente em nenhuma (foto borrada, assunto não relacionado a estoque), retorne "produto_fisico" com confianca "baixa" — é o fallback mais seguro (sempre pede confirmação).`;

export async function triarFoto(imageBuffer: Buffer, mimeType: MimeTypeImagem, caption?: string): Promise<ResultadoTriagem> {
  const contexto = caption ? `Legenda enviada junto: "${caption}"` : "Classifique esta foto.";
  const raw = await chamarVisao(TRIAGEM_SYSTEM, imageBuffer, mimeType, contexto, 256);
  try {
    const parsed = JSON.parse(limparJson(raw));
    const tipo: TipoFotoEstoque = ["lista_impressa", "lista_manuscrita", "produto_fisico"].includes(parsed.tipo) ? parsed.tipo : "indefinido";
    const confianca = ["alta", "media", "baixa"].includes(parsed.confianca) ? parsed.confianca : "baixa";
    return { tipo, confianca };
  } catch (err) {
    console.error("[foto-contagem] Erro ao parsear triagem:", err, "Raw:", raw.substring(0, 200));
    return { tipo: "indefinido", confianca: "baixa" };
  }
}

// ── 2) Lista impressa/manuscrita — extrai nome + quantidade por linha ─────

export interface ItemListaExtraido {
  nome: string;
  quantidade: number | null;
  unidade: string | null;
  confianca: "alta" | "media" | "baixa";
}

export interface ResultadoExtracaoLista {
  itens: ItemListaExtraido[];
}

const LISTA_SYSTEM = `Você lê uma foto de lista de contagem de estoque de uma pizzaria (pode ser impressa/digitada ou
manuscrita) e extrai cada produto com a quantidade contada. Retorne SOMENTE JSON válido, sem markdown:

{
  "itens": [
    { "nome": string, "quantidade": number | null, "unidade": string | null, "confianca": "alta" | "media" | "baixa" }
  ]
}

Regras:
- Uma linha da lista = um item. Não pule nenhuma linha, mesmo que a letra esteja difícil de ler.
- "nome": transcreva o nome do produto como está escrito (não traduza nem corrija — a resolução pro produto cadastrado é feita depois, por outro processo).
- "quantidade": o número contado. Se não conseguir ler o número com confiança, retorne null e marque confianca "baixa" NESSE item — não invente um número.
- "unidade": kg, un, bisnaga, pacote, etc — o que estiver escrito do lado do número. null se não tiver.
- "confianca" é POR ITEM: "alta" se nome e número estão claramente legíveis, "media" se há dúvida em um dos dois, "baixa" se a letra/número está difícil de ler ou ambíguo.
- Se a imagem não tiver nenhuma lista legível, retorne {"itens": []}.`;

export async function extrairListaContagem(imageBuffer: Buffer, mimeType: MimeTypeImagem, caption?: string): Promise<ResultadoExtracaoLista> {
  const contexto = caption ? `Legenda enviada junto: "${caption}"` : "Extraia todos os itens desta lista de contagem.";
  const raw = await chamarVisao(LISTA_SYSTEM, imageBuffer, mimeType, contexto, 2048);
  try {
    const parsed = JSON.parse(limparJson(raw));
    if (!Array.isArray(parsed.itens)) return { itens: [] };
    return { itens: parsed.itens };
  } catch (err) {
    console.error("[foto-contagem] Erro ao parsear lista:", err, "Raw:", raw.substring(0, 200));
    return { itens: [] };
  }
}

// ── 3) Foto de produto físico — conta embalagens/unidades visíveis ────────

export interface ResultadoContagemFisica {
  produtoIdentificado: string | null;
  unidadesContadas: number | null;
  confianca: "alta" | "media" | "baixa";
  observacao: string | null;
}

function contagemFisicaSystem(nomeProdutoConhecido: string | null, padraoEmbalagem: string | null): string {
  const contextoProduto = nomeProdutoConhecido
    ? `O produto já foi identificado como "${nomeProdutoConhecido}" — conte quantas unidades de embalagem aparecem na foto (não precisa identificar o produto de novo).`
    : `Identifique qual produto aparece na foto (pelo rótulo/embalagem visível) e conte quantas unidades de embalagem aparecem.`;

  const contextoPadrao = padraoEmbalagem
    ? `Padrão de embalagem cadastrado pra esse produto: ${padraoEmbalagem}. Conte quantas CAIXAS/EMBALAGENS FECHADAS aparecem (não o conteúdo de dentro) — a multiplicação pelo padrão é feita depois, por outro processo.`
    : `Não há padrão de embalagem cadastrado pra esse produto — conte as unidades individuais que conseguir ver diretamente (ex: quantas peças, potes, sacos soltos).`;

  return `Você conta estoque físico de uma pizzaria a partir de uma foto (prateleira, geladeira, pilha de caixas).
${contextoProduto}
${contextoPadrao}

Retorne SOMENTE JSON válido, sem markdown:
{
  "produto_identificado": string | null,
  "unidades_contadas": number | null,
  "confianca": "alta" | "media" | "baixa",
  "observacao": string | null
}

Regras:
- "unidades_contadas": null se não der pra contar com nenhuma confiança (foto ruim, produto não identificável). Nunca invente um número só pra preencher.
- "confianca": "alta" só se a contagem for direta e sem ambiguidade (itens bem separados, visíveis, contáveis 1 a 1). Empilhamento, produtos parcialmente escondidos, ou contagem sem padrão de embalagem cadastrado NUNCA é "alta" — no máximo "media".
- "observacao": qualquer ressalva relevante (ex: "pode ter mais caixas atrás da pilha visível", "rótulo parcialmente coberto").`;
}

export async function contarProdutoFisico(
  imageBuffer: Buffer,
  mimeType: MimeTypeImagem,
  opcoes: { nomeProdutoConhecido?: string | null; padraoEmbalagemDescricao?: string | null; caption?: string }
): Promise<ResultadoContagemFisica> {
  const system = contagemFisicaSystem(opcoes.nomeProdutoConhecido ?? null, opcoes.padraoEmbalagemDescricao ?? null);
  const contexto = opcoes.caption ? `Legenda enviada junto: "${opcoes.caption}"` : "Conte o que aparece nesta foto.";
  const raw = await chamarVisao(system, imageBuffer, mimeType, contexto, 512);
  try {
    const parsed = JSON.parse(limparJson(raw));
    return {
      produtoIdentificado: typeof parsed.produto_identificado === "string" ? parsed.produto_identificado : null,
      unidadesContadas: typeof parsed.unidades_contadas === "number" ? parsed.unidades_contadas : null,
      confianca: ["alta", "media", "baixa"].includes(parsed.confianca) ? parsed.confianca : "baixa",
      observacao: typeof parsed.observacao === "string" ? parsed.observacao : null,
    };
  } catch (err) {
    console.error("[foto-contagem] Erro ao parsear contagem física:", err, "Raw:", raw.substring(0, 200));
    return { produtoIdentificado: null, unidadesContadas: null, confianca: "baixa", observacao: null };
  }
}
