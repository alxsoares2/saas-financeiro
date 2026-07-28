import { DRE, GrupoDRE, LinhasDRE } from "../types.js";
import { getLancamentos } from "../db/supabase.js";

// Grupos que compõem os Custos Variáveis
const GRUPOS_CUSTOS_VARIAVEIS: GrupoDRE[] = [
  "cmv",
  "materiais_venda_direta",
  "materiais_apoio",
  "cmo_eventual",
  "tarifas_cartao",
  "impostos_variaveis",
];

// Grupos que compõem as Despesas Fixas
const GRUPOS_DESPESAS_FIXAS: GrupoDRE[] = [
  "ocupacao",
  "utilidades",
  "despesas_admin",
  "marketing",
  "pessoal_fixo",
];

type GrupoMap = Record<GrupoDRE, LinhasDRE[]>;

export async function calcularDRE(inicio: string, fim: string): Promise<DRE> {
  const lancamentos = await getLancamentos(inicio, fim);

  const grupos: GrupoMap = {
    receita_bruta: [],
    deducoes_receita: [],
    cmv: [],
    materiais_venda_direta: [],
    materiais_apoio: [],
    cmo_eventual: [],
    tarifas_cartao: [],
    impostos_variaveis: [],
    ocupacao: [],
    utilidades: [],
    despesas_admin: [],
    marketing: [],
    pessoal_fixo: [],
  };

  for (const l of lancamentos) {
    const grupo = (l as any).grupo_dre as GrupoDRE | undefined;
    if (!grupo || !(grupo in grupos)) continue;

    const nome = (l as any).categoria_nome ?? l.descricao;
    const existing = grupos[grupo].find((g) => g.categoria === nome);
    if (existing) {
      existing.valor += Number(l.valor);
    } else {
      grupos[grupo].push({ categoria: nome, valor: Number(l.valor) });
    }
  }

  const soma = (linhas: LinhasDRE[]) =>
    linhas.reduce((acc, l) => acc + l.valor, 0);

  const pct = (valor: number, base: number) =>
    base !== 0 ? Math.round((valor / base) * 10000) / 100 : 0;

  // ── Receita ──────────────────────────────────────────────────────────────
  const total_receita_bruta = soma(grupos.receita_bruta);
  const total_deducoes = soma(grupos.deducoes_receita);
  const receita_liquida = total_receita_bruta - total_deducoes;

  // ── Custos Variáveis ─────────────────────────────────────────────────────
  const total_custos_variaveis = GRUPOS_CUSTOS_VARIAVEIS.reduce(
    (acc, g) => acc + soma(grupos[g]),
    0
  );
  const total_custos_variaveis_pct = pct(total_custos_variaveis, receita_liquida);

  // ── Margem de Contribuição ───────────────────────────────────────────────
  const margem_contribuicao = receita_liquida - total_custos_variaveis;
  const margem_contribuicao_pct = pct(margem_contribuicao, receita_liquida);

  // ── Despesas Fixas ───────────────────────────────────────────────────────
  const total_despesas_fixas = GRUPOS_DESPESAS_FIXAS.reduce(
    (acc, g) => acc + soma(grupos[g]),
    0
  );
  const total_despesas_fixas_pct = pct(total_despesas_fixas, receita_liquida);

  // ── Resultado ────────────────────────────────────────────────────────────
  const resultado_operacional = margem_contribuicao - total_despesas_fixas;
  const resultado_operacional_pct = pct(resultado_operacional, receita_liquida);

  // Adiciona % em cada linha (sobre receita líquida)
  const comPct = (linhas: LinhasDRE[]) =>
    linhas.map((l) => ({ ...l, pct: pct(l.valor, receita_liquida) }));

  return {
    periodo: { inicio, fim },
    receita_bruta: comPct(grupos.receita_bruta),
    total_receita_bruta,
    deducoes_receita: comPct(grupos.deducoes_receita),
    receita_liquida,
    cmv: comPct(grupos.cmv),
    materiais_venda_direta: comPct(grupos.materiais_venda_direta),
    materiais_apoio: comPct(grupos.materiais_apoio),
    cmo_eventual: comPct(grupos.cmo_eventual),
    tarifas_cartao: comPct(grupos.tarifas_cartao),
    impostos_variaveis: comPct(grupos.impostos_variaveis),
    total_custos_variaveis,
    total_custos_variaveis_pct,
    margem_contribuicao,
    margem_contribuicao_pct,
    ocupacao: comPct(grupos.ocupacao),
    utilidades: comPct(grupos.utilidades),
    despesas_admin: comPct(grupos.despesas_admin),
    marketing: comPct(grupos.marketing),
    pessoal_fixo: comPct(grupos.pessoal_fixo),
    total_despesas_fixas,
    total_despesas_fixas_pct,
    resultado_operacional,
    resultado_operacional_pct,
  };
}

// ── Resumo rápido (sem DRE completo) ─────────────────────────────────────────

export function formatarResumoWhatsApp(
  totalReceitas: number,
  totalDespesas: number,
  totalPendentes: number,
  periodo: string
): string {
  const saldo = totalReceitas - totalDespesas;
  const brl = (v: number) =>
    v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return [
    `*Resumo — ${periodo}*`,
    "",
    `Receitas:   R$ ${brl(totalReceitas)}`,
    `Despesas:   R$ ${brl(totalDespesas)}`,
    `─────────────────────`,
    `Saldo:      ${saldo >= 0 ? "R$ " + brl(saldo) : "(R$ " + brl(Math.abs(saldo)) + ")"}`,
    "",
    `A pagar:    R$ ${brl(totalPendentes)}`,
    "",
    `_Use *dre* para o demonstrativo completo._`,
  ].join("\n");
}

// ── Formatação para WhatsApp ──────────────────────────────────────────────────

function brl(value: number): string {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function sinalBrl(value: number): string {
  return value < 0 ? `(R$ ${brl(Math.abs(value))})` : `R$ ${brl(value)}`;
}

function linhasTexto(linhas: LinhasDRE[], base: number): string {
  if (linhas.length === 0) return "  —";
  return linhas
    .filter((l) => l.valor !== 0)
    .map((l) => {
      const p = base > 0 ? ` (${((l.valor / base) * 100).toFixed(1)}%)` : "";
      return `  ${l.categoria}: R$ ${brl(l.valor)}${p}`;
    })
    .join("\n");
}

export function formatarDREWhatsApp(dre: DRE): string {
  const { periodo, receita_liquida } = dre;

  const bloco = (
    titulo: string,
    linhas: LinhasDRE[],
    total?: number,
    totalLabel?: string
  ): string => {
    const corpo = linhasTexto(linhas, receita_liquida);
    const rodape =
      total !== undefined
        ? `  *${totalLabel ?? "Total"}: R$ ${brl(total)}*`
        : "";
    return [titulo, corpo, rodape].filter(Boolean).join("\n");
  };

  const linhas: string[] = [
    `*DRE OPERACIONAL — ${periodo.inicio} a ${periodo.fim}*`,
    "",
    // ── Receita ────────────────────────────────────
    "*RECEITA BRUTA*",
    linhasTexto(dre.receita_bruta, receita_liquida),
    `  *Total Bruto: R$ ${brl(dre.total_receita_bruta)}*`,
    "",
    bloco("*(-) Deduções*", dre.deducoes_receita),
    "",
    `*= RECEITA LÍQUIDA: R$ ${brl(receita_liquida)}*`,
    "",
    // ── Custos Variáveis ───────────────────────────
    "*(-) CUSTOS VARIÁVEIS*",
    bloco("_Matéria-Prima (CMV):_", dre.cmv),
    bloco("_Materiais de Venda Direta:_", dre.materiais_venda_direta),
    bloco("_Materiais de Apoio:_", dre.materiais_apoio),
    bloco("_CMO Eventual:_", dre.cmo_eventual),
    bloco("_Tarifas de Cartão/Delivery:_", dre.tarifas_cartao),
    bloco("_Impostos Variáveis:_", dre.impostos_variaveis),
    `  *Total Custos Variáveis: R$ ${brl(dre.total_custos_variaveis)} (${dre.total_custos_variaveis_pct}%)*`,
    "",
    // ── Margem de Contribuição ─────────────────────
    `*= MARGEM DE CONTRIBUIÇÃO: ${sinalBrl(dre.margem_contribuicao)} (${dre.margem_contribuicao_pct}%)*`,
    "",
    // ── Despesas Fixas ─────────────────────────────
    "*(-) DESPESAS FIXAS*",
    bloco("_Ocupação:_", dre.ocupacao),
    bloco("_Utilidades:_", dre.utilidades),
    bloco("_Administrativas:_", dre.despesas_admin),
    bloco("_Marketing:_", dre.marketing),
    bloco("_Pessoal Fixo:_", dre.pessoal_fixo),
    `  *Total Despesas Fixas: R$ ${brl(dre.total_despesas_fixas)} (${dre.total_despesas_fixas_pct}%)*`,
    "",
    // ── Resultado ──────────────────────────────────
    `*= RESULTADO OPERACIONAL: ${sinalBrl(dre.resultado_operacional)} (${dre.resultado_operacional_pct}%)*`,
  ];

  return linhas.filter((l) => l !== undefined).join("\n");
}
