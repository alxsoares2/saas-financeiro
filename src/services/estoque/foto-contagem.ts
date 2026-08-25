// Chamadas de IA (visão) do pipeline de contagem por foto — SPEC seção 2.
// Mesmo padrão de integração já usado em services/claude.ts (que, apesar
// do nome, usa o SDK da OpenAI — mesmo client singleton, mesmo jeito de
// montar a mensagem com image_url em base64, mesmo parse com tratamento
// de erro). Reaproveitado aqui de propósito, pra manter só um padrão de
// chamada de IA com imagem no projeto inteiro.
//
// Modelo: gpt-4o-mini na triagem e na leitura de lista (texto — o modelo
// mini já lê bem letra impressa/manuscrita). A CONTAGEM DE PRODUTO FÍSICO
// usa gpt-4o (sem "mini") + detail:"high" — mesmo upgrade já usado pro
// cupom fiscal em claude.ts (transcreverCupom): teste real mostrou o mini
// separando mal objetos sobrepostos/parcialmente escondidos numa mesma
// foto (contava 2 garrafas empilhadas como 1, ignorava uma parcialmente
// coberta por outra) — limitação de visão computacional em fotos com
// vários itens amontoados, não algo que ajuste de prompt sozinho resolve.
// Custa mais por imagem, mas é exatamente a troca de precisão por custo
// que faz sentido aqui (poucas fotos de produto físico por dia, cada uma
// grava estoque real).
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

async function chamarVisao(
  system: string,
  imageBuffer: Buffer,
  mimeType: MimeTypeImagem,
  textoUsuario: string,
  maxTokens = 1024,
  opcoes?: { modelo?: string; detail?: "auto" | "low" | "high" }
): Promise<string> {
  const imageUrl: { url: string; detail?: "auto" | "low" | "high" } = { url: paraDataUri(imageBuffer, mimeType) };
  if (opcoes?.detail) imageUrl.detail = opcoes.detail;

  const response = await getClient().chat.completions.create({
    model: opcoes?.modelo ?? "gpt-4o-mini",
    max_tokens: maxTokens,
    // temperature 0: triagem/leitura/contagem são tarefas determinísticas
    // por natureza (a resposta certa não muda entre rodadas) — sem isso o
    // modelo usa a temperatura padrão da OpenAI, o que explicou um caso
    // real de inconsistência entre rodadas na mesma foto (nome de item
    // mudando, item sumindo do resultado sem a foto ter mudado).
    temperature: 0,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: imageUrl },
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

// ── 3) Foto de produto físico — pode ter 1 OU VÁRIOS produtos na mesma foto
// (pilha de caixas de um item só, ou geladeira/prateleira com vários
// produtos diferentes juntos) — por isso devolve a MESMA forma de
// {itens: [...]} da extração de lista, em vez de um resultado único: o
// downstream (matching + confirmação em lote) já sabe lidar com N itens.

function contagemFisicaSystem(referenciaPadroes: string): string {
  return `Você conta estoque físico de uma pizzaria a partir de uma foto (pode ser 1 produto só — ex: pilha de
caixas do mesmo item — ou vários produtos diferentes juntos na mesma foto — ex: geladeira ou prateleira com
itens variados).

Identifique CADA produto distinto visível na foto e estime a quantidade de cada um, JÁ CONVERTIDA pra
unidade de estoque que a pizzaria usa (kg, un, bisnaga, barra etc — não a quantidade de caixas/pacotes).

Referência de embalagem de produtos já cadastrados (use pra converter "vejo N caixas/peças" em quantidade
de estoque, quando o produto da foto bater com um da lista — ex: "3 barras de queijo" vira quantidade 12,
unidade "kg", se a barra for de 4kg segundo a referência):
${referenciaPadroes || "(nenhum padrão de embalagem cadastrado ainda)"}

Retorne SOMENTE JSON válido, sem markdown:
{
  "itens": [
    { "nome": string, "quantidade": number | null, "unidade": string | null, "confianca": "alta" | "media" | "baixa" }
  ]
}

Regras:
- ⚠️ NÃO PULE NENHUM PRODUTO — antes de responder, varra a foto de novo do início ao fim (esquerda pra
  direita, de cima a baixo) conferindo se todo item que você já listou continua lá E se não ficou nenhum
  produto de fora. É um erro comum ignorar um produto porque ele "parece repetido" ou "parece o mesmo" de
  outro já listado — NÃO é: dois produtos lado a lado com embalagem parecida (ex: duas garrafas PET de
  refrigerante) quase sempre são MARCAS OU VARIANTES DIFERENTES (ex: uma garrafa com tampa vermelha —
  Coca-Cola normal — do lado de uma com tampa preta — Coca-Cola Zero; ou duas marcas de guaraná lado a
  lado). Leia o RÓTULO de cada unidade individualmente antes de agrupar ou descartar qualquer uma — nunca
  assuma que é duplicata só pelo formato da embalagem.
- Cada RÓTULO/VARIANTE distinto = um item próprio na lista, mesmo que a embalagem física (garrafa, caixa)
  seja idêntica — normal e zero/diet/light do mesmo refrigerante são produtos DIFERENTES, nunca some as
  duas num item só.
- "nome": nome do produto como você identifica pelo rótulo/embalagem/aparência.
- "quantidade": CONTE CADA UNIDADE FÍSICA INDIVIDUALMENTE, incluindo garrafas/embalagens parcialmente
  visíveis, parcialmente sobrepostas por outra, ou cortadas na borda da foto — uma garrafa atrás de outra
  ou só com o gargalo visível ainda é 1 unidade, não descarte. Já CONVERTIDA pra unidade de estoque que a
  pizzaria usa (kg, un, bisnaga, barra etc — não a quantidade de caixas/pacotes; use a referência de
  embalagem acima quando o produto bater). Se não conseguir estimar com nenhuma confiança pra um produto
  específico, quantidade=null NESSE item — não invente número, mas ainda assim liste o produto se
  conseguiu identificar ele.
- "confianca" é por item: contagem por foto raramente é "alta" (itens podem estar parcialmente escondidos,
  empilhados, ou sem referência de embalagem conhecida) — use "alta" só quando a contagem é direta e sem
  ambiguidade nenhuma.
- Se a foto não mostrar nenhum produto de estoque reconhecível, retorne {"itens": []}.`;
}

export async function contarProdutosVisiveis(
  imageBuffer: Buffer,
  mimeType: MimeTypeImagem,
  referenciaPadroes: string,
  caption?: string
): Promise<ResultadoExtracaoLista> {
  const contexto = caption ? `Legenda enviada junto: "${caption}"` : "Identifique e conte os produtos visíveis nesta foto.";
  // gpt-4o (não o -mini) + detail "high" — ver comentário no topo do arquivo.
  const raw = await chamarVisao(contagemFisicaSystem(referenciaPadroes), imageBuffer, mimeType, contexto, 1024, {
    modelo: "gpt-4o",
    detail: "high",
  });
  try {
    const parsed = JSON.parse(limparJson(raw));
    if (!Array.isArray(parsed.itens)) return { itens: [] };
    return { itens: parsed.itens };
  } catch (err) {
    console.error("[foto-contagem] Erro ao parsear contagem de produtos visíveis:", err, "Raw:", raw.substring(0, 200));
    return { itens: [] };
  }
}
