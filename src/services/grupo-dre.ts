import { GrupoDRE } from "../types.js";

// Mapeamento de palavras-chave → grupo do DRE (baseado na planilha ENG-DRE ARTS)
const MAPA_DESPESA: Array<{ keywords: string[]; grupo: GrupoDRE }> = [
  // ── Ocupação ──────────────────────────────────────────────────────────────
  {
    keywords: ["aluguel", "condomin", "iptu", "tcr", "taxa de coleta", "nucleo admin"],
    grupo: "ocupacao",
  },
  // ── Utilidades Públicas ───────────────────────────────────────────────────
  {
    keywords: ["luz", "energia", "eletric", "conta de agua", "conta agua", "esgoto", "gas", "conta de gas", "telefone"],
    grupo: "utilidades",
  },
  // ── Pessoal Fixo ──────────────────────────────────────────────────────────
  {
    keywords: [
      "salario", "salário", "fgts", "inss", "encargo", "vale transporte",
      "vale refeicao", "vale refeição", "plano de saude", "plano de saúde",
      "ferias", "férias", "13o", "13º", "rescisao", "rescisão",
      "medicina do trabalho", "seguro de vida", "contribuicao sindical",
      "remuneracao", "remuneração", "gratificacao", "gratificação",
      "admissao", "admissão", "demissao", "demissão", "uniforme",
      "bolsa auxilio", "ajuda de custo moradia", "irpf funcionario",
      "salario familia", "salário família",
    ],
    grupo: "pessoal_fixo",
  },
  // ── Retirada dos Sócios ───────────────────────────────────────────────────
  {
    keywords: [
      "retirada", "pro-labore", "prolabore", "pro labore",
      "socio", "sócio", "distribuicao de lucros", "distribuição de lucros",
    ],
    grupo: "retirada_socios",
  },
  // ── Serviços Terceirizados ────────────────────────────────────────────────
  {
    keywords: [
      "musico", "músico", "banda", "dj", "artista", "show",
      "contabilidade", "contador",
      "seguranca", "segurança", "vigilancia", "vigilância",
      "transportadora", "frete servico", "frete serviço",
      "grafica", "gráfica", "servico grafico", "serviço gráfico",
      "dedetizacao", "dedetização", "controle de pragas",
      "advocacia", "advogado", "juridico", "jurídico",
      "agencia de marketing", "agência de marketing",
      "jardinagem", "paisagismo", "decoracao", "decoração",
      "consultoria gastronomia", "consultoria gastro",
      "nutricional", "assessoria nutri",
      "terceirizado", "terceirizada",
      "delivery", "motoboy", "entrega",
    ],
    grupo: "servicos_terceirizados",
  },
  // ── Marketing ─────────────────────────────────────────────────────────────
  {
    keywords: [
      "marketing", "publicidade", "propaganda", "redes sociais",
      "instagram", "google ads", "facebook", "midia", "mídia",
      "impresso", "panfleto", "anuncio", "anúncio", "influencer",
      "criacao de conteudo", "criação de conteúdo", "divulgacao", "divulgação",
    ],
    grupo: "marketing",
  },
  // ── Manutenção ────────────────────────────────────────────────────────────
  {
    keywords: [
      "manutencao", "manutenção", "reparo", "conserto", "reforma",
      "predial", "preventiva", "corretiva", "manutencao de maquina",
      "manutenção de equipamento",
    ],
    grupo: "manutencao",
  },
  // ── Despesas de Aquisição (CAPEX) ─────────────────────────────────────────
  {
    keywords: [
      "equipamento", "utensilio", "utensílio", "maquinario", "maquinário",
      "aquisicao", "aquisição", "compra de equipamento", "compra de utensilio",
    ],
    grupo: "despesas_aquisicao",
  },
  // ── Despesas Administrativas ──────────────────────────────────────────────
  {
    keywords: [
      "sistema", "pdv", "erp", "software", "internet", "banda larga",
      "escritorio", "escritório", "seguro", "alvara", "alvará",
      "licenca", "licença", "honorario", "honorário",
      "material de escritorio", "informatica",
      "assinatura", "subscription", "app", "aplicativo", "plugin",
      "claude", "chatgpt", "copilot", "gemini", "ia",
      "veiculo", "veículo",
      "cartao corporativo", "cartão corporativo",
      "maquininha", "aluguel de maquineta",
    ],
    grupo: "despesas_admin",
  },
  // ── Despesas Financeiras ──────────────────────────────────────────────────
  {
    keywords: [
      "bancaria", "bancário", "iof", "emprestimo", "empréstimo",
      "financiamento", "juros", "multa bancaria", "giro", "capital de giro",
      "tarifa bancaria", "tarifa bancária",
    ],
    grupo: "despesas_financeiras",
  },
  // ── Renegociações de Dívidas ──────────────────────────────────────────────
  {
    keywords: [
      "renegociacao", "renegociação", "parcelamento", "divida", "dívida",
      "acordo", "reparcelamento",
    ],
    grupo: "renegociacoes_dividas",
  },
  // ── Tarifas de Cartão / Delivery ──────────────────────────────────────────
  {
    keywords: [
      "tarifa cartao", "tarifa cartão", "taxa cartao", "taxa cartão",
      "ifood taxa", "taxa ifood", "adquirente",
      "stone", "cielo", "rede ", "getnet", "pagseguro",
      "mercado pago taxa", "taxa pix", "taxa debito", "taxa credito",
      "taxa delivery",
    ],
    grupo: "tarifas_cartao",
  },
  // ── Impostos Variáveis ────────────────────────────────────────────────────
  {
    keywords: [
      "pis", "cofins", "icms", "simples nacional", "das ", "iss ",
      "imposto", "tributo", "feef", "funcep", "sped",
    ],
    grupo: "impostos_variaveis",
  },
  // ── Materiais de Venda Direta (bebidas revendidas) ────────────────────────
  {
    keywords: [
      "cerveja", "destilado", "whisky", "whiskey", "vodka", "gin",
      "cachaca", "cachaça", "vinho", "espumante", "energetico", "energético",
      "refrigerante", "agua mineral", "água mineral", "bebida", "doses",
    ],
    grupo: "materiais_venda_direta",
  },
  // ── Materiais de Apoio (limpeza, descartáveis de cozinha) ──────────────────
  {
    keywords: [
      "limpeza", "higiene", "descartavel", "descartável",
      "copo", "prato descartavel", "talher", "guardanapo",
      "gelo", "papel toalha", "papel higienico", "papel higienco",
    ],
    grupo: "materiais_apoio",
  },
  // ── CMO Eventual ──────────────────────────────────────────────────────────
  {
    keywords: [
      "freelancer", "diarista", "eventual", "temporario", "temporário",
      "avulso", "fotografo", "fotógrafo", "bartender",
    ],
    grupo: "cmo_eventual",
  },
  // ── CMV - Matéria-Prima / Insumos ─────────────────────────────────────────
  {
    keywords: [
      "bovino", "carne", "bife", "alcatra", "picanha", "costela",
      "suino", "suíno", "porco", "costela de porco", "toucinho",
      "ave", "frango", "peitinho", "coxa", "asa",
      "peixe", "frutos do mar", "camarao", "camarão", "ostra", "vieira", "lagosta",
      "flv", "fruta", "legume", "verdura", "abobora", "abóbora", "cenoura", "batata",
      "tomate", "alface", "brocolis", "brócolis", "couve",
      "laticinio", "lacticinio", "queijo", "mussarela", "mozzarela", "parmesao", "parmesão",
      "presunto", "mortadela", "salame", "linguica", "lingüiça", "frio",
      "leite", "manteiga", "creme de leite", "iogurte",
      "congelado", "pizza congelada", "massa congelada",
      "grao", "grão", "cereal", "farinha", "arroz", "feijao", "feijão",
      "macarrao", "macarrão", "massa fresca", "pasta fresca",
      "oleo", "óleo", "azeite", "gordura", "manteiga de garrafa",
      "cafe", "café", "cha", "chá", "capsula", "capsula nescafe",
      "condimento", "tempero", "molho", "salsa", "pimenta", "pimento", "orégano",
      "ovo", "ovo caipira",
      "mel", "açucar", "açúcar", "rapadura",
      "chocolate", "chocola", "cobertura",
      "corante", "essencia", "essência", "fermento", "amido",
      "embalagem", "caixa", "quentinha", "lacre", "papel kraft", "papel manteiga",
      "sacola", "saco", "plastico", "plástico", "filme plastico",
    ],
    grupo: "cmv",
  },
];

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, ""); // remove acentos
}

export function inferirGrupoDre(
  categoriaNome: string,
  tipo: "receita" | "despesa"
): GrupoDRE {
  if (tipo === "receita") return "receita_bruta";

  const nome = normalizar(categoriaNome);

  for (const entry of MAPA_DESPESA) {
    for (const kw of entry.keywords) {
      if (nome.includes(normalizar(kw))) return entry.grupo;
    }
  }

  return "cmv"; // fallback — ingredientes são o custo mais comum de restaurante
}
