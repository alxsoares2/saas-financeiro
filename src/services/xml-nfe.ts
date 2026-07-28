import { parseStringPromise } from "xml2js";
import { ExtractedDocument } from "../types.js";

// Extrai os dados relevantes de um XML de NF-e (modelo 55)
export async function extractFromNFeXml(xml: string): Promise<ExtractedDocument> {
  const parsed = await parseStringPromise(xml, { explicitArray: false });

  // NF-e pode ter raiz nfeProc (com protocolo) ou NFeProc ou direto em NFe
  const nfe =
    parsed?.nfeProc?.NFe ??
    parsed?.NFeProc?.NFe ??
    parsed?.NFe;

  if (!nfe) throw new Error("XML não parece ser uma NF-e válida");

  const infNFe = nfe.infNFe;
  const emit = infNFe?.emit;
  const ide = infNFe?.ide;
  const total = infNFe?.total?.ICMSTot;
  const cobr = infNFe?.cobr;

  const cnpjEmitente = emit?.CNPJ ?? emit?.CPF ?? undefined;
  const nomeEmitente = emit?.xNome ?? undefined;

  const valorTotal = parseFloat(total?.vNF ?? "0");

  // Data de emissão: YYYY-MM-DDTHH:MM:SS → pega só YYYY-MM-DD
  const dhEmi: string | undefined = ide?.dhEmi ?? ide?.dEmi;
  const dataEmissao = dhEmi ? dhEmi.substring(0, 10) : undefined;

  // Data de vencimento: pode estar em cobr.dup.dVenc (array de duplicatas)
  let dataVencimento: string | undefined;
  if (cobr?.dup) {
    const dups = Array.isArray(cobr.dup) ? cobr.dup : [cobr.dup];
    // Pega a vencimento da primeira duplicata
    dataVencimento = dups[0]?.dVenc;
  }

  // Descrição: usa xPed (pedido) ou monta com número + série
  const nNF = ide?.nNF ?? "";
  const serie = ide?.serie ?? "";
  const descricao = `NF-e ${serie}/${nNF}${nomeEmitente ? ` — ${nomeEmitente}` : ""}`;

  return {
    tipo_documento: "nota_fiscal",
    fornecedor: nomeEmitente,
    cnpj_cpf: cnpjEmitente,
    descricao,
    valor_total: valorTotal,
    data_emissao: dataEmissao,
    data_vencimento: dataVencimento,
    categoria_sugerida: "CMV / Matéria-Prima",
    tipo_lancamento: "despesa",
    confianca: "alta",
  };
}
