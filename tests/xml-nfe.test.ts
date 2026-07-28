import { extractFromNFeXml } from "../src/services/xml-nfe";

const NF_XML_MINIMA = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe>
      <ide>
        <nNF>12345</nNF>
        <serie>1</serie>
        <dhEmi>2024-07-15T10:30:00-03:00</dhEmi>
      </ide>
      <emit>
        <CNPJ>12345678000195</CNPJ>
        <xNome>Fornecedor Exemplo LTDA</xNome>
      </emit>
      <total>
        <ICMSTot>
          <vNF>1500.90</vNF>
        </ICMSTot>
      </total>
      <cobr>
        <dup>
          <dVenc>2024-08-15</dVenc>
        </dup>
      </cobr>
    </infNFe>
  </NFe>
</nfeProc>`;

describe("extractFromNFeXml", () => {
  it("extrai valor total corretamente", async () => {
    const result = await extractFromNFeXml(NF_XML_MINIMA);
    expect(result.valor_total).toBe(1500.90);
  });

  it("extrai data de emissão no formato YYYY-MM-DD", async () => {
    const result = await extractFromNFeXml(NF_XML_MINIMA);
    expect(result.data_emissao).toBe("2024-07-15");
  });

  it("extrai CNPJ do emitente", async () => {
    const result = await extractFromNFeXml(NF_XML_MINIMA);
    expect(result.cnpj_cpf).toBe("12345678000195");
  });

  it("extrai nome do fornecedor", async () => {
    const result = await extractFromNFeXml(NF_XML_MINIMA);
    expect(result.fornecedor).toBe("Fornecedor Exemplo LTDA");
  });

  it("extrai data de vencimento da duplicata", async () => {
    const result = await extractFromNFeXml(NF_XML_MINIMA);
    expect(result.data_vencimento).toBe("2024-08-15");
  });

  it("classifica como despesa com confiança alta", async () => {
    const result = await extractFromNFeXml(NF_XML_MINIMA);
    expect(result.tipo_lancamento).toBe("despesa");
    expect(result.confianca).toBe("alta");
    expect(result.tipo_documento).toBe("nota_fiscal");
  });

  it("inclui número e série na descrição", async () => {
    const result = await extractFromNFeXml(NF_XML_MINIMA);
    expect(result.descricao).toContain("12345");
    expect(result.descricao).toContain("Fornecedor Exemplo LTDA");
  });

  it("lança erro para XML inválido", async () => {
    await expect(extractFromNFeXml("<root>não é nfe</root>")).rejects.toThrow(
      "XML não parece ser uma NF-e válida"
    );
  });
});
