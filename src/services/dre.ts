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

// Grupos que compõem as Despesas Fixas (ordem da planilha ENG-DRE ARTS)
const GRUPOS_DESPESAS_FIXAS: GrupoDRE[] = [
  "ocupacao",
  "utilidades",
  "despesas_admin",
  "marketing",
  "manutencao",
  "despesas_aquisicao",
  "servicos_terceirizados",
  "pessoal_fixo",
  "retirada_socios",
  "renegociacoes_dividas",
  "despesas_financeiras",
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
    manutencao: [],
    despesas_aquisicao: [],
    servicos_terceirizados: [],
    pessoal_fixo: [],
    retirada_socios: [],
    renegociacoes_dividas: [],
    despesas_financeiras: [],
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
    manutencao: comPct(grupos.manutencao),
    despesas_aquisicao: comPct(grupos.despesas_aquisicao),
    servicos_terceirizados: comPct(grupos.servicos_terceirizados),
    pessoal_fixo: comPct(grupos.pessoal_fixo),
    retirada_socios: comPct(grupos.retirada_socios),
    renegociacoes_dividas: comPct(grupos.renegociacoes_dividas),
    despesas_financeiras: comPct(grupos.despesas_financeiras),
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
  const comValor = linhas.filter((l) => l.valor !== 0);
  if (comValor.length === 0) return "";
  return comValor
    .map((l) => {
      const p = base > 0 ? ` (${((l.valor / base) * 100).toFixed(1)}%)` : "";
      return `  • ${l.categoria}: R$ ${brl(l.valor)}${p}`;
    })
    .join("\n");
}

// Retorna bloco somente se tiver lançamentos; omite subcategorias vazias
function bloco(titulo: string, linhas: LinhasDRE[], base: number): string | null {
  const corpo = linhasTexto(linhas, base);
  if (!corpo) return null;
  return `${titulo}\n${corpo}`;
}

// Linha de total por sub-grupo de Despesas Fixas
function linhaGrupo(
  label: string,
  linhas: LinhasDRE[],
  base: number
): string | null {
  const total = linhas.reduce((s, l) => s + l.valor, 0);
  if (total === 0) return null;
  const p = base > 0 ? ` (${((total / base) * 100).toFixed(1)}%)` : "";
  return `  ${label}: R$ ${brl(total)}${p}`;
}

export function formatarDREWhatsApp(dre: DRE): string {
  const { periodo, receita_liquida } = dre;

  const receitaLinhas = linhasTexto(dre.receita_bruta, receita_liquida);
  const deducoesLinhas = linhasTexto(dre.deducoes_receita, receita_liquida);

  // Custos variáveis — mostra categorias individuais por sub-grupo
  const subCustosVariaveis = [
    bloco("_Matéria-Prima (CMV):_", dre.cmv, receita_liquida),
    bloco("_Mat. Venda Direta:_", dre.materiais_venda_direta, receita_liquida),
    bloco("_Mat. de Apoio:_", dre.materiais_apoio, receita_liquida),
    bloco("_CMO Eventual:_", dre.cmo_eventual, receita_liquida),
    bloco("_Tarifas Cartão/Delivery:_", dre.tarifas_cartao, receita_liquida),
    bloco("_Impostos Variáveis:_", dre.impostos_variaveis, receita_liquida),
  ].filter(Boolean) as string[];

  // Despesas fixas — mostra categorias individuais por sub-grupo (igual ao CMV)
  const linhasFixas = [
    bloco("_Ocupação:_", dre.ocupacao, receita_liquida),
    bloco("_Utilidades:_", dre.utilidades, receita_liquida),
    bloco("_Pessoal Fixo:_", dre.pessoal_fixo, receita_liquida),
    bloco("_Serv. Terceirizados:_", dre.servicos_terceirizados, receita_liquida),
    bloco("_Administrativas:_", dre.despesas_admin, receita_liquida),
    bloco("_Marketing:_", dre.marketing, receita_liquida),
    bloco("_Manutenção:_", dre.manutencao, receita_liquida),
    bloco("_Aquisições:_", dre.despesas_aquisicao, receita_liquida),
    bloco("_Retirada de Sócios:_", dre.retirada_socios, receita_liquida),
    bloco("_Renegociações:_", dre.renegociacoes_dividas, receita_liquida),
    bloco("_Desp. Financeiras:_", dre.despesas_financeiras, receita_liquida),
  ].filter(Boolean) as string[];

  const linhas: (string | null)[] = [
    `*DRE OPERACIONAL — ${periodo.inicio} a ${periodo.fim}*`,
    "",
    "*RECEITA BRUTA*",
    receitaLinhas || "  —",
    `  *Total Bruto: R$ ${brl(dre.total_receita_bruta)}*`,
    deducoesLinhas ? `\n*(-) Deduções*\n${deducoesLinhas}` : null,
    "",
    `*= RECEITA LÍQUIDA: R$ ${brl(receita_liquida)}*`,
    "",
    "*(-) CUSTOS VARIÁVEIS*",
    subCustosVariaveis.length > 0 ? subCustosVariaveis.join("\n") : "  —",
    `  *Total: R$ ${brl(dre.total_custos_variaveis)} (${dre.total_custos_variaveis_pct}%)*`,
    "",
    `*= MARGEM DE CONTRIBUIÇÃO: ${sinalBrl(dre.margem_contribuicao)} (${dre.margem_contribuicao_pct}%)*`,
    "",
    "*(-) DESPESAS FIXAS*",
    linhasFixas.length > 0 ? linhasFixas.join("\n") : "  —",
    `  *Total: R$ ${brl(dre.total_despesas_fixas)} (${dre.total_despesas_fixas_pct}%)*`,
    "",
    `*= RESULTADO OPERACIONAL: ${sinalBrl(dre.resultado_operacional)} (${dre.resultado_operacional_pct}%)*`,
  ];

  return linhas.filter((l) => l !== null).join("\n");
}
