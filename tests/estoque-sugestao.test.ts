import { calcularSugestaoCompra, formatarSugestaoWhatsApp } from "../src/services/estoque/sugestao-compra";
import * as db from "../src/services/estoque/db";
import { FichaTecnica, GrupoSubstituicao, ItemUniversal, PadraoEmbalagem, Produto, Sabor, SaborIngrediente } from "../src/services/estoque/types";

jest.mock("../src/services/estoque/db");

const mockListProdutos = db.listProdutos as jest.MockedFunction<typeof db.listProdutos>;
const mockListSabores = db.listSabores as jest.MockedFunction<typeof db.listSabores>;
const mockListIngredientes = db.listTodosIngredientesSabores as jest.MockedFunction<typeof db.listTodosIngredientesSabores>;
const mockListItensUniversais = db.listItensUniversais as jest.MockedFunction<typeof db.listItensUniversais>;
const mockListGrupos = db.listGruposSubstituicao as jest.MockedFunction<typeof db.listGruposSubstituicao>;
const mockListFichas = db.listFichasTecnicas as jest.MockedFunction<typeof db.listFichasTecnicas>;
const mockListPadroes = db.listPadroesEmbalagem as jest.MockedFunction<typeof db.listPadroesEmbalagem>;
const mockGetMembrosGrupo = db.getMembrosGrupo as jest.MockedFunction<typeof db.getMembrosGrupo>;
const mockGetPadrao = db.getPadraoEmbalagem as jest.MockedFunction<typeof db.getPadraoEmbalagem>;
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
  mockListFichas.mockResolvedValue([]);
  mockListPadroes.mockResolvedValue([]);
  mockGetMembrosGrupo.mockResolvedValue([]);
  mockGetPadrao.mockResolvedValue(null);
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

  function sabor(over: Partial<Sabor> & { id: string; nome: string }): Sabor {
    return {
      tipo: "piso_seguranca",
      categoria: "salgada",
      piso_minimo_pizzas: 4,
      queijo_override_kg: null,
      ativo: true,
      observacoes: null,
      ...over,
    };
  }

  it("ingrediente usado por um único sabor: soma direta (qtd_por_pizza × piso)", async () => {
    const lombo = produto({ id: "lombo", nome: "Lombinho Canadense Fatiado", estoque_atual: 0 });
    mockListProdutos.mockResolvedValue([...produtos, lombo]);
    mockListSabores.mockResolvedValue([sabor({ id: "s1", nome: "Lombo c/ catupiry", piso_minimo_pizzas: 4 })]);
    mockListIngredientes.mockResolvedValue([
      { id: "i1", sabor_id: "s1", produto_id: lombo.id, grupo_substituicao_id: null, quantidade: 0.18, unidade: "kg" },
    ]);

    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 0, registrarMeta: false });

    // 0.18kg * 4 pizzas = 0.72kg
    const lomboItem = resultado.itens.find((i) => i.produtoNome === lombo.nome)!;
    expect(lomboItem.necessario).toBeCloseTo(0.72);
  });

  it("[correção] piso de segurança NÃO infla os itens universais — só a meta principal dimensiona eles", async () => {
    const lombo = produto({ id: "lombo", nome: "Lombinho Canadense Fatiado", estoque_atual: 0 });
    // massa sem estoque pra deixar visível se ela aparecesse por engano
    const massaSemEstoque = produto({ id: "massa", nome: "Massa de Pizza", unidade: "un", tipo: "manipulado", estoque_atual: 0 });
    mockListProdutos.mockResolvedValue([massaSemEstoque, molho, queijo, caixaBasilico, lombo]);
    mockListSabores.mockResolvedValue([sabor({ id: "s1", nome: "Lombo c/ catupiry", piso_minimo_pizzas: 4 })]);
    mockListIngredientes.mockResolvedValue([
      { id: "i1", sabor_id: "s1", produto_id: lombo.id, grupo_substituicao_id: null, quantidade: 0.18, unidade: "kg" },
    ]);

    // meta = 0 pizzas, só tem o piso do Lombo (4 pizzas) — massa NÃO deve
    // aparecer no relatório (necessário universal = 0, mesmo com piso ativo)
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 0, registrarMeta: false });

    expect(resultado.itens.find((i) => i.produtoNome === "Massa de Pizza")).toBeUndefined();
    expect(resultado.itens.find((i) => i.produtoNome === lombo.nome)).toBeDefined();
  });

  it("[correção] com meta pedida, universal escala só pela meta — piso não soma em cima", async () => {
    const lombo = produto({ id: "lombo", nome: "Lombinho Canadense Fatiado", estoque_atual: 0 });
    mockListProdutos.mockResolvedValue([...produtos, lombo]);
    mockListSabores.mockResolvedValue([sabor({ id: "s1", nome: "Lombo c/ catupiry", piso_minimo_pizzas: 4 })]);
    mockListIngredientes.mockResolvedValue([
      { id: "i1", sabor_id: "s1", produto_id: lombo.id, grupo_substituicao_id: null, quantidade: 0.18, unidade: "kg" },
    ]);

    // meta = 20 pizzas Basílico; piso do Lombo continua em 4 pizzas —
    // massa deve ser 20 (só a meta), NÃO 24 (meta + piso, comportamento antigo)
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 20, qtdPizzasPopulares: 0, registrarMeta: false });
    const massaItem = resultado.itens.find((i) => i.produtoNome === "Massa de Pizza")!;
    expect(massaItem.necessario).toBe(20);
  });

  it("ingrediente compartilhado por 2+ sabores: mediana das contribuições × 1,5 (não soma)", async () => {
    const bacon = produto({ id: "bacon", nome: "Bacon em Cubos", estoque_atual: 0 });
    mockListProdutos.mockResolvedValue([...produtos, bacon]);

    // 3 sabores usando bacon, cada um com piso e quantidade diferentes:
    //   A: 0.16kg * 4 = 0.64
    //   B: 0.09kg * 4 = 0.36
    //   C: 0.16kg * 5 = 0.80  (piso maior, ex: grupo doce hipotético)
    // mediana(0.64, 0.36, 0.80) = 0.64  →  0.64 * 1.5 = 0.96
    mockListSabores.mockResolvedValue([
      sabor({ id: "sA", nome: "Corn e Bacon", piso_minimo_pizzas: 4 }),
      sabor({ id: "sB", nome: "Calabresa e Bacon", piso_minimo_pizzas: 4 }),
      sabor({ id: "sC", nome: "Bacon Especial", piso_minimo_pizzas: 5 }),
    ]);
    mockListIngredientes.mockResolvedValue([
      { id: "iA", sabor_id: "sA", produto_id: bacon.id, grupo_substituicao_id: null, quantidade: 0.16, unidade: "kg" },
      { id: "iB", sabor_id: "sB", produto_id: bacon.id, grupo_substituicao_id: null, quantidade: 0.09, unidade: "kg" },
      { id: "iC", sabor_id: "sC", produto_id: bacon.id, grupo_substituicao_id: null, quantidade: 0.16, unidade: "kg" },
    ]);

    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 0, registrarMeta: false });
    const baconItem = resultado.itens.find((i) => i.produtoNome === bacon.nome)!;

    expect(baconItem.necessario).toBeCloseTo(0.96);
    expect(baconItem.motivo).toContain("compartilhado entre 3 sabores");
    expect(baconItem.motivo).toContain("mediana");
  });
});

describe("calcularSugestaoCompra — explosão de manipulado em brutos", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocksBasicos();
  });

  it("substitui o manipulado pelos insumos brutos da ficha técnica, proporcional à falta", async () => {
    // Farinha: 0.5kg por unidade de Massa; Queijo (Massa) não tem estoque_minimo
    const farinha = produto({ id: "farinha", nome: "Farinha de Trigo", estoque_atual: 100 });
    mockListProdutos.mockResolvedValue([...produtos, farinha]);

    const ficha: FichaTecnica = {
      id: "f1",
      produto_manipulado_id: massa.id, // estoque 10
      produto_bruto_id: farinha.id,
      quantidade_bruto_por_unidade: 0.5,
      perda_pct: null,
      observacoes: null,
    };
    mockListFichas.mockResolvedValue([ficha]);

    // necessário de Massa = 20un, estoque 10 -> falta 10un -> 10 * 0.5 = 5kg de farinha
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 20, qtdPizzasPopulares: 0, registrarMeta: false });

    expect(resultado.itens.find((i) => i.produtoNome === "Massa de Pizza")).toBeUndefined();

    const farinhaItem = resultado.itens.find((i) => i.produtoNome === "Farinha de Trigo")!;
    expect(farinhaItem.necessario).toBeCloseTo(5);
    expect(farinhaItem.estoqueAtual).toBe(100);
    expect(farinhaItem.falta).toBe(0); // 100kg em estoque cobre de sobra
  });

  it("não gera necessidade de bruto quando o estoque do manipulado já cobre a meta", async () => {
    const farinha = produto({ id: "farinha", nome: "Farinha de Trigo", estoque_atual: 100 });
    mockListProdutos.mockResolvedValue([...produtos, farinha]);
    mockListFichas.mockResolvedValue([
      { id: "f1", produto_manipulado_id: massa.id, produto_bruto_id: farinha.id, quantidade_bruto_por_unidade: 0.5, perda_pct: null, observacoes: null },
    ]);

    // meta pede só 5 pizzas -> necessário de Massa = 5un, estoque 10un cobre -> falta 0, sem explosão
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 5, qtdPizzasPopulares: 0, registrarMeta: false });

    expect(resultado.itens.find((i) => i.produtoNome === "Massa de Pizza")).toBeUndefined();
    expect(resultado.itens.find((i) => i.produtoNome === "Farinha de Trigo")).toBeUndefined();
  });

  it("soma a necessidade explodida com o uso direto do mesmo bruto por outro sabor", async () => {
    const farinha = produto({ id: "farinha", nome: "Farinha de Trigo", estoque_atual: 0 });
    mockListProdutos.mockResolvedValue([...produtos, farinha]);
    mockListFichas.mockResolvedValue([
      { id: "f1", produto_manipulado_id: massa.id, produto_bruto_id: farinha.id, quantidade_bruto_por_unidade: 0.5, perda_pct: null, observacoes: null },
    ]);

    // piso de segurança de um sabor hipotético que usa Farinha direto (bruto)
    mockListSabores.mockResolvedValue([
      { id: "s1", nome: "Sabor com farinha direta", tipo: "piso_seguranca", categoria: "salgada", piso_minimo_pizzas: 4, queijo_override_kg: null, ativo: true, observacoes: null },
    ]);
    mockListIngredientes.mockResolvedValue([
      { id: "i1", sabor_id: "s1", produto_id: farinha.id, grupo_substituicao_id: null, quantidade: 1, unidade: "kg" },
    ]);

    // Massa: necessário 4 (meta 0 + piso 4un), estoque 10 -> falta 0 -> sem explosão
    // Farinha direta: 1kg * 4 = 4kg
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 0, registrarMeta: false });
    const farinhaItem = resultado.itens.find((i) => i.produtoNome === "Farinha de Trigo")!;
    expect(farinhaItem.necessario).toBeCloseTo(4);
  });

  it("mantém o manipulado direto (com aviso) quando não há ficha técnica cadastrada", async () => {
    // sem mockListFichas customizado -> fica [] (default), então Massa (falta 10) some
    // sem entrar no fallback? Não: setupMocksBasicos já deixa fichas=[] -> fallback ativa.
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 20, qtdPizzasPopulares: 0, registrarMeta: false });
    const massaItem = resultado.itens.find((i) => i.produtoNome === "Massa de Pizza")!;
    expect(massaItem).toBeDefined();
    expect(massaItem.motivo).toContain("sem ficha técnica cadastrada");
  });
});

describe("calcularSugestaoCompra — valor estimado", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocksBasicos();
  });

  it("calcula valorEstimado = precoUnitario × sugestaoArredondada e soma no total", async () => {
    const caixaComPreco = produto({ id: "caixa-b", nome: "Caixa de Pizza Basílico", unidade: "un", estoque_atual: 5, preco_unitario: 2.5 });
    mockListProdutos.mockResolvedValue([massa, molho, queijo, caixaComPreco]);

    // necessário: 20un, estoque 5 -> falta 15 -> 15 * 2.5 = 37.5
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 20, qtdPizzasPopulares: 0, registrarMeta: false });
    const caixaItem = resultado.itens.find((i) => i.produtoNome === "Caixa de Pizza Basílico")!;

    expect(caixaItem.valorEstimado).toBeCloseTo(37.5);
    expect(resultado.valorTotalEstimado).toBeGreaterThanOrEqual(37.5);
  });

  it("conta itens sem preço cadastrado em vez de tratar como zero", async () => {
    // Massa (fallback, sem ficha) não tem preco_unitario -> não deveria contar no total
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 20, qtdPizzasPopulares: 0, registrarMeta: false });
    const massaItem = resultado.itens.find((i) => i.produtoNome === "Massa de Pizza")!;

    expect(massaItem.valorEstimado).toBeNull();
    expect(resultado.itensComPrecoDesconhecido).toBeGreaterThan(0);
  });

  it("usa o preço do membro mais barato do pool como estimativa", async () => {
    const grupo: GrupoSubstituicao = { id: "g1", nome: "Requeijão (populares)", categoria: "requeijao", observacoes: null };
    mockListGrupos.mockResolvedValue([grupo]);

    const barato = produto({ id: "r1", nome: "Requeijão Genérico", estoque_atual: 0, preco_unitario: 17.9 });
    const caro = produto({ id: "r2", nome: "Requeijão Puranata", estoque_atual: 0, preco_unitario: 64.9 });
    mockGetMembrosGrupo.mockResolvedValue([barato, caro]);

    mockListSabores.mockResolvedValue([
      { id: "s1", nome: "Sabor pool", tipo: "piso_seguranca", categoria: "salgada", piso_minimo_pizzas: 4, queijo_override_kg: null, ativo: true, observacoes: null },
    ]);
    mockListIngredientes.mockResolvedValue([
      { id: "i1", sabor_id: "s1", produto_id: null, grupo_substituicao_id: grupo.id, quantidade: 0.1, unidade: "kg" },
    ]);

    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 0, registrarMeta: false });
    const item = resultado.itens.find((i) => i.produtoNome === grupo.nome)!;

    expect(item.precoUnitario).toBe(17.9);
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
      quantidade_minima: null,
      ativo: true,
    };
    mockListPadroes.mockResolvedValue([padrao]);

    // necessário: 0.2kg * 30 pizzas = 6kg, estoque 0 -> falta 6kg -> arredonda pra 8kg (múltiplo de 4)
    // queijo é manipulado sem ficha cadastrada -> cai no fallback, que também aplica padrão de embalagem
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 30, qtdPizzasPopulares: 0, registrarMeta: false });
    const queijoItem = resultado.itens.find((i) => i.produtoNome === "Queijo Triturado")!;
    expect(queijoItem.falta).toBe(6);
    expect(queijoItem.sugestaoArredondada).toBe(8);
    expect(queijoItem.origemPadrao).toBe(padrao.nome_padrao);
  });

  it("[quantidade_minima] respeita piso de compra diferente do incremento (Pepperoni: mín. 1kg, passos de 0,5kg)", async () => {
    const pepperoni = produto({ id: "pepperoni", nome: "Pepperoni", estoque_atual: 0 });
    mockListProdutos.mockResolvedValue([...produtos, pepperoni]);
    mockListPadroes.mockResolvedValue([
      {
        id: "pp1",
        produto_id: pepperoni.id,
        nome_padrao: "Mínimo 1kg, passos de 0,5kg",
        unidades_por_padrao: 1,
        peso_ou_volume_por_unidade: 0.5,
        multiplo_minimo: null,
        quantidade_minima: 1,
        ativo: true,
      },
    ]);
    mockListSabores.mockResolvedValue([
      { id: "s1", nome: "Sabor com pepperoni", tipo: "piso_seguranca", categoria: "salgada", piso_minimo_pizzas: 4, queijo_override_kg: null, ativo: true, observacoes: null },
    ]);

    // falta pequena (bem abaixo do mínimo) -> compra exatamente o mínimo, 1kg
    mockListIngredientes.mockResolvedValue([
      { id: "i1", sabor_id: "s1", produto_id: pepperoni.id, grupo_substituicao_id: null, quantidade: 0.08, unidade: "kg" },
    ]);
    const resultadoBaixo = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 0, registrarMeta: false });
    expect(resultadoBaixo.itens.find((i) => i.produtoNome === "Pepperoni")!.sugestaoArredondada).toBe(1);

    // falta de 1.1kg -> passa do mínimo, sobe pro próximo passo de 0,5kg: 1,5kg (não 2kg)
    mockListIngredientes.mockResolvedValue([
      { id: "i1", sabor_id: "s1", produto_id: pepperoni.id, grupo_substituicao_id: null, quantidade: 0.275, unidade: "kg" },
    ]);
    const resultadoAlto = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 0, registrarMeta: false });
    expect(resultadoAlto.itens.find((i) => i.produtoNome === "Pepperoni")!.sugestaoArredondada).toBe(1.5);
  });

  it("[multiplo_minimo em unidade discreta] Caixa de Pizza Genérica só sugere em pacotes fechados de 25", async () => {
    const caixaComPadrao = produto({ id: "caixa-b", nome: "Caixa de Pizza Genérica", unidade: "un", marca: "populares", estoque_atual: 18 });
    mockListProdutos.mockResolvedValue([massa, molho, queijo, caixaComPadrao]);
    mockListItensUniversais.mockResolvedValue([
      { id: "4", categoria: "ambas", produto_id: caixaComPadrao.id, grupo_substituicao_id: null, marca: "populares", quantidade: 1, unidade: "un", observacoes: null, ativo: true },
    ]);
    mockListPadroes.mockResolvedValue([
      {
        id: "pcx1",
        produto_id: caixaComPadrao.id,
        nome_padrao: "Pacote de 25 unidades",
        unidades_por_padrao: 25,
        peso_ou_volume_por_unidade: 1,
        multiplo_minimo: 25,
        quantidade_minima: null,
        ativo: true,
      },
    ]);

    // necessário 20un, estoque 18un -> falta 2un -> sem padrão seria "2 un",
    // com o pacote de 25 tem que virar 1 pacote inteiro (25un)
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 20, registrarMeta: false });
    const caixaItem = resultado.itens.find((i) => i.produtoNome === "Caixa de Pizza Genérica")!;
    expect(caixaItem.falta).toBe(2);
    expect(caixaItem.sugestaoArredondada).toBe(25);
  });

  it("converte kg da receita pra unidade discreta de estoque (bisnaga) e arredonda pro inteiro, nunca fração", async () => {
    // produto tracked em "bisnaga" (~1,5kg cada), receita pede em kg
    const requeijao = produto({ id: "req", nome: "Requeijão Genérico", unidade: "bisnaga", estoque_atual: 0 });
    mockListProdutos.mockResolvedValue([...produtos, requeijao]);
    mockListPadroes.mockResolvedValue([
      { id: "pr1", produto_id: requeijao.id, nome_padrao: "Bisnaga 1,5kg", unidades_por_padrao: 1, peso_ou_volume_por_unidade: 1.5, multiplo_minimo: null, quantidade_minima: null, ativo: true },
    ]);
    mockListSabores.mockResolvedValue([
      { id: "s1", nome: "Sabor com requeijão", tipo: "piso_seguranca", categoria: "salgada", piso_minimo_pizzas: 4, queijo_override_kg: null, ativo: true, observacoes: null },
    ]);
    // 0.09kg por pizza * 4 = 0.36kg necessários -> 0.36/1.5 = 0.24 bisnaga -> arredonda pra 1 bisnaga inteira
    mockListIngredientes.mockResolvedValue([
      { id: "i1", sabor_id: "s1", produto_id: requeijao.id, grupo_substituicao_id: null, quantidade: 0.09, unidade: "kg" },
    ]);

    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 0, registrarMeta: false });
    const item = resultado.itens.find((i) => i.produtoNome === "Requeijão Genérico")!;

    expect(item.unidade).toBe("bisnaga");
    expect(item.sugestaoArredondada).toBe(1); // nunca "0,24 bisnaga"
    expect(Number.isInteger(item.sugestaoArredondada)).toBe(true);
  });

  it("item solto sem padrão cadastrado arredonda pro inteiro mais próximo pra cima (nunca fração)", async () => {
    const tomate = produto({ id: "tomate", nome: "Tomate", unidade: "kg", estoque_atual: 0 });
    mockListProdutos.mockResolvedValue([...produtos, tomate]);
    mockListSabores.mockResolvedValue([
      { id: "s1", nome: "Sabor com tomate", tipo: "piso_seguranca", categoria: "salgada", piso_minimo_pizzas: 4, queijo_override_kg: null, ativo: true, observacoes: null },
    ]);
    // 0.35kg * 4 = 1.4kg necessários, sem padrão -> arredonda pra 2kg (inteiro pra cima)
    mockListIngredientes.mockResolvedValue([
      { id: "i1", sabor_id: "s1", produto_id: tomate.id, grupo_substituicao_id: null, quantidade: 0.35, unidade: "kg" },
    ]);

    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 0, registrarMeta: false });
    const item = resultado.itens.find((i) => i.produtoNome === "Tomate")!;

    expect(item.falta).toBeCloseTo(1.4);
    expect(item.sugestaoArredondada).toBe(2);
    expect(Number.isInteger(item.sugestaoArredondada)).toBe(true);
  });
});

describe("formatarSugestaoWhatsApp", () => {
  it("informa quando não há necessidade de compra", () => {
    const texto = formatarSugestaoWhatsApp({
      meta: { validoAte: null, qtdPizzasBasilico: 10, qtdPizzasPopulares: 0 },
      itens: [],
      valorTotalEstimado: 0,
      itensComPrecoDesconhecido: 0,
      custoPorPizza: 0,
      alertaCustoExcedido: false,
    });
    expect(texto).toContain("nenhuma compra necessária");
  });

  it("lista itens com falta, valor estimado, total e tag de pool quando aplicável", () => {
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
          precoUnitario: 39.9,
          valorEstimado: 159.6,
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
          precoUnitario: 17.9,
          valorEstimado: 35.8,
        },
      ],
      valorTotalEstimado: 195.4,
      itensComPrecoDesconhecido: 0,
      custoPorPizza: 19.54,
      alertaCustoExcedido: false,
    });

    expect(texto).toContain("Queijo Triturado");
    expect(texto).toContain("2026-08-27");
    expect(texto).toContain("pool");
    expect(texto).toContain("195,40");
    expect(texto).toContain("Total estimado");
  });

  it("[failsafe] custo por pizza acima do limite vira alerta, não a lista pronta pra aprovar", () => {
    const texto = formatarSugestaoWhatsApp({
      meta: { validoAte: null, qtdPizzasBasilico: 5, qtdPizzasPopulares: 0 },
      itens: [
        {
          produtoId: "queijo",
          produtoNome: "Queijo Triturado",
          unidade: "kg",
          isPool: false,
          necessario: 5,
          estoqueAtual: 0,
          falta: 5,
          sugestaoArredondada: 5,
          motivo: "item universal",
          precoUnitario: 250,
          valorEstimado: 1250,
        },
      ],
      valorTotalEstimado: 1250,
      itensComPrecoDesconhecido: 0,
      custoPorPizza: 250,
      alertaCustoExcedido: true,
    });

    expect(texto).toContain("CUSTO FORA DO ESPERADO");
    expect(texto).toContain("REVISÃO MANUAL");
    expect(texto).not.toContain("Queijo Triturado"); // não lista os itens como se estivesse pronto
  });
});

describe("calcularSugestaoCompra — failsafe de custo por pizza", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocksBasicos();
  });

  it("marca alertaCustoExcedido quando custo/pizza passa do limite (R$40)", async () => {
    const queijoCaro = produto({ id: "queijo", nome: "Queijo Triturado", tipo: "manipulado", marca: "basilico", estoque_atual: 0, preco_unitario: 300 });
    mockListProdutos.mockResolvedValue([massa, molho, queijoCaro, caixaBasilico]);

    // 10 pizzas Basílico -> queijo necessário 2kg * R$300 = R$600 -> R$60/pizza (> R$40)
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 10, qtdPizzasPopulares: 0, registrarMeta: false });

    expect(resultado.custoPorPizza).toBeGreaterThan(40);
    expect(resultado.alertaCustoExcedido).toBe(true);
  });

  it("não alerta quando custo/pizza está dentro do limite", async () => {
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 10, qtdPizzasPopulares: 0, registrarMeta: false });
    expect(resultado.alertaCustoExcedido).toBe(false);
  });

  it("custoPorPizza é null quando não há pizzas pedidas", async () => {
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: 0, qtdPizzasPopulares: 0, registrarMeta: false });
    expect(resultado.custoPorPizza).toBeNull();
    expect(resultado.alertaCustoExcedido).toBe(false);
  });
});
