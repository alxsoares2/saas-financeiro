// Compara modelos de IA (acerto × custo × tempo) nas duas tarefas de visão
// do projeto, usando os MESMOS prompts de produção (importados de
// services/claude.ts e services/estoque/foto-contagem.ts) — só o modelo e
// os parâmetros de chamada mudam entre as configurações testadas.
//
// Uso:
//   npm run comparar-modelos -- --cupons=20
//   npm run comparar-modelos -- --cupons=20 --configs=antigo,sol,luna
//   npm run comparar-modelos -- --cupons=0 --estoque          (só estoque)
//   npm run comparar-modelos -- --cupons=20 --loja=basilico   (tenant do TENANTS)
//
// Precisa de OPENAI_API_KEY no ambiente (o .env local não tem — a chave de
// produção fica no Railway). Supabase vem do .env como no resto do projeto.
//
// ── Cupons ───────────────────────────────────────────────────────────────────
// Gabarito = o que está gravado hoje em `lancamentos` pra cada foto de cupom
// (url_arquivo com "img_"): soma dos valores, data de emissão e valor por
// categoria. Isso inclui as correções feitas no grupo (ajustar/categoria/
// data), mas cupom que ninguém conferiu reflete o que o gpt-4o leu na época —
// ou seja, o gabarito puxa um pouco a favor do modelo antigo (gpt-4o). Divergência de
// outro modelo NÃO quer dizer automaticamente que ele errou: confira os
// casos listados no relatório abrindo a foto.
//
// ── Estoque ──────────────────────────────────────────────────────────────────
// Foto de estoque não fica salva em lugar nenhum, então o gabarito é manual:
// coloque as fotos em eval/estoque/ e descreva o que tem nelas em
// eval/estoque/gabarito.json:
//   {
//     "geladeira1.jpg": { "tipo": "produto_fisico", "itens": [{ "nome": "Coca-Cola 2L", "quantidade": 3 }] },
//     "lista1.jpg":     { "tipo": "lista", "itens": [{ "nome": "Mussarela", "quantidade": 12 }] }
//   }
//
// Relatório sai em scripts/resultados/ (markdown + JSON bruto).
import "dotenv/config";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { extname, join } from "path";
import {
  CLASSIFICACAO_SYSTEM,
  LinhaCupom,
  TRANSCRICAO_SYSTEM,
  TranscricaoCupom,
  corrigirLinhasDesconto,
  montarItensAgrupados,
  parseClassificacao,
  parseTranscricao,
} from "../src/services/claude.js";
import { LISTA_SYSTEM, contagemFisicaSystem } from "../src/services/estoque/foto-contagem.js";
import { listPadroesEmbalagem, listProdutos } from "../src/services/estoque/db.js";
import { runWithTenant } from "../src/db/supabase.js";
import { getTenants } from "../src/config/tenants.js";

// ── Preços (US$ por 1M tokens) — developers.openai.com/api/docs/pricing, set/2026 ──
const PRECOS: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-4o": { input: 2.5, cached: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cached: 0.075, output: 0.6 },
  "gpt-6-astra": { input: 10, cached: 1, output: 50 },
  "gpt-6-sol": { input: 2, cached: 0.2, output: 10 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  "gpt-5.6-terra": { input: 2, cached: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
  "gpt-5-mini": { input: 0.25, cached: 0.025, output: 2 },
};

// Um "passo" = um modelo + como chamar. `effort` só vale pros modelos de
// raciocínio (GPT-5+/6); undefined = não manda o parâmetro (gpt-4o*).
// Com effort "none" dá pra manter temperature 0 como em produção; com
// raciocínio ligado a OpenAI rejeita temperature, então o script tira.
interface Passo {
  modelo: string;
  effort?: "none" | "low" | "medium" | "high";
}

interface Config {
  nome: string;
  descricao: string;
  transcricao: Passo; // cupom — etapa 1 (visão)
  classificacao: Passo; // cupom — etapa 2 (texto)
  contagem: Passo; // estoque — produto físico (visão)
  lista: Passo; // estoque — lista impressa/manuscrita (visão)
}

const CONFIGS: Config[] = [
  {
    nome: "antigo",
    descricao: "Produção até set/2026: gpt-4o nas visões difíceis, gpt-4o-mini no resto",
    transcricao: { modelo: "gpt-4o" },
    classificacao: { modelo: "gpt-4o-mini" },
    contagem: { modelo: "gpt-4o" },
    lista: { modelo: "gpt-4o-mini" },
  },
  {
    nome: "sol",
    descricao: "gpt-6-sol nas visões difíceis, gpt-6-luna no resto, sem raciocínio",
    transcricao: { modelo: "gpt-6-sol", effort: "none" },
    classificacao: { modelo: "gpt-6-luna", effort: "none" },
    contagem: { modelo: "gpt-6-sol", effort: "none" },
    lista: { modelo: "gpt-6-luna", effort: "none" },
  },
  {
    nome: "sol-low",
    descricao: "Igual 'sol', mas com raciocínio low nas visões difíceis",
    transcricao: { modelo: "gpt-6-sol", effort: "low" },
    classificacao: { modelo: "gpt-6-luna", effort: "none" },
    contagem: { modelo: "gpt-6-sol", effort: "low" },
    lista: { modelo: "gpt-6-luna", effort: "none" },
  },
  {
    nome: "luna",
    descricao: "gpt-6-luna em tudo, sem raciocínio (opção mais barata)",
    transcricao: { modelo: "gpt-6-luna", effort: "none" },
    classificacao: { modelo: "gpt-6-luna", effort: "none" },
    contagem: { modelo: "gpt-6-luna", effort: "none" },
    lista: { modelo: "gpt-6-luna", effort: "none" },
  },
];

// ── Args ─────────────────────────────────────────────────────────────────────

function arg(nome: string): string | undefined {
  const a = process.argv.find((x) => x === `--${nome}` || x.startsWith(`--${nome}=`));
  if (!a) return undefined;
  return a.includes("=") ? a.split("=").slice(1).join("=") : "true";
}

const N_CUPONS = Number(arg("cupons") ?? 20);
const RODAR_ESTOQUE = arg("estoque") === "true";
const NOMES_CONFIGS = (arg("configs") ?? CONFIGS.map((c) => c.nome).join(",")).split(",");
const LOJA = arg("loja");

// ── Chamada à OpenAI com medição ─────────────────────────────────────────────

type MimeTypeImagem = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

interface Medicao {
  custo: number;
  ms: number;
  tokensEntrada: number;
  tokensSaida: number;
  tokensRaciocinio: number;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 2 });

async function chamar(
  passo: Passo,
  system: string,
  conteudoUsuario: string | any[],
  opcoes: { temperatura0: boolean }
): Promise<{ texto: string; medicao: Medicao }> {
  const raciocinando = passo.effort !== undefined && passo.effort !== "none";
  const body: any = {
    model: passo.modelo,
    // max_completion_tokens (não max_tokens): nos modelos de raciocínio o
    // limite inclui os tokens de raciocínio, então fica folgado pra não
    // cortar o JSON no meio.
    max_completion_tokens: raciocinando ? 16000 : 4096,
    messages: [
      { role: "system", content: system },
      { role: "user", content: conteudoUsuario },
    ],
  };
  if (passo.effort !== undefined) body.reasoning_effort = passo.effort;
  if (opcoes.temperatura0 && !raciocinando) body.temperature = 0;

  const inicio = Date.now();
  const resp: any = await openai.chat.completions.create(body);
  const ms = Date.now() - inicio;

  const u = resp.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const preco = PRECOS[passo.modelo];
  const custo = preco
    ? ((u.prompt_tokens - cached) * preco.input + cached * preco.cached + u.completion_tokens * preco.output) / 1e6
    : NaN;

  return {
    texto: resp.choices[0]?.message?.content ?? "",
    medicao: {
      custo,
      ms,
      tokensEntrada: u.prompt_tokens ?? 0,
      tokensSaida: u.completion_tokens ?? 0,
      tokensRaciocinio: u.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

function somaMedicoes(a: Medicao, b: Medicao): Medicao {
  return {
    custo: a.custo + b.custo,
    ms: a.ms + b.ms,
    tokensEntrada: a.tokensEntrada + b.tokensEntrada,
    tokensSaida: a.tokensSaida + b.tokensSaida,
    tokensRaciocinio: a.tokensRaciocinio + b.tokensRaciocinio,
  };
}

function imagemUsuario(buffer: Buffer, mime: MimeTypeImagem, texto: string): any[] {
  return [
    { type: "image_url", image_url: { url: `data:${mime};base64,${buffer.toString("base64")}`, detail: "high" } },
    { type: "text", text: texto },
  ];
}

function limparJson(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
}

// ── Cupons: gabarito do banco ────────────────────────────────────────────────

interface GabaritoCupom {
  url: string;
  total: number;
  data: string | null;
  porCategoria: Map<string, number>;
}

function escolherTenant() {
  const tenants = getTenants();
  const t = LOJA ? tenants.find((x) => x.id === LOJA) : tenants[0];
  if (!t) throw new Error(`Loja "${LOJA}" não encontrada. Disponíveis: ${tenants.map((x) => x.id).join(", ")}`);
  return t;
}

async function carregarGabaritoCupons(n: number): Promise<GabaritoCupom[]> {
  const t = escolherTenant();
  const db = createClient(t.url, t.key, { db: { schema: t.schema } });

  const { data: categorias, error: errCat } = await db.from("categorias").select("id, nome");
  if (errCat) throw new Error(`Erro lendo categorias: ${errCat.message}`);
  const nomeCategoria = new Map<string, string>((categorias ?? []).map((c: any) => [c.id, c.nome]));

  // Busca bastante linha: cada cupom vira vários lançamentos (um por categoria).
  const { data, error } = await db
    .from("lancamentos")
    .select("url_arquivo, valor, data_emissao, categoria_id, created_at")
    .ilike("url_arquivo", "%img_%")
    .order("created_at", { ascending: false })
    .limit(n * 15);
  if (error) throw new Error(`Erro lendo lançamentos: ${error.message}`);

  const porUrl = new Map<string, GabaritoCupom>();
  for (const l of data ?? []) {
    let g = porUrl.get(l.url_arquivo);
    if (!g) {
      if (porUrl.size >= n) continue;
      g = { url: l.url_arquivo, total: 0, data: l.data_emissao ?? null, porCategoria: new Map() };
      porUrl.set(l.url_arquivo, g);
    }
    const valor = Number(l.valor);
    g.total = Math.round((g.total + valor) * 100) / 100;
    const cat = nomeCategoria.get(l.categoria_id) ?? "(sem categoria)";
    g.porCategoria.set(cat, Math.round(((g.porCategoria.get(cat) ?? 0) + valor) * 100) / 100);
  }
  return Array.from(porUrl.values());
}

// ── Cupons: roda o pipeline de 2 etapas com uma config ───────────────────────

interface ResultadoCupom {
  ok: boolean;
  erro?: string;
  total?: number;
  somaLinhasBateTotal?: boolean;
  data?: string | null;
  porCategoria?: Map<string, number>;
  medicao: Medicao;
}

const MEDICAO_ZERO: Medicao = { custo: 0, ms: 0, tokensEntrada: 0, tokensSaida: 0, tokensRaciocinio: 0 };

async function rodarCupom(cfg: Config, imagem: Buffer, mime: MimeTypeImagem): Promise<ResultadoCupom> {
  let medicao = MEDICAO_ZERO;
  try {
    const t = await chamar(
      cfg.transcricao,
      TRANSCRICAO_SYSTEM,
      imagemUsuario(imagem, mime, "Transcreva todas as linhas de produto deste documento."),
      { temperatura0: false } // produção não fixa temperature nessa etapa
    );
    medicao = t.medicao;
    const bruta: TranscricaoCupom | null = parseTranscricao(t.texto);
    if (!bruta || !bruta.linhas?.length) return { ok: false, erro: "transcrição vazia/inválida", medicao };

    const linhas: LinhaCupom[] = corrigirLinhasDesconto(bruta.linhas);
    const produtos = linhas.map((l, i) => `${i}: ${l.descricao}`).join("\n");
    const c = await chamar(
      cfg.classificacao,
      CLASSIFICACAO_SYSTEM,
      `Fornecedor: ${bruta.fornecedor ?? "não identificado"}\nTipo de documento: ${bruta.tipo_documento}\n\nProdutos a classificar (um por linha, "índice: descrição"):\n${produtos}`,
      { temperatura0: false }
    );
    medicao = somaMedicoes(medicao, c.medicao);
    const classificacoes = parseClassificacao(c.texto);
    if (!classificacoes?.length) return { ok: false, erro: "classificação vazia/inválida", medicao };

    const itens = montarItensAgrupados(linhas, classificacoes);
    const somaItens = itens.reduce((s, i) => s + i.valor, 0);
    const totalDoc = bruta.valor_total_documento;
    // Mesmo ajuste proporcional que o webhook faz antes de gravar
    // (registrarMultipla): se a soma dos itens não bate com o total do
    // documento, escala os itens pro total — é o que iria pro banco.
    const fator = totalDoc != null && somaItens > 0 && Math.abs(somaItens - totalDoc) > 0.01 ? totalDoc / somaItens : 1;
    const porCategoria = new Map<string, number>();
    for (const i of itens) {
      const v = Math.round(i.valor * fator * 100) / 100;
      const cat = i.categoria_sugerida ?? "(sem categoria)";
      porCategoria.set(cat, Math.round(((porCategoria.get(cat) ?? 0) + v) * 100) / 100);
    }

    return {
      ok: true,
      total: totalDoc ?? Math.round(somaItens * 100) / 100,
      somaLinhasBateTotal: totalDoc == null ? undefined : Math.abs(somaItens - totalDoc) <= 0.05,
      data: bruta.data_emissao,
      porCategoria,
      medicao,
    };
  } catch (err: any) {
    return { ok: false, erro: err?.message ?? String(err), medicao };
  }
}

// Fração do valor do cupom que caiu na categoria certa (1 = tudo certo).
function acertoCategoria(gab: Map<string, number>, res: Map<string, number>, total: number): number {
  if (total <= 0) return 0;
  const cats = new Set([...gab.keys(), ...res.keys()]);
  let divergente = 0;
  for (const c of cats) divergente += Math.abs((gab.get(c) ?? 0) - (res.get(c) ?? 0));
  return Math.max(0, 1 - divergente / 2 / total);
}

// ── Estoque: gabarito manual + comparação por nome ───────────────────────────

interface ItemGabarito {
  nome: string;
  quantidade: number;
}

interface EntradaGabaritoEstoque {
  tipo: "produto_fisico" | "lista";
  itens: ItemGabarito[];
}

function normalizar(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

function similaridade(a: string, b: string): number {
  const ta = new Set(normalizar(a));
  const tb = new Set(normalizar(b));
  const inter = [...ta].filter((w) => tb.has(w)).length;
  const uniao = new Set([...ta, ...tb]).size;
  return uniao === 0 ? 0 : inter / uniao;
}

// Casa cada item do gabarito com o item da IA de nome mais parecido
// (guloso, cada item da IA usado uma vez só). Nome casado é aproximado —
// o relatório mostra os pares pra você conferir.
function compararEstoque(gab: ItemGabarito[], ia: { nome: string; quantidade: number | null }[]) {
  const usados = new Set<number>();
  let encontrados = 0;
  let quantidadeExata = 0;
  const pares: string[] = [];
  for (const g of gab) {
    let melhor = -1;
    let melhorSim = 0;
    ia.forEach((i, idx) => {
      if (usados.has(idx)) return;
      const s = similaridade(g.nome, i.nome ?? "");
      if (s > melhorSim) {
        melhorSim = s;
        melhor = idx;
      }
    });
    if (melhor >= 0 && melhorSim >= 0.34) {
      usados.add(melhor);
      encontrados++;
      const q = ia[melhor].quantidade;
      if (q != null && Math.abs(q - g.quantidade) < 0.01) quantidadeExata++;
      pares.push(`${g.nome} (${g.quantidade}) ↔ ${ia[melhor].nome} (${q ?? "?"})`);
    } else {
      pares.push(`${g.nome} (${g.quantidade}) ↔ — não encontrado`);
    }
  }
  return { encontrados, quantidadeExata, aMais: ia.length - usados.size, pares };
}

const MIME_POR_EXT: Record<string, MimeTypeImagem> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

// ── Relatório ────────────────────────────────────────────────────────────────

function brl(v: number): string {
  return v.toFixed(2).replace(".", ",");
}

function usd(v: number): string {
  return Number.isNaN(v) ? "?" : `$${v.toFixed(4)}`;
}

function pct(a: number, b: number): string {
  return b === 0 ? "—" : `${Math.round((a / b) * 100)}%`;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY não definida. Rode com a chave no ambiente (ex.: $env:OPENAI_API_KEY='...' no PowerShell).");
    process.exit(1);
  }

  const configs = CONFIGS.filter((c) => NOMES_CONFIGS.includes(c.nome));
  if (configs.length === 0) throw new Error(`Nenhuma config válida em --configs. Opções: ${CONFIGS.map((c) => c.nome).join(", ")}`);

  const md: string[] = [`# Comparação de modelos — ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`, ""];
  md.push("| Config | Descrição |", "|---|---|");
  for (const c of configs) md.push(`| ${c.nome} | ${c.descricao} |`);
  md.push("");
  const bruto: any = { configs, cupons: [], estoque: [] };

  // ── Cupons ─────────────────────────────────────────────────────────────────
  if (N_CUPONS > 0) {
    const gabaritos = await carregarGabaritoCupons(N_CUPONS);
    console.log(`\n${gabaritos.length} cupons com foto encontrados no banco.`);

    const agregado = new Map(
      configs.map((c) => [c.nome, { ok: 0, totalCerto: 0, dataCerta: 0, somaCat: 0, bateInterno: 0, comTotalDoc: 0, medicao: MEDICAO_ZERO }])
    );
    const divergencias: string[] = [];

    for (const [i, gab] of gabaritos.entries()) {
      const resp = await fetch(gab.url);
      if (!resp.ok) {
        console.warn(`  [${i + 1}] não baixou a foto (${resp.status}) — pulando`);
        continue;
      }
      const imagem = Buffer.from(await resp.arrayBuffer());
      const mime = (resp.headers.get("content-type") as MimeTypeImagem) || "image/jpeg";

      // Configs em paralelo pro mesmo cupom — são modelos diferentes, não
      // competem pelo mesmo rate limit.
      const resultados = await Promise.all(configs.map((c) => rodarCupom(c, imagem, mime)));
      const linhaLog: string[] = [];
      resultados.forEach((r, idx) => {
        const c = configs[idx];
        const a = agregado.get(c.nome)!;
        a.medicao = somaMedicoes(a.medicao, r.medicao);
        bruto.cupons.push({
          url: gab.url,
          config: c.nome,
          gabarito: { total: gab.total, data: gab.data, porCategoria: Object.fromEntries(gab.porCategoria) },
          resultado: { ...r, porCategoria: r.porCategoria ? Object.fromEntries(r.porCategoria) : undefined },
        });
        if (!r.ok) {
          linhaLog.push(`${c.nome}: ERRO`);
          divergencias.push(`- **${c.nome}** — [foto](${gab.url}): falhou (${r.erro})`);
          return;
        }
        a.ok++;
        const totalCerto = Math.abs((r.total ?? 0) - gab.total) <= 0.05;
        const dataCerta = !!gab.data && r.data === gab.data;
        const cat = acertoCategoria(gab.porCategoria, r.porCategoria!, gab.total);
        if (totalCerto) a.totalCerto++;
        if (dataCerta) a.dataCerta++;
        a.somaCat += cat;
        if (r.somaLinhasBateTotal !== undefined) {
          a.comTotalDoc++;
          if (r.somaLinhasBateTotal) a.bateInterno++;
        }
        linhaLog.push(`${c.nome}: ${totalCerto ? "✓" : "✗"} R$${brl(r.total ?? 0)}`);
        if (!totalCerto || cat < 0.9) {
          divergencias.push(
            `- **${c.nome}** — [foto](${gab.url}): total R$${brl(r.total ?? 0)} (gabarito R$${brl(gab.total)}), categoria ${Math.round(cat * 100)}%`
          );
        }
      });
      console.log(`  [${i + 1}/${gabaritos.length}] gabarito R$${brl(gab.total)} → ${linhaLog.join(" | ")}`);
    }

    const n = gabaritos.length;
    md.push(`## Cupons fiscais (${n} fotos)`, "");
    md.push(
      "| Config | Total certo | Data certa | Valor na categoria certa | Linhas somam o total do cupom | Falhas | Custo total | Custo/cupom | Tempo médio | Tokens raciocínio |",
      "|---|---|---|---|---|---|---|---|---|---|"
    );
    for (const c of configs) {
      const a = agregado.get(c.nome)!;
      md.push(
        `| ${c.nome} | ${pct(a.totalCerto, n)} | ${pct(a.dataCerta, n)} | ${a.ok ? Math.round((a.somaCat / a.ok) * 100) + "%" : "—"} | ${pct(a.bateInterno, a.comTotalDoc)} | ${n - a.ok} | ${usd(a.medicao.custo)} | ${usd(a.medicao.custo / Math.max(n, 1))} | ${(a.medicao.ms / Math.max(n, 1) / 1000).toFixed(1)}s | ${a.medicao.tokensRaciocinio} |`
      );
    }
    md.push("", "**Como ler:**");
    md.push("- *Total certo* e *Data certa* comparam com o que está gravado no banco. Diferença de até R$0,05 conta como certo.");
    md.push("- *Valor na categoria certa* mostra quanto do valor do cupom caiu na mesma categoria gravada no banco.");
    md.push("- *Linhas somam o total do cupom* é uma conferência interna, sem gabarito: indica se o modelo leu todas as linhas. Quando a soma não bate, a produção faz um ajuste proporcional que esconde o erro.");
    md.push("- O gabarito vem do que o gpt-4o leu na época, a menos que alguém tenha corrigido no grupo. Por isso a comparação favorece a config `antigo`. Abra as fotos abaixo antes de concluir quem errou.", "");
    if (divergencias.length) md.push("### Divergências pra conferir", "", ...divergencias, "");
  }

  // ── Estoque ────────────────────────────────────────────────────────────────
  if (RODAR_ESTOQUE) {
    const dir = join(process.cwd(), "eval", "estoque");
    const arqGabarito = join(dir, "gabarito.json");
    if (!existsSync(arqGabarito)) {
      console.warn(`\nSem ${arqGabarito} — pulando estoque (ver instruções no topo do script).`);
    } else {
      const gabarito: Record<string, EntradaGabaritoEstoque> = JSON.parse(readFileSync(arqGabarito, "utf-8"));
      const t = escolherTenant();
      const referencia = await runWithTenant({ url: t.url, key: t.key, schema: t.schema }, async () => {
        const [padroes, produtos] = await Promise.all([listPadroesEmbalagem(), listProdutos({ ativo: true })]);
        const porId = new Map(produtos.map((p) => [p.id, p]));
        return padroes
          .map((p) => (porId.get(p.produto_id) ? `- ${porId.get(p.produto_id)!.nome}: ${p.nome_padrao}` : null))
          .filter(Boolean)
          .join("\n");
      });

      const agregado = new Map(configs.map((c) => [c.nome, { itensGab: 0, encontrados: 0, exatos: 0, aMais: 0, falhas: 0, medicao: MEDICAO_ZERO }]));
      const detalhes: string[] = [];

      for (const [arquivo, entrada] of Object.entries(gabarito)) {
        const mime = MIME_POR_EXT[extname(arquivo).toLowerCase()];
        if (!mime) {
          console.warn(`  ${arquivo}: extensão não suportada — pulando`);
          continue;
        }
        const imagem = readFileSync(join(dir, arquivo));
        const system = entrada.tipo === "lista" ? LISTA_SYSTEM : contagemFisicaSystem(referencia);
        const texto = entrada.tipo === "lista" ? "Extraia todos os itens desta lista de contagem." : "Identifique e conte os produtos visíveis nesta foto.";

        const resultados = await Promise.all(
          configs.map(async (c) => {
            const passo = entrada.tipo === "lista" ? c.lista : c.contagem;
            try {
              const r = await chamar(passo, system, imagemUsuario(imagem, mime, texto), { temperatura0: true });
              const parsed = JSON.parse(limparJson(r.texto));
              return { itens: Array.isArray(parsed.itens) ? parsed.itens : [], medicao: r.medicao, erro: undefined as string | undefined };
            } catch (err: any) {
              return { itens: [], medicao: MEDICAO_ZERO, erro: err?.message ?? String(err) };
            }
          })
        );

        detalhes.push(`### ${arquivo} (${entrada.tipo})`, "");
        const linhaLog: string[] = [];
        resultados.forEach((r, idx) => {
          const c = configs[idx];
          const a = agregado.get(c.nome)!;
          a.medicao = somaMedicoes(a.medicao, r.medicao);
          a.itensGab += entrada.itens.length;
          bruto.estoque.push({ arquivo, config: c.nome, gabarito: entrada, resultado: r });
          if (r.erro) {
            a.falhas++;
            linhaLog.push(`${c.nome}: ERRO`);
            detalhes.push(`- **${c.nome}**: falhou (${r.erro})`);
            return;
          }
          const cmp = compararEstoque(entrada.itens, r.itens);
          a.encontrados += cmp.encontrados;
          a.exatos += cmp.quantidadeExata;
          a.aMais += cmp.aMais;
          linhaLog.push(`${c.nome}: ${cmp.quantidadeExata}/${entrada.itens.length}`);
          detalhes.push(`- **${c.nome}**: ${cmp.pares.join("; ")}${cmp.aMais ? ` — +${cmp.aMais} item(ns) que não estão no gabarito` : ""}`);
        });
        detalhes.push("");
        console.log(`  ${arquivo}: quantidade exata → ${linhaLog.join(" | ")}`);
      }

      const nFotos = Object.keys(gabarito).length;
      md.push(`## Estoque (${nFotos} fotos, gabarito manual)`, "");
      md.push("| Config | Produtos encontrados | Quantidade exata | Itens a mais | Falhas | Custo total | Custo/foto | Tempo médio |", "|---|---|---|---|---|---|---|---|");
      for (const c of configs) {
        const a = agregado.get(c.nome)!;
        md.push(
          `| ${c.nome} | ${pct(a.encontrados, a.itensGab)} | ${pct(a.exatos, a.itensGab)} | ${a.aMais} | ${a.falhas} | ${usd(a.medicao.custo)} | ${usd(a.medicao.custo / Math.max(nFotos, 1))} | ${(a.medicao.ms / Math.max(nFotos, 1) / 1000).toFixed(1)}s |`
        );
      }
      md.push("", "Os nomes são casados por semelhança aproximada. Confira os pares abaixo.", "", ...detalhes);
    }
  }

  const outDir = join(process.cwd(), "scripts", "resultados");
  mkdirSync(outDir, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const arqMd = join(outDir, `comparacao-${carimbo}.md`);
  writeFileSync(arqMd, md.join("\n"));
  writeFileSync(join(outDir, `comparacao-${carimbo}.json`), JSON.stringify(bruto, null, 2));
  console.log(`\nRelatório: ${arqMd}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
