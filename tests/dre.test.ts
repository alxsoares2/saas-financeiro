import { calcularDRE, formatarDREWhatsApp } from "../src/services/dre";
import * as supabase from "../src/db/supabase";

jest.mock("../src/db/supabase");

const mockGetLancamentos = supabase.getLancamentos as jest.MockedFunction<
  typeof supabase.getLancamentos
>;

const base = {
  id: "uuid",
  tipo: "despesa" as const,
  descricao: "Teste",
  valor: 0,
  status: "pendente" as const,
  created_at: "2024-07-01T00:00:00Z",
};

function lanc(
  id: string,
  categoria_nome: string,
  grupo_dre: string,
  valor: number,
  tipo: "receita" | "despesa" = "despesa"
) {
  return { ...base, id, tipo, valor, categoria_nome, grupo_dre } as any;
}

describe("calcularDRE — operacional restaurante", () => {
  beforeEach(() => jest.clearAllMocks());

  it("calcula receita líquida após deduções", async () => {
    mockGetLancamentos.mockResolvedValue([
      lanc("1", "Vendas - Cartão de Crédito", "receita_bruta", 10000, "receita"),
      lanc("2", "Serviço 10%", "deducoes_receita", 1000),
    ]);

    const dre = await calcularDRE("2024-07-01", "2024-07-31");
    expect(dre.total_receita_bruta).toBe(10000);
    expect(dre.receita_liquida).toBe(9000);
  });

  it("calcula margem de contribuição", async () => {
    mockGetLancamentos.mockResolvedValue([
      lanc("1", "Vendas - Pix", "receita_bruta", 20000, "receita"),
      lanc("2", "Bovinos",                "cmv",                  4000),
      lanc("3", "Cervejas",               "materiais_venda_direta", 3000),
      lanc("4", "Simples Nacional (DAS)", "impostos_variaveis",   2000),
      lanc("5", "Tarifa Cartão de Crédito","tarifas_cartao",       600),
    ]);

    const dre = await calcularDRE("2024-07-01", "2024-07-31");
    // receita_liquida = 20000 (sem deduções)
    // custos_variaveis = 4000 + 3000 + 2000 + 600 = 9600
    expect(dre.total_custos_variaveis).toBe(9600);
    expect(dre.margem_contribuicao).toBe(10400);
    expect(dre.margem_contribuicao_pct).toBe(52); // 10400/20000
  });

  it("calcula resultado operacional após despesas fixas", async () => {
    mockGetLancamentos.mockResolvedValue([
      lanc("1", "Vendas - Dinheiro", "receita_bruta",  15000, "receita"),
      lanc("2", "Bovinos",           "cmv",              3000),
      lanc("3", "Aluguel do Estabelecimento", "ocupacao", 5000),
      lanc("4", "Salários CLT",      "pessoal_fixo",    4000),
    ]);

    const dre = await calcularDRE("2024-07-01", "2024-07-31");
    // margem = 15000 - 3000 = 12000
    // despesas_fixas = 5000 + 4000 = 9000
    expect(dre.margem_contribuicao).toBe(12000);
    expect(dre.total_despesas_fixas).toBe(9000);
    expect(dre.resultado_operacional).toBe(3000);
  });

  it("resultado operacional negativo quando despesas superam a margem", async () => {
    mockGetLancamentos.mockResolvedValue([
      lanc("1", "Vendas - Dinheiro", "receita_bruta",  5000, "receita"),
      lanc("2", "Aluguel do Estabelecimento", "ocupacao", 8000),
    ]);

    const dre = await calcularDRE("2024-07-01", "2024-07-31");
    expect(dre.resultado_operacional).toBe(-3000);
  });

  it("agrega múltiplos lançamentos da mesma categoria", async () => {
    mockGetLancamentos.mockResolvedValue([
      lanc("1", "Bovinos", "cmv", 1000),
      lanc("2", "Bovinos", "cmv", 2500),
    ]);

    const dre = await calcularDRE("2024-07-01", "2024-07-31");
    expect(dre.cmv).toHaveLength(1);
    expect(dre.cmv[0].valor).toBe(3500);
  });

  it("retorna DRE zerado sem lançamentos", async () => {
    mockGetLancamentos.mockResolvedValue([]);

    const dre = await calcularDRE("2024-07-01", "2024-07-31");
    expect(dre.resultado_operacional).toBe(0);
    expect(dre.margem_contribuicao).toBe(0);
    expect(dre.receita_liquida).toBe(0);
  });

  it("calcula % da margem sobre receita líquida", async () => {
    mockGetLancamentos.mockResolvedValue([
      lanc("1", "Vendas - Pix", "receita_bruta", 10000, "receita"),
      lanc("2", "Bovinos",      "cmv",             3000),
    ]);

    const dre = await calcularDRE("2024-07-01", "2024-07-31");
    expect(dre.margem_contribuicao_pct).toBe(70); // 7000/10000
  });
});

describe("formatarDREWhatsApp", () => {
  it("inclui os blocos principais na saída", () => {
    const dre = {
      periodo: { inicio: "2024-07-01", fim: "2024-07-31" },
      receita_bruta: [{ categoria: "Vendas - Pix", valor: 10000, pct: 100 }],
      total_receita_bruta: 10000,
      deducoes_receita: [],
      receita_liquida: 10000,
      cmv: [{ categoria: "Bovinos", valor: 3000, pct: 30 }],
      materiais_venda_direta: [],
      materiais_apoio: [],
      cmo_eventual: [],
      tarifas_cartao: [],
      impostos_variaveis: [],
      total_custos_variaveis: 3000,
      total_custos_variaveis_pct: 30,
      margem_contribuicao: 7000,
      margem_contribuicao_pct: 70,
      ocupacao: [{ categoria: "Aluguel", valor: 2000, pct: 20 }],
      utilidades: [],
      despesas_admin: [],
      marketing: [],
      pessoal_fixo: [],
      total_despesas_fixas: 2000,
      total_despesas_fixas_pct: 20,
      resultado_operacional: 5000,
      resultado_operacional_pct: 50,
    };

    const texto = formatarDREWhatsApp(dre);

    expect(texto).toContain("RECEITA BRUTA");
    expect(texto).toContain("RECEITA LÍQUIDA");
    expect(texto).toContain("CUSTOS VARIÁVEIS");
    expect(texto).toContain("MARGEM DE CONTRIBUIÇÃO");
    expect(texto).toContain("DESPESAS FIXAS");
    expect(texto).toContain("RESULTADO OPERACIONAL");
    expect(texto).toContain("70%");
    expect(texto).toContain("2024-07-01");
  });
});
