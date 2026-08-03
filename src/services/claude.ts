import Anthropic from "@anthropic-ai/sdk";
import { ExtractedDocument, ExtracaoMultipla } from "../types.js";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const EXTRACTION_SYSTEM = `Você é um assistente especializado em extração de dados financeiros para restaurantes brasileiros.
Analise o documento fornecido e retorne SOMENTE um JSON válido, sem markdown, sem explicações.

Schema obrigatório:
{
  "tipo_documento": "nota_fiscal" | "boleto" | "comprovante" | "recibo" | "extrato" | "contrato" | "outro",
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
- Se a mensagem NÃO contiver nenhum dado financeiro (saudações, conversas casuais, perguntas sem valor monetário), retorne SOMENTE: {"skip": true}
- tipo_documento: use "comprovante" para comprovantes de pagamento já realizados (PIX enviado, transferência concluída, recibo de quitação). Use "boleto" para contas a pagar ainda não pagas.
- valor_total sempre em reais, número sem formatação (ex: 1500.90)
- tipo_lancamento: "despesa" para compras/boletos/NF de fornecedor; "receita" para fechamento de caixa/comprovante de venda
- confianca: "alta" se dados claramente visíveis; "media" se há ambiguidade; "baixa" se ilegível ou incompleto
- categoria_sugerida: OBRIGATÓRIA — NUNCA null. Use EXATAMENTE uma das categorias abaixo, sempre a mais próxima. Queijo/leite/manteiga → "Laticínios e Frios"; gasolina → "Despesas com Veículos". Na dúvida, escolha a mais próxima — nunca deixe em branco.

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

function parseExtraction(raw: string): ExtractedDocument | null {
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
  const parsed = JSON.parse(cleaned);

  if (parsed.skip === true) return null;

  if (typeof parsed.valor_total !== "number") {
    throw new Error("valor_total inválido na extração");
  }
  if (!["receita", "despesa"].includes(parsed.tipo_lancamento)) {
    throw new Error("tipo_lancamento inválido");
  }

  return parsed as ExtractedDocument;
}

async function callHaiku(messages: Anthropic.MessageParam[]): Promise<string> {
  const response = await getClient().messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: EXTRACTION_SYSTEM,
    messages,
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("Claude não retornou texto");
  return textBlock.text;
}

export async function extractFromImage(
  imageBuffer: Buffer,
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif",
  caption?: string
): Promise<ExtractedDocument | null> {
  const base64 = imageBuffer.toString("base64");
  const contexto = caption
    ? `Contexto fornecido pelo usuário: "${caption}". Use esse contexto para interpretar o documento.`
    : "Extraia os dados financeiros deste documento.";
  const text = await callHaiku([
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
        { type: "text", text: contexto },
      ],
    },
  ]);
  return parseExtraction(text);
}

export async function extractFromPDF(pdfBuffer: Buffer): Promise<ExtractedDocument | null> {
  const base64 = pdfBuffer.toString("base64");
  const text = await callHaiku([
    {
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
        { type: "text", text: "Extraia os dados financeiros deste documento PDF." },
      ],
    },
  ]);
  return parseExtraction(text);
}

export async function extractFromText(text: string): Promise<ExtractedDocument | null> {
  const raw = await callHaiku([
    { role: "user", content: `Extraia os dados financeiros da seguinte mensagem:\n\n${text}` },
  ]);
  return parseExtraction(raw);
}

// ── Extração multi-item (imagens e PDFs de notas com vários produtos) ─────────

const EXTRACTION_MULTI_SYSTEM = `Você é especializado em leitura de documentos financeiros para restaurantes brasileiros.
Analise o documento e agrupe os itens por CATEGORIA DO DRE.
Retorne SOMENTE JSON válido, sem markdown, sem explicações.

IMPORTANTE: Recibos, faturas, comprovantes de pagamento, extratos, boletos e notas são SEMPRE documentos financeiros. Não pule.
Se o documento tiver um valor (R$), total, data ou dados de pagamento, é financeiro.
Só retorne {"skip": true} se for saudação, conversa casual ou pergunta sem dados numéricos.

Se não for documento financeiro, retorne: {"skip": true}

Schema quando for documento financeiro:
{
  "tipo_documento": "nota_fiscal" | "boleto" | "comprovante" | "recibo" | "extrato" | "outro",
  "fornecedor": string | null,
  "cnpj_cpf": string | null,
  "data_emissao": "YYYY-MM-DD" | null,
  "data_vencimento": "YYYY-MM-DD" | null,
  "valor_total_documento": number | null,
  "itens": [
    {
      "descricao": string,
      "valor": number,
      "quantidade": number | null,  // ex: 10 (kg, un, litros)
      "unidade": string | null,     // ex: "kg", "un", "l"
      "tipo_lancamento": "receita" | "despesa",
      "categoria_sugerida": string | null,
      "confianca": "alta" | "media" | "baixa"
    }
  ]
}

Regras de agrupamento:
- Use "comprovante" para pagamentos já realizados (PIX enviado, transferência concluída). Use "boleto" para contas ainda a pagar.
- Agrupe TUDO da mesma categoria DRE em UM único item com o valor somado. Exemplo: 20x Coca-Cola + 1x Powerade = 1 item "Bebidas Não Alcoólicas" com a soma dos dois. NUNCA crie dois itens para a mesma categoria.
- Não liste produto por produto — agrupe pela categoria DRE
- Para documentos com item único (boleto de água, conta de luz), use array com 1 item
- valor sempre número sem formatação (ex: 1500.90)
- valor_total_documento: valor total final mostrado no documento (campo "Total", "Total a Pagar", "Valor Total"). Se não visível, null. A SOMA dos itens deve ser igual a esse total — se não bater, revise os valores dos itens.
- Atenção ao formato de data em cupons térmicos brasileiros: o formato é DD/MM/AAAA. Exemplo: 01/08/2026 = dia 01 de agosto de 2026.
- QUANTIDADE E UNIDADE (importante para rastreamento de variação de preço):
  * Se o documento mostrar quantidade explícita (ex: "10kg", "5 unidades", "2L"), EXTRAIA:
    - quantidade: número (ex: 10, 5, 2)
    - unidade: texto (ex: "kg", "un", "l")
  * Exemplo: "Tomate 10kg R$ 100" → quantidade: 10, unidade: "kg", valor: 100
  * Se não houver quantidade, deixe ambos null
  * Quando agrupa por categoria (ex: 10kg + 5kg de legumes diferentes), SOME as quantidades:
    - Exemplo: "10kg alface + 5kg tomate" → quantidade: 15, unidade: "kg" (mesmo grupo FLV)

ATENÇÃO — iFood Pago vs Tarifa iFood:
- "iFood Pago" / "IFOOD PAGO IP" é uma conta digital (banco) que restaurantes usam para fazer PIX e transferências. NÃO é taxa de plataforma.
- "Tarifa iFood" só se aplica quando o documento é uma fatura/boleto de comissão cobrada pelo iFood pelo uso do app de delivery.
- Se o comprovante mostra PIX enviado de uma conta iFood Pago para uma PESSOA ou EMPRESA TERCEIRA (campo Destino/Favorecido com nome diferente do iFood), classifique conforme o destinatário e o contexto — pode ser salário, fornecedor, aluguel, etc. Não use "Tarifa iFood" nesses casos.

⛔ REGRA CRÍTICA — categoria_sugerida é OBRIGATÓRIA em TODO item. NUNCA devolva null.
Todo produto de restaurante tem uma categoria. Sempre escolha a MAIS PRÓXIMA da lista abaixo.
Se estiver em dúvida entre duas, escolha uma — nunca deixe em branco.
Se realmente não encaixar em nenhuma específica, use "Outros Ingredientes" (comida/insumo),
"Bebidas Não Alcoólicas" (bebida) ou "Outras Despesas Administrativas" (não-alimentar).
Exemplos de itens que SEMPRE têm categoria (não erre estes):
  - queijo, muçarela, leite, manteiga, requeijão, iogurte, presunto → "Laticínios e Frios"
  - carne, boi, alcatra, patinho, acém → "Bovinos"
  - frango, coxa, peito, asa → "Aves"
  - tomate, cebola, alface, batata → "FLV (Frutas, Legumes e Verduras)"
  - gasolina, combustível, diesel → "Despesas com Veículos"
  - refrigerante, coca, guaraná, suco → "Bebidas Não Alcoólicas"

Categorias disponíveis (use o nome exato):
  CMV: "Bovinos", "Suínos", "Aves", "Frutos do Mar", "FLV (Frutas, Legumes e Verduras)",
       "Laticínios e Frios" (INCLUI: leite, queijo, manteiga, iogurte, requeijão, cream cheese, frios, presunto, mortadela),
       "Congelados", "Grãos / Cereais / Farinhas", "Óleos / Azeites / Gorduras", "Café e Infusões", "Condimentos / Temperos / Molhos", "Outros Ingredientes"
  Bebidas: "Cervejas", "Destilados", "Vinhos", "Bebidas Não Alcoólicas", "Água Mineral"
  Apoio: "Material de Limpeza e Higiene", "Embalagens e Descartáveis", "Gelo"
  Tarifas: "Tarifa Cartão de Crédito", "Tarifa Cartão de Débito", "Tarifa iFood", "Tarifa Pix"
  Impostos: "PIS", "COFINS", "ICMS", "Simples Nacional (DAS)", "ISS"
  Mão de obra eventual: "Mão de Obra Eventual / Freelancer"
  Ocupação: "Aluguel do Estabelecimento", "IPTU", "TCR / Taxa de Coleta", "Condomínio"
  Utilidades: "Conta de Luz", "Conta de Água e Esgoto", "Conta de Gás", "Telefone / Internet"
  Administrativas: "Sistema PDV / ERP / Gestão", "Contabilidade / Honorários", "Manutenção de Equipamentos", "Seguros", "Despesas com Veículos", "Alvará / Licenças / Taxas", "Outras Despesas Administrativas"
  Marketing: "Marketing Digital / Redes Sociais", "Patrocínios / Parcerias", "Material Gráfico / Impressos"
  Pessoal fixo: "Salários CLT", "Pró-Labore", "Encargos Trabalhistas (FGTS/INSS)", "Vale Transporte", "Vale Refeição / Alimentação", "Plano de Saúde"
  Receitas: "Vendas - Dinheiro", "Vendas - Pix", "Vendas - Cartão de Débito", "Vendas - Cartão de Crédito", "Vendas - iFood", "Vendas - Vale Refeição", "Serviços - Eventos", "Outras Receitas"`;

function parseMulti(raw: string): ExtracaoMultipla | null {
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
    const parsed = JSON.parse(cleaned);
    if (parsed.skip === true) {
      console.log("[Claude] Documento pulado (skip: true)");
      return null;
    }
    if (!Array.isArray(parsed.itens) || parsed.itens.length === 0) {
      console.log("[Claude] Nenhum item encontrado ou itens vazio", { itens: parsed.itens });
      return null;
    }
    return parsed as ExtracaoMultipla;
  } catch (err) {
    console.error("[Claude] Erro ao parsear extração:", err, "Raw:", raw.substring(0, 200));
    return null;
  }
}

async function callHaikuMulti(messages: Anthropic.MessageParam[]): Promise<string> {
  const response = await getClient().messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 2048,
    system: EXTRACTION_MULTI_SYSTEM,
    messages,
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("Claude não retornou texto");
  return textBlock.text;
}

// Sonnet para imagens — visão superior a Haiku em cupons térmicos e documentos complexos
async function callSonnetMulti(messages: Anthropic.MessageParam[]): Promise<string> {
  const response = await getClient().messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: EXTRACTION_MULTI_SYSTEM,
    messages,
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("Claude não retornou texto");
  return textBlock.text;
}

export async function extractMultiFromImage(
  imageBuffer: Buffer,
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif",
  caption?: string
): Promise<ExtracaoMultipla | null> {
  const base64 = imageBuffer.toString("base64");
  const contexto = caption
    ? `O usuário identificou este documento como: "${caption}". Use ESSA informação para determinar a categoria — ela tem prioridade sobre o nome da instituição ou banco que aparece no documento. O usuário sabe melhor do que ninguém o que a despesa representa. Extraia valor, data e fornecedor do documento, mas classifique conforme a legenda.`
    : "Agrupe os itens do documento por categoria DRE.";
  const raw = await callSonnetMulti([
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
        { type: "text", text: contexto },
      ],
    },
  ]);
  return parseMulti(raw);
}

// ── Análise financeira consultiva ─────────────────────────────────────────────

const ANALISE_SYSTEM = `Você é um consultor financeiro especializado em restaurantes brasileiros.
Analise os dados do DRE comparando o mês atual com o mês anterior e dê uma análise prática e direta.
Escreva em português informal, como se fosse uma mensagem de WhatsApp de um consultor para o dono do restaurante.
Use emojis com moderação. Seja objetivo e acionável.
Máximo 400 palavras. Não use tabelas — só texto corrido e listas com bullet points.`;

export async function gerarAnalise(atual: string, anterior: string): Promise<string> {
  const prompt = `Compare os dois meses e faça uma análise consultiva completa.

DADOS DO MÊS ATUAL:
${atual}

DADOS DO MÊS ANTERIOR:
${anterior}

Analise:
1. O que subiu de preço (insumos, utilidades, pessoal) — indique % de variação
2. O que preocupa (categorias fora do padrão, margens apertadas)
3. O que melhorou
4. 2-3 ações práticas que o dono pode tomar agora`;

  const response = await getClient().messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: ANALISE_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("Claude não retornou análise");
  return block.text;
}

export async function extractMultiFromPDF(pdfBuffer: Buffer): Promise<ExtracaoMultipla | null> {
  const base64 = pdfBuffer.toString("base64");
  const sizeKB = Math.round(base64.length / 1024);
  console.log(`[Claude] Iniciando extração de PDF (${sizeKB}KB) com Sonnet`);

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout na extração de PDF (> 60s)")), 60000)
    );

    const extractionPromise = callSonnetMulti([
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: "Agrupe os itens do documento por categoria DRE. Se não conseguir estruturar, retorne os dados legíveis em um formato aproximado." },
        ],
      },
    ]);

    const raw = await Promise.race([extractionPromise, timeoutPromise]);
    console.log(`[Claude] Extração de PDF concluída`);
    return parseMulti(raw);
  } catch (err) {
    console.error(`[Claude] Erro ao extrair PDF:`, err);
    return null;
  }
}
