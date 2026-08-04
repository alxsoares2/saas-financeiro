import OpenAI from "openai";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExtractedDocument, ExtracaoMultipla } from "../types.js";

const execAsync = promisify(exec);

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
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
- categoria_sugerida: OBRIGATÓRIA — NUNCA null. Use EXATAMENTE uma das categorias abaixo, sempre a mais próxima. Queijo/leite/manteiga → "Latícinios"; gasolina → "Despesas com veículos (comb., manut., IPVA, outros)". Na dúvida, escolha a mais próxima — nunca deixe em branco.

Categorias de DESPESA disponíveis (use o nome EXATO):
  CMV: "Bovinos", "Suínos", "Ovinos", "Aves", "Frutos do Mar", "Frutas, legumes e verduras FLV", "Doces industrializados", "Latícinios", "Congelados", "Grãos/Cereais/Farinha", "Óleos/Azeites/Gordura", "Café", "Conservas", "Condimentos/Temperos/Molhos", "Embalagens e Descartáveis", "Etiquetas"
  Bebidas: "Cervejas", "Destilados", "Vinhos", "Bebidas Não alcoólicas"
  Apoio: "Material de limpeza e higiene"
  Mão de obra eventual: "Mão de Obra Eventual / Freelancer"
  Tarifas: "Cartão de Crédito", "Cartão de Débito", "Ifood", "Pix"
  Impostos: "PIS", "COFINS", "FUNCEP", "FEEF", "Simples Nacional Consultoria", "ICMS bebida quente", "ICMS fronteira", "ICMS normal"
  Ocupação: "Aluguel do estabelecimento", "IPTU", "TCR", "Outros impostos e taxas"
  Utilidades: "Conta de Luz", "Conta de Água", "Telefone", "Conta de Gás"
  Administrativas: "Material de Escritório / informática", "Sistema Gerencial", "Internet", "Seguro", "Aluguel de maquinetas", "Aluguel de Equipamentos", "Despesas de Locomoção", "Assinaturas digitais/Apps/Softwares", "Sindicato", "Despesas com veículos (comb., manut., IPVA, outros)", "Outras despesas administrativas"
  Marketing: "Anúncios", "Criação de conteúdo/Influencers", "Divulgação"
  Manutenção: "Predial", "Reparos Máquinas e Equipamentos", "Preventiva"
  Aquisição: "Equipamentos", "Utensílios cozinha e salão"
  Serviços terceirizados: "Contabilidade", "Segurança", "Segurança eletrônica", "Transportadora", "Serviços gráficos", "Dedetização", "Advocacia", "Músicos/bandas", "Agência de Marketing", "Jardinagem/Paisagismo/Decoração", "Consultoria Gastronomia", "Assessoria Nutricional"
  Pessoal: "Salários", "Vale-Transporte", "Férias", "INSS", "FGTS", "Despesas com admissão e demissão", "Assistência médica", "Medicina do Trabalho", "Seguro de Vida", "13º salário", "Rescisões", "Extras", "Gratificação", "Contribuição sindical / assistencial", "Retenção IRPF", "Salário Família", "Bolsa Auxilio Estágio", "Cursos profissionalizantes", "Uniformes", "Ajuda de custo (Moradia)"
  Retirada de sócios: "Retirada de lucro de Sócios"
  Financeiras: "Despesas Bancárias", "IOF", "Empréstimos/Giro", "Juros"

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

async function callHaiku(messages: any[]): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1024,
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM },
      ...messages,
    ],
  } as any);
  const textContent = response.choices[0]?.message?.content;
  if (!textContent) throw new Error("OpenAI não retornou texto");
  return typeof textContent === "string" ? textContent : "";
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
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
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
      content: `[PDF Base64]\ndata:application/pdf;base64,${base64}\n\nExtraía os dados financeiros deste documento PDF.`,
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
Analise o documento e extraia EXATAMENTE as categorias abaixo (sem invenções).
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
      "quantidade": number | null,
      "unidade": string | null,
      "tipo_lancamento": "receita" | "despesa",
      "categoria_sugerida": string | null,
      "confianca": "alta" | "media" | "baixa"
    }
  ]
}

Regras:
- Use "comprovante" para pagamentos já realizados. Use "boleto" para contas ainda a pagar.
- Agrupe TUDO da mesma categoria em UM único item com valor somado.
- Ao agrupar vários produtos na mesma "descricao", separe cada um por vírgula e inclua a
  quantidade/unidade de CADA produto entre parênteses logo após o nome dele, lendo a coluna
  de quantidade do documento. Ex: "Queijo Mussarela Fat KG (1,076kg), Leite UHT CX 1L (2un)".
  Se não conseguir ler a quantidade de um produto específico, omita os parênteses só dele.
- valor sempre número sem formatação (ex: 1500.90)
- Atenção ao formato de data: DD/MM/AAAA (Ex: 01/08/2026 = 1º de agosto)

⛔ REGRA CRÍTICA — categoria_sugerida é OBRIGATÓRIA. NUNCA devolva null.
Use EXATAMENTE uma categoria da lista abaixo. Sem exceções, sem criatividade.

MAPEAMENTO DE CATEGORIAS REAIS DO CLIENTE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RECEITAS:
  "Vendas - Dinheiro", "Vendas - Pix", "Vendas - Cartão de Débito", "Vendas - Cartão de Crédito",
  "Vendas - iFood", "Vendas - Vale Refeição", "Serviços - Eventos", "Outras Receitas"

CMV (Custo da Mercadoria Vendida):
  "Bovinos", "Suínos", "Ovinos", "Aves", "Frutos do Mar", "Frutas, legumes e verduras FLV",
  "Doces industrializados", "Latícinios", "Congelados", "Grãos/Cereais/Farinha", "Óleos/Azeites/Gordura",
  "Café", "Conservas", "Condimentos/Temperos/Molhos", "Embalagens e Descartáveis", "Etiquetas"

BEBIDAS (Materiais de Venda Direta):
  "Cervejas", "Destilados", "Bebidas Não alcoólicas", "Vinhos"

MATERIAIS DE APOIO:
  "Material de limpeza e higiene"

MANO DE OBRA EVENTUAL:
  "Mão de Obra Eventual / Freelancer"

TARIFAS (Cartões/Delivery):
  "Cartão de Crédito", "Cartão de Débito", "Ifood", "Pix"

IMPOSTOS VARIÁVEIS:
  "PIS", "COFINS", "FUNCEP", "FEEF", "Simples Nacional Consultoria", "ICMS bebida quente", "ICMS fronteira", "ICMS normal"

OCUPAÇÃO:
  "Aluguel do estabelecimento", "IPTU", "TCR", "Outros impostos e taxas"

UTILIDADES PÚBLICAS:
  "Conta de Luz", "Conta de Água", "Telefone", "Conta de Gás"

DESPESAS ADMINISTRATIVAS (⭐ INTERNET VAI AQUI):
  "Material de Escritório / informática", "Sistema Gerencial", "Internet", "Seguro",
  "Aluguel de maquinetas", "Aluguel de Equipamentos", "Despesas de Locomoção",
  "Assinaturas digitais/Apps/Softwares", "Sindicato", "Despesas com veículos (comb., manut., IPVA, outros)",
  "Outras despesas administrativas"

MARKETING:
  "Anúncios", "Criação de conteúdo/Influencers", "Divulgação"

MANUTENÇÃO:
  "Predial", "Reparos Máquinas e Equipamentos", "Preventiva"

AQUISIÇÃO:
  "Equipamentos", "Utensílios cozinha e salão"

SERVIÇOS TERCEIRIZADOS:
  "Contabilidade", "Segurança", "Segurança eletrônica", "Transportadora", "Serviços gráficos",
  "Dedetização", "Advocacia", "Músicos/bandas", "Agência de Marketing", "Jardinagem/Paisagismo/Decoração",
  "Consultoria Gastronomia", "Assessoria Nutricional"

PESSOAL (Mão de Obra Fixa):
  "Salários", "Vale-Transporte", "Férias", "INSS", "FGTS", "Despesas com admissão e demissão",
  "Assistência médica", "Medicina do Trabalho", "Seguro de Vida", "13º salário", "Rescisões", "Extras",
  "Gratificação", "Contribuição sindical / assistencial", "Retenção IRPF", "Salário Família",
  "Bolsa Auxilio Estágio", "Cursos profissionalizantes", "Uniformes", "Ajuda de custo (Moradia)"

RETIRADA DE SÓCIOS:
  "Retirada de lucro de Sócios"

FINANCEIRAS:
  "Despesas Bancárias", "IOF", "Empréstimos/Giro", "Juros"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EXEMPLOS DE MAPEAMENTO (estude bem):
  • "Brisanet", "Vivo", "Claro", "provedor", "banda larga", "internet" → "Internet" (ADMINISTRATIVAS, NÃO UTILIDADES)
  • "Copasa", "Sabesp", "conta de água" → "Conta de Água" (UTILIDADES)
  • "CEMIG", "Neon", "Light", "conta de luz", "energia" → "Conta de Luz" (UTILIDADES)
  • "queijo", "manteiga", "leite" → "Latícinios" (CMV)
  • "carne", "boi", "alcatra" → "Bovinos" (CMV)
  • "frango", "peito", "coxa" → "Aves" (CMV)`;

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

async function callHaikuMulti(messages: any[]): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 2048,
    messages: [
      { role: "system", content: EXTRACTION_MULTI_SYSTEM },
      ...messages,
    ],
  } as any);
  const textContent = response.choices[0]?.message?.content;
  if (!textContent) throw new Error("OpenAI não retornou texto");
  return typeof textContent === "string" ? textContent : "";
}

// GPT-4o Mini para imagens
async function callSonnetMulti(messages: any[]): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 2048,
    messages: [
      { role: "system", content: EXTRACTION_MULTI_SYSTEM },
      ...messages,
    ],
  } as any);
  const textContent = response.choices[0]?.message?.content;
  if (!textContent) throw new Error("OpenAI não retornou texto");
  return typeof textContent === "string" ? textContent : "";
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
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
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

  const response = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1024,
    messages: [
      { role: "system", content: ANALISE_SYSTEM },
      { role: "user", content: prompt },
    ],
  } as any);
  const textContent = response.choices[0]?.message?.content;
  if (!textContent) throw new Error("OpenAI não retornou análise");
  return typeof textContent === "string" ? textContent : "";
}

export async function extractMultiFromPDF(pdfBuffer: Buffer): Promise<ExtracaoMultipla | null> {
  const sizeKB = Math.round(pdfBuffer.length / 1024);
  console.log(`[Poppler] Iniciando conversão de PDF → PNG (${sizeKB}KB)`);

  const tmpDir = tmpdir();
  const pdfPath = join(tmpDir, `doc-${Date.now()}.pdf`);
  const pngPath = join(tmpDir, `doc-${Date.now()}`);

  try {
    // Escreve PDF em arquivo temporário
    writeFileSync(pdfPath, pdfBuffer);

    // Converte primeira página do PDF pra PNG usando pdftoppm (Poppler)
    // pdftoppm entrada.pdf saida (gera saida-1.png, saida-2.png, etc.)
    // -f 1 -l 1 = apenas primeira página; -png = formato PNG
    await execAsync(`pdftoppm -f 1 -l 1 -png "${pdfPath}" "${pngPath}"`);

    // Lê imagem convertida (pdftoppm gera arquivo com sufixo -1.png)
    const convertedPath = `${pngPath}-1.png`;
    const pngBuffer = readFileSync(convertedPath);
    console.log(`[Poppler] PDF convertido para PNG (${Math.round(pngBuffer.length / 1024)}KB)`);

    // Processa como imagem normal
    const result = await extractMultiFromImage(pngBuffer, "image/png", "Documento extraído de PDF");

    // Limpa arquivos temporários
    unlinkSync(pdfPath);
    unlinkSync(convertedPath);

    return result;
  } catch (err) {
    console.error(`[Poppler] Erro ao converter PDF:`, err);
    // Tenta limpar arquivos mesmo com erro
    try {
      unlinkSync(pdfPath);
      unlinkSync(`${pngPath}-1.png`);
    } catch {}
    return null;
  }
}
