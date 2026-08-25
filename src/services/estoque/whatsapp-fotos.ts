// Orquestração do pipeline de contagem por foto — SPEC seção 2. Recebe a
// foto já baixada do Z-API (buffer + mimeType) e a URL já persistida no
// Storage (o chamador em webhook.ts faz isso, mesmo padrão do fluxo
// financeiro), faz a triagem, extrai/conta, resolve produto via
// matching.ts e decide gravar direto ou pedir confirmação no grupo —
// nunca sem passar por uma dessas duas coisas.
//
// Os 3 tipos de foto (lista impressa, lista manuscrita, produto físico)
// convergem pro MESMO formato depois da extração — {nome, quantidade,
// unidade, confianca} por item — porque produto físico pode ter vários
// produtos na mesma foto (geladeira, prateleira), não só um. Isso deixa
// o resto do pipeline (matching + confirmação em lote) igual pros três.
//
// Confiança (spec seção 2, "Ordem do fluxo"):
//   - lista impressa/digitada: item com produto encontrado (matching.ts) E
//     confiança alta da IA -> grava direto. Resto do lote vai pra confirmação.
//   - lista manuscrita: TODO item sempre vai pra confirmação, mesmo com
//     confiança alta na leitura — "sempre pedir confirmação" é explícito na spec.
//   - foto de produto físico: SEMPRE confirma, com ou sem padrão de
//     embalagem cadastrado — mais conservador que o texto da spec (que só
//     fala explicitamente do caso sem padrão), mas contagem por visão é
//     inerentemente mais sujeita a erro que leitura de texto, então trata
//     os dois casos igual até haver dado de acerto/erro real pra calibrar.
import { encontrarProdutoPorNome } from "./matching.js";
import { contarProdutosVisiveis, extrairListaContagem, ItemListaExtraido, triarFoto } from "./foto-contagem.js";
import { listPadroesEmbalagem, listProdutos, registrarMovimentacao } from "./db.js";
import { OrigemMovimentacao } from "./types.js";
import { sendTextMessage } from "../zapi.js";

type MimeTypeImagem = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

// Confiança mínima (produto encontrado × confiança da IA) pra gravar
// direto sem passar por confirmação — só usado na lista impressa.
const LIMIAR_AUTO_REGISTRO = 0.8;

// Acima desse tanto de produtos distintos numa foto de PRODUTO FÍSICO
// (não lista — ali é normal ter muita linha), sugere fotos separadas —
// fotos com muitos itens amontoados são exatamente onde a contagem visual
// mais erra (objetos sobrepostos/parcialmente escondidos).
const LIMIAR_ITENS_PARA_DICA_SEGMENTACAO = 2;
const DICA_SEGMENTACAO =
  "💡 _Pra contagens mais precisas, tente fotos separadas por categoria (ex: só os refrigerantes, só os laticínios), com os itens de frente e sem sobrepor uns aos outros._";

interface ItemPendente {
  nomeLido: string;
  quantidade: number;
  unidade: string | null;
  produtoId: string | null;
  produtoNome: string | null;
  confiancaOcr: number; // 0..1
}

interface PendingConfirmacaoFoto {
  origem: OrigemMovimentacao;
  itens: ItemPendente[];
  fotoUrl: string;
  criadoEm: number;
}

// Estado em memória — mesmo padrão do pendingConfirmations do fluxo
// financeiro em webhook.ts. Uma confirmação pendente por chat.
const pendentes = new Map<string, PendingConfirmacaoFoto>();

function brl(v: number): string {
  return v.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}

function confiancaTextoParaNumero(c: "alta" | "media" | "baixa"): number {
  return c === "alta" ? 1 : c === "media" ? 0.65 : 0.3;
}

// ── Entrada principal — chamada pelo webhook quando chega uma imagem ──────

export async function handleFotoEstoque(
  chatId: string,
  imageBuffer: Buffer,
  mimeType: MimeTypeImagem,
  caption: string | undefined,
  fotoUrl: string
): Promise<void> {
  let triagem;
  try {
    triagem = await triarFoto(imageBuffer, mimeType, caption);
  } catch (err) {
    console.error("[whatsapp-fotos] Erro na triagem:", err);
    await sendTextMessage(chatId, "❌ Não consegui analisar essa foto agora. Tenta de novo em instantes.");
    return;
  }

  try {
    if (triagem.tipo === "lista_impressa" || triagem.tipo === "lista_manuscrita") {
      const extraido = await extrairListaContagem(imageBuffer, mimeType, caption);
      const origem: OrigemMovimentacao = triagem.tipo === "lista_impressa" ? "foto_lista_impressa" : "foto_lista_manuscrita";
      await processarItensVisuais(chatId, extraido.itens, origem, fotoUrl, triagem.tipo === "lista_impressa");
    } else {
      const referencia = await construirReferenciaPadroes();
      const resultado = await contarProdutosVisiveis(imageBuffer, mimeType, referencia, caption);
      await processarItensVisuais(chatId, resultado.itens, "foto_produto", fotoUrl, false);
    }
  } catch (err) {
    console.error("[whatsapp-fotos] Erro ao processar foto:", err);
    await sendTextMessage(chatId, "❌ Erro ao processar essa foto. Tenta de novo, ou usa um comando de texto (*ajuda*).");
  }
}

// Monta um texto de referência ("Produto: descrição do padrão") a partir
// de padroes_embalagem, pra IA converter "N caixas/peças visíveis" direto
// pra quantidade de estoque na contagem de produto físico.
async function construirReferenciaPadroes(): Promise<string> {
  const [padroes, produtos] = await Promise.all([listPadroesEmbalagem(), listProdutos({ ativo: true })]);
  const produtoPorId = new Map(produtos.map((p) => [p.id, p]));
  return padroes
    .map((padrao) => {
      const produto = produtoPorId.get(padrao.produto_id);
      return produto ? `- ${produto.nome}: ${padrao.nome_padrao}` : null;
    })
    .filter((linha): linha is string => linha !== null)
    .join("\n");
}

// ── Pipeline comum — resolve produto, decide gravar direto ou confirmar ──
// Usado pelos 3 tipos de foto (lista impressa, manuscrita, produto
// físico), já que todos convergem pro formato {nome, quantidade, unidade}.

async function processarItensVisuais(
  chatId: string,
  itensExtraidos: ItemListaExtraido[],
  origem: OrigemMovimentacao,
  fotoUrl: string,
  permitirAutoRegistro: boolean
): Promise<void> {
  const comQuantidade = itensExtraidos.filter((i) => i.quantidade != null);

  if (comQuantidade.length === 0) {
    await sendTextMessage(
      chatId,
      "Não consegui identificar quantidade em nenhum item dessa foto. Tenta mandar de novo com mais luz/foco, ou usa um comando de texto (*ajuda*)."
    );
    return;
  }

  const produtos = await listProdutos({ ativo: true });
  const itensResolvidos: ItemPendente[] = comQuantidade.map((item) => {
    const match = encontrarProdutoPorNome(item.nome, produtos);
    const confiancaCombinada = match ? Math.min(match.confianca, confiancaTextoParaNumero(item.confianca)) : 0;
    return {
      nomeLido: item.nome,
      quantidade: item.quantidade!,
      unidade: item.unidade,
      produtoId: match?.produto.id ?? null,
      produtoNome: match?.produto.nome ?? null,
      confiancaOcr: confiancaCombinada,
    };
  });

  const auto = permitirAutoRegistro ? itensResolvidos.filter((i) => i.produtoId && i.confiancaOcr >= LIMIAR_AUTO_REGISTRO) : [];
  const paraConfirmar = itensResolvidos.filter((i) => !auto.includes(i));

  for (const item of auto) {
    await registrarMovimentacao({
      produtoId: item.produtoId!,
      tipo: "contagem",
      quantidade: item.quantidade,
      estoqueResultante: item.quantidade,
      origem,
      confiancaOcr: item.confiancaOcr,
      fotoUrl,
    });
  }

  const linhas: string[] = [];
  if (auto.length > 0) {
    linhas.push(`✅ *${auto.length} ${auto.length === 1 ? "item gravado" : "itens gravados"} direto:*`);
    for (const item of auto) linhas.push(`   • ${item.produtoNome}: ${brl(item.quantidade)}${item.unidade ? ` ${item.unidade}` : ""}`);
  }

  if (paraConfirmar.length > 0) {
    pendentes.set(chatId, { origem, itens: paraConfirmar, fotoUrl, criadoEm: Date.now() });
    if (linhas.length > 0) linhas.push("");
    linhas.push(`⚠️ *${paraConfirmar.length} ${paraConfirmar.length === 1 ? "item precisa" : "itens precisam"} de confirmação:*`);
    paraConfirmar.forEach((item, idx) => {
      const alvo = item.produtoNome ?? `"${item.nomeLido}" _(produto não encontrado no cadastro)_`;
      linhas.push(`   ${idx + 1}. ${alvo}: ${brl(item.quantidade)}${item.unidade ? ` ${item.unidade}` : ""}`);
    });
    linhas.push("", "Responda *sim* pra confirmar todos, *não* pra descartar, ou *sim 1,3* pra confirmar só os números 1 e 3.");
  }

  if (origem === "foto_produto" && itensResolvidos.length > LIMIAR_ITENS_PARA_DICA_SEGMENTACAO) {
    linhas.push("", DICA_SEGMENTACAO);
  }

  await sendTextMessage(chatId, linhas.join("\n"));
}

// ── Resposta de confirmação ("sim" / "não" / "sim 1,3") ────────────────
// Chamado pelo webhook ANTES do roteador de comandos de texto — se não
// houver confirmação pendente pro chat, devolve false e quem chamou segue
// o fluxo normal de comando.

export async function handleRespostaConfirmacaoFoto(chatId: string, textoOriginal: string, confirmadoPor?: string): Promise<boolean> {
  const pendente = pendentes.get(chatId);
  if (!pendente) return false;

  const texto = textoOriginal.trim().toLowerCase();

  if (/^(nao|não|cancelar|descartar)\b/.test(texto)) {
    pendentes.delete(chatId);
    await sendTextMessage(chatId, "❌ Descartado — nada foi gravado.");
    return true;
  }

  const matchSim = texto.match(/^sim\b\s*([\d,\s]*)$/);
  if (!matchSim) return false; // não é resposta de confirmação — deixa outro handler tratar

  const listaIndices = matchSim[1].trim();
  const selecionados = listaIndices
    ? listaIndices
        .split(",")
        .map((s) => parseInt(s.trim(), 10) - 1)
        .filter((i) => !isNaN(i) && i >= 0 && i < pendente.itens.length)
    : pendente.itens.map((_, i) => i);

  if (selecionados.length === 0) {
    await sendTextMessage(chatId, "Não entendi quais números confirmar. Responda *sim* (todos), *não*, ou *sim 1,3* (só alguns).");
    return true;
  }

  let gravados = 0;
  const semProduto: string[] = [];
  for (const idx of selecionados) {
    const item = pendente.itens[idx];
    if (!item.produtoId) {
      semProduto.push(item.nomeLido);
      continue;
    }
    await registrarMovimentacao({
      produtoId: item.produtoId,
      tipo: "contagem",
      quantidade: item.quantidade,
      estoqueResultante: item.quantidade,
      origem: pendente.origem,
      confiancaOcr: item.confiancaOcr,
      confirmadoPor,
      fotoUrl: pendente.fotoUrl,
    });
    gravados++;
  }

  pendentes.delete(chatId);

  const linhas = [
    gravados > 0 ? `✅ ${gravados} ${gravados === 1 ? "item gravado" : "itens gravados"}.` : null,
    semProduto.length > 0
      ? `⚠️ ${semProduto.length} não ${semProduto.length === 1 ? "foi gravado" : "foram gravados"} (produto não cadastrado): ${semProduto.join(", ")}`
      : null,
  ];
  await sendTextMessage(chatId, linhas.filter(Boolean).join("\n") || "Nada foi gravado.");
  return true;
}
