import Anthropic from "@anthropic-ai/sdk";
import { ExtractedDocument } from "../types.js";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const EXTRACTION_SYSTEM = `Você é um assistente especializado em extração de dados financeiros para restaurantes brasileiros.
Analise o documento fornecido e retorne SOMENTE um JSON válido, sem markdown, sem explicações.

Schema obrigatório:
{
  "tipo_documento": "nota_fiscal" | "boleto" | "recibo" | "extrato" | "contrato" | "outro",
  "fornecedor": string | null,
  "cnpj_cpf": string | null,
  "descricao": string,
  "valor_total": number,
  "data_emissao": "YYYY-MM-DD" | null,
  "data_vencimento": "YYYY-MM-DD" | null,
  "categoria_sugerida": string | null,
  "tipo_lancamento": "receita" | "despesa",
  "confianca": "alta" | "media" | "baixa"
}

Regras:
- valor_total sempre em reais, número sem formatação (ex: 1500.90)
- tipo_lancamento: "despesa" para compras/boletos/NF de fornecedor; "receita" para fechamento de caixa/comprovante de venda
- confianca: "alta" se dados claramente visíveis; "media" se há ambiguidade; "baixa" se ilegível ou incompleto
- categoria_sugerida: use EXATAMENTE uma das categorias abaixo conforme o conteúdo do documento

Categorias de DESPESA disponíveis (use o nome exato):
  Custos variáveis: "Bovinos", "Suínos", "Aves", "Frutos do Mar", "FLV (Frutas, Legumes e Verduras)", "Laticínios e Frios", "Congelados", "Grãos / Cereais / Farinhas", "Óleos / Azeites / Gorduras", "Café e Infusões", "Condimentos / Temperos / Molhos", "Outros Ingredientes"
  Bebidas revendidas: "Cervejas", "Destilados", "Vinhos", "Bebidas Não Alcoólicas", "Água Mineral"
  Apoio: "Material de Limpeza e Higiene", "Embalagens e Descartáveis", "Gelo"
  Tarifas: "Tarifa Cartão de Crédito", "Tarifa Cartão de Débito", "Tarifa iFood", "Tarifa Pix"
  Impostos: "PIS", "COFINS", "ICMS", "Simples Nacional (DAS)", "ISS"
  Mão de obra eventual: "Mão de Obra Eventual / Freelancer"
  Ocupação: "Aluguel do Estabelecimento", "IPTU", "TCR / Taxa de Coleta", "Condomínio"
  Utilidades: "Conta de Luz", "Conta de Água e Esgoto", "Conta de Gás", "Telefone / Internet"
  Administrativas: "Sistema PDV / ERP / Gestão", "Contabilidade / Honorários", "Manutenção de Equipamentos", "Seguros", "Despesas com Veículos", "Alvará / Licenças / Taxas", "Outras Despesas Administrativas"
  Marketing: "Marketing Digital / Redes Sociais", "Patrocínios / Parcerias", "Material Gráfico / Impressos"
  Pessoal fixo: "Salários CLT", "Pró-Labore", "Encargos Trabalhistas (FGTS/INSS)", "Vale Transporte", "Vale Refeição / Alimentação", "Plano de Saúde"

Categorias de RECEITA disponíveis:
  "Vendas - Dinheiro", "Vendas - Pix", "Vendas - Cartão de Débito", "Vendas - Cartão de Crédito", "Vendas - iFood", "Vendas - Vale Refeição", "Serviços - Eventos", "Outras Receitas"

Se nenhuma categoria se encaixar, retorne null em categoria_sugerida.`;

function parseExtraction(raw: string): ExtractedDocument {
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
  const parsed = JSON.parse(cleaned);

  if (typeof parsed.valor_total !== "number") {
    throw new Error("valor_total inválido na extração");
  }
  if (!["receita", "despesa"].includes(parsed.tipo_lancamento)) {
    throw new Error("tipo_lancamento inválido");
  }

  return parsed as ExtractedDocument;
}

export async function extractFromImage(
  imageBuffer: Buffer,
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"
): Promise<ExtractedDocument> {
  const base64 = imageBuffer.toString("base64");

  const stream = await getClient().messages.stream({
    model: "claude-opus-5",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType, data: base64 },
          },
          { type: "text", text: "Extraia os dados financeiros deste documento." },
        ],
      },
    ],
  });

  const message = await stream.finalMessage();
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude não retornou bloco de texto");
  }

  return parseExtraction(textBlock.text);
}

export async function extractFromPDF(pdfBuffer: Buffer): Promise<ExtractedDocument> {
  const base64 = pdfBuffer.toString("base64");

  const stream = await getClient().messages.stream({
    model: "claude-opus-5",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          },
          { type: "text", text: "Extraia os dados financeiros deste documento PDF." },
        ],
      },
    ],
  });

  const message = await stream.finalMessage();
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude não retornou bloco de texto");
  }

  return parseExtraction(textBlock.text);
}

export async function extractFromText(text: string): Promise<ExtractedDocument> {
  const stream = await getClient().messages.stream({
    model: "claude-opus-5",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Extraia os dados financeiros da seguinte mensagem:\n\n${text}`,
      },
    ],
  });

  const message = await stream.finalMessage();
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude não retornou bloco de texto");
  }

  return parseExtraction(textBlock.text);
}
