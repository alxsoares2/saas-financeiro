import OpenAI from "openai";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExtractedDocument, ExtracaoMultipla, ItemExtraido } from "../types.js";

const execAsync = promisify(exec);

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      // Sem timeout explícito, uma instabilidade na API da OpenAI deixava a
      // chamada pendurada indefinidamente — o usuário ficava travado no
      // "Analisando documento..." pra sempre, sem erro e sem resposta.
      // Com o timeout, isso agora estoura uma exceção (capturada pelo
      // try/catch do webhook) em vez de travar a conversa pra sempre.
      timeout: 45_000,
      maxRetries: 2,
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
  "subcategoria": string | null,
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
- subcategoria: normalmente null. Preencha SÓ quando o item comprado for um destes 5 produtos
  rastreados (o cliente acompanha eles individualmente): "Filé de Peito" (categoria_sugerida =
  "Aves"), "Filé Mignon" (categoria_sugerida = "Bovinos"), "Queijo Mussarela" (categoria_sugerida =
  "Latícinios"), "Camarão" (categoria_sugerida = "Frutos do Mar"), "Óleo" (categoria_sugerida =
  "Óleos/Azeites/Gordura"). Use exatamente esses nomes de subcategoria.

Categorias de DESPESA disponíveis (use o nome EXATO):
  CMV: "Bovinos", "Suínos", "Ovinos", "Aves", "Ovos", "Frutos do Mar", "Frutas, legumes e verduras FLV", "Doces industrializados", "Latícinios", "Congelados", "Grãos/Cereais/Farinha", "Óleos/Azeites/Gordura", "Café", "Conservas", "Condimentos/Temperos/Molhos", "Embalagens e Descartáveis", "Etiquetas"
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

// Lista de categorias reais do cliente, compartilhada entre o prompt antigo
// (EXTRACTION_MULTI_SYSTEM, mantido como fallback) e o novo estágio de
// classificação (CLASSIFICACAO_SYSTEM) do pipeline em duas etapas.
const LISTA_CATEGORIAS = `⛔ REGRA CRÍTICA — categoria_sugerida é OBRIGATÓRIA. NUNCA devolva null.
Use EXATAMENTE uma categoria da lista abaixo. Sem exceções, sem criatividade.
Não saber qual categoria usar NUNCA muda o tipo_lancamento — se é claramente o restaurante
comprando algo (mesmo sem achar a categoria perfeita), continua sendo "despesa" e você escolhe a
categoria de despesa mais próxima da lista. Nunca "resolva" a incerteza de categoria jogando o
item pra uma categoria de receita.

MAPEAMENTO DE CATEGORIAS REAIS DO CLIENTE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RECEITAS:
  "Vendas - Dinheiro", "Vendas - Pix", "Vendas - Cartão de Débito", "Vendas - Cartão de Crédito",
  "Vendas - iFood", "Vendas - Vale Refeição", "Serviços - Eventos", "Outras Receitas"

CMV (Custo da Mercadoria Vendida):
  "Bovinos", "Suínos", "Ovinos", "Aves", "Ovos", "Frutos do Mar", "Frutas, legumes e verduras FLV",
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

// Regra dos 5 produtos rastreados individualmente (reaproveitada nos dois
// prompts que precisam categorizar produto por produto).
const REGRA_SUBCATEGORIAS = `⛔ PRODUTOS RASTREADOS INDIVIDUALMENTE — nunca ficam agrupados com outros produtos
da mesma categoria, sempre viram item próprio:
  • "Filé de Peito"    → categoria_sugerida "Aves",                    subcategoria "Filé de Peito"
  • "Filé Mignon"      → categoria_sugerida "Bovinos",                 subcategoria "Filé Mignon"
  • "Queijo Mussarela" → categoria_sugerida "Latícinios",              subcategoria "Queijo Mussarela"
  • "Camarão"          → categoria_sugerida "Frutos do Mar",           subcategoria "Camarão"
  • "Óleo"             → categoria_sugerida "Óleos/Azeites/Gordura",   subcategoria "Óleo"
Para qualquer outro produto, subcategoria fica null.`;

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
      "subcategoria": string | null,
      "confianca": "alta" | "media" | "baixa"
    }
  ]
}

Regras:
- Use "comprovante" para pagamentos já realizados. Use "boleto" para contas ainda a pagar.
- tipo_lancamento: "despesa" quando o restaurante está PAGANDO (comprando insumos, embalagens,
  equipamentos, serviços, mercadoria de fornecedor) — mesmo que o pagamento tenha sido via PIX ou
  cartão. "receita" SÓ quando é dinheiro que o restaurante está RECEBENDO (venda pro cliente,
  fechamento de caixa). PIX/cartão são só formas de pagamento e NÃO indicam direção do dinheiro —
  olhe o CONTEXTO (quem comprou o quê de quem). Cupons de "conferência de produtos" ou notas com
  colunas de PRODUTO/QTDE/PREÇO listando insumos, embalagens, sacos, potes etc. são SEMPRE despesa
  (o restaurante comprando), mesmo que mencionem PIX como pagamento.
- Classifique CADA produto individualmente na categoria certa ANTES de agrupar. Só depois
  disso, agrupe em um único item os produtos que ficaram com a MESMA categoria — NUNCA agrupe
  produtos de categorias diferentes só porque vieram na mesma nota. Uma nota de supermercado
  normalmente gera VÁRIOS itens (um por categoria), não um só. Exemplo do que NÃO fazer: numa
  nota com alface, coca-cola, ovos, queijo e presunto, NÃO coloque tudo em "Frutas, legumes e
  verduras FLV" — alface/manjericão/pimentão vão em FLV, coca-cola vai em "Bebidas Não
  alcoólicas", queijo/presunto vão em "Latícinios", e assim por diante, cada grupo com seu
  próprio item na lista "itens".
- Ao agrupar vários produtos na mesma "descricao", separe cada um por vírgula e inclua a
  quantidade/unidade de CADA produto entre parênteses logo após o nome dele, lendo a coluna
  de quantidade do documento. Ex: "Queijo Mussarela Fat KG (1,076kg), Leite UHT CX 1L (2un)".
  Se não conseguir ler a quantidade de um produto específico, omita os parênteses só dele.
- ⛔ EXCEÇÃO AO AGRUPAMENTO — produtos rastreados individualmente: se um produto da nota for um
  destes 5, ele NUNCA entra no grupo/descrição de outros produtos — vira SEMPRE seu próprio item
  separado na lista "itens", com "quantidade"/"unidade" exatos dele (não somados com mais nada):
    • "Filé de Peito"    → categoria_sugerida "Aves",                    subcategoria "Filé de Peito"
    • "Filé Mignon"      → categoria_sugerida "Bovinos",                 subcategoria "Filé Mignon"
    • "Queijo Mussarela" → categoria_sugerida "Latícinios",              subcategoria "Queijo Mussarela"
    • "Camarão"          → categoria_sugerida "Frutos do Mar",           subcategoria "Camarão"
    • "Óleo"             → categoria_sugerida "Óleos/Azeites/Gordura",   subcategoria "Óleo"
  Todo o resto da mesma categoria continua agrupado normalmente entre si (ex: coxa e asa de
  frango seguem juntas em "Aves", só o Filé de Peito sai pra linha própria). Para qualquer item
  que NÃO seja um desses 5, subcategoria fica null.
- valor sempre número sem formatação (ex: 1500.90)
- ⚠️ CUPONS FISCAIS (NFC-e) têm normalmente 3 números por linha de produto: QTD/UN, VALOR
  UNITÁRIO (R$ por kg/un/litro) e VALOR DO ITEM (o já multiplicado pela quantidade — é esse
  último que é o valor REALMENTE pago por aquele item). Use SEMPRE o VALOR DO ITEM como "valor",
  NUNCA o valor unitário. Isso é CRÍTICO em produtos pesados (kg): o preço por kg pode ser bem
  maior que o valor pago, porque a quantidade comprada não é 1kg inteiro. Ex: linha
  "PIMENTAO AMARELO kg  0,225KG  27,90  6,28" → o item custou 6,28 (0,225kg × 27,90/kg), NÃO
  27,90. Se só existir um número na linha, aí sim use ele.
- Preste atenção em linhas de "DESCONTO" logo abaixo de um produto — o desconto se aplica
  SÓ àquele produto específico (o imediatamente acima dele na nota), nunca a outro item.
  Subtraia do valor daquele produto antes de somar. NÃO aplique esse desconto em nenhum
  outro produto da nota.
- NÃO PULE nenhuma linha de produto do cupom — cada código/linha de produto é um item real que
  foi comprado e tem que aparecer na descrição de algum grupo. Antes de finalizar, confira que
  todo produto listado no cupom está representado em algum item da lista "itens".
- Quando agrupar vários produtos num único item (mesma categoria), o "valor" desse item tem que
  ser EXATAMENTE a soma dos valores dos produtos que você listou na "descricao" dele — não
  arredonde, não estime, calcule a soma de verdade dos produtos que estão naquela descrição.
- No fim, a SOMA de todos os "valor" dos itens deve bater com o total do documento (Total/Valor
  a Pagar) — se não bater, revise: (1) se pegou valor unitário em vez de valor do item em algum
  produto pesado, (2) se aplicou algum desconto no produto errado, (3) se esqueceu de incluir
  algum produto do cupom, (4) se a soma de um grupo bate com os produtos listados nele.
- Atenção ao formato de data: DD/MM/AAAA (Ex: 01/08/2026 = 1º de agosto)

${LISTA_CATEGORIAS}`;

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

// ── Pipeline em duas etapas: transcrição + classificação ──────────────────────
//
// Pedir pra uma única chamada de IA ler a imagem, fazer contas (desconto,
// valor unitário x valor do item) E categorizar tudo de uma vez mostrou ser
// pouco confiável em cupons densos (16+ linhas): a IA variava entre
// tentativas — somava grupo errado, perdia item, trocava desconto de lugar.
//
// Separando em duas chamadas mais simples — 1) só ler os números certos, sem
// categorizar nada; 2) só classificar texto já limpo, sem fazer conta nenhuma
// — e fazendo o AGRUPAMENTO/SOMA no código (determinístico), a IA só precisa
// acertar leitura (etapa 1) e categoria (etapa 2), separadamente, e a soma
// nunca mais erra porque deixa de ser trabalho da IA.

interface LinhaCupom {
  descricao: string;
  quantidade: number | null;
  unidade: string | null;
  valor_item: number; // valor do produto já multiplicado pela quantidade, ANTES do desconto
  desconto: number; // valor a subtrair (0 se não teve desconto nessa linha)
}

interface TranscricaoCupom {
  skip?: boolean;
  tipo_documento: string;
  fornecedor: string | null;
  cnpj_cpf: string | null;
  data_emissao: string | null;
  data_vencimento: string | null;
  valor_total_documento: number | null;
  linhas: LinhaCupom[];
}

const TRANSCRICAO_SYSTEM = `Você transcreve documentos financeiros brasileiros (cupons fiscais, notas, recibos)
LINHA POR LINHA. Sua única tarefa é ler os números certos — NÃO categorize, NÃO agrupe, NÃO
decida receita/despesa. Isso é feito depois, por outra pessoa, com o texto que você transcrever.

Retorne SOMENTE JSON válido, sem markdown, sem explicações.

Se não for um documento financeiro (saudação, conversa, pergunta sem valor), retorne: {"skip": true}

Schema:
{
  "tipo_documento": "nota_fiscal" | "boleto" | "comprovante" | "recibo" | "extrato" | "outro",
  "fornecedor": string | null,
  "cnpj_cpf": string | null,
  "data_emissao": "YYYY-MM-DD" | null,
  "data_vencimento": "YYYY-MM-DD" | null,
  "valor_total_documento": number | null,
  "linhas": [
    {
      "descricao": string,
      "quantidade": number | null,
      "unidade": string | null,
      "valor_item": number,
      "desconto": number
    }
  ]
}

Regras:
- Transcreva TODA linha de produto do documento, uma por uma — não pule nenhuma, mesmo que
  pareça repetida ou parecida com outra (ex: se "Manjericão" aparece 2 vezes na nota, gera 2
  linhas, não 1).
- Não invente produtos que não existem no documento. Não duplique um produto que só aparece
  uma vez.
- ⚠️ CONTAGEM: antes de responder, conte de novo quantas linhas de produto existem no
  documento (cada código/número de item é UMA linha) e confira que sua lista "linhas" tem
  exatamente essa quantidade. É comum errar a contagem quando vários produtos parecidos se
  repetem em sequência (ex: 3x "Alface Americana", 2x "Manjericão") — trate CADA número de
  item/código da nota como uma linha própria, mesmo que o produto seja idêntico ao anterior.
- ⚠️ LINHA DE DESCONTO NÃO SUBSTITUI O PRODUTO: quando um produto é seguido de uma linha
  "DESCONTO", isso NÃO significa que o produto virou outra coisa — o produto AINDA é uma linha
  normal em "linhas" (com seu valor_item cheio), e o desconto só entra no campo "desconto"
  DESSE MESMO produto. Nunca pule a transcrição de um produto só porque ele tem desconto.
- "valor_item" é o VALOR DO ITEM já multiplicado pela quantidade — ANTES de qualquer desconto.
  Cupons fiscais (NFC-e) costumam ter 3 números por linha de produto: quantidade, valor
  UNITÁRIO (R$ por kg/un/litro) e valor do ITEM (o já calculado). Use SEMPRE o valor do ITEM,
  NUNCA o valor unitário — isso vale pra QUALQUER produto vendido por peso/kg na nota, não só
  o primeiro que aparecer, incluindo produtos perto do fim da lista (queijo, frios, carnes
  fatiadas etc. costumam ser os últimos itens e são vendidos por kg também). Confira TODOS os
  produtos com "kg" na unidade, um por um, sem exceção. Exemplos:
    "PIMENTAO AMARELO kg   0,225KG  27,90  6,28"  → valor_item é 6,28 (0,225kg × 27,90/kg), NÃO 27,90
    "QUEIJO MUSSARELA kg   0,596KG  43,90  26,16" → valor_item é 26,16 (0,596kg × 43,90/kg), NÃO 43,90
  Se só existir um número na linha, use ele.
- "desconto": se tiver uma linha de "DESCONTO" logo abaixo de um produto, coloque o valor dela
  (positivo) no campo "desconto" DESSE produto (o de cima). 0 se não teve desconto. Nunca
  aplique o desconto de um produto em outro — é sempre o produto imediatamente acima.
- valores sempre números sem formatação (ex: 27.90), nunca string.
- Atenção ao formato de data: DD/MM/AAAA (Ex: 01/08/2026 = 1º de agosto)
- Depois de transcrever tudo, confira: a soma de (valor_item - desconto) de todas as linhas
  deveria bater com "valor_total_documento". Se não bater, revise as linhas antes de responder.`;

function parseTranscricao(raw: string): TranscricaoCupom | null {
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
    const parsed = JSON.parse(cleaned);
    if (parsed.skip === true) return null;
    if (!Array.isArray(parsed.linhas) || parsed.linhas.length === 0) {
      console.log("[Claude] Transcrição sem linhas");
      return null;
    }
    return parsed as TranscricaoCupom;
  } catch (err) {
    console.error("[Claude] Erro ao parsear transcrição:", err, "Raw:", raw.substring(0, 200));
    return null;
  }
}

async function transcreverCupom(
  imageBuffer: Buffer,
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif",
  caption?: string
): Promise<TranscricaoCupom | null> {
  const base64 = imageBuffer.toString("base64");
  const contexto = caption
    ? `O usuário identificou este documento como: "${caption}". Isso pode ajudar a entender o contexto, mas sua tarefa aqui é só transcrever os números — não categorize.`
    : "Transcreva todas as linhas de produto deste documento.";
  const response = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 2048,
    messages: [
      { role: "system", content: TRANSCRICAO_SYSTEM },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: "text", text: contexto },
        ],
      },
    ],
  } as any);
  const textContent = response.choices[0]?.message?.content;
  if (!textContent) throw new Error("OpenAI não retornou transcrição");
  return parseTranscricao(typeof textContent === "string" ? textContent : "");
}

// ── Etapa 2: classificação (texto puro, sem imagem, sem conta nenhuma) ────────

interface ClassificacaoProduto {
  indice: number; // índice na lista enviada, pra casar de volta com a linha certa
  tipo_lancamento: "receita" | "despesa";
  categoria_sugerida: string;
  subcategoria: string | null;
}

const CLASSIFICACAO_SYSTEM = `Você classifica produtos de documentos financeiros de restaurantes brasileiros em
categorias contábeis. Os valores já estão corretos e prontos — sua única tarefa é escolher a
categoria de cada produto. NÃO faça nenhuma conta.

Retorne SOMENTE JSON válido, sem markdown, sem explicações.

Schema:
{
  "classificacoes": [
    { "indice": number, "tipo_lancamento": "receita" | "despesa", "categoria_sugerida": string, "subcategoria": string | null }
  ]
}

Regras:
- tipo_lancamento: "despesa" quando o restaurante está PAGANDO (comprando insumos, embalagens,
  equipamentos, serviços, mercadoria de fornecedor). "receita" SÓ quando é dinheiro que o
  restaurante está RECEBENDO (venda pro cliente, fechamento de caixa). Cupons de "conferência
  de produtos" ou notas com produto/quantidade/preço listando insumos são SEMPRE despesa.
- Devolva "indice" IGUAL ao índice do produto na lista que você recebeu, na mesma ordem — um
  item de classificação por produto recebido, sem pular nenhum e sem inventar índice novo.

${REGRA_SUBCATEGORIAS}

${LISTA_CATEGORIAS}`;

const SUBCATEGORIAS_VALIDAS = new Set([
  "Filé de Peito",
  "Filé Mignon",
  "Queijo Mussarela",
  "Camarão",
  "Óleo",
]);

function parseClassificacao(raw: string): ClassificacaoProduto[] | null {
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.classificacoes)) return null;
    return parsed.classificacoes as ClassificacaoProduto[];
  } catch (err) {
    console.error("[Claude] Erro ao parsear classificação:", err, "Raw:", raw.substring(0, 200));
    return null;
  }
}

async function classificarLinhas(
  linhas: LinhaCupom[],
  contexto: { fornecedor: string | null; tipo_documento: string }
): Promise<ClassificacaoProduto[] | null> {
  const produtos = linhas.map((l, i) => `${i}: ${l.descricao}`).join("\n");
  const prompt = `Fornecedor: ${contexto.fornecedor ?? "não identificado"}
Tipo de documento: ${contexto.tipo_documento}

Produtos a classificar (um por linha, "índice: descrição"):
${produtos}`;

  const response = await getClient().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 2048,
    messages: [
      { role: "system", content: CLASSIFICACAO_SYSTEM },
      { role: "user", content: prompt },
    ],
  } as any);
  const textContent = response.choices[0]?.message?.content;
  if (!textContent) throw new Error("OpenAI não retornou classificação");
  return parseClassificacao(typeof textContent === "string" ? textContent : "");
}

// ── Merge determinístico: agrupa por categoria e soma em CÓDIGO (não IA) ──────
// Exportado só pra ser testável isoladamente com dados simulados.

export function montarItensAgrupados(
  linhas: LinhaCupom[],
  classificacoes: ClassificacaoProduto[]
): ItemExtraido[] {
  const classMap = new Map(classificacoes.map((c) => [c.indice, c]));

  interface Grupo {
    categoria_sugerida: string;
    tipo_lancamento: "receita" | "despesa";
    subcategoria: string | null;
    produtos: { descricao: string; quantidade: number | null; unidade: string | null }[];
    valor: number;
  }

  const grupos = new Map<string, Grupo>();

  linhas.forEach((linha, idx) => {
    const classificacao = classMap.get(idx);
    // Rede de segurança: se a classificação sumir/não vier pra essa linha,
    // usa um fallback óbvio em vez de descartar o produto silenciosamente.
    const categoria = classificacao?.categoria_sugerida || "Outras despesas administrativas";
    const tipo = classificacao?.tipo_lancamento || "despesa";
    const subcategoriaBruta = classificacao?.subcategoria ?? null;
    const subcategoria = subcategoriaBruta && SUBCATEGORIAS_VALIDAS.has(subcategoriaBruta) ? subcategoriaBruta : null;

    const valorFinal = Math.round((linha.valor_item - (linha.desconto || 0)) * 100) / 100;

    // Produtos rastreados (subcategoria != null) NUNCA agrupam com outros —
    // cada linha vira seu próprio item, com quantidade exata dela.
    const chave = subcategoria ? `sub::${subcategoria}::${idx}` : `cat::${categoria}`;

    const atual: Grupo = grupos.get(chave) ?? {
      categoria_sugerida: categoria,
      tipo_lancamento: tipo,
      subcategoria,
      produtos: [],
      valor: 0,
    };

    // Defesa contra a IA omitir o campo "descricao" numa linha (já aconteceu:
    // virava a string literal "undefined" no texto final sem essa checagem).
    const descricaoLinha = linha.descricao && linha.descricao.trim() ? linha.descricao.trim() : "Produto não identificado";
    atual.produtos.push({ descricao: descricaoLinha, quantidade: linha.quantidade, unidade: linha.unidade });
    atual.valor = Math.round((atual.valor + valorFinal) * 100) / 100;
    grupos.set(chave, atual);
  });

  return Array.from(grupos.values()).map((g) => {
    const descricao =
      g.produtos.length > 1
        ? g.produtos
            .map((p) => `${p.descricao}${p.quantidade && p.unidade ? ` (${p.quantidade}${p.unidade})` : ""}`)
            .join(", ")
        : g.produtos[0].descricao;

    return {
      descricao,
      valor: g.valor,
      quantidade: g.produtos.length === 1 ? g.produtos[0].quantidade ?? undefined : undefined,
      unidade: g.produtos.length === 1 ? g.produtos[0].unidade ?? undefined : undefined,
      categoria_sugerida: g.categoria_sugerida,
      subcategoria: g.subcategoria,
      tipo_lancamento: g.tipo_lancamento,
      confianca: "alta" as const,
    };
  });
}

export async function extractMultiFromImageV2(
  imageBuffer: Buffer,
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif",
  caption?: string
): Promise<ExtracaoMultipla | null> {
  const transcricao = await transcreverCupom(imageBuffer, mimeType, caption);
  if (!transcricao || !transcricao.linhas || transcricao.linhas.length === 0) {
    console.warn("[Claude] Transcrição vazia/falhou, caindo pro pipeline antigo (uma chamada só)");
    return extractMultiFromImage(imageBuffer, mimeType, caption);
  }

  const somaLinhas = transcricao.linhas.reduce((s, l) => s + (l.valor_item - (l.desconto || 0)), 0);
  if (transcricao.valor_total_documento != null) {
    const diff = Math.abs(somaLinhas - transcricao.valor_total_documento);
    if (diff > 0.05) {
      console.warn(
        `[Claude] Transcrição: soma das linhas (${somaLinhas.toFixed(2)}) difere do total do documento (${transcricao.valor_total_documento}) em R$${diff.toFixed(2)}`
      );
    }
  }

  const classificacoes = await classificarLinhas(transcricao.linhas, {
    fornecedor: transcricao.fornecedor,
    tipo_documento: transcricao.tipo_documento,
  });

  if (!classificacoes || classificacoes.length === 0) {
    console.warn("[Claude] Classificação vazia/falhou, caindo pro pipeline antigo (uma chamada só)");
    return extractMultiFromImage(imageBuffer, mimeType, caption);
  }

  const itens = montarItensAgrupados(transcricao.linhas, classificacoes);

  return {
    tipo_documento: transcricao.tipo_documento,
    fornecedor: transcricao.fornecedor ?? undefined,
    cnpj_cpf: transcricao.cnpj_cpf ?? undefined,
    data_emissao: transcricao.data_emissao ?? undefined,
    data_vencimento: transcricao.data_vencimento ?? undefined,
    valor_total_documento: transcricao.valor_total_documento ?? undefined,
    itens,
  };
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
    const result = await extractMultiFromImageV2(pngBuffer, "image/png", "Documento extraído de PDF");

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
