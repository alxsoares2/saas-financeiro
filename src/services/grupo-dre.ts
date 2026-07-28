import { GrupoDRE } from "../types.js";

// Mapeamento de palavras-chave → grupo do DRE operacional de restaurante
const MAPA_DESPESA: Array<{ keywords: string[]; grupo: GrupoDRE }> = [
  // ── Ocupação ──────────────────────────────────────────────────────────────
  {
    keywords: ["aluguel", "condomin", "iptu", "tcr", "taxa de coleta", "ocupacao", "ocupação"],
    grupo: "ocupacao",
  },
  // ── Utilidades ────────────────────────────────────────────────────────────
  {
    keywords: [
      "luz", "energia", "eletric", "agua", "esgoto", "gas", "telefone",
      "internet", "banda larga", "utilidade",
    ],
    grupo: "utilidades",
  },
  // ── Pessoal Fixo ──────────────────────────────────────────────────────────
  {
    keywords: [
      "salario", "salário", "pro-labore", "prolabore", "pro labore",
      "fgts", "inss", "encargo", "vale transporte", "vale refeicao",
      "vale refeição", "plano de saude", "plano de saúde", "pessoal",
      "ferias", "férias", "13o", "13º", "rescisao", "rescisão",
    ],
    grupo: "pessoal_fixo",
  },
  // ── Marketing ─────────────────────────────────────────────────────────────
  {
    keywords: [
      "marketing", "publicidade", "propaganda", "redes sociais",
      "instagram", "google ads", "facebook", "midia", "mídia",
      "grafico", "gráfico", "impresso", "panfleto",
    ],
    grupo: "marketing",
  },
  // ── Despesas Administrativas ──────────────────────────────────────────────
  {
    keywords: [
      "contabilidade", "contador", "sistema", "pdv", "erp", "software",
      "escritorio", "escritório", "seguro", "manutencao", "manutenção",
      "veiculo", "veículo", "alvara", "alvará", "licenca", "licença",
      "honorario", "honorário", "consultoria", "juridico", "jurídico",
    ],
    grupo: "despesas_admin",
  },
  // ── Tarifas de Cartão / Delivery ──────────────────────────────────────────
  {
    keywords: [
      "tarifa", "taxa cartao", "taxa cartão", "ifood", "maquininha",
      "adquirente", "stone", "cielo", "rede ", "getnet", "pagseguro",
      "mercado pago", "taxa pix", "taxa debito", "taxa credito",
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
  // ── Materiais de Apoio ────────────────────────────────────────────────────
  {
    keywords: [
      "limpeza", "higiene", "embalagem", "descartavel", "descartável",
      "copo", "prato descartavel", "talher", "guardanapo", "sacola",
      "gelo", "papel toalha", "papel higienico",
    ],
    grupo: "materiais_apoio",
  },
  // ── CMO Eventual ──────────────────────────────────────────────────────────
  {
    keywords: [
      "freelancer", "diarista", "eventual", "temporario", "temporário",
      "extra", "avulso", "dj", "fotografo", "fotógrafo", "bartender",
    ],
    grupo: "cmo_eventual",
  },
  // ── CMV é o fallback (ingredientes, fornecedores de insumos) ─────────────
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
