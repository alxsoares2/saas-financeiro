import PDFDocument from "pdfkit";
import { createClient } from "@supabase/supabase-js";
import { Readable } from "stream";

let supabase: any = null;

function getSupabase() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    console.log("[relatorio] Iniciando Supabase client:");
    console.log(`  SUPABASE_URL: ${url ? "OK" : "MISSING"}`);
    console.log(`  SUPABASE_SERVICE_ROLE_KEY: ${key ? "OK" : "MISSING"}`);

    if (!url) {
      throw new Error("SUPABASE_URL não está configurado no .env");
    }
    if (!key) {
      throw new Error(
        "SUPABASE_SERVICE_ROLE_KEY não está configurado no .env (deve ser o mesmo do .env.example)"
      );
    }

    supabase = createClient(url, key, { db: { schema: "financeiro" } });
    console.log("[relatorio] Cliente Supabase criado com sucesso");
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
    console.log("[relatorio] Query: SELECT id, nome FROM categorias");
    const result = await sb
      .from("categorias")
      .select("id, nome");

    console.log("[relatorio] Response recebido, error:", result.error?.message || "nenhum erro");

    if (result.error) {
      console.error("[relatorio] Erro ao buscar categorias:", result.error);
      console.log("[relatorio] Continuando sem categorias...");
    } else {
      categorias = result.data || [];
      console.log(`[relatorio] Encontradas ${categorias.length} categorias`);
      if (categorias.length > 0) {
        console.log("[relatorio] Primeira categoria:", JSON.stringify(categorias[0]));
      }
    }
  } catch (err) {
    console.error("[relatorio] Exceção ao buscar categorias:", err);
    throw err;
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

  // Calcula totais e ordena por data (mais antiga para mais nova)
  console.log("[relatorio] Calculando totais e ordenando...");
  let totalPago = 0;
  let totalAPagar = 0;
  let totalVencido = 0;

  try {
    (lancamentos || []).forEach((l: any) => {
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

    // Ordena por data (mais antiga para mais nova)
    lancamentos.sort((a: any, b: any) => {
      const dataA = new Date(a.data_emissao || a.data_vencimento || "");
      const dataB = new Date(b.data_emissao || b.data_vencimento || "");
      return dataA.getTime() - dataB.getTime();
    });

    console.log(`[relatorio] Totais calculados: Pago=${totalPago} APagar=${totalAPagar} Vencido=${totalVencido}`);
  } catch (err) {
    console.error("[relatorio] Erro ao calcular totais:", err);
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
  doc.fontSize(14).font("Helvetica-Bold").text("RESUMO", 50);
  doc.fontSize(11).font("Helvetica");
  doc.text(`Pago: R$ ${totalPago.toFixed(2)}`, 50);
  doc.text(`A Pagar: R$ ${totalAPagar.toFixed(2)}`, 50);
  doc.text(`Vencido: R$ ${totalVencido.toFixed(2)}`, 50);
  doc.moveDown(0.3);
  doc.fontSize(12).font("Helvetica-Bold").text(
    `TOTAL: R$ ${(totalPago + totalAPagar + totalVencido).toFixed(2)}`,
    { underline: true }
  );

  doc.moveDown(1);

  // Tabela de lançamentos com formato monospace
  doc.fontSize(11).font("Helvetica-Bold").text("LANÇAMENTOS");
  doc.moveDown(0.3);

  // Cabeçalho e dados em formato monospace
  doc.fontSize(9).font("Courier");
  doc.text("Data        Categoria                Valor         Situação");
  doc.fontSize(8);
  doc.text("─────────────────────────────────────────────────────────────");
  doc.moveDown(0.2);

  // Linhas de dados
  lancamentos.forEach((item: any) => {
    let situacao = "?";

    if (item.status === "pago" || item.status === "pago_parcialmente") {
      situacao = item.status === "pago" ? "Pago" : "P.Parcial";
    } else if (item.status === "pendente") {
      if (item.data_vencimento && new Date(item.data_vencimento) < new Date()) {
        situacao = "Vencido";
      } else {
        situacao = "A Pagar";
      }
    }

    const data = item.data_emissao ? formatarData(item.data_emissao) : "—";
    const categoria = (item.categoria || "—").substring(0, 20).padEnd(20);
    const valor = `R$ ${Number(item.valor).toFixed(2)}`.padStart(13);

    const linha = `${data}  ${categoria}  ${valor}  ${situacao}`;
    doc.text(linha);
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
