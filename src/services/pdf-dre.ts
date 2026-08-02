import puppeteer from "puppeteer";
import { DRE } from "../types.js";

// ── Formatadores ──────────────────────────────────────────────────────────────

function brl(v: number): string {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(v: number, base: number): string {
  if (base === 0) return "—";
  return `${((v / base) * 100).toFixed(1)}%`;
}

function tendencia(atual: number, anterior: number): string {
  if (anterior === 0) return "";
  const diff = ((atual - anterior) / Math.abs(anterior)) * 100;
  if (Math.abs(diff) < 0.5) return `<span class="delta neutral">→ ${Math.abs(diff).toFixed(1)}%</span>`;
  const positivo = diff > 0;
  return `<span class="delta ${positivo ? "up" : "down"}">${positivo ? "▲" : "▼"} ${Math.abs(diff).toFixed(1)}%</span>`;
}

function mesLabel(iso: string): string {
  const [ano, mes] = iso.split("-");
  const nomes = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  return `${nomes[Number(mes) - 1]}/${ano.slice(2)}`;
}

// ── Componentes HTML ──────────────────────────────────────────────────────────

function kpiCard(
  label: string,
  valor: number,
  pctVal: string,
  cor: string,
  anterior?: number
): string {
  const tend = anterior !== undefined ? tendencia(valor, anterior) : "";
  return `
    <div class="kpi-card" style="border-top:4px solid ${cor}">
      <div class="kpi-label">${label}</div>
      <div class="kpi-valor" style="color:${valor < 0 ? "#ef4444" : "#1e293b"}">${valor < 0 ? `(R$ ${brl(Math.abs(valor))})` : `R$ ${brl(valor)}`}</div>
      <div class="kpi-meta">${pctVal} ${tend}</div>
    </div>`;
}

interface LinhaTabela {
  label: string;
  valorAtual: number;
  baseAtual: number;
  valorAnterior?: number;
  baseAnterior?: number;
  nivel?: "item" | "grupo" | "total" | "resultado";
  corFundo?: string;
}

function linhaTabela(l: LinhaTabela): string {
  const classeNivel = l.nivel ?? "item";
  const valAtual = l.valorAtual;
  const pctAtual = pct(Math.abs(valAtual), l.baseAtual);

  let celAnterior = "";
  if (l.valorAnterior !== undefined && l.baseAnterior !== undefined) {
    const pctAnt = pct(Math.abs(l.valorAnterior), l.baseAnterior);
    const tend = (l.nivel === "item" || l.nivel === "total")
      ? tendencia(valAtual, l.valorAnterior)
      : "";
    celAnterior = `
      <td class="num">${l.valorAnterior < 0 ? `(R$ ${brl(Math.abs(l.valorAnterior))})` : `R$ ${brl(l.valorAnterior)}`}</td>
      <td class="pct">${pctAnt}</td>
      <td class="tend">${tend}</td>`;
  } else {
    celAnterior = `<td></td><td></td><td></td>`;
  }

  const bgStyle = l.corFundo ? `style="background:${l.corFundo}"` : "";
  const numColor = valAtual < 0 ? `style="color:#ef4444"` : "";

  return `
    <tr class="${classeNivel}" ${bgStyle}>
      <td class="desc">${l.label}</td>
      <td class="num" ${numColor}>${valAtual < 0 ? `(R$ ${brl(Math.abs(valAtual))})` : `R$ ${brl(valAtual)}`}</td>
      <td class="pct">${pctAtual}</td>
      ${celAnterior}
    </tr>`;
}

function secaoHeader(label: string, cor: string): string {
  return `<tr class="secao-header" style="background:${cor}"><td colspan="6">${label}</td></tr>`;
}

// ── Gerador de HTML ───────────────────────────────────────────────────────────

function gerarHtml(dre: DRE, anterior?: DRE): string {
  const rl = dre.receita_liquida;
  const rlAnt = anterior?.receita_liquida;

  const labelAtual = mesLabel(dre.periodo.inicio);
  const labelAnt = anterior ? mesLabel(anterior.periodo.inicio) : "";

  // Soma de linhas de um grupo
  const soma = (linhas: { valor: number }[]) => linhas.reduce((s, l) => s + l.valor, 0);

  // Linhas de custos variáveis (categorias individuais)
  function linhasCusto(
    titulo: string,
    linhasAt: { categoria: string; valor: number }[],
    linhasAnt?: { categoria: string; valor: number }[]
  ): string {
    const com = linhasAt.filter((l) => l.valor !== 0);
    if (com.length === 0) return "";

    const antMap = new Map((linhasAnt ?? []).map((l) => [l.categoria, l.valor]));
    const rows = com.map((l) =>
      linhaTabela({
        label: `&nbsp;&nbsp;&nbsp;&nbsp;${l.categoria}`,
        valorAtual: l.valor,
        baseAtual: rl,
        valorAnterior: linhasAnt ? antMap.get(l.categoria) : undefined,
        baseAnterior: rlAnt,
        nivel: "item",
      })
    ).join("");

    return `
      <tr class="sub-header"><td colspan="6">${titulo}</td></tr>
      ${rows}`;
  }

  // Linha de total por sub-grupo para Despesas Fixas
  function linhaFixa(
    label: string,
    linhasAt: { valor: number }[],
    linhasAnt?: { valor: number }[]
  ): string {
    const total = soma(linhasAt);
    if (total === 0) return "";
    return linhaTabela({
      label: `&nbsp;&nbsp;&nbsp;&nbsp;${label}`,
      valorAtual: total,
      baseAtual: rl,
      valorAnterior: linhasAnt ? soma(linhasAnt) : undefined,
      baseAnterior: rlAnt,
      nivel: "item",
    });
  }

  const kpis = `
    <div class="kpi-grid">
      ${kpiCard("Receita Bruta", dre.total_receita_bruta, pct(dre.total_receita_bruta, dre.total_receita_bruta), "#10b981", anterior?.total_receita_bruta)}
      ${kpiCard("Receita Líquida", rl, "100%", "#3b82f6", rlAnt)}
      ${kpiCard("Margem de Contribuição", dre.margem_contribuicao, pct(dre.margem_contribuicao, rl), "#f59e0b", anterior?.margem_contribuicao)}
      ${kpiCard("Resultado Operacional", dre.resultado_operacional, pct(dre.resultado_operacional, rl), dre.resultado_operacional >= 0 ? "#10b981" : "#ef4444", anterior?.resultado_operacional)}
    </div>`;

  const cabecalhoTabela = `
    <thead>
      <tr class="col-header">
        <th class="desc"></th>
        <th colspan="2" class="mes-header">${labelAtual}</th>
        ${anterior ? `<th colspan="2" class="mes-header prev">${labelAnt}</th><th></th>` : ""}
      </tr>
      <tr class="col-sub">
        <th class="desc">Categoria</th>
        <th class="num">Valor</th>
        <th class="pct">% RL</th>
        ${anterior ? `<th class="num">Valor</th><th class="pct">% RL</th><th class="tend">Var.</th>` : ""}
      </tr>
    </thead>`;

  const corpo = `
    <tbody>
      ${secaoHeader("RECEITA BRUTA", "#059669")}
      ${linhasCusto("Vendas", dre.receita_bruta, anterior?.receita_bruta)}
      ${linhasCusto("(-) Deduções", dre.deducoes_receita.map(l => ({ ...l, valor: -l.valor })), anterior?.deducoes_receita.map(l => ({ ...l, valor: -l.valor })))}
      ${linhaTabela({ label: "= RECEITA LÍQUIDA", valorAtual: rl, baseAtual: rl, valorAnterior: rlAnt, baseAnterior: rlAnt, nivel: "total", corFundo: "#f0fdf4" })}

      ${secaoHeader("(-) CUSTOS VARIÁVEIS", "#d97706")}
      ${linhasCusto("Matéria-Prima (CMV)", dre.cmv, anterior?.cmv)}
      ${linhasCusto("Mat. de Venda Direta", dre.materiais_venda_direta, anterior?.materiais_venda_direta)}
      ${linhasCusto("Mat. de Apoio", dre.materiais_apoio, anterior?.materiais_apoio)}
      ${linhasCusto("CMO Eventual", dre.cmo_eventual, anterior?.cmo_eventual)}
      ${linhasCusto("Tarifas Cartão/Delivery", dre.tarifas_cartao, anterior?.tarifas_cartao)}
      ${linhasCusto("Impostos Variáveis", dre.impostos_variaveis, anterior?.impostos_variaveis)}
      ${linhaTabela({ label: "TOTAL CUSTOS VARIÁVEIS", valorAtual: dre.total_custos_variaveis, baseAtual: rl, valorAnterior: anterior?.total_custos_variaveis, baseAnterior: rlAnt, nivel: "total", corFundo: "#fffbeb" })}

      ${linhaTabela({ label: "= MARGEM DE CONTRIBUIÇÃO", valorAtual: dre.margem_contribuicao, baseAtual: rl, valorAnterior: anterior?.margem_contribuicao, baseAnterior: rlAnt, nivel: "resultado", corFundo: "#fef9c3" })}

      ${secaoHeader("(-) DESPESAS FIXAS", "#dc2626")}
      ${linhasCusto("Ocupação", dre.ocupacao, anterior?.ocupacao)}
      ${linhasCusto("Utilidades", dre.utilidades, anterior?.utilidades)}
      ${linhasCusto("Pessoal Fixo", dre.pessoal_fixo, anterior?.pessoal_fixo)}
      ${linhasCusto("Serviços Terceirizados", dre.servicos_terceirizados, anterior?.servicos_terceirizados)}
      ${linhasCusto("Administrativas", dre.despesas_admin, anterior?.despesas_admin)}
      ${linhasCusto("Marketing", dre.marketing, anterior?.marketing)}
      ${linhasCusto("Manutenção", dre.manutencao, anterior?.manutencao)}
      ${linhasCusto("Aquisições", dre.despesas_aquisicao, anterior?.despesas_aquisicao)}
      ${linhasCusto("Retirada de Sócios", dre.retirada_socios, anterior?.retirada_socios)}
      ${linhasCusto("Renegociações", dre.renegociacoes_dividas, anterior?.renegociacoes_dividas)}
      ${linhasCusto("Desp. Financeiras", dre.despesas_financeiras, anterior?.despesas_financeiras)}
      ${linhaTabela({ label: "TOTAL DESPESAS FIXAS", valorAtual: dre.total_despesas_fixas, baseAtual: rl, valorAnterior: anterior?.total_despesas_fixas, baseAnterior: rlAnt, nivel: "total", corFundo: "#fef2f2" })}

      ${linhaTabela({ label: "= RESULTADO OPERACIONAL", valorAtual: dre.resultado_operacional, baseAtual: rl, valorAnterior: anterior?.resultado_operacional, baseAnterior: rlAnt, nivel: "resultado", corFundo: dre.resultado_operacional >= 0 ? "#f0fdf4" : "#fef2f2" })}
    </tbody>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    font-size: 12px;
    background: #f1f5f9;
    color: #1e293b;
    padding: 28px;
  }

  /* ── Header ── */
  .header {
    background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
    color: white;
    padding: 20px 28px;
    border-radius: 14px;
    margin-bottom: 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .header h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
  .header .periodo { font-size: 13px; opacity: 0.75; margin-top: 4px; }
  .header .badge {
    background: rgba(255,255,255,0.15);
    border-radius: 8px;
    padding: 10px 18px;
    text-align: right;
  }
  .header .badge .label { font-size: 11px; opacity: 0.7; }
  .header .badge .val { font-size: 15px; font-weight: 700; }

  /* ── KPI Cards ── */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    margin-bottom: 20px;
  }
  .kpi-card {
    background: white;
    border-radius: 12px;
    padding: 16px 18px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.07);
  }
  .kpi-label { font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .kpi-valor { font-size: 17px; font-weight: 700; margin-bottom: 4px; }
  .kpi-meta { font-size: 11px; color: #94a3b8; }

  /* ── Delta badges ── */
  .delta { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px; }
  .delta.up { color: #059669; background: #d1fae5; }
  .delta.down { color: #dc2626; background: #fee2e2; }
  .delta.neutral { color: #64748b; background: #f1f5f9; }

  /* ── Tabela DRE ── */
  .dre-wrap {
    background: white;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 1px 4px rgba(0,0,0,0.07);
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }

  /* cabeçalho de meses */
  .col-header th { padding: 10px 12px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
  .col-sub th { padding: 6px 12px; background: #f8fafc; border-bottom: 2px solid #e2e8f0; font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
  .mes-header { font-size: 12px; font-weight: 700; color: #1e293b; text-align: center; border-left: 1px solid #e2e8f0; }
  .mes-header.prev { color: #94a3b8; }

  /* linhas de seção */
  .secao-header td {
    padding: 10px 14px;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.8px;
    color: white;
    text-transform: uppercase;
  }

  .sub-header td {
    padding: 6px 14px;
    font-size: 11px;
    font-weight: 600;
    color: #475569;
    background: #f8fafc;
    border-top: 1px solid #e2e8f0;
    font-style: italic;
  }

  /* linhas normais */
  tr.item td { padding: 6px 12px; border-bottom: 1px solid #f1f5f9; }
  tr.item:hover td { background: #f8fafc; }

  /* linhas de total */
  tr.total td {
    padding: 9px 12px;
    font-weight: 700;
    font-size: 12px;
    border-top: 2px solid #e2e8f0;
    border-bottom: 2px solid #e2e8f0;
  }

  /* resultado destacado */
  tr.resultado td {
    padding: 11px 12px;
    font-weight: 800;
    font-size: 13px;
    border-top: 2px solid #e2e8f0;
  }

  /* alinhamento de colunas */
  td.desc, th.desc { text-align: left; width: 38%; }
  td.num, th.num { text-align: right; width: 14%; font-variant-numeric: tabular-nums; }
  td.pct, th.pct { text-align: right; width: 7%; color: #64748b; font-size: 11px; }
  td.tend, th.tend { text-align: center; width: 8%; }

  /* rodapé */
  .rodape {
    margin-top: 16px;
    text-align: center;
    font-size: 10px;
    color: #94a3b8;
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="h1" style="font-size:22px;font-weight:700;color:white">DRE OPERACIONAL</div>
    <div class="periodo" style="font-size:13px;opacity:0.7;color:white;margin-top:4px">
      ${labelAtual}${anterior ? ` vs ${labelAnt}` : ""}
      &nbsp;·&nbsp; ${dre.periodo.inicio} a ${dre.periodo.fim}
    </div>
  </div>
  <div class="badge">
    <div class="label" style="font-size:11px;opacity:0.7;color:white">Resultado</div>
    <div class="val" style="font-size:18px;font-weight:700;color:${dre.resultado_operacional >= 0 ? "#4ade80" : "#f87171"}">
      ${dre.resultado_operacional >= 0 ? "R$ " + brl(dre.resultado_operacional) : "(R$ " + brl(Math.abs(dre.resultado_operacional)) + ")"}
    </div>
    <div style="font-size:11px;opacity:0.7;color:white">${pct(dre.resultado_operacional, rl)} da receita</div>
  </div>
</div>

${kpis}

<div class="dre-wrap">
  <table>
    ${cabecalhoTabela}
    ${corpo}
  </table>
</div>

<div class="rodape">Gerado em ${new Date().toLocaleString("pt-BR")} · DRE Operacional para Restaurantes</div>

</body>
</html>`;
}

// ── Geração do PDF via Puppeteer ──────────────────────────────────────────────

export async function gerarPdfDRE(dre: DRE, anterior?: DRE): Promise<Buffer> {
  const html = gerarHtml(dre, anterior);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });

    const pdf = await page.pdf({
      format: "A4",
      landscape: anterior !== undefined, // landscape quando tem comparativo
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
