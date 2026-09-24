// Ferramentas do assistente Marcos. Dois tipos:
//
// - CONSULTA: executa na hora e devolve dados pro modelo.
// - ALTERAÇÃO: NÃO executa. Valida os argumentos (lançamento existe,
//   categoria existe...), monta uma descrição em código do que vai ser feito
//   e guarda como ação pendente. Só roda quando alguém do grupo responde
//   "sim" (ver marcos.ts) — a descrição que o usuário confirma é essa gerada
//   aqui, nunca um resumo escrito pela IA.
//
import type Anthropic from "@anthropic-ai/sdk";
import {
  ajustarValorLancamento,
  atualizarCategoria,
  atualizarDataEmissao,
  atualizarDescricao,
  createLancamento,
  excluirLancamento,
  getCategoriaMap,
  getClient,
} from "../../db/supabase.js";
import { calcularDRE, formatarDREWhatsApp } from "../dre.js";
import {
  AcaoPendente,
  criarAcerto,
  definirPertenceA,
  excluirAcertosDoLancamento,
  listarAcertos,
} from "./db.js";

export interface ContextoMarcos {
  lojaAtual: string; // loja dona do grupo/banco (ex: "mano")
  outrasLojas: string[]; // demais lojas cadastradas (ex: ["basilico"])
  remetente: string; // nome de quem mandou a mensagem
}

type Tool = Anthropic.Beta.BetaTool;

const str = { type: ["string", "null"] } as const;
const num = { type: ["number", "null"] } as const;
const data = { type: ["string", "null"], description: "Data no formato YYYY-MM-DD, ou null" } as const;

// Sem strict: misturar ferramentas strict e não-strict na mesma chamada dá
// 400 "Schema is too complex" (testado em set/2026), e strict em todas
// estoura o limite de campos anuláveis. Os argumentos das ALTERAÇÕES são
// validados em código em prepararAlteracao (código existe, valor > 0, data
// válida, categoria/loja existem) antes de virar ação pendente.
// `obrigatorios` omitido = todos os campos obrigatórios (opcional vira null).
function ferramenta(name: string, description: string, properties: Record<string, unknown>, obrigatorios?: string[]): Tool {
  return {
    name,
    description,
    input_schema: {
      type: "object",
      properties,
      required: obrigatorios ?? Object.keys(properties),
      additionalProperties: false,
    },
  } as Tool;
}

// Lista FIXA (mesma ordem, mesmo texto em toda chamada) — mudar as
// ferramentas no meio de uma conversa invalida o cache e o raciocínio já feito.
export const FERRAMENTAS: Tool[] = [
  // ── Consultas ──────────────────────────────────────────────────────────────
  ferramenta(
    "buscar_lancamentos",
    "Busca lançamentos (notas, contas, receitas) com filtros. Todo filtro é opcional (omita = sem filtro). Devolve cada lançamento com seu código de 6 caracteres (usado pra alterar), além do total e da soma dos valores encontrados.",
    {
      data_inicio: { type: "string", description: "Data de emissão mínima (YYYY-MM-DD)" },
      data_fim: { type: "string", description: "Data de emissão máxima (YYYY-MM-DD)" },
      texto: { type: "string", description: "Trecho do fornecedor ou da descrição (ex: 'atacadao', 'queijo')" },
      categoria: { type: "string", description: "Nome (ou trecho) da categoria" },
      tipo: { type: "string", enum: ["receita", "despesa"] },
      status: { type: "string", enum: ["pendente", "pago"] },
      valor_min: { type: "number" },
      valor_max: { type: "number" },
      loja_dona: {
        type: "string",
        description: "'propria' = só o que é desta loja; nome de outra loja = só o que foi comprado pra ela; omita pra tudo",
      },
      ordenar: { type: "string", enum: ["recentes", "data_emissao"], description: "'recentes' = últimos enviados ao grupo primeiro" },
      limite: { type: "integer", description: "Máximo de lançamentos a listar (padrão 30, máximo 100). A soma/total considera todos." },
    },
    ["ordenar"]
  ),
  ferramenta(
    "resumo_gastos",
    "Soma lançamentos de um período agrupados por categoria, fornecedor, grupo do DRE ou mês. Use pra perguntas de 'quanto gastei com X', comparações entre meses e visão geral.",
    {
      data_inicio: { type: "string", description: "YYYY-MM-DD" },
      data_fim: { type: "string", description: "YYYY-MM-DD" },
      agrupar_por: { type: "string", enum: ["categoria", "fornecedor", "grupo_dre", "mes"] },
      tipo: { type: "string", enum: ["receita", "despesa"] },
      incluir_de_outras_lojas: {
        type: "boolean",
        description: "true = inclui o que foi comprado pra outra loja (pertence_a preenchido). O DRE não inclui.",
      },
    },
    ["data_inicio", "data_fim", "agrupar_por", "incluir_de_outras_lojas"]
  ),
  ferramenta("dre_mes", "DRE completo de um mês (mesmo relatório do comando 'dre'), já formatado.", {
    mes: { type: "string", description: "YYYY-MM" },
  }, ["mes"]),
  ferramenta("contas_a_pagar", "Despesas pendentes (não pagas) ordenadas por vencimento, marcando as vencidas.", {
    vencimento_ate: { type: "string", description: "Só as que vencem até essa data (YYYY-MM-DD); omita pra todas" },
  }, []),
  ferramenta("historico_preco", "Histórico de preço por unidade de um insumo nas últimas compras (ex: queijo, tomate).", {
    produto: { type: "string" },
  }, ["produto"]),
  ferramenta("listar_categorias", "Lista as categorias cadastradas (nome, grupo do DRE e tipo).", {}, []),
  ferramenta(
    "saldo_entre_lojas",
    "Conta corrente entre esta loja e outra: todas as dívidas (compras feitas por uma loja pra outra, valores lançados à mão) e pagamentos, com o saldo final de quem deve quanto pra quem.",
    { outra_loja: { type: "string" } },
    ["outra_loja"]
  ),

  // ── Alterações (ficam pendentes até alguém responder "sim") ────────────────
  ferramenta(
    "alterar_lancamento",
    "Prepara a alteração de um lançamento existente (fica pendente de confirmação). Campos null não mudam.",
    {
      codigo: { type: "string", description: "Código de 6 caracteres do lançamento" },
      nova_categoria: { ...str, description: "Nome exato de uma categoria existente (ver listar_categorias) ou null" },
      novo_valor: num,
      nova_data_emissao: data,
      nova_data_vencimento: data,
      nova_descricao: str,
    }
  ),
  ferramenta("marcar_como_pago", "Prepara marcar um lançamento pendente como pago (fica pendente de confirmação).", {
    codigo: { type: "string" },
    data_pagamento: { ...data, description: "YYYY-MM-DD ou null pra hoje" },
  }),
  ferramenta("excluir_lancamento", "Prepara a exclusão de um lançamento (fica pendente de confirmação).", {
    codigo: { type: "string" },
  }),
  ferramenta("criar_lancamento", "Prepara um lançamento novo (fica pendente de confirmação).", {
    tipo: { type: "string", enum: ["receita", "despesa"] },
    descricao: { type: "string" },
    fornecedor: str,
    valor: { type: "number" },
    categoria: { type: "string", description: "Nome exato de uma categoria existente" },
    data_emissao: { type: "string", description: "YYYY-MM-DD" },
    data_vencimento: data,
    ja_pago: { type: "boolean" },
  }),
  ferramenta(
    "definir_loja_dona",
    "Prepara marcar lançamentos desta loja como comprados PRA OUTRA loja (fica pendente de confirmação). Ao confirmar: saem do DRE desta loja e cada um vira dívida da outra loja com esta, no valor do lançamento. loja = null desfaz (volta a ser desta loja e apaga a dívida).",
    {
      codigos: { type: "array", items: { type: "string" }, description: "Códigos de 6 caracteres" },
      loja: { ...str, description: "Loja que deve (ex: 'basilico') ou null pra desfazer" },
    }
  ),
  ferramenta(
    "registrar_acerto",
    "Prepara um lançamento manual na conta corrente entre lojas (fica pendente de confirmação): 'divida' = loja_devedora passou a dever valor à loja_credora (ex: compra sem nota no sistema); 'pagamento' = loja_devedora pagou valor à loja_credora.",
    {
      tipo: { type: "string", enum: ["divida", "pagamento"] },
      loja_devedora: { type: "string" },
      loja_credora: { type: "string" },
      valor: { type: "number" },
      descricao: { type: "string" },
      data: { ...data, description: "YYYY-MM-DD ou null pra hoje" },
    }
  ),
];

export const FERRAMENTAS_DE_ALTERACAO = new Set([
  "alterar_lancamento",
  "marcar_como_pago",
  "excluir_lancamento",
  "criar_lancamento",
  "definir_loja_dona",
  "registrar_acerto",
]);

// ── Utilitários ──────────────────────────────────────────────────────────────

export function codigoCurto(id: string): string {
  return id.replace(/-/g, "").substring(0, 6).toUpperCase();
}

function brl(v: number): string {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dataBR(iso: string | null | undefined): string {
  if (!iso) return "sem data";
  const [a, m, d] = iso.substring(0, 10).split("-");
  return `${d}/${m}/${a}`;
}

export function hojeISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function validarData(d: string | null | undefined, campo: string): string | null {
  if (d == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new Error(`${campo} inválida: "${d}" (use YYYY-MM-DD)`);
  return d;
}

// Tira caracteres que quebram a sintaxe de filtro do PostgREST (.or / ilike).
function limparTexto(t: string): string {
  return t.replace(/[,()*%\\]/g, " ").trim();
}

function normalizarLoja(ctx: ContextoMarcos, nome: string): string {
  const n = nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
  const todas = [ctx.lojaAtual, ...ctx.outrasLojas];
  const achada = todas.find((l) => n === l || n.includes(l) || l.includes(n));
  if (!achada) throw new Error(`Loja "${nome}" não cadastrada. Lojas: ${todas.join(", ")}`);
  return achada;
}

// Lançamento pelo código de 6 caracteres (início do UUID) — busca por faixa
// de UUID no banco, sem limite de "últimos N".
async function lancamentoPorCodigo(codigo: string): Promise<any> {
  const c = codigo.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(c)) throw new Error(`Código "${codigo}" inválido — são 6 caracteres (0-9, A-F)`);
  const { data, error } = await getClient()
    .from("lancamentos")
    .select("*")
    .gte("id", `${c}00-0000-0000-0000-000000000000`)
    .lte("id", `${c}ff-ffff-ffff-ffff-ffffffffffff`)
    .limit(2);
  if (error) throw new Error(`Erro ao buscar lançamento ${codigo}: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`Lançamento ${codigo.toUpperCase()} não encontrado`);
  if (data.length > 1) throw new Error(`Código ${codigo.toUpperCase()} é ambíguo (mais de um lançamento)`);
  return data[0];
}

function curto(t: string | null | undefined, max: number): string {
  const s = String(t ?? "").trim();
  return s.length > max ? s.substring(0, max - 1).trimEnd() + "…" : s;
}

function dataCurta(iso: string | null | undefined): string {
  return iso ? dataBR(iso).substring(0, 5) : "s/data";
}

// Ex: "*3C1347* Dj Produtos de Alim… R$ 208,60 (17/09)"
function resumoLancamento(l: any): string {
  return `*${codigoCurto(l.id)}* ${curto(l.fornecedor || l.descricao || "lançamento", 28)} R$ ${brl(Number(l.valor))} (${dataCurta(l.data_emissao)})`;
}

// Categoria pelo nome: exato (sem diferenciar maiúscula) primeiro; se não
// achar, NÃO cria nem chuta — devolve erro com sugestões.
async function categoriaPorNome(nome: string): Promise<{ id: string; nome: string }> {
  const { data, error } = await getClient().from("categorias").select("id, nome");
  if (error) throw new Error(`Erro ao ler categorias: ${error.message}`);
  const alvo = nome.trim().toLowerCase();
  const exata = (data ?? []).find((c: any) => c.nome.trim().toLowerCase() === alvo);
  if (exata) return exata;
  const parecidas = (data ?? []).filter((c: any) => c.nome.toLowerCase().includes(alvo) || alvo.includes(c.nome.toLowerCase()));
  throw new Error(
    `Categoria "${nome}" não existe.` +
      (parecidas.length ? ` Parecidas: ${parecidas.map((c: any) => c.nome).join(", ")}.` : " Use listar_categorias.")
  );
}

// ── Consultas ────────────────────────────────────────────────────────────────

async function buscarLancamentos(e: any, ctx: ContextoMarcos) {
  const limite = Math.min(Math.max(e.limite ?? 30, 1), 100);
  let q = getClient()
    .from("lancamentos")
    .select("id, tipo, descricao, fornecedor, valor, data_emissao, data_vencimento, status, categoria_id, pertence_a, url_arquivo, created_at");
  if (e.data_inicio) q = q.gte("data_emissao", validarData(e.data_inicio, "data_inicio"));
  if (e.data_fim) q = q.lte("data_emissao", validarData(e.data_fim, "data_fim"));
  if (e.tipo) q = q.eq("tipo", e.tipo);
  if (e.status) q = q.eq("status", e.status);
  if (e.valor_min != null) q = q.gte("valor", e.valor_min);
  if (e.valor_max != null) q = q.lte("valor", e.valor_max);
  if (e.texto) {
    const t = limparTexto(e.texto);
    if (t) q = q.or(`descricao.ilike.*${t}*,fornecedor.ilike.*${t}*`);
  }
  if (e.loja_dona === "propria") q = q.is("pertence_a", null);
  else if (e.loja_dona) q = q.eq("pertence_a", normalizarLoja(ctx, e.loja_dona));

  const cats = await getCategoriaMap();
  if (e.categoria) {
    const alvo = e.categoria.toLowerCase();
    const ids = [...cats.entries()].filter(([, c]) => c.nome.toLowerCase().includes(alvo)).map(([id]) => id);
    if (ids.length === 0) return { erro: `Nenhuma categoria parecida com "${e.categoria}". Use listar_categorias.` };
    q = q.in("categoria_id", ids);
  }
  q = e.ordenar === "recentes" ? q.order("created_at", { ascending: false }) : q.order("data_emissao", { ascending: false });

  const { data, error } = await q.limit(2000);
  if (error) throw new Error(`Erro ao buscar lançamentos: ${error.message}`);
  const linhas = data ?? [];
  const soma = linhas.reduce((s: number, l: any) => s + Number(l.valor), 0);

  return {
    encontrados: linhas.length,
    soma_valores: Math.round(soma * 100) / 100,
    listados: Math.min(limite, linhas.length),
    lancamentos: linhas.slice(0, limite).map((l: any) => ({
      codigo: codigoCurto(l.id),
      tipo: l.tipo,
      data_emissao: l.data_emissao,
      vencimento: l.data_vencimento,
      fornecedor: l.fornecedor,
      descricao: String(l.descricao ?? "").substring(0, 150),
      valor: Number(l.valor),
      categoria: cats.get(l.categoria_id)?.nome ?? null,
      status: l.status,
      comprado_para: l.pertence_a,
      tem_foto: !!l.url_arquivo,
      enviado_em: l.created_at,
    })),
  };
}

async function resumoGastos(e: any) {
  const inicio = validarData(e.data_inicio, "data_inicio")!;
  const fim = validarData(e.data_fim, "data_fim")!;
  let q = getClient()
    .from("lancamentos")
    .select("tipo, fornecedor, valor, data_emissao, categoria_id, pertence_a")
    .gte("data_emissao", inicio)
    .lte("data_emissao", fim);
  if (e.tipo) q = q.eq("tipo", e.tipo);
  if (!e.incluir_de_outras_lojas) q = q.is("pertence_a", null);
  const { data, error } = await q.limit(10000);
  if (error) throw new Error(`Erro ao resumir: ${error.message}`);

  const cats = await getCategoriaMap();
  const grupos = new Map<string, { total: number; qtd: number }>();
  let total = 0;
  for (const l of data ?? []) {
    const cat = cats.get(l.categoria_id);
    const chave =
      e.agrupar_por === "categoria"
        ? cat?.nome ?? "(sem categoria)"
        : e.agrupar_por === "fornecedor"
          ? l.fornecedor || "(sem fornecedor)"
          : e.agrupar_por === "grupo_dre"
            ? cat?.grupo_dre ?? "(sem grupo)"
            : String(l.data_emissao ?? "").substring(0, 7) || "(sem data)";
    const g = grupos.get(chave) ?? { total: 0, qtd: 0 };
    g.total += Number(l.valor);
    g.qtd++;
    grupos.set(chave, g);
    total += Number(l.valor);
  }
  const ordenados = [...grupos.entries()]
    .map(([grupo, g]) => ({ grupo, total: Math.round(g.total * 100) / 100, lancamentos: g.qtd }))
    .sort((a, b) => (e.agrupar_por === "mes" ? a.grupo.localeCompare(b.grupo) : b.total - a.total));
  return {
    periodo: `${inicio} a ${fim}`,
    total: Math.round(total * 100) / 100,
    grupos: ordenados.slice(0, 60),
    grupos_omitidos: Math.max(0, ordenados.length - 60),
  };
}

async function dreMes(e: any) {
  if (!/^\d{4}-\d{2}$/.test(e.mes)) throw new Error(`Mês inválido: "${e.mes}" (use YYYY-MM)`);
  const [a, m] = e.mes.split("-").map(Number);
  const ultimoDia = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const dre = await calcularDRE(`${e.mes}-01`, `${e.mes}-${String(ultimoDia).padStart(2, "0")}`);
  return formatarDREWhatsApp(dre);
}

async function contasAPagar(e: any) {
  let q = getClient()
    .from("lancamentos")
    .select("id, fornecedor, descricao, valor, valor_pago, data_vencimento, data_emissao")
    .eq("status", "pendente")
    .eq("tipo", "despesa")
    .order("data_vencimento", { ascending: true, nullsFirst: false });
  if (e.vencimento_ate) q = q.lte("data_vencimento", validarData(e.vencimento_ate, "vencimento_ate"));
  const { data, error } = await q.limit(100);
  if (error) throw new Error(`Erro ao buscar contas a pagar: ${error.message}`);
  const hoje = hojeISO();
  const linhas = (data ?? []).map((l: any) => ({
    codigo: codigoCurto(l.id),
    fornecedor: l.fornecedor,
    descricao: String(l.descricao ?? "").substring(0, 100),
    valor: Number(l.valor),
    ja_pago_parcial: Number(l.valor_pago ?? 0),
    vencimento: l.data_vencimento,
    vencida: !!l.data_vencimento && l.data_vencimento < hoje,
  }));
  return {
    hoje,
    quantidade: linhas.length,
    total_em_aberto: Math.round(linhas.reduce((s: number, l: any) => s + l.valor - l.ja_pago_parcial, 0) * 100) / 100,
    contas: linhas,
  };
}

async function historicoPreco(e: any) {
  const t = limparTexto(e.produto);
  const { data, error } = await getClient()
    .from("historico_compras")
    .select("produto_nome, quantidade, unidade, preco_total, preco_unitario, fornecedor, data_compra, variacao_pct")
    .ilike("produto_nome", `%${t}%`)
    .order("data_compra", { ascending: false })
    .limit(20);
  if (error) throw new Error(`Erro ao buscar histórico: ${error.message}`);
  return { compras: data ?? [] };
}

async function listarCategorias() {
  const { data, error } = await getClient().from("categorias").select("nome, grupo_dre, tipo").order("nome");
  if (error) throw new Error(`Erro ao listar categorias: ${error.message}`);
  return { categorias: data ?? [] };
}

function nomeLoja(l: string): string {
  return ({ mano: "Mano", basilico: "Basílico" } as Record<string, string>)[l] ?? l;
}

// Extrato da conta corrente entre esta loja e `outra`, montado em código (o
// modelo só repassa). Cada linha mostra o efeito no saldo "quanto a outra
// loja deve a esta": + aumenta a dívida, − abate. Exportado pra ser mostrado
// também logo depois de um "sim" (ver marcos.ts).
export async function extratoEntreLojas(ctx: ContextoMarcos, outraLoja: string): Promise<{ extrato: string; saldo: number; movimentos: number }> {
  const outra = normalizarLoja(ctx, outraLoja);
  if (outra === ctx.lojaAtual) throw new Error("Informe a OUTRA loja, não esta.");
  const acertos = await listarAcertos(ctx.lojaAtual, outra);
  const [nOutra, nAqui] = [nomeLoja(outra), nomeLoja(ctx.lojaAtual)];
  const titulo = `*Conta ${nOutra} × ${nAqui}*`;

  if (acertos.length === 0) {
    return {
      extrato: [
        titulo,
        "Ainda não tem nada registrado entre as lojas.",
        "",
        "Pra lançar, é só dizer, por exemplo:",
        `• respondendo a foto da nota: _marcos, essa é da ${nOutra}_`,
        `• _marcos, o Fiuza pagou R$ 230 de gás pra ${nOutra}_`,
        "• _marcos, paguei R$ 100 pro Fiuza_",
      ].join("\n"),
      saldo: 0,
      movimentos: 0,
    };
  }

  let saldo = 0;
  const linhas: string[] = [];
  for (const a of acertos) {
    const efeito = (a.tipo === "divida" ? 1 : -1) * (a.loja_devedora === outra ? 1 : -1) * a.valor;
    saldo = Math.round((saldo + efeito) * 100) / 100;
    const codigo = a.lancamento_id ? ` (${codigoCurto(a.lancamento_id)})` : "";
    const rotulo = a.tipo === "pagamento" ? `Pagamento ${nomeLoja(a.loja_devedora)} → ${nomeLoja(a.loja_credora)}` : curto(a.descricao, 32);
    linhas.push(`• ${dataCurta(a.data)} — ${rotulo}${codigo}: ${efeito >= 0 ? "+" : "−"}R$ ${brl(Math.abs(efeito))}`);
  }
  const fim =
    saldo > 0
      ? `*Saldo: ${nOutra} deve R$ ${brl(saldo)} ao ${nAqui}*`
      : saldo < 0
        ? `*Saldo: ${nAqui} deve R$ ${brl(-saldo)} à ${nOutra}*`
        : "*Saldo: zerado, ninguém deve nada*";
  return {
    extrato: [titulo, `_(+ = ${nOutra} passou a dever · − = pagamento)_`, "", ...linhas, "", fim].join("\n"),
    saldo,
    movimentos: acertos.length,
  };
}

async function saldoEntreLojas(e: any, ctx: ContextoMarcos) {
  const r = await extratoEntreLojas(ctx, e.outra_loja);
  return { extrato: r.extrato, saldo_que_a_outra_loja_deve: r.saldo, movimentos: r.movimentos };
}

// Notas (lançamentos) geradas por uma mensagem do grupo — pra quando alguém
// RESPONDE a foto de uma nota. Cada lançamento guarda o ID da mensagem que o
// gerou (message_id; cupom com vários itens vira "<id>-0", "<id>-1"...).
export async function notasDaMensagem(messageId: string): Promise<string[]> {
  const id = messageId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return [];
  const { data, error } = await getClient()
    .from("lancamentos")
    .select("id, fornecedor, descricao, valor, data_emissao, pertence_a")
    .or(`message_id.eq.${id},message_id.like.${id}-*`);
  if (error) throw new Error(`Erro ao buscar notas da mensagem citada: ${error.message}`);
  return (data ?? []).map((l: any) => `${resumoLancamento(l)}${l.pertence_a ? ` [já é compra da ${nomeLoja(l.pertence_a)}]` : ""}`);
}

// ── Preparação de alterações (valida + descreve, não executa) ────────────────

async function prepararAlteracao(nome: string, e: any, ctx: ContextoMarcos): Promise<AcaoPendente> {
  switch (nome) {
    case "alterar_lancamento": {
      const l = await lancamentoPorCodigo(e.codigo);
      const mudancas: string[] = [];
      if (e.nova_categoria) mudancas.push(`categoria → ${(await categoriaPorNome(e.nova_categoria)).nome}`);
      if (e.novo_valor != null) {
        if (!(e.novo_valor > 0)) throw new Error("Valor precisa ser maior que zero");
        mudancas.push(`valor R$ ${brl(Number(l.valor))} → R$ ${brl(e.novo_valor)}`);
      }
      if (e.nova_data_emissao) mudancas.push(`emissão → ${dataBR(validarData(e.nova_data_emissao, "nova_data_emissao"))}`);
      if (e.nova_data_vencimento) mudancas.push(`vencimento → ${dataBR(validarData(e.nova_data_vencimento, "nova_data_vencimento"))}`);
      if (e.nova_descricao) mudancas.push(`descrição → "${e.nova_descricao}"`);
      if (mudancas.length === 0) throw new Error("Nenhuma alteração informada");
      return { ferramenta: nome, entrada: e, descricao: `Corrigir ${resumoLancamento(l)}: ${mudancas.join("; ")}` };
    }
    case "marcar_como_pago": {
      const l = await lancamentoPorCodigo(e.codigo);
      if (l.status === "pago") throw new Error(`${codigoCurto(l.id)} já está pago`);
      const d = validarData(e.data_pagamento, "data_pagamento") ?? hojeISO();
      return { ferramenta: nome, entrada: e, descricao: `Marcar ${resumoLancamento(l)} como *pago* em ${dataCurta(d)}` };
    }
    case "excluir_lancamento": {
      const l = await lancamentoPorCodigo(e.codigo);
      return { ferramenta: nome, entrada: e, descricao: `🗑️ Excluir ${resumoLancamento(l)}` };
    }
    case "criar_lancamento": {
      if (!(e.valor > 0)) throw new Error("Valor precisa ser maior que zero");
      const cat = await categoriaPorNome(e.categoria);
      validarData(e.data_emissao, "data_emissao");
      validarData(e.data_vencimento, "data_vencimento");
      return {
        ferramenta: nome,
        entrada: e,
        descricao: `Criar ${e.tipo} "${e.descricao}"${e.fornecedor ? ` (${e.fornecedor})` : ""} — R$ ${brl(e.valor)}, ${cat.nome}, emissão ${dataBR(e.data_emissao)}${e.data_vencimento ? `, vence ${dataBR(e.data_vencimento)}` : ""}, ${e.ja_pago ? "já pago" : "pendente"}`,
      };
    }
    case "definir_loja_dona": {
      if (!Array.isArray(e.codigos) || e.codigos.length === 0) throw new Error("Informe ao menos um código");
      const loja = e.loja ? normalizarLoja(ctx, e.loja) : null;
      if (loja === ctx.lojaAtual) throw new Error(`Os lançamentos já são de ${ctx.lojaAtual} — informe a outra loja`);
      const lancs = [];
      for (const c of e.codigos) lancs.push(await lancamentoPorCodigo(c));
      const soma = lancs.reduce((s, l) => s + Number(l.valor), 0);
      const lista = lancs.map(resumoLancamento).join("\n   ");
      return {
        ferramenta: nome,
        entrada: { ...e, loja },
        descricao: loja
          ? `Marcar como compra da *${nomeLoja(loja)}*:\n   ${lista}\n   → sai do DRE do ${nomeLoja(ctx.lojaAtual)} e a ${nomeLoja(loja)} passa a dever R$ ${brl(soma)} ao ${nomeLoja(ctx.lojaAtual)}`
          : `Voltar pra conta do ${nomeLoja(ctx.lojaAtual)} (desfaz a compra pra outra loja e apaga a dívida):\n   ${lista}`,
      };
    }
    case "registrar_acerto": {
      if (!(e.valor > 0)) throw new Error("Valor precisa ser maior que zero");
      const devedora = normalizarLoja(ctx, e.loja_devedora);
      const credora = normalizarLoja(ctx, e.loja_credora);
      if (devedora === credora) throw new Error("Loja devedora e credora são a mesma");
      const d = validarData(e.data, "data") ?? hojeISO();
      return {
        ferramenta: nome,
        entrada: { ...e, loja_devedora: devedora, loja_credora: credora },
        descricao:
          e.tipo === "divida"
            ? `Registrar que a *${nomeLoja(devedora)}* deve R$ ${brl(e.valor)} ao *${nomeLoja(credora)}* — ${curto(e.descricao, 40)} (${dataCurta(d)})`
            : `Registrar pagamento de R$ ${brl(e.valor)} da *${nomeLoja(devedora)}* pro *${nomeLoja(credora)}* — ${curto(e.descricao, 40)} (${dataCurta(d)}) → abate da dívida`,
      };
    }
  }
  throw new Error(`Ferramenta de alteração desconhecida: ${nome}`);
}

// ── Execução (só depois do "sim") ────────────────────────────────────────────

export async function executarAcao(acao: AcaoPendente, ctx: ContextoMarcos): Promise<string> {
  const e: any = acao.entrada;
  switch (acao.ferramenta) {
    case "alterar_lancamento": {
      const l = await lancamentoPorCodigo(e.codigo);
      if (e.nova_categoria) await atualizarCategoria(l.id, (await categoriaPorNome(e.nova_categoria)).id);
      if (e.novo_valor != null) {
        await ajustarValorLancamento(l.id, e.novo_valor);
        // Se o lançamento é compra pra outra loja, a dívida acompanha o valor novo.
        if (l.pertence_a) {
          await excluirAcertosDoLancamento(l.id);
          await criarAcertoDoLancamento({ ...l, valor: e.novo_valor }, l.pertence_a, ctx);
        }
      }
      if (e.nova_data_emissao) await atualizarDataEmissao(l.id, e.nova_data_emissao);
      if (e.nova_data_vencimento) {
        const { error } = await getClient().from("lancamentos").update({ data_vencimento: e.nova_data_vencimento }).eq("id", l.id);
        if (error) throw new Error(`Erro ao atualizar vencimento: ${error.message}`);
      }
      if (e.nova_descricao) await atualizarDescricao(l.id, e.nova_descricao);
      return `• ${codigoCurto(l.id)} corrigido`;
    }
    case "marcar_como_pago": {
      const l = await lancamentoPorCodigo(e.codigo);
      const { error } = await getClient()
        .from("lancamentos")
        .update({ status: "pago", data_pagamento: e.data_pagamento ?? hojeISO() })
        .eq("id", l.id);
      if (error) throw new Error(`Erro ao marcar pago: ${error.message}`);
      return `• ${codigoCurto(l.id)} marcado como pago`;
    }
    case "excluir_lancamento": {
      const l = await lancamentoPorCodigo(e.codigo);
      await excluirAcertosDoLancamento(l.id);
      await excluirLancamento(l.id);
      return `• ${codigoCurto(l.id)} excluído`;
    }
    case "criar_lancamento": {
      const cat = await categoriaPorNome(e.categoria);
      const l = await createLancamento(
        {
          tipo_documento: "outro",
          fornecedor: e.fornecedor ?? undefined,
          descricao: e.descricao,
          valor_total: e.valor,
          data_emissao: e.data_emissao,
          data_vencimento: e.data_vencimento ?? undefined,
          categoria_sugerida: cat.nome,
          tipo_lancamento: e.tipo,
          confianca: "alta",
        },
        `marcos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        undefined,
        cat.id,
        e.ja_pago ? "pago" : "pendente",
        e.ja_pago ? e.data_emissao : undefined
      );
      return `• Lançamento criado: *${codigoCurto(l.id)}*`;
    }
    case "definir_loja_dona": {
      const feitos: string[] = [];
      for (const c of e.codigos) {
        const l = await lancamentoPorCodigo(c);
        await excluirAcertosDoLancamento(l.id);
        await definirPertenceA(l.id, e.loja);
        if (e.loja) await criarAcertoDoLancamento(l, e.loja, ctx);
        feitos.push(codigoCurto(l.id));
      }
      return e.loja
        ? `• ${feitos.join(", ")} agora é compra da ${nomeLoja(e.loja)} (fora do DRE do ${nomeLoja(ctx.lojaAtual)})`
        : `• ${feitos.join(", ")} voltou pra conta do ${nomeLoja(ctx.lojaAtual)}`;
    }
    case "registrar_acerto": {
      await criarAcerto({
        tipo: e.tipo,
        loja_devedora: e.loja_devedora,
        loja_credora: e.loja_credora,
        valor: e.valor,
        descricao: e.descricao,
        data: e.data ?? hojeISO(),
        lancamento_id: null,
        criado_por: ctx.remetente,
      });
      return e.tipo === "divida"
        ? `• Dívida de R$ ${brl(e.valor)} registrada (${nomeLoja(e.loja_devedora)} deve ao ${nomeLoja(e.loja_credora)})`
        : `• Pagamento de R$ ${brl(e.valor)} registrado (${nomeLoja(e.loja_devedora)} → ${nomeLoja(e.loja_credora)})`;
    }
  }
  throw new Error(`Ação desconhecida: ${acao.ferramenta}`);
}

async function criarAcertoDoLancamento(l: any, lojaDevedora: string, ctx: ContextoMarcos) {
  await criarAcerto({
    tipo: "divida",
    loja_devedora: lojaDevedora,
    loja_credora: ctx.lojaAtual,
    valor: Number(l.valor),
    descricao: `${l.fornecedor || "Compra"} — ${String(l.descricao ?? "").substring(0, 80)}`,
    data: l.data_emissao ?? hojeISO(),
    lancamento_id: l.id,
    criado_por: ctx.remetente,
  });
}

// ── Despacho ─────────────────────────────────────────────────────────────────

// Executa uma chamada de ferramenta do modelo. Consulta → dados. Alteração →
// vira ação pendente (adicionada em `pendentes`) e o modelo recebe só o aviso.
export async function executarFerramenta(
  nome: string,
  entrada: any,
  ctx: ContextoMarcos,
  pendentes: AcaoPendente[]
): Promise<unknown> {
  if (FERRAMENTAS_DE_ALTERACAO.has(nome)) {
    const acao = await prepararAlteracao(nome, entrada, ctx);
    pendentes.push(acao);
    return {
      status: "aguardando_confirmacao",
      numero: pendentes.length,
      descricao: acao.descricao,
      aviso:
        "NADA foi alterado ainda. O sistema vai listar essa ação pro grupo e só executa quando alguém responder 'sim'. Não diga que foi feito.",
    };
  }
  switch (nome) {
    case "buscar_lancamentos":
      return buscarLancamentos(entrada, ctx);
    case "resumo_gastos":
      return resumoGastos(entrada);
    case "dre_mes":
      return dreMes(entrada);
    case "contas_a_pagar":
      return contasAPagar(entrada);
    case "historico_preco":
      return historicoPreco(entrada);
    case "listar_categorias":
      return listarCategorias();
    case "saldo_entre_lojas":
      return saldoEntreLojas(entrada, ctx);
  }
  throw new Error(`Ferramenta desconhecida: ${nome}`);
}

