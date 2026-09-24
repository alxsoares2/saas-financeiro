// Assistente "Marcos" no grupo financeiro — conversa com o Claude (Opus 5.5)
// usando as ferramentas de services/marcos/ferramentas.ts.
//
// Roteamento (chamado pelo webhook, ver routes/webhook.ts):
//   - mensagem começando com "marcos" (qualquer caixa) → abre/continua a conversa
//   - com conversa aberta (atividade nos últimos 10 min):
//       "sim"/"não" com ações pendentes → executa/cancela (código, sem IA)
//       "valeu"/"obrigado"/"tchau"...   → encerra a conversa
//       comandos normais (dre, pago...) → continuam indo pro handleComando
//       qualquer outro texto             → vai pro Marcos
//
// Histórico da conversa é append-only e reenviado byte a byte (system prompt
// e ferramentas fixos, sem data no system): o Opus 5.5 amarra o raciocínio
// anterior ao prefixo exato da conversa, e o cache também depende disso.
import Anthropic from "@anthropic-ai/sdk";
import { getTenants } from "../../config/tenants.js";
import { sendTextMessage } from "../zapi.js";
import {
  AcaoPendente,
  Conversa,
  buscarConversaAtiva,
  criarConversa,
  encerrarConversa,
  salvarConversa,
} from "./db.js";
import { ContextoMarcos, FERRAMENTAS, executarAcao, executarFerramenta } from "./ferramentas.js";
import { montarSystemPrompt } from "./prompt.js";

const MODELO = "claude-opus-5-5";
// Esforço de raciocínio: "low" deixa mais barato e rápido; "medium" (padrão
// do modelo) pensa mais nas perguntas difíceis. Troca sem deploy via env.
const EFFORT = (process.env.MARCOS_EFFORT as "low" | "medium" | "high" | undefined) ?? "low";
const MAX_RODADAS_FERRAMENTA = 10;

// US$ por 1M tokens. Fallback de recusa pode responder com outro modelo.
const PRECOS: Record<string, { input: number; cacheWrite: number; cacheRead: number; output: number }> = {
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  "claude-opus-5": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-8": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
};

// Envio pro WhatsApp — trocável em teste (definirEnvio) pra não mandar nada
// pra grupo de verdade.
type Envio = (chatId: string, texto: string) => Promise<void>;
let enviar: Envio = sendTextMessage;
export function definirEnvio(fn: Envio): void {
  enviar = fn;
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 2 });
  return _client;
}

// ── Detecção de mensagem ─────────────────────────────────────────────────────

export function ehChamadaMarcos(texto: string): boolean {
  return /^\s*marcos\b/i.test(texto);
}

export const RE_SIM = /^\s*(sim|s|confirmo|confirma|confirmado|pode|pode sim|ok|isso)\s*[.!]*\s*$/i;
// "sim, mas quero ver X" → executa as pendentes e manda o resto pro Marcos.
// Só "sim/confirmo/confirma" (não "pode"/"ok", que costumam iniciar outro pedido).
export const RE_SIM_COM_RESTO = /^\s*(sim|confirmo|confirma)\s*[,.;:!-]?\s+(\S[\s\S]*)$/i;
export const RE_NAO = /^\s*(n[aã]o|cancela|cancelar|deixa|esquece)\s*[.!]*\s*$/i;
export const RE_ENCERRAR = /^\s*(valeu|obrigad[oa]|brigad[oa]|tchau|falou|era isso|s[oó] isso|pode parar|encerrar?)\b[^?]{0,30}$/i;

// ── Fila por grupo ───────────────────────────────────────────────────────────
// Duas mensagens seguidas no mesmo grupo não podem processar ao mesmo tempo
// (as duas leriam o mesmo histórico e uma sobrescreveria a outra).
const filas = new Map<string, Promise<unknown>>();
function naFila<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const anterior = filas.get(chatId) ?? Promise.resolve();
  const atual = anterior.catch(() => undefined).then(fn);
  filas.set(chatId, atual);
  atual.finally(() => {
    if (filas.get(chatId) === atual) filas.delete(chatId);
  });
  return atual;
}

// ── Pontos de entrada do webhook ─────────────────────────────────────────────

export interface EntradaMarcos {
  chatId: string;
  texto: string;
  remetente: string;
  lojaAtual: string; // tenant.id
}

// Chamado ANTES do roteador de comandos. Trata o que tem prioridade sobre os
// comandos: chamada explícita ("marcos ..."), "sim"/"não" de ações pendentes
// do Marcos e encerramento. Devolve true se tratou a mensagem.
export function marcosAntesDosComandos(e: EntradaMarcos): Promise<boolean> {
  return naFila(e.chatId, async () => {
    if (ehChamadaMarcos(e.texto)) {
      await conversar(e, await buscarConversaAtiva(e.chatId));
      return true;
    }
    const conversa = await buscarConversaAtiva(e.chatId);
    if (!conversa) return false;

    if (conversa.acoesPendentes.length && RE_SIM.test(e.texto)) {
      await confirmar(e, conversa);
      return true;
    }
    const simComResto = conversa.acoesPendentes.length ? e.texto.match(RE_SIM_COM_RESTO) : null;
    if (simComResto) {
      await confirmar(e, conversa);
      await conversar({ ...e, texto: simComResto[2] }, conversa);
      return true;
    }
    if (conversa.acoesPendentes.length && RE_NAO.test(e.texto)) {
      await cancelar(e, conversa);
      return true;
    }
    if (RE_ENCERRAR.test(e.texto)) {
      await encerrarConversa(conversa.id);
      await enviar(e.chatId, "👍");
      return true;
    }
    return false;
  });
}

// Chamado DEPOIS do roteador de comandos (a mensagem não era comando). Se
// tem conversa aberta, o texto vai pro Marcos. Devolve true se tratou.
export function marcosDepoisDosComandos(e: EntradaMarcos): Promise<boolean> {
  return naFila(e.chatId, async () => {
    const conversa = await buscarConversaAtiva(e.chatId);
    if (!conversa) return false;
    await conversar(e, conversa);
    return true;
  });
}

// ── Conversa ─────────────────────────────────────────────────────────────────

// Lojas que podem aparecer no acerto de contas. Não precisam ter grupo
// cadastrado no sistema (o acerto fica todo no banco deste grupo) — por isso
// a lista soma as lojas de TENANTS com MARCOS_LOJAS.
function contexto(e: EntradaMarcos): ContextoMarcos {
  const extras = (process.env.MARCOS_LOJAS ?? "mano,basilico").split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
  const lojas = [...new Set([...getTenants().map((t) => t.id.replace(/-estoque$/, "")), ...extras])];
  return { lojaAtual: e.lojaAtual, outrasLojas: lojas.filter((l) => l !== e.lojaAtual), remetente: e.remetente };
}

function carimbo(remetente: string): string {
  const agora = new Date();
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(agora);
  return `[${remetente} — ${fmt}]`;
}

function custoDaResposta(r: Anthropic.Beta.BetaMessage): number {
  const p = PRECOS[r.model] ?? PRECOS[MODELO];
  const u: any = r.usage;
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.output_tokens ?? 0) * p.output) /
    1e6
  );
}

async function conversar(e: EntradaMarcos, existente: Conversa | null): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    await enviar(e.chatId, "⚠️ O Marcos ainda não está configurado (falta ANTHROPIC_API_KEY no servidor).");
    return;
  }

  const ctx = contexto(e);
  const conversa = existente ?? (await criarConversa(e.chatId));
  const tamanhoAntes = conversa.mensagens.length;

  let prefixo = "";
  if (conversa.acoesPendentes.length) {
    prefixo = "[sistema: as alterações que estavam aguardando confirmação foram descartadas, porque chegou mensagem nova em vez de 'sim'.]\n";
    conversa.acoesPendentes = [];
  }
  conversa.mensagens.push({ role: "user", content: [{ type: "text", text: `${prefixo}${carimbo(e.remetente)} ${e.texto.trim()}` }] });

  const system = montarSystemPrompt(ctx.lojaAtual, ctx.outrasLojas);
  const pendentes: AcaoPendente[] = [];
  let custoTurno = 0;
  let textoFinal = "";

  try {
    for (let rodada = 0; rodada < MAX_RODADAS_FERRAMENTA; rodada++) {
      const resposta = await getClient().beta.messages.create({
        model: MODELO,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"],
        // Se o filtro de segurança recusar por engano, a própria API refaz
        // num modelo substituto em vez de devolver a recusa.
        fallbacks: "default",
        // Raciocínio fica sempre ligado no Opus 5.5 (não dá pra desligar); o
        // controle de custo é o effort. drop_block: se algum dia o histórico
        // salvo divergir, a API descarta o raciocínio antigo em vez de dar erro.
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } } as any,
        output_config: { effort: EFFORT },
        cache_control: { type: "ephemeral" },
        system,
        tools: FERRAMENTAS,
        messages: conversa.mensagens,
      });
      custoTurno += custoDaResposta(resposta);

      if (resposta.stop_reason === "refusal") {
        textoFinal = "Não consegui processar esse pedido. Tenta reformular?";
        break;
      }

      conversa.mensagens.push({ role: "assistant", content: resposta.content as any });
      textoFinal = resposta.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      if (resposta.stop_reason !== "tool_use") break;

      const chamadas = resposta.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const resultados: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const c of chamadas) {
        try {
          const saida = await executarFerramenta(c.name, c.input, ctx, pendentes);
          resultados.push({
            type: "tool_result",
            tool_use_id: c.id,
            content: typeof saida === "string" ? saida : JSON.stringify(saida),
          });
        } catch (err) {
          resultados.push({
            type: "tool_result",
            tool_use_id: c.id,
            is_error: true,
            content: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Todos os resultados numa mensagem só (vários na mesma rodada é normal).
      conversa.mensagens.push({ role: "user", content: resultados });
    }
  } catch (err) {
    // Falha no meio: volta o histórico pro estado de antes desta mensagem
    // (um tool_use sem tool_result quebraria a próxima chamada).
    conversa.mensagens.length = tamanhoAntes;
    console.error("[Marcos] Erro na conversa:", err);
    await salvarConversa(conversa);
    const detalhe = err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err instanceof Error ? err.message : String(err);
    await enviar(e.chatId, `⚠️ Marcos teve um problema e não conseguiu responder: ${detalhe.substring(0, 200)}`);
    return;
  }

  conversa.custoUsd += custoTurno;
  conversa.acoesPendentes = pendentes;
  await salvarConversa(conversa);
  console.log(`[Marcos] turno: US$ ${custoTurno.toFixed(4)} | conversa: US$ ${conversa.custoUsd.toFixed(4)} | pendentes: ${pendentes.length}`);

  // "[silencio]" = o modelo decidiu não falar (conversa entre as pessoas, ou
  // alteração que a lista de confirmação já explica sozinha).
  const texto = textoFinal.replace(/\[silencio\]/gi, "").trim();
  const partes: string[] = [];
  if (texto) partes.push(texto);
  if (pendentes.length) {
    partes.push(
      [
        "📝 *Confirma?*",
        ...pendentes.map((p, i) => `${i + 1}. ${p.descricao}`),
        "*sim* ou *não*",
      ].join("\n")
    );
  }
  if (partes.length) await enviar(e.chatId, partes.join("\n\n"));
}

// ── Confirmação (código puro — a IA não decide o que executar) ───────────────

async function confirmar(e: EntradaMarcos, conversa: Conversa): Promise<void> {
  const ctx = contexto(e);
  const linhas: string[] = [];
  for (const acao of conversa.acoesPendentes) {
    try {
      linhas.push(await executarAcao(acao, ctx));
    } catch (err) {
      linhas.push(`❌ Falhou: ${acao.descricao.split("\n")[0]} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  conversa.acoesPendentes = [];
  // Registra no histórico pro Marcos saber o que aconteceu na próxima pergunta.
  conversa.mensagens.push({
    role: "user",
    content: [{ type: "text", text: `[sistema: ${e.remetente} confirmou. Resultado:\n${linhas.join("\n")}]` }],
  });
  await salvarConversa(conversa);
  await enviar(e.chatId, linhas.join("\n"));
}

async function cancelar(e: EntradaMarcos, conversa: Conversa): Promise<void> {
  conversa.acoesPendentes = [];
  conversa.mensagens.push({
    role: "user",
    content: [{ type: "text", text: `[sistema: ${e.remetente} cancelou as alterações pendentes. Nada foi alterado.]` }],
  });
  await salvarConversa(conversa);
  await enviar(e.chatId, "❌ Cancelado, nada foi alterado.");
}
