import { calcularSugestaoCompra, formatarSugestaoWhatsApp } from "../src/services/estoque/sugestao-compra";
import * as db from "../src/services/estoque/db";
import { GrupoSubstituicao, ItemUniversal, PadraoEmbalagem, Produto, Sabor, SaborIngrediente } from "../src/services/estoque/types";

jest.mock("../src/services/estoque/db");

const mockListProdutos = db.listProdutos as jest.MockedFunction<typeof db.listProdutos>;
const mockListSabores = db.listSabores as jest.MockedFunction<typeof db.listSabores>;
const mockListIngredientes = db.listTodosIngredientesSabores as jest.MockedFunction<typeof db.listTodosIngredientesSabores>;
const mockListItensUniversais = db.listItensUniversais as jest.MockedFunction<typeof db.listItensUniversais>;
const mockListGrupos = db.listGruposSubstituicao as jest.MockedFunction<typeof db.listGruposSubstituicao>;
const mockGetMembrosGrupo = db.getMembrosGrupo as jest.MockedFunction<typeof db.getMembrosGrupo>;
const mockGetPadrao = db.getPadraoEmbalagem as jest.MockedFunction<typeof db.getPadraoEmbalagem>;
const mockGetProdutoPorId = db.getProdutoPorId as jest.MockedFunction<typeof db.getProdutoPorId>;
const mockCriarMeta = db.criarMetaProducao as jest.MockedFunction<typeof db.criarMetaProducao>;

function produto(over: Partial<Produto> & { id: string; nome: string }): Produto {
  return {
    unidade: "kg",
    tipo: "bruto",
    categoria: null,
    marca: null,
    preco_unitario: null,
    estoque_atual: 0,
    estoque_minimo: 0,
    fornecedor: null,
    formato_saida: null,
    ativo: true,
    observacoes: null,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

const massa = produto({ id: "massa", nome: "Massa de Pizza", unidade: "un", tipo: "manipulado", estoque_atual: 10 });
const molho = produto({ id: "molho", nome: "Molho de Tomate", tipo: "manipulado", estoque_atual: 1 });
const queijo = produto({ id: "queijo", nome: "Queijo Triturado", tipo: "manipulado", marca: "basilico", estoque_atual: 0 });
const caixaBasilico = produto({ id: "caixa-b", nome: "Caixa de Pizza Basílico", unidade: "un", estoque_atual: 5 });

const produtos: Produto[] = [massa, molho, queijo, caixaBasilico];

const itensUniversais: ItemUniversal[] = [
  { id: "1", categoria: "ambas", produto_id: massa.id, grupo_substituicao_id: null, marca: null, quantidade: 1, unidade: "un", observacoes: null, ativo: true },
  { id: "2", categoria: "salgada", produto_id: molho.id, grupo_substituicao_id: null, marca: null, quantidade: 0.09, unidade: "kg", observacoes: null, ativo: true },
  { id: "3", categoria: "ambas", produto_id: queijo.id, grupo_substituicao_id: null, marca: "basilico", quantidade: 0.2, unidade: "kg", observacoes: null, ativo: true },
  { id: "4", categoria: "ambas", produto_id: caixaBasilico.id, grupo_substituicao_id: null, marca: "basilico", quantidade: 1, unidade: "un", observacoes: null, ativo: true },
];

function setupMocksBasicos() {
  mockListProdutos.mockResolvedValue(produtos);
  mockListSabores.mockResolvedValue([]);
  mockListIngredientes.mockResolvedValue([]);
  mockListItensUniversais.mockResolvedValue(itensUniversais);
  mockListGrupos.mockResolvedValue([]);
  mockGetMembrosGrupo.mockResolvedValue([]);
  mockGetPadrao.mockResolvedValue(null);
  mockGetProdutoPorId.mockImplementation(async (id: string) => produtos.find((p) => p.id === id) ?? null);
  mockCriarMeta.mockResolvedValue({
    id: "meta-1",
    data: "2026-08-24",
    valido_ate: null,
    qtd_pizzas_basilico: 0,
    qtd_pizzas_populares: 0,
    texto_original: null,
    chat_id: null,
    created_at: "",
  });
}

describe("calcularSugestaoCompra — itens universais", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocksBasicos();
  });

  it("dimensiona massa/molho/queijo/caixa proporcionalmente à meta pedida", async () => {
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 20, qtdPizzasPopulares: 0, registrarMeta: false });

    const item = (nome: string) => resultado.itens.find((i) => i.produtoNome === nome)!;

    expect(item("Massa de Pizza").necessario).toBe(20);
    expect(item("Molho de Tomate").necessario).toBeCloseTo(1.8);
    expect(item("Queijo Triturado").necessario).toBeCloseTo(4);
    expect(item("Caixa de Pizza Basílico").necessario).toBe(20);
  });

  it("calcula falta como necessário menos estoque atual", async () => {
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 20, qtdPizzasPopulares: 0, registrarMeta: false });
    const massaItem = resultado.itens.find((i) => i.produtoNome === "Massa de Pizza")!;
    // necessário 20, estoque 10 -> falta 10
    expect(massaItem.falta).toBe(10);
  });

  it("não gera necessidade quando não há pizzas pedidas nem piso ativo", async () => {
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 0, registrarMeta: false });
    expect(resultado.itens).toHaveLength(0);
  });

  it("não registra meta quando registrarMeta é false", async () => {
    await calcularSugestaoCompra({ qtdPizzasBasilico: 5, qtdPizzasPopulares: 0, registrarMeta: false });
    expect(mockCriarMeta).not.toHaveBeenCalled();
  });

  it("registra meta por padrão", async () => {
    await calcularSugestaoCompra({ qtdPizzasBasilico: 5, qtdPizzasPopulares: 0 });
    expect(mockCriarMeta).toHaveBeenCalledWith(expect.objectContaining({ qtdPizzasBasilico: 5 }));
  });
});

describe("calcularSugestaoCompra — piso de segurança", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocksBasicos();
  });

  it("soma o piso mínimo de sabores não-âncora ao total de pizzas salgadas (item universal)", async () => {
    const lombo = produto({ id: "lombo", nome: "Lombinho Canadense Fatiado", estoque_atual: 0 });
    mockListProdutos.mockResolvedValue([...produtos, lombo]);

    const sabor: Sabor = {
      id: "s1",
      nome: "Lombo c/ catupiry",
      tipo: "piso_seguranca",
      categoria: "salgada",
      piso_minimo_pizzas: 4,
      queijo_override_kg: null,
      ativo: true,
      observacoes: null,
    };
    mockListSabores.mockResolvedValue([sabor]);

    const ingrediente: SaborIngrediente = {
      id: "i1",
      sabor_id: "s1",
      produto_id: lombo.id,
      grupo_substituicao_id: null,
      quantidade: 0.18,
      unidade: "kg",
    };
    mockListIngredientes.mockResolvedValue([ingrediente]);

    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 0, registrarMeta: false });

    // ingrediente exclusivo do piso: 0.18kg * 4 pizzas = 0.72kg
    const lomboItem = resultado.itens.find((i) => i.produtoNome === lombo.nome)!;
    expect(lomboItem.necessario).toBeCloseTo(0.72);

    // universal (massa) também sobe: 0 da meta + 4 do piso = 4 unidades
    const massaItem = resultado.itens.find((i) => i.produtoNome === "Massa de Pizza")!;
    expect(massaItem.necessario).toBe(4);
  });
});

describe("calcularSugestaoCompra — padrão de embalagem", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocksBasicos();
  });

  it("arredonda a compra pro múltiplo do padrão de embalagem", async () => {
    const padrao: PadraoEmbalagem = {
      id: "p1",
      produto_id: queijo.id,
      nome_padrao: "Barra de queijo (múltiplos de 4kg)",
      unidades_por_padrao: 1,
      peso_ou_volume_por_unidade: 4,
      multiplo_minimo: null,
      ativo: true,
    };
    mockGetPadrao.mockImplementation(async (produtoId: string) => (produtoId === queijo.id ? padrao : null));

    // necessário: 0.2kg * 30 pizzas = 6kg, estoque 0 -> falta 6kg -> arredonda pra 8kg (múltiplo de 4)
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 30, qtdPizzasPopulares: 0, registrarMeta: false });
    const queijoItem = resultado.itens.find((i) => i.produtoNome === "Queijo Triturado")!;
    expect(queijoItem.falta).toBe(6);
    expect(queijoItem.sugestaoArredondada).toBe(8);
    expect(queijoItem.origemPadrao).toBe(padrao.nome_padrao);
  });
});

describe("formatarSugestaoWhatsApp", () => {
  it("informa quando não há necessidade de compra", () => {
    const texto = formatarSugestaoWhatsApp({
      meta: { validoAte: null, qtdPizzasBasilico: 10, qtdPizzasPopulares: 0 },
      itens: [],
    });
    expect(texto).toContain("nenhuma compra necessária");
  });

  it("lista itens com falta, incluindo tag de pool quando aplicável", () => {
    const texto = formatarSugestaoWhatsApp({
      meta: { validoAte: "2026-08-27", qtdPizzasBasilico: 10, qtdPizzasPopulares: 0 },
      itens: [
        {
          produtoId: "queijo",
          produtoNome: "Queijo Triturado",
          unidade: "kg",
          isPool: false,
          necessario: 5,
          estoqueAtual: 1,
          falta: 4,
          sugestaoArredondada: 4,
          motivo: "item universal (salgada, basilico)",
        },
        {
          produtoId: "grupo-requeijao",
          produtoNome: "Requeijão (populares)",
          unidade: "kg",
          isPool: true,
          necessario: 2,
          estoqueAtual: 0,
          falta: 2,
          sugestaoArredondada: 2,
          motivo: "piso de segurança",
        },
      ],
    });

    expect(texto).toContain("Queijo Triturado");
    expect(texto).toContain("2026-08-27");
    expect(texto).toContain("pool");
  });
});
