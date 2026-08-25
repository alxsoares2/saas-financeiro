import { handleFotoEstoque, handleRespostaConfirmacaoFoto } from "../src/services/estoque/whatsapp-fotos";
import * as db from "../src/services/estoque/db";
import * as fotoContagem from "../src/services/estoque/foto-contagem";
import * as zapi from "../src/services/zapi";
import { Produto } from "../src/services/estoque/types";

jest.mock("../src/services/estoque/db");
jest.mock("../src/services/estoque/foto-contagem");
jest.mock("../src/services/zapi");

const mockListProdutos = db.listProdutos as jest.MockedFunction<typeof db.listProdutos>;
const mockListPadroes = db.listPadroesEmbalagem as jest.MockedFunction<typeof db.listPadroesEmbalagem>;
const mockRegistrarMovimentacao = db.registrarMovimentacao as jest.MockedFunction<typeof db.registrarMovimentacao>;
const mockTriarFoto = fotoContagem.triarFoto as jest.MockedFunction<typeof fotoContagem.triarFoto>;
const mockExtrairLista = fotoContagem.extrairListaContagem as jest.MockedFunction<typeof fotoContagem.extrairListaContagem>;
const mockContarProdutosVisiveis = fotoContagem.contarProdutosVisiveis as jest.MockedFunction<typeof fotoContagem.contarProdutosVisiveis>;
const mockSendTextMessage = zapi.sendTextMessage as jest.MockedFunction<typeof zapi.sendTextMessage>;

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

const tomate = produto({ id: "tomate", nome: "Tomate", estoque_atual: 2 });
const queijo = produto({ id: "queijo", nome: "Queijo Mussarela", unidade: "kg", estoque_atual: 3 });
const requeijao = produto({ id: "requeijao", nome: "Requeijão Genérico", unidade: "kg", estoque_atual: 1 });

const buffer = Buffer.from("fake-image");

beforeEach(() => {
  jest.clearAllMocks();
  mockListProdutos.mockResolvedValue([tomate, queijo, requeijao]);
  mockListPadroes.mockResolvedValue([]);
  mockRegistrarMovimentacao.mockResolvedValue({} as any);
  mockSendTextMessage.mockResolvedValue(undefined);
});

describe("handleFotoEstoque — lista impressa", () => {
  it("grava direto item com produto encontrado e confiança alta", async () => {
    mockTriarFoto.mockResolvedValue({ tipo: "lista_impressa", confianca: "alta" });
    mockExtrairLista.mockResolvedValue({
      itens: [{ nome: "Tomate", quantidade: 5, unidade: "kg", confianca: "alta" }],
    });

    await handleFotoEstoque("chat1", buffer, "image/jpeg", undefined, "https://foto.url/1.jpg");

    expect(mockRegistrarMovimentacao).toHaveBeenCalledWith(
      expect.objectContaining({ produtoId: "tomate", quantidade: 5, estoqueResultante: 5, origem: "foto_lista_impressa" })
    );
    const texto = mockSendTextMessage.mock.calls[0][1];
    expect(texto).toContain("gravado");
  });

  it("manda pra confirmação item sem produto encontrado, mesmo com confiança alta", async () => {
    mockTriarFoto.mockResolvedValue({ tipo: "lista_impressa", confianca: "alta" });
    mockExtrairLista.mockResolvedValue({
      itens: [{ nome: "Produto Inexistente XYZ", quantidade: 3, unidade: null, confianca: "alta" }],
    });

    await handleFotoEstoque("chat2", buffer, "image/jpeg", undefined, "https://foto.url/2.jpg");

    expect(mockRegistrarMovimentacao).not.toHaveBeenCalled();
    const texto = mockSendTextMessage.mock.calls[0][1];
    expect(texto).toContain("confirmação");
  });
});

describe("handleFotoEstoque — lista manuscrita", () => {
  it("NUNCA grava direto, mesmo com produto encontrado e confiança alta", async () => {
    mockTriarFoto.mockResolvedValue({ tipo: "lista_manuscrita", confianca: "alta" });
    mockExtrairLista.mockResolvedValue({
      itens: [{ nome: "Tomate", quantidade: 5, unidade: "kg", confianca: "alta" }],
    });

    await handleFotoEstoque("chat3", buffer, "image/jpeg", undefined, "https://foto.url/3.jpg");

    expect(mockRegistrarMovimentacao).not.toHaveBeenCalled();
    const texto = mockSendTextMessage.mock.calls[0][1];
    expect(texto).toContain("confirmação");
  });
});

describe("handleFotoEstoque — produto físico", () => {
  it("sempre confirma, mesmo com produto identificado e confiança alta (1 produto só)", async () => {
    mockTriarFoto.mockResolvedValue({ tipo: "produto_fisico", confianca: "alta" });
    mockContarProdutosVisiveis.mockResolvedValue({
      itens: [{ nome: "Queijo Mussarela", quantidade: 12, unidade: "kg", confianca: "alta" }],
    });

    await handleFotoEstoque("chat4", buffer, "image/jpeg", "queijo mussarela", "https://foto.url/4.jpg");

    expect(mockRegistrarMovimentacao).not.toHaveBeenCalled();
    const texto = mockSendTextMessage.mock.calls[0][1];
    expect(texto).toContain("Queijo Mussarela");
    expect(texto).toContain("12");
    expect(texto).toContain("sim");
  });

  it("reconhece VÁRIOS produtos na mesma foto (ex: geladeira) e pede confirmação de todos", async () => {
    mockTriarFoto.mockResolvedValue({ tipo: "produto_fisico", confianca: "media" });
    mockContarProdutosVisiveis.mockResolvedValue({
      itens: [
        { nome: "Queijo Mussarela", quantidade: 4, unidade: "kg", confianca: "media" },
        { nome: "Requeijão Genérico", quantidade: 1.5, unidade: "kg", confianca: "media" },
        { nome: "Tomate", quantidade: 3, unidade: "kg", confianca: "baixa" },
      ],
    });

    await handleFotoEstoque("chat-geladeira", buffer, "image/jpeg", undefined, "https://foto.url/geladeira.jpg");

    // produto físico nunca grava direto, mesmo com 3 itens reconhecidos
    expect(mockRegistrarMovimentacao).not.toHaveBeenCalled();
    const texto = mockSendTextMessage.mock.calls[0][1];
    expect(texto).toContain("Queijo Mussarela");
    expect(texto).toContain("Requeijão Genérico");
    expect(texto).toContain("Tomate");
    expect(texto).toContain("3 itens precisam de confirmação");
    expect(texto).toContain("fotos separadas por categoria"); // dica de segmentação (>2 itens)

    const confirmado = await handleRespostaConfirmacaoFoto("chat-geladeira", "sim", "Fulano");
    expect(confirmado).toBe(true);
    expect(mockRegistrarMovimentacao).toHaveBeenCalledTimes(3);
  });

  it("NÃO mostra a dica de segmentação com poucos itens (<=2)", async () => {
    mockTriarFoto.mockResolvedValue({ tipo: "produto_fisico", confianca: "alta" });
    mockContarProdutosVisiveis.mockResolvedValue({
      itens: [{ nome: "Queijo Mussarela", quantidade: 4, unidade: "kg", confianca: "alta" }],
    });

    await handleFotoEstoque("chat-poucositens", buffer, "image/jpeg", undefined, "https://foto.url/poucos.jpg");

    const texto = mockSendTextMessage.mock.calls[0][1];
    expect(texto).not.toContain("fotos separadas por categoria");
  });

  it("não confirma nada quando não consegue identificar produto nem contar", async () => {
    mockTriarFoto.mockResolvedValue({ tipo: "produto_fisico", confianca: "baixa" });
    mockContarProdutosVisiveis.mockResolvedValue({ itens: [] });

    await handleFotoEstoque("chat5", buffer, "image/jpeg", undefined, "https://foto.url/5.jpg");

    expect(mockRegistrarMovimentacao).not.toHaveBeenCalled();
    const texto = mockSendTextMessage.mock.calls[0][1];
    expect(texto).toContain("Não consegui");
  });
});

describe("handleRespostaConfirmacaoFoto", () => {
  async function gerarPendencia(chatId: string) {
    mockTriarFoto.mockResolvedValue({ tipo: "lista_manuscrita", confianca: "alta" });
    mockExtrairLista.mockResolvedValue({
      itens: [
        { nome: "Tomate", quantidade: 5, unidade: "kg", confianca: "alta" },
        { nome: "Queijo Mussarela", quantidade: 2, unidade: "kg", confianca: "media" },
      ],
    });
    await handleFotoEstoque(chatId, buffer, "image/jpeg", undefined, "https://foto.url/x.jpg");
    mockSendTextMessage.mockClear();
  }

  it("retorna false quando não há confirmação pendente", async () => {
    const tratado = await handleRespostaConfirmacaoFoto("chat-sem-pendencia", "sim", "Fulano");
    expect(tratado).toBe(false);
  });

  it('"sim" confirma todos os itens pendentes', async () => {
    await gerarPendencia("chat6");
    const tratado = await handleRespostaConfirmacaoFoto("chat6", "sim", "Fulano");

    expect(tratado).toBe(true);
    expect(mockRegistrarMovimentacao).toHaveBeenCalledTimes(2);
    expect(mockRegistrarMovimentacao).toHaveBeenCalledWith(expect.objectContaining({ produtoId: "tomate", quantidade: 5, confirmadoPor: "Fulano" }));
    expect(mockRegistrarMovimentacao).toHaveBeenCalledWith(expect.objectContaining({ produtoId: "queijo", quantidade: 2 }));

    // segunda resposta não encontra mais pendência (já foi consumida)
    const tratado2 = await handleRespostaConfirmacaoFoto("chat6", "sim", "Fulano");
    expect(tratado2).toBe(false);
  });

  it('"não" descarta sem gravar nada', async () => {
    await gerarPendencia("chat7");
    const tratado = await handleRespostaConfirmacaoFoto("chat7", "não", "Fulano");

    expect(tratado).toBe(true);
    expect(mockRegistrarMovimentacao).not.toHaveBeenCalled();
    expect(mockSendTextMessage.mock.calls[0][1]).toContain("Descartado");
  });

  it('"sim 1" confirma só o item selecionado', async () => {
    await gerarPendencia("chat8");
    const tratado = await handleRespostaConfirmacaoFoto("chat8", "sim 1", "Fulano");

    expect(tratado).toBe(true);
    expect(mockRegistrarMovimentacao).toHaveBeenCalledTimes(1);
    expect(mockRegistrarMovimentacao).toHaveBeenCalledWith(expect.objectContaining({ produtoId: "tomate" }));
  });

  it("texto não relacionado devolve false e não mexe na pendência", async () => {
    await gerarPendencia("chat9");
    const tratado = await handleRespostaConfirmacaoFoto("chat9", "sugestao 10 20", "Fulano");
    expect(tratado).toBe(false);
    expect(mockRegistrarMovimentacao).not.toHaveBeenCalled();

    // pendência continua viva — "sim" depois ainda funciona
    const tratado2 = await handleRespostaConfirmacaoFoto("chat9", "sim", "Fulano");
    expect(tratado2).toBe(true);
    expect(mockRegistrarMovimentacao).toHaveBeenCalledTimes(2);
  });
});
