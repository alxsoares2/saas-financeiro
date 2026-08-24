import puppeteer from "puppeteer";
import { Produto, SugestaoCompraResultado } from "./types.js";

function brl(v: number): string {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Quantos itens cabem confortavelmente numa página A4 com essa tabela —
// usado só pra decidir onde cortar as páginas do PDF (ver premissa de
// paginação abaixo). Ajustar se a fonte/linha mudar de tamanho.
const ITENS_POR_PAGINA = 22;

function linhaTabela(item: SugestaoCompraResultado["itens"][number]): string {
  return `
    <tr class="falta">
      <td class="desc">${item.produtoNome}${item.isPool ? ' <span class="pool">pool</span>' : ""}</td>
      <td class="num">${brl(item.estoqueAtual)}</td>
      <td class="num">${brl(item.necessario)}</td>
      <td class="num destaque">${brl(item.sugestaoArredondada)}</td>
      <td class="unidade">${item.unidade}</td>
      <td class="num">${item.precoUnitario != null ? `R$ ${brl(item.precoUnitario)}` : "?"}</td>
      <td class="num destaque">${item.valorEstimado != null ? `R$ ${brl(item.valorEstimado)}` : "?"}</td>
      <td class="motivo">${item.motivo}</td>
    </tr>`;
}

const CABECALHO_TABELA = `
    <tr>
      <th>Produto</th>
      <th style="text-align:right">Estoque</th>
      <th style="text-align:right">Necessário</th>
      <th style="text-align:right">Comprar</th>
      <th>Unidade</th>
      <th style="text-align:right">Valor unit.</th>
      <th style="text-align:right">Valor total</th>
      <th>Motivo</th>
    </tr>`;

function estiloComumSugestao(): string {
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    font-size: 11px;
    background: #f1f5f9;
    color: #1e293b;
    padding: 24px;
  }
  .header {
    background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
    color: white;
    padding: 20px 28px;
    border-radius: 14px;
    margin-bottom: 20px;
  }
  .header h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
  .header .meta { font-size: 13px; opacity: 0.8; margin-top: 6px; }
  .header .badge {
    display: inline-block;
    margin-top: 10px;
    background: rgba(255,255,255,0.15);
    border-radius: 8px;
    padding: 6px 14px;
    font-weight: 700;
  }
  .pagina-label { font-size: 11px; color: #64748b; font-weight: 700; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .wrap {
    background: white;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 1px 4px rgba(0,0,0,0.07);
  }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    padding: 8px 10px;
    background: #f8fafc;
    border-bottom: 2px solid #e2e8f0;
    font-size: 9px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    text-align: left;
  }
  td { padding: 6px 10px; border-bottom: 1px solid #f1f5f9; font-size: 11px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.destaque { font-weight: 700; }
  tr.falta td.destaque { color: #dc2626; }
  .pool { font-size: 9px; background: #e0e7ff; color: #4338ca; padding: 1px 6px; border-radius: 4px; margin-left: 4px; }
  .motivo { color: #64748b; font-size: 9px; }
  tr.subtotal td { padding: 8px 10px; font-weight: 700; font-size: 11px; border-top: 2px solid #cbd5e1; color: #475569; }
  .pagina { page-break-after: always; }
  .pagina:last-child { page-break-after: auto; }
  .total-geral {
    margin-top: 18px;
    background: #1e293b;
    color: white;
    border-radius: 14px;
    padding: 18px 24px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .total-geral-label { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.85; }
  .total-geral-valor { font-size: 24px; font-weight: 800; }
  .total-geral-nota { font-size: 10px; opacity: 0.75; margin-top: 4px; }
  .rodape { margin-top: 16px; text-align: center; font-size: 10px; color: #94a3b8; }
  `;
}

function gerarHtml(resultado: SugestaoCompraResultado): string {
  const { meta, itens, valorTotalEstimado, itensComPrecoDesconhecido } = resultado;
  const comFalta = itens.filter((i) => i.falta > 0);

  // Paginação manual (em vez de deixar o quebra-página automático do
  // navegador cortar a tabela no meio): cada página carrega só os itens
  // dela, com um subtotal PRÓPRIO no rodapé da tabela — nunca o total
  // geral repetido em todo canto. O Total Geral só aparece uma vez, no
  // fim da última página, visualmente destacado do subtotal de página.
  const paginas: (typeof comFalta)[] = [];
  for (let i = 0; i < comFalta.length; i += ITENS_POR_PAGINA) {
    paginas.push(comFalta.slice(i, i + ITENS_POR_PAGINA));
  }
  if (paginas.length === 0) paginas.push([]);

  const headerPrincipal = `
    <div class="header">
      <div class="h1" style="font-size:22px;font-weight:700;color:white">SUGESTÃO DE COMPRA — ESTOQUE</div>
      <div class="meta">
        Basílico: ${meta.qtdPizzasBasilico} pizzas &nbsp;·&nbsp; Populares: ${meta.qtdPizzasPopulares} pizzas
        ${meta.validoAte ? `&nbsp;·&nbsp; válido até ${meta.validoAte}` : ""}
      </div>
      <div class="badge">${comFalta.length} ${comFalta.length === 1 ? "item precisa" : "itens precisam"} de compra${paginas.length > 1 ? ` · ${paginas.length} páginas` : ""}</div>
    </div>`;

  const blocosPaginas = paginas
    .map((itensPagina, idx) => {
      const isPrimeira = idx === 0;
      const isUltima = idx === paginas.length - 1;
      const subtotalPagina = itensPagina.reduce((s, i) => s + (i.valorEstimado ?? 0), 0);
      const linhas = itensPagina.map(linhaTabela).join("");
      const corpoTabela =
        linhas || `<tr><td colspan="8" style="text-align:center;padding:24px;color:#94a3b8">✅ Estoque cobre a meta pedida — nenhuma compra necessária.</td></tr>`;

      return `
      <div class="pagina">
        ${isPrimeira ? headerPrincipal : `<div class="pagina-label">Sugestão de compra — página ${idx + 1} de ${paginas.length} (continuação)</div>`}
        <div class="wrap">
          <table>
            <thead>${CABECALHO_TABELA}</thead>
            <tbody>${corpoTabela}</tbody>
            ${
              itensPagina.length > 0
                ? `<tfoot><tr class="subtotal"><td colspan="6">SUBTOTAL DESTA PÁGINA (${itensPagina.length} ${itensPagina.length === 1 ? "item" : "itens"})</td><td class="num" colspan="2">R$ ${brl(subtotalPagina)}</td></tr></tfoot>`
                : ""
            }
          </table>
        </div>
        ${
          isUltima && comFalta.length > 0
            ? `
        <div class="total-geral">
          <div>
            <div class="total-geral-label">Total Geral — todas as páginas</div>
            ${itensComPrecoDesconhecido > 0 ? `<div class="total-geral-nota">${itensComPrecoDesconhecido} item(ns) sem preço cadastrado, não incluído(s)</div>` : ""}
          </div>
          <div class="total-geral-valor">R$ ${brl(valorTotalEstimado)}</div>
        </div>`
            : ""
        }
        ${isUltima ? `<div class="rodape">Gerado em ${new Date().toLocaleString("pt-BR")} · Sugestão automática — decisão final é do time</div>` : ""}
      </div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<style>${estiloComumSugestao()}</style>
</head>
<body>
${blocosPaginas}
</body>
</html>`;
}

async function renderizarPdf(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

export async function gerarPdfSugestaoCompra(resultado: SugestaoCompraResultado): Promise<Buffer> {
  return renderizarPdf(gerarHtml(resultado));
}

// ── Consulta de estoque atual (lista de produtos) ─────────────────────────

function estiloBase(): string {
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    font-size: 12px;
    background: #f1f5f9;
    color: #1e293b;
    padding: 28px;
  }
  .header {
    background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
    color: white;
    padding: 20px 28px;
    border-radius: 14px;
    margin-bottom: 20px;
  }
  .header h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
  .header .meta { font-size: 13px; opacity: 0.8; margin-top: 6px; }
  .header .badge {
    display: inline-block;
    margin-top: 10px;
    background: rgba(255,255,255,0.15);
    border-radius: 8px;
    padding: 6px 14px;
    font-weight: 700;
  }
  .wrap {
    background: white;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 1px 4px rgba(0,0,0,0.07);
  }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    padding: 10px 12px;
    background: #f8fafc;
    border-bottom: 2px solid #e2e8f0;
    font-size: 10px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    text-align: left;
  }
  td { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.destaque { font-weight: 700; }
  .rodape { margin-top: 16px; text-align: center; font-size: 10px; color: #94a3b8; }
  `;
}

function linhaEstoque(p: Produto): string {
  const abaixoDoMinimo = Number(p.estoque_atual) < Number(p.estoque_minimo);
  return `
    <tr class="${abaixoDoMinimo ? "falta" : "ok"}">
      <td class="desc">${p.nome}</td>
      <td>${p.tipo === "manipulado" ? "manipulado" : "bruto"}${p.marca ? ` · ${p.marca}` : ""}</td>
      <td class="num ${abaixoDoMinimo ? "destaque" : ""}" style="${abaixoDoMinimo ? "color:#dc2626" : ""}">${p.estoque_atual}</td>
      <td class="num">${p.estoque_minimo}</td>
      <td>${p.unidade}</td>
    </tr>`;
}

function gerarHtmlEstoque(produtos: Produto[]): string {
  const ativos = produtos.filter((p) => p.ativo).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  const abaixoDoMinimo = ativos.filter((p) => Number(p.estoque_atual) < Number(p.estoque_minimo));
  const linhas = ativos.map(linhaEstoque).join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<style>${estiloBase()}</style>
</head>
<body>

<div class="header">
  <div class="h1" style="font-size:22px;font-weight:700;color:white">ESTOQUE ATUAL</div>
  <div class="meta">${ativos.length} produtos ativos</div>
  ${abaixoDoMinimo.length > 0 ? `<div class="badge">${abaixoDoMinimo.length} abaixo do mínimo</div>` : ""}
</div>

<div class="wrap">
  <table>
    <thead>
      <tr>
        <th>Produto</th>
        <th>Tipo</th>
        <th style="text-align:right">Estoque</th>
        <th style="text-align:right">Mínimo</th>
        <th>Unidade</th>
      </tr>
    </thead>
    <tbody>
      ${linhas}
    </tbody>
  </table>
</div>

<div class="rodape">Gerado em ${new Date().toLocaleString("pt-BR")}</div>

</body>
</html>`;
}

export async function gerarPdfEstoque(produtos: Produto[]): Promise<Buffer> {
  return renderizarPdf(gerarHtmlEstoque(produtos));
}
