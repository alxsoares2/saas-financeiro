// Orquestração do pipeline de contagem por foto — SPEC seção 2. Recebe a
// foto já baixada do Z-API (buffer + mimeType) e a URL já persistida no
// Storage (o chamador em webhook.ts faz isso, mesmo padrão do fluxo
// financeiro), faz a triagem, extrai/conta, resolve produto via
// matching.ts e decide gravar direto ou pedir confirmação no grupo —
// nunca sem passar por uma dessas duas coisas.
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
import { contarProdutoFisico, extrairListaContagem, triarFoto, TipoFotoEstoque } from "./foto-contagem.js";
import { getPadraoEmbalagem, listProdutos, registrarMovimentacao } from "./db.js";
import { OrigemMovimentacao, Produto } from "./types.js";
import { sendTextMessage } from "../zapi.js";

type MimeTypeImagem = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

// Confiança mínima (produto encontrado × confiança da IA) pra gravar
// direto sem passar por confirmação — só usado na lista impressa.
const LIMIAR_AUTO_REGISTRO = 0.8;

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
      await processarLista(chatId, imageBuffer, mimeType, caption, fotoUrl, triagem.tipo);
    } else {
      await processarProdutoFisico(chatId, imageBuffer, mimeType, caption, fotoUrl);
    }
  } catch (err) {
    console.error("[whatsapp-fotos] Erro ao processar foto:", err);
    await sendTextMessage(chatId, "❌ Erro ao processar essa foto. Tenta de novo, ou usa um comando de texto (*ajuda*).");
  }
}

// ── Lista impressa/manuscrita ───────────────────────────────────────────

async function processarLista(
  chatId: string,
  imageBuffer: Buffer,
  mimeType: MimeTypeImagem,
  caption: string | undefined,
  fotoUrl: string,
  tipo: TipoFotoEstoque
): Promise<void> {
  const extraido = await extrairListaContagem(imageBuffer, mimeType, caption);
  const comQuantidade = extraido.itens.filter((i) => i.quantidade != null);

  if (comQuantidade.length === 0) {
    await sendTextMessage(
      chatId,
      "Não consegui ler nenhum item com quantidade nessa lista. Tenta mandar de novo com mais luz/foco, ou usa um comando de texto (*ajuda*)."
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

  // Só a lista IMPRESSA pode gravar direto (spec: "OCR direto, alta
  // confiança"). Manuscrita sempre vai inteira pra confirmação.
  const auto = tipo === "lista_impressa" ? itensResolvidos.filter((i) => i.produtoId && i.confiancaOcr >= LIMIAR_AUTO_REGISTRO) : [];
  const paraConfirmar = itensResolvidos.filter((i) => !auto.includes(i));
  const origem: OrigemMovimentacao = tipo === "lista_impressa" ? "foto_lista_impressa" : "foto_lista_manuscrita";

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

  await sendTextMessage(chatId, linhas.join("\n"));
}

// ── Foto de produto físico ──────────────────────────────────────────────

async function processarProdutoFisico(
  chatId: string,
  imageBuffer: Buffer,
  mimeType: MimeTypeImagem,
  caption: string | undefined,
  fotoUrl: string
): Promise<void> {
  const produtos = await listProdutos({ ativo: true });

  // Resolve o produto pela legenda ANTES de perguntar pra IA — mais
  // confiável que pedir pra ela adivinhar só pela imagem.
  let produtoConhecido: Produto | null = null;
  if (caption) {
    const match = encontrarProdutoPorNome(caption, produtos);
    if (match && match.confianca >= 0.6) produtoConhecido = match.produto;
  }

  const padraoConhecido = produtoConhecido ? await getPadraoEmbalagem(produtoConhecido.id) : null;
  const descricaoPadrao = padraoConhecido ? `${padraoConhecido.nome_padrao} (${padraoConhecido.unidades_por_padrao} unidades por embalagem)` : null;

  const resultado = await contarProdutoFisico(imageBuffer, mimeType, {
    nomeProdutoConhecido: produtoConhecido?.nome ?? null,
    padraoEmbalagemDescricao: descricaoPadrao,
    caption,
  });

  // Sem legenda, tenta casar pelo que a IA identificou na foto.
  if (!produtoConhecido && resultado.produtoIdentificado) {
    const match = encontrarProdutoPorNome(resultado.produtoIdentificado, produtos);
    if (match) produtoConhecido = match.produto;
  }

  if (!produtoConhecido || resultado.unidadesContadas == null) {
    const linhas = [
      "Não consegui identificar o produto ou contar com confiança nessa foto.",
      resultado.observacao ? `_${resultado.observacao}_` : null,
      'Tenta mandar de novo com o produto na legenda (ex: "queijo mussarela"), ou usa um comando de texto.',
    ];
    await sendTextMessage(chatId, linhas.filter(Boolean).join("\n"));
    return;
  }

  const padrao = padraoConhecido ?? (await getPadraoEmbalagem(produtoConhecido.id));
  const quantidadeFinal = padrao?.unidades_por_padrao ? resultado.unidadesContadas * padrao.unidades_por_padrao : resultado.unidadesContadas;

  const item: ItemPendente = {
    nomeLido: resultado.produtoIdentificado ?? produtoConhecido.nome,
    quantidade: quantidadeFinal,
    unidade: produtoConhecido.unidade,
    produtoId: produtoConhecido.id,
    produtoNome: produtoConhecido.nome,
    confiancaOcr: confiancaTextoParaNumero(resultado.confianca),
  };

  // Produto físico SEMPRE confirma (ver premissa no topo do arquivo).
  pendentes.set(chatId, { origem: "foto_produto", itens: [item], fotoUrl, criadoEm: Date.now() });

  const linhas = [
    `📦 *${produtoConhecido.nome}*`,
    padrao?.unidades_por_padrao
      ? `${brl(resultado.unidadesContadas)} ${padrao.nome_padrao} × ${padrao.unidades_por_padrao} = *${brl(quantidadeFinal)} ${produtoConhecido.unidade}*`
      : `*${brl(quantidadeFinal)} ${produtoConhecido.unidade}*`,
    resultado.observacao ? `_${resultado.observacao}_` : null,
    "",
    "Responda *sim* pra confirmar ou *não* pra descartar.",
  ];
  await sendTextMessage(chatId, linhas.filter(Boolean).join("\n"));
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
