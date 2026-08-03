import PDFDocument from "pdfkit";
import { createClient } from "@supabase/supabase-js";
import { Readable } from "stream";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

interface Lancamento {
  id: string;
  categoria: string;
  valor: number;
  status: "pago" | "a_pagar" | "vencido";
  data_vencimento: string | null;
  data_pagamento: string | null;
  descricao: string;
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

  if (mes && ano) {
    // Relatório de um mês específico
    let { data: lancamentosData, error } = await supabase
      .from("lancamentos")
      .select("*")
      .eq("mes", mes)
      .eq("ano", ano)
      .order("data_vencimento", { ascending: true });

    if (error) {
      console.error("Erro ao buscar lançamentos:", error);
      lancamentosData = [];
    }
    lancamentos = lancamentosData || [];
    mesLabel = `${getMesNome(mes)} de ${ano}`;
  } else {
    // Relatório GERAL (todos os meses)
    let { data: lancamentosData, error } = await supabase
      .from("lancamentos")
      .select("*")
      .order("ano", { ascending: false })
      .order("mes", { ascending: false })
      .order("data_vencimento", { ascending: true });

    if (error) {
      console.error("Erro ao buscar lançamentos:", error);
      lancamentosData = [];
    }
    lancamentos = lancamentosData || [];
    mesLabel = "GERAL (Todos os meses)";
  }

  // Agrupa por categoria e calcula totais
  const porCategoria: Record<string, Lancamento[]> = {};
  let totalPago = 0;
  let totalAPagar = 0;
  let totalVencido = 0;

  (lancamentos || []).forEach((l: any) => {
    if (!porCategoria[l.categoria]) {
      porCategoria[l.categoria] = [];
    }
    porCategoria[l.categoria].push(l);

    // Calcula status e totais
    const status = determinarStatus(l.data_pagamento, l.data_vencimento);
    if (status === "pago") totalPago += l.valor;
    else if (status === "vencido") totalVencido += l.valor;
    else totalAPagar += l.valor;
  });

  // Gera PDF
  const doc = new PDFDocument({ margin: 40 });
  const chunks: Buffer[] = [];

  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  // Cabeçalho
  doc.fontSize(20).font("Helvetica-Bold").text("RELATÓRIO DE CONTAS");
  doc.fontSize(12)
    .font("Helvetica")
    .text(mesLabel, { align: "left", underline: true });

  doc.moveDown(1);

  // Resumo de totais
  doc.fontSize(11).font("Helvetica-Bold").text("RESUMO");
  doc.fontSize(10).font("Helvetica");
  doc.text(`✅ Pago: R$ ${totalPago.toFixed(2)}`);
  doc.text(`⏳ A Pagar: R$ ${totalAPagar.toFixed(2)}`);
  doc.text(`⚠️  Vencido: R$ ${totalVencido.toFixed(2)}`);
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
        const status = determinarStatus(
          item.data_pagamento,
          item.data_vencimento
        );
        const statusEmoji =
          status === "pago" ? "✅" : status === "vencido" ? "⚠️" : "⏳";

        x = 40;
        doc.text(statusEmoji, x, doc.y, { width: colunas.status });
        x += colunas.status;
        doc.text(item.descricao || item.categoria, x, doc.y - 12, {
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

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on("error", reject);
  });
}

function determinarStatus(
  dataPagamento: string | null,
  dataVencimento: string | null
): "pago" | "a_pagar" | "vencido" {
  if (dataPagamento) return "pago";
  if (dataVencimento) {
    const venc = new Date(dataVencimento);
    if (venc < new Date()) return "vencido";
    return "a_pagar";
  }
  return "a_pagar";
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
