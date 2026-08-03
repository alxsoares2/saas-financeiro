import PDFDocument from "pdfkit";
import { createClient } from "@supabase/supabase-js";
import { Readable } from "stream";

let supabase: any = null;

function getSupabase() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    if (!url || !key) {
      throw new Error(
        `Supabase credentials missing: URL=${!!url}, KEY=${!!key}`
      );
    }

    supabase = createClient(url, key, { db: { schema: "financeiro" } });
  }
  return supabase;
}

interface Lancamento {
  id: string;
  categoria: string;
  valor: number;
  status: "pendente" | "pago" | "pago_parcialmente";
  data_vencimento: string | null;
  data_pagamento: string | null;
  data_emissao: string;
  descricao: string;
  tipo: "receita" | "despesa";
}

interface RelatorioData {
  mes: string;
  ano: number;
  lancamentos: Lancamento[];
  totais: {
    pago: number;
    a_pagar: number;
    vencido: number;
  };
}

export async function gerarRelatorioContas(
  schema: string,
  mes?: number,
  ano?: number
): Promise<Buffer> {
  let lancamentos: any[] = [];
  let mesLabel = "";

  const sb = getSupabase();
  console.log("[relatorio] Iniciando geração de relatório...");

  // Buscar categorias para mapping
  console.log("[relatorio] Buscando categorias...");
  let categorias: any[] = [];
  try {
    const result = await sb
      .from("categorias")
      .select("id, nome");

    if (result.error) {
      console.error("[relatorio] Erro ao buscar categorias:", result.error);
      console.log("[relatorio] Continuando sem categorias...");
    } else {
      categorias = result.data || [];
      console.log(`[relatorio] Encontradas ${categorias.length} categorias`);
    }
  } catch (err) {
    console.error("[relatorio] Exceção ao buscar categorias:", err);
  }

  const categoriasMap = new Map(
    (categorias || []).map((c: any) => [c.id, c.nome])
  );
  console.log(`[relatorio] Mapa de categorias pronto: ${categoriasMap.size} entradas`);

  if (mes && ano) {
    // Relatório de um mês específico
    const dataInicio = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const dataFim = mes === 12 ? `${ano + 1}-01-01` : `${ano}-${String(mes + 1).padStart(2, "0")}-01`;

    console.log(`[relatorio] Buscando lançamentos de ${dataInicio} a ${dataFim}`);

    console.log(`[relatorio] Query de período: ${dataInicio} a ${dataFim}`);
    const result = await sb
      .from("lancamentos")
      .select("*")
      .gte("data_emissao", dataInicio)
      .lt("data_emissao", dataFim);

    if (result.error) {
      console.error("[relatorio] Erro ao buscar lançamentos:", result.error);
      throw new Error(`Supabase query error: ${result.error.message}`);
    }

    const lancamentosData = result.data || [];
    console.log(`[relatorio] Query retornou ${lancamentosData.length} registros`);

    lancamentos = (lancamentosData || []).map((l: any) => ({
      ...l,
      categoria: categoriasMap.get(l.categoria_id) || "Sem categoria",
    }));
    console.log(`[relatorio] Encontrados ${lancamentos.length} lançamentos após mapping`);
    mesLabel = `${getMesNome(mes)} de ${ano}`;
  } else {
    // Relatório GERAL (todos os meses)
    console.log("[relatorio] Buscando todos os lançamentos (relatório geral)");

    const result = await sb
      .from("lancamentos")
      .select("*");

    if (result.error) {
      console.error("[relatorio] Erro ao buscar lançamentos geral:", result.error);
      throw new Error(`Supabase query error: ${result.error.message}`);
    }

    const lancamentosData = result.data || [];
    console.log(`[relatorio] Query geral retornou ${lancamentosData.length} registros`);

    lancamentos = (lancamentosData || []).map((l: any) => ({
      ...l,
      categoria: categoriasMap.get(l.categoria_id) || "Sem categoria",
    }));
    console.log(`[relatorio] Encontrados ${lancamentos.length} lançamentos após mapping (geral)`);
    mesLabel = "GERAL (Todos os meses)";
  }

  // Agrupa por categoria e calcula totais
  console.log("[relatorio] Agrupando por categoria...");
  const porCategoria: Record<string, Lancamento[]> = {};
  let totalPago = 0;
  let totalAPagar = 0;
  let totalVencido = 0;

  try {
    (lancamentos || []).forEach((l: any) => {
      const categoria = l.categoria || "Sem categoria";
      if (!porCategoria[categoria]) {
        porCategoria[categoria] = [];
      }
      porCategoria[categoria].push(l);

      // Calcula totais baseado no status e data
      if (l.status === "pago" || l.status === "pago_parcialmente") {
        totalPago += Number(l.valor_pago) || 0;
        const pendente = Number(l.valor) - (Number(l.valor_pago) || 0);
        if (pendente > 0) {
          if (l.data_vencimento && new Date(l.data_vencimento) < new Date()) {
            totalVencido += pendente;
          } else {
            totalAPagar += pendente;
          }
        }
      } else if (l.status === "pendente") {
        if (l.data_vencimento && new Date(l.data_vencimento) < new Date()) {
          totalVencido += Number(l.valor);
        } else {
          totalAPagar += Number(l.valor);
        }
      }
    });
    console.log(`[relatorio] Agrupamento concluído: ${Object.keys(porCategoria).length} categorias`);
  } catch (err) {
    console.error("[relatorio] Erro ao agrupar:", err);
    throw err;
  }

  // Gera PDF
  console.log("[relatorio] Iniciando geração do PDF...");
  const doc = new PDFDocument({ margin: 40 });
  const chunks: Buffer[] = [];

  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  doc.on("error", (err: Error) => {
    console.error("[relatorio] Erro no evento 'data' do PDF:", err);
  });

  // Cabeçalho
  doc.fontSize(20).font("Helvetica-Bold").text("RELATÓRIO DE CONTAS");
  doc.fontSize(12)
    .font("Helvetica")
    .text(mesLabel, { align: "left", underline: true });

  doc.moveDown(1);

  // Resumo de totais
  doc.fontSize(11).font("Helvetica-Bold").text("RESUMO");
  doc.fontSize(10).font("Helvetica");
  doc.text(`[PAGO] R$ ${totalPago.toFixed(2)}`);
  doc.text(`[A PAGAR] R$ ${totalAPagar.toFixed(2)}`);
  doc.text(`[VENCIDO] R$ ${totalVencido.toFixed(2)}`);
  doc.text(`────────────────────────`);
  doc.text(
    `TOTAL: R$ ${(totalPago + totalAPagar + totalVencido).toFixed(2)}`,
    { underline: true }
  );

  doc.moveDown(1.5);

  // Detalhes por categoria
  doc.fontSize(11).font("Helvetica-Bold").text("CONTAS POR CATEGORIA");
  doc.moveDown(0.5);

  Object.keys(porCategoria)
    .sort()
    .forEach((categoria) => {
      doc.fontSize(10).font("Helvetica-Bold").text(categoria);

      const items = porCategoria[categoria];
      const colunas = {
        status: 60,
        descricao: 200,
        valor: 70,
        vencimento: 80,
      };

      // Cabeçalho da tabela
      doc.fontSize(9).font("Helvetica-Bold");
      let x = doc.x;
      doc.text("Status", x, doc.y, { width: colunas.status });
      x += colunas.status;
      doc.text("Descrição", x, doc.y - 12, { width: colunas.descricao });
      x += colunas.descricao;
      doc.text("Valor", x, doc.y - 24, { width: colunas.valor });
      x += colunas.valor;
      doc.text("Vencimento", x, doc.y - 36, { width: colunas.vencimento });

      doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).stroke();
      doc.moveDown(0.5);

      // Linhas de dados
      doc.fontSize(8).font("Helvetica");
      items.forEach((item: any) => {
        let statusLabel = "?";

        if (item.status === "pago" || item.status === "pago_parcialmente") {
          statusLabel = item.status === "pago" ? "P" : "PP";
        } else if (item.status === "pendente") {
          if (item.data_vencimento && new Date(item.data_vencimento) < new Date()) {
            statusLabel = "V";
          } else {
            statusLabel = "A";
          }
        }

        x = 40;
        doc.text(statusLabel, x, doc.y, { width: colunas.status });
        x += colunas.status;
        doc.text(item.descricao || "—", x, doc.y - 12, {
          width: colunas.descricao,
        });
        x += colunas.descricao;
        doc.text(`R$ ${item.valor.toFixed(2)}`, x, doc.y - 24, {
          width: colunas.valor,
          align: "right",
        });
        x += colunas.valor;
        doc.text(
          item.data_vencimento ? formatarData(item.data_vencimento) : "—",
          x,
          doc.y - 36,
          { width: colunas.vencimento }
        );

        doc.moveDown(0.8);
      });

      doc.moveDown(0.5);
    });

  try {
    console.log("[relatorio] Finalizando PDF...");
    doc.end();
  } catch (err) {
    console.error("[relatorio] Erro ao chamar doc.end():", err);
    throw err;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error("[relatorio] Timeout ao gerar PDF (>10s)");
      reject(new Error("PDF generation timeout"));
    }, 10000);

    doc.on("end", () => {
      clearTimeout(timeout);
      console.log(`[relatorio] PDF gerado com sucesso: ${chunks.length} chunks, ${Buffer.concat(chunks).length} bytes`);
      resolve(Buffer.concat(chunks));
    });
    doc.on("error", (err: Error) => {
      clearTimeout(timeout);
      console.error("[relatorio] Erro ao gerar PDF:", err);
      reject(err);
    });
  });
}


function getMesNome(mes: number): string {
  const nomes = [
    "Janeiro",
    "Fevereiro",
    "Março",
    "Abril",
    "Maio",
    "Junho",
    "Julho",
    "Agosto",
    "Setembro",
    "Outubro",
    "Novembro",
    "Dezembro",
  ];
  return nomes[mes - 1];
}

function formatarData(data: string): string {
  const d = new Date(data);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}
