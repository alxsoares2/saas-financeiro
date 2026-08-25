// Motor de sugestão de compra — equivalente ao calcularDRE() do módulo
// financeiro, mas pro estoque. Ver SPEC-estoque-manipulacao.md seções 4 a 10.
//
// Premissas assumidas explicitamente (a spec deixa como "ajustar durante
// implementação" ou "a confirmar" — documentadas aqui pra revisão fácil):
//
// 1. Os sabores-âncora (tipo='ancora') NÃO entram no cálculo de ingredientes
//    exclusivos (frango desfiado, calabresa fatiada, requeijão etc) — só os
//    itens UNIVERSAIS são dimensionados pela meta interativa. A spec é
//    explícita: "o sistema não tenta prever a proporção exata por sabor,
//    só garante que os universais cubram o total pedido" (seção 7). Decidir
//    quanto de frango/calabresa/requeijão comprar pros âncoras fica com o
//    time — o relatório apenas lista o estoque atual desses insumos como
//    referência, sem sugestão automática.
// 2. [CORRIGIDO — antes somava, causava dupla contagem] Os itens
//    UNIVERSAIS (massa/molho/queijo/caixa/lacre/orégano) são dimensionados
//    SÓ pela meta principal (qtdPizzasBasilico + qtdPizzasPopulares) — o
//    piso de segurança por sabor NUNCA entra nesse total. Antes, cada uma
//    das ~34 sabores de piso somava seu piso mínimo ao total de pizzas
//    usado pros universais, inflando artificialmente o "necessário" de
//    praticamente todo item do relatório (farinha, queijo, caixa etc.)
//    bem acima do que a meta pedida realmente precisa. O piso de segurança
//    continua existindo, mas só afeta os ingredientes EXCLUSIVOS de cada
//    sabor individual (seção 3 abaixo) — nunca os universais compartilhados.
// 3. Refrigerante Basílico assume proporção normal:zero de 2:1 (spec diz
//    "o bot já assume", sem confirmar o valor exato — seção 9). Ajustável
//    em REFRIGERANTE_BASILICO_PROPORCAO_ZERO abaixo.
// 4. Piso mínimo padrão pra sabores piso_seguranca não-doce é 4 pizzas
//    (spec diz "3-4", ficamos com o teto pra manter a margem de segurança
//    já usada em outras regras da spec). Grupo doce usa 5 (seção 6).
// 5. Ingrediente de piso de segurança compartilhado por 2+ sabores: em vez
//    de somar a contribuição (qtd_por_pizza × piso) de cada sabor, usa a
//    MEDIANA dessas contribuições × 1,5 — soma pura superestima muito
//    quando vários sabores de baixo giro dividem o mesmo insumo (não são
//    todos feitos no piso máximo ao mesmo tempo). Ingrediente usado por
//    um único sabor mantém a soma direta (== o próprio valor).
// 6. Produto tipo='manipulado' nunca aparece como sugestão de compra
//    direta — a falta dele (necessário + estoque_minimo − estoque_atual)
//    é explodida via fichas_tecnicas nos insumos brutos correspondentes,
//    que entram no relatório em vez do manipulado. Confirmado com o
//    cliente: nunca há manipulado que depende de outro manipulado, então
//    a explosão é sempre de 1 nível só (sem recursão). Manipulado sem
//    ficha técnica cadastrada é um fallback — fica listado direto, com
//    aviso, em vez de sumir silenciosamente do relatório.
// 7. Valor estimado por item = preco_unitario (cadastrado em produtos) ×
//    quantidade sugerida (já arredondada pelo padrão de embalagem). Pool
//    usa o preco_unitario do membro mais barato (mesma lógica já usada
//    pra escolher o refrigerante popular). Item sem preço cadastrado não
//    entra no total (fica contado em itensComPrecoDesconhecido).
// 8. Arredondamento sempre inteiro, sempre pra cima, nunca fração:
//    - Produto com padrões_embalagem cadastrado E unidade CONTÍNUA (kg/g/
//      l/ml, ex: Queijo Mussarela em kg com barra de 4kg): arredonda pro
//      múltiplo inteiro do tamanho da embalagem.
//    - Produto com padrões_embalagem cadastrado E unidade DISCRETA (ex:
//      Requeijão em "bisnaga", Chocolate em "barra"): a ficha técnica
//      declara a necessidade em kg, então primeiro CONVERTE kg→unidade de
//      estoque usando o padrão (kg por 1 unidade), depois arredonda pro
//      inteiro de unidades mais próximo pra cima (nunca "1,34 bisnaga").
//    - Produto solto sem padrão cadastrado (tomate, banana, milho...):
//      arredonda pro inteiro mais próximo pra cima, na própria unidade
//      (kg ou un) — nunca fração.
//    Quando a unidade da receita (ficha técnica/sabor) difere da unidade
//    de estoque do produto e NÃO há padrão cadastrado pra converter, a
//    quantidade fica na unidade da receita mesmo (mais visível o
//    descompasso do que escondê-lo) — ver script scripts/_audit_padroes*.ts
//    pra levantar esses casos.
// 9. Failsafe de custo por pizza: valorTotalEstimado ÷ (qtdPizzasBasilico +
//    qtdPizzasPopulares) — se passar de LIMITE_CUSTO_POR_PIZZA_REAIS, o
//    resultado vem marcado com alertaCustoExcedido=true. Quem consome o
//    resultado (formatarSugestaoWhatsApp, comandos de WhatsApp) deve tratar
//    isso como "não mandar como se estivesse pronto pra aprovar" — vira um
//    alerta pedindo revisão manual, não a lista de compra normal. O cálculo
//    completo continua disponível (ex: em PDF) pra quem for investigar.
import {
  criarMetaProducao,
  getMembrosGrupo,
  listFichasTecnicas,
  listGruposSubstituicao,
  listItensUniversais,
  listPadroesEmbalagem,
  listProdutos,
  listSabores,
  listTodosIngredientesSabores,
} from "./db.js";
import {
  CategoriaItemUniversal,
  GrupoSubstituicao,
  Marca,
  NecessidadeInsumo,
  PadraoEmbalagem,
  Produto,
  RefInsumo,
  SaborIngrediente,
  SugestaoCompraResultado,
} from "./types.js";

export const REFRIGERANTE_BASILICO_PCT_DAS_PIZZAS = 0.6;
export const REFRIGERANTE_POPULARES_PCT_DAS_PIZZAS = 0.7;
export const REFRIGERANTE_BASILICO_PROPORCAO_ZERO = 1 / 3; // 2:1 normal:zero
export const PISO_MINIMO_PADRAO_PIZZAS = 4;
export const PISO_MINIMO_DOCE_PIZZAS = 5;
export const MARGEM_INGREDIENTE_COMPARTILHADO = 1.5;
export const LIMITE_CUSTO_POR_PIZZA_REAIS = 40;

interface Acumulador {
  chave: string; // "produto:<id>" ou "grupo:<id>"
  isPool: boolean;
  refId: string;
  necessario: number;
  unidade: string;
  motivos: Set<string>;
}

function chaveDe(ref: RefInsumo): string {
  return ref.produto_id ? `produto:${ref.produto_id}` : `grupo:${ref.grupo_substituicao_id}`;
}

function acumular(mapa: Map<string, Acumulador>, ref: RefInsumo, qtd: number, unidade: string, motivo: string) {
  if (qtd <= 0) return;
  const chave = chaveDe(ref);
  const existente = mapa.get(chave);
  if (existente) {
    existente.necessario += qtd;
    existente.motivos.add(motivo);
  } else {
    mapa.set(chave, {
      chave,
      isPool: !!ref.grupo_substituicao_id,
      refId: (ref.produto_id ?? ref.grupo_substituicao_id)!,
      necessario: qtd,
      unidade,
      motivos: new Set([motivo]),
    });
  }
}

function mediana(valores: number[]): number {
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 !== 0 ? ordenados[meio] : (ordenados[meio - 1] + ordenados[meio]) / 2;
}

// Unidades "contínuas" (peso/volume) — só essas fazem sentido como
// múltiplo fracionário de um padrão de embalagem (ex: barra de 4kg).
// Qualquer outra unidade (bisnaga, barra, pacote, balde, un, maço...) é
// inerentemente discreta — compra-se em unidades inteiras dela.
const UNIDADES_CONTINUAS = new Set(["kg", "g", "l", "ml"]);

function ehUnidadeContinua(unidade: string): boolean {
  return UNIDADES_CONTINUAS.has(unidade.toLowerCase().trim());
}

function normalizarUnidade(unidade: string): string {
  const u = unidade.toLowerCase().trim();
  return u === "und" || u === "unid" || u === "unidade" ? "un" : u;
}

// Converte uma quantidade expressa na unidade da RECEITA (ficha técnica
// ou sabor_ingrediente — normalmente kg, às vezes "und") pra unidade de
// ESTOQUE do produto, quando elas divergem (ex: receita pede 0,09kg de
// requeijão, mas o produto é contado em "bisnaga"). Usa
// padrao.peso_ou_volume_por_unidade como "quantidade na unidade da
// receita por 1 unidade de estoque". Sem padrão cadastrado pra converter,
// devolve a quantidade como veio (descompasso fica visível no relatório
// em vez de escondido) — ver premissa 8.
function paraUnidadeDoEstoque(
  quantidade: number,
  unidadeReceita: string,
  produto: Produto | undefined,
  padroesPorProdutoId: Map<string, PadraoEmbalagem>
): { quantidade: number; unidade: string } {
  if (!produto) return { quantidade, unidade: unidadeReceita };
  if (normalizarUnidade(unidadeReceita) === normalizarUnidade(produto.unidade)) {
    return { quantidade, unidade: produto.unidade };
  }

  const padrao = padroesPorProdutoId.get(produto.id);
  if (padrao?.peso_ou_volume_por_unidade) {
    return { quantidade: quantidade / padrao.peso_ou_volume_por_unidade, unidade: produto.unidade };
  }

  return { quantidade, unidade: unidadeReceita };
}

// Arredonda SEMPRE pra um número inteiro de "incrementos de compra", sem
// fração (ver premissa 8):
//   - unidade contínua (kg/g/l/ml) + padrão cadastrado: incremento = o
//     tamanho do padrão (ex: 4kg) — múltiplo inteiro dele.
//   - qualquer outro caso (unidade discreta, ou sem padrão): incremento =
//     1 unidade inteira de estoque.
function arredondarCompra(falta: number, produtoUnidade: string, padrao: PadraoEmbalagem | null): { quantidade: number; origemPadrao?: string } {
  if (falta <= 0) return { quantidade: 0 };

  const continua = ehUnidadeContinua(produtoUnidade);
  const incremento = padrao?.peso_ou_volume_por_unidade && continua ? padrao.peso_ou_volume_por_unidade : 1;

  // Piso de compra diferente do incremento (ex: Pepperoni — nunca compra
  // menos de 1kg, mas depois do mínimo sobe de 0,5 em 0,5kg: 1/1,5/2kg...).
  // Só se aplica a unidade contínua — não faz sentido "mínimo de X un".
  const minimo = padrao?.quantidade_minima && continua ? padrao.quantidade_minima : 0;
  if (falta <= minimo) {
    return { quantidade: minimo, origemPadrao: padrao?.nome_padrao };
  }

  let unidadesExcedente = Math.ceil((falta - minimo) / incremento);
  if (padrao?.multiplo_minimo && padrao.multiplo_minimo > 1) {
    unidadesExcedente = Math.ceil(unidadesExcedente / padrao.multiplo_minimo) * padrao.multiplo_minimo;
  }
  return { quantidade: minimo + unidadesExcedente * incremento, origemPadrao: padrao?.nome_padrao };
}

// Monta a linha final do relatório (falta + arredondamento + valor
// estimado) — usado tanto pra insumos brutos quanto pra pools e pro
// fallback de manipulado sem ficha técnica.
function resolverItem(params: {
  id: string;
  nome: string;
  unidade: string;
  isPool: boolean;
  necessarioBase: number; // ainda sem o colchão de estoque_minimo
  colchao: number; // estoque_minimo a somar (0 pra pool — não tem um único produto)
  motivos: string[];
  estoqueAtual: number;
  padrao: PadraoEmbalagem | null;
  precoUnitario: number | null;
}): NecessidadeInsumo {
  const necessario = params.necessarioBase + params.colchao;
  const falta = Math.max(necessario - params.estoqueAtual, 0);
  const { quantidade: sugestaoArredondada, origemPadrao } = arredondarCompra(falta, params.unidade, params.padrao);
  const valorEstimado = params.precoUnitario != null ? round(params.precoUnitario * sugestaoArredondada) : null;

  return {
    produtoId: params.id,
    produtoNome: params.nome,
    unidade: params.unidade,
    isPool: params.isPool,
    necessario: round(necessario),
    estoqueAtual: round(params.estoqueAtual),
    falta: round(falta),
    sugestaoArredondada: round(sugestaoArredondada),
    origemPadrao,
    motivo: params.motivos.join(" + "),
    precoUnitario: params.precoUnitario,
    valorEstimado,
  };
}

export interface ParametrosSugestao {
  qtdPizzasBasilico: number;
  qtdPizzasPopulares: number;
  validoAte?: string;
  textoOriginal?: string;
  chatId?: string;
  registrarMeta?: boolean; // default true — grava em metas_producao pra histórico
}

export async function calcularSugestaoCompra(params: ParametrosSugestao): Promise<SugestaoCompraResultado> {
  const [produtos, sabores, ingredientesSabores, itensUniversais, grupos, fichasTecnicas, padroesEmbalagem] = await Promise.all([
    listProdutos({ ativo: true }),
    listSabores(),
    listTodosIngredientesSabores(),
    listItensUniversais(),
    listGruposSubstituicao(),
    listFichasTecnicas(),
    listPadroesEmbalagem(),
  ]);

  const produtoPorId = new Map(produtos.map((p) => [p.id, p]));
  const gruposPorId = new Map(grupos.map((g) => [g.id, g]));
  const padroesPorProdutoId = new Map(padroesEmbalagem.map((p) => [p.produto_id, p]));
  const fichasPorManipulado = new Map<string, typeof fichasTecnicas>();
  for (const f of fichasTecnicas) {
    const lista = fichasPorManipulado.get(f.produto_manipulado_id) ?? [];
    lista.push(f);
    fichasPorManipulado.set(f.produto_manipulado_id, lista);
  }

  // ── 1) Total de pizzas pra dimensionar os itens UNIVERSAIS ──────────────
  // Só a meta principal (ver premissa 2 corrigida) — piso de segurança
  // NUNCA entra aqui, só nos ingredientes exclusivos de cada sabor (seção 3).
  const pisoSabores = sabores.filter((s) => s.tipo === "piso_seguranca" && s.ativo);

  const totalSalgadaBasilico = params.qtdPizzasBasilico;
  const totalSalgadaPopulares = params.qtdPizzasPopulares;
  const totalDoce = 0; // meta interativa não cobre sobremesas (spec seção 7) e piso não inflaciona mais o universal

  const acumulador = new Map<string, Acumulador>();

  // ── 2) Itens universais (massa, molho, queijo, caixa, lacre, orégano) ───
  const totalPorCategoriaEMarca = (categoria: CategoriaItemUniversal, marca: Marca | null): number => {
    const totalSalgada = marca === "basilico" ? totalSalgadaBasilico : marca === "populares" ? totalSalgadaPopulares : totalSalgadaBasilico + totalSalgadaPopulares;
    const totalDoceMarca = marca ? 0 : totalDoce; // doce hoje só existe na spec como cardápio Basílico (fonte: FichaTécnicaPizza.xlsx)
    if (categoria === "salgada") return totalSalgada;
    if (categoria === "doce") return totalDoceMarca;
    return totalSalgada + totalDoceMarca; // 'ambas'
  };

  for (const item of itensUniversais) {
    const totalPizzas = totalPorCategoriaEMarca(item.categoria, item.marca);
    if (totalPizzas <= 0) continue;
    acumular(
      acumulador,
      { produto_id: item.produto_id, grupo_substituicao_id: item.grupo_substituicao_id },
      item.quantidade * totalPizzas,
      item.unidade,
      `item universal (${item.categoria}${item.marca ? `, ${item.marca}` : ""})`
    );
  }

  // ── 3) Piso de segurança — ingredientes exclusivos de cada sabor não-âncora
  // Ingrediente usado por um único sabor: soma direta (== o próprio valor).
  // Ingrediente compartilhado por 2+ sabores: mediana das contribuições ×
  // 1,5 em vez da soma (ver premissa 5).
  const ingredientesPorSabor = new Map<string, SaborIngrediente[]>();
  for (const ing of ingredientesSabores) {
    const lista = ingredientesPorSabor.get(ing.sabor_id) ?? [];
    lista.push(ing);
    ingredientesPorSabor.set(ing.sabor_id, lista);
  }

  interface ContribuicaoPiso {
    ref: RefInsumo;
    saborNome: string;
    valor: number;
    unidade: string;
  }
  const contribuicoesPorIngrediente = new Map<string, ContribuicaoPiso[]>();

  for (const sabor of pisoSabores) {
    const piso = sabor.piso_minimo_pizzas ?? (sabor.categoria === "doce" ? PISO_MINIMO_DOCE_PIZZAS : PISO_MINIMO_PADRAO_PIZZAS);
    const ingredientes = ingredientesPorSabor.get(sabor.id) ?? [];
    for (const ing of ingredientes) {
      const ref: RefInsumo = { produto_id: ing.produto_id, grupo_substituicao_id: ing.grupo_substituicao_id };
      const chave = chaveDe(ref);
      const lista = contribuicoesPorIngrediente.get(chave) ?? [];
      lista.push({ ref, saborNome: sabor.nome, valor: ing.quantidade * piso, unidade: ing.unidade });
      contribuicoesPorIngrediente.set(chave, lista);
    }
  }

  for (const contribs of contribuicoesPorIngrediente.values()) {
    if (contribs.length === 1) {
      const c = contribs[0];
      acumular(acumulador, c.ref, c.valor, c.unidade, `piso de segurança — ${c.saborNome}`);
      continue;
    }

    const valorFinal = mediana(contribs.map((c) => c.valor)) * MARGEM_INGREDIENTE_COMPARTILHADO;
    const nomesSabores = contribs.map((c) => c.saborNome).join(", ");
    acumular(
      acumulador,
      contribs[0].ref,
      valorFinal,
      contribs[0].unidade,
      `piso de segurança — compartilhado entre ${contribs.length} sabores (mediana ×1,5): ${nomesSabores}`
    );
  }

  // ── 4) Refrigerante ───────────────────────────────────────────────────
  await acumularRefrigerante(acumulador, produtos, grupos, params.qtdPizzasBasilico, params.qtdPizzasPopulares);

  // ── 5) Explode manipulados em insumos brutos (sempre 1 nível — ver premissa 6)
  // somarBruto recebe a quantidade na unidade da RECEITA (kg, quase
  // sempre) e converte pra unidade de estoque do produto aqui dentro —
  // cobre tanto uso direto de bruto quanto o resultado da explosão de
  // manipulado, que também é sempre expresso em kg pela ficha técnica
  // (ver premissa 8 / paraUnidadeDoEstoque).
  const necessidadeBruto = new Map<string, { unidade: string; quantidade: number; motivos: Set<string> }>();
  const somarBruto = (id: string, qtdNaUnidadeReceita: number, unidadeReceita: string, motivo: string) => {
    if (qtdNaUnidadeReceita <= 0) return;
    const produto = produtoPorId.get(id);
    const { quantidade, unidade } = paraUnidadeDoEstoque(qtdNaUnidadeReceita, unidadeReceita, produto, padroesPorProdutoId);
    const atual = necessidadeBruto.get(id);
    if (atual) {
      atual.quantidade += quantidade;
      atual.motivos.add(motivo);
    } else {
      necessidadeBruto.set(id, { unidade, quantidade, motivos: new Set([motivo]) });
    }
  };

  const itens: NecessidadeInsumo[] = [];

  for (const acc of acumulador.values()) {
    if (acc.isPool) continue; // pools resolvidos separadamente abaixo

    const produto = produtoPorId.get(acc.refId);
    if (!produto) continue; // produto sumiu/inativo — ignora

    if (produto.tipo !== "manipulado") {
      somarBruto(acc.refId, acc.necessario, acc.unidade, Array.from(acc.motivos).join(" + "));
      continue;
    }

    // É manipulado: calcula a própria falta (com colchão de estoque_minimo)
    // pra saber quanto precisa ser PRODUZIDO — só isso vira demanda de
    // insumo bruto, não a necessidade bruta toda (o que já está em
    // estoque como manipulado não precisa ser reproduzido).
    const faltaManipulado = Math.max(acc.necessario + Number(produto.estoque_minimo) - Number(produto.estoque_atual), 0);
    if (faltaManipulado <= 0) continue; // estoque do manipulado já cobre

    const ficha = fichasPorManipulado.get(acc.refId);
    if (!ficha || ficha.length === 0) {
      // Sem ficha técnica cadastrada — não dá pra explodir. Mantém o
      // manipulado listado direto (com aviso) em vez de sumir do relatório.
      const padrao = padroesPorProdutoId.get(acc.refId) ?? null;
      itens.push(
        resolverItem({
          id: acc.refId,
          nome: produto.nome,
          unidade: acc.unidade,
          isPool: false,
          necessarioBase: acc.necessario,
          colchao: Number(produto.estoque_minimo),
          estoqueAtual: Number(produto.estoque_atual),
          padrao,
          precoUnitario: produto.preco_unitario != null ? Number(produto.preco_unitario) : null,
          motivos: [...Array.from(acc.motivos), "⚠️ sem ficha técnica cadastrada — sugestão direta do manipulado"],
        })
      );
      continue;
    }

    for (const f of ficha) {
      const brutoProduto = produtoPorId.get(f.produto_bruto_id);
      const qtdBruto = faltaManipulado * Number(f.quantidade_bruto_por_unidade);
      somarBruto(
        f.produto_bruto_id,
        qtdBruto,
        brutoProduto?.unidade ?? acc.unidade,
        `produção de ${produto.nome} (falta ${round(faltaManipulado)}${produto.unidade})`
      );
    }
  }

  // ── 6) Resolve os insumos brutos (uso direto + explodidos de manipulados)
  for (const [id, dados] of necessidadeBruto) {
    const produto = produtoPorId.get(id);
    const padrao = padroesPorProdutoId.get(id) ?? null;
    itens.push(
      resolverItem({
        id,
        nome: produto?.nome ?? "Produto desconhecido",
        unidade: produto?.unidade ?? dados.unidade,
        isPool: false,
        necessarioBase: dados.quantidade,
        colchao: Number(produto?.estoque_minimo ?? 0),
        estoqueAtual: Number(produto?.estoque_atual ?? 0),
        padrao,
        precoUnitario: produto?.preco_unitario != null ? Number(produto.preco_unitario) : null,
        motivos: Array.from(dados.motivos),
      })
    );
  }

  // ── 7) Resolve os pools (grupos de substituição) ─────────────────────
  for (const acc of acumulador.values()) {
    if (!acc.isPool) continue;

    const grupo = gruposPorId.get(acc.refId);
    const membros = await getMembrosGrupo(acc.refId);
    const estoqueAtual = membros.reduce((s, m) => s + Number(m.estoque_atual), 0);
    const precosValidos = membros.filter((m) => m.preco_unitario != null).map((m) => Number(m.preco_unitario));
    const precoUnitario = precosValidos.length > 0 ? Math.min(...precosValidos) : null;

    itens.push(
      resolverItem({
        id: acc.refId,
        nome: grupo?.nome ?? "Grupo desconhecido",
        unidade: acc.unidade,
        isPool: true,
        necessarioBase: acc.necessario,
        colchao: 0, // pool não tem um único produto com estoque_minimo próprio
        estoqueAtual,
        padrao: null, // decisão de qual variante comprar fica com o time (spec seção 8)
        precoUnitario,
        motivos: Array.from(acc.motivos),
      })
    );
  }

  itens.sort((a, b) => b.falta - a.falta);

  // ── 8) Valor total estimado ──────────────────────────────────────────
  let valorTotalEstimado = 0;
  let itensComPrecoDesconhecido = 0;
  for (const item of itens) {
    if (item.falta <= 0) continue;
    if (item.valorEstimado != null) valorTotalEstimado += item.valorEstimado;
    else itensComPrecoDesconhecido++;
  }

  if (params.registrarMeta !== false) {
    await criarMetaProducao({
      validoAte: params.validoAte,
      qtdPizzasBasilico: params.qtdPizzasBasilico,
      qtdPizzasPopulares: params.qtdPizzasPopulares,
      textoOriginal: params.textoOriginal,
      chatId: params.chatId,
    });
  }

  // ── 9) Failsafe de custo por pizza (ver premissa 9) ──────────────────
  const totalPizzasPedidas = params.qtdPizzasBasilico + params.qtdPizzasPopulares;
  const custoPorPizza = totalPizzasPedidas > 0 ? round(valorTotalEstimado / totalPizzasPedidas) : null;
  const alertaCustoExcedido = custoPorPizza != null && custoPorPizza > LIMITE_CUSTO_POR_PIZZA_REAIS;

  return {
    meta: {
      validoAte: params.validoAte ?? null,
      qtdPizzasBasilico: params.qtdPizzasBasilico,
      qtdPizzasPopulares: params.qtdPizzasPopulares,
    },
    itens,
    valorTotalEstimado: round(valorTotalEstimado),
    itensComPrecoDesconhecido,
    custoPorPizza,
    alertaCustoExcedido,
  };
}

async function acumularRefrigerante(
  acumulador: Map<string, Acumulador>,
  produtos: Produto[],
  grupos: GrupoSubstituicao[],
  qtdPizzasBasilico: number,
  qtdPizzasPopulares: number
): Promise<void> {
  // Basílico: refrigerante nominal (Coca-Cola) + zero, proporção 2:1
  const totalBasilico = Math.ceil(qtdPizzasBasilico * REFRIGERANTE_BASILICO_PCT_DAS_PIZZAS);
  const coca = produtos.find((p) => normalizarSimples(p.nome) === "coca cola 1l");
  const cocaZero = produtos.find((p) => normalizarSimples(p.nome) === "coca cola zero 1l");
  if (coca && totalBasilico > 0) {
    const qtdZero = Math.round(totalBasilico * REFRIGERANTE_BASILICO_PROPORCAO_ZERO);
    const qtdNormal = totalBasilico - qtdZero;
    acumular(acumulador, { produto_id: coca.id, grupo_substituicao_id: null }, qtdNormal, coca.unidade, "refrigerante Basílico (60% das pizzas, normal)");
    if (cocaZero) {
      acumular(acumulador, { produto_id: cocaZero.id, grupo_substituicao_id: null }, qtdZero, cocaZero.unidade, "refrigerante Basílico (60% das pizzas, zero)");
    }
  }

  // Populares: total (70% das pizzas) coberto pelo membro mais barato do
  // pool "Refrigerante Popular" que ainda não está em estoque suficiente.
  const totalPopulares = Math.ceil(qtdPizzasPopulares * REFRIGERANTE_POPULARES_PCT_DAS_PIZZAS);
  if (totalPopulares > 0) {
    const grupoPopular = grupos.find((g) => g.categoria === "refrigerante_popular");
    if (grupoPopular) {
      const membros = await getMembrosGrupo(grupoPopular.id);
      const estoquePool = membros.reduce((acc, m) => acc + Number(m.estoque_atual), 0);
      const falta = totalPopulares - estoquePool;
      if (falta > 0) {
        const maisBarato = [...membros].filter((m) => m.preco_unitario != null).sort((a, b) => Number(a.preco_unitario) - Number(b.preco_unitario))[0];
        if (maisBarato) {
          acumular(acumulador, { produto_id: maisBarato.id, grupo_substituicao_id: null }, falta, maisBarato.unidade, "refrigerante populares (70% das pizzas, mais barato disponível)");
        }
      }
    }
  }
}

function normalizarSimples(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // remove pontuação (ex: o hífen de "Coca-Cola")
    .replace(/\s+/g, " ")
    .trim();
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Formatação para WhatsApp ──────────────────────────────────────────────

function brl(v: number): string {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Quando o custo por pizza estoura o limite, o grupo recebe um ALERTA em
// vez da lista de compra pronta — não deve parecer "pronto pra aprovar"
// (ver premissa 9). O relatório completo continua acessível via PDF.
export function formatarAlertaCustoWhatsApp(resultado: SugestaoCompraResultado): string {
  const { meta, valorTotalEstimado, custoPorPizza } = resultado;
  const totalPizzas = meta.qtdPizzasBasilico + meta.qtdPizzasPopulares;

  return [
    `⚠️ *CUSTO FORA DO ESPERADO — REVISÃO MANUAL NECESSÁRIA*`,
    "",
    `A sugestão de compra pra ${totalPizzas} pizzas (Basílico: ${meta.qtdPizzasBasilico} · Populares: ${meta.qtdPizzasPopulares}) saiu em`,
    `*R$ ${brl(custoPorPizza ?? 0)} por pizza* — acima do limite de R$ ${brl(LIMITE_CUSTO_POR_PIZZA_REAIS)}/pizza.`,
    "",
    `Total estimado: R$ ${brl(valorTotalEstimado)}`,
    "",
    `*Não compre com base nesse número ainda.* Confira o relatório detalhado (comando *sugestao ${meta.qtdPizzasBasilico} ${meta.qtdPizzasPopulares} pdf*) antes de decidir — pode ser estoque muito baixo puxando junto insumos que não precisavam entrar, preço desatualizado, ou item duplicado.`,
  ].join("\n");
}

export function formatarSugestaoWhatsApp(resultado: SugestaoCompraResultado): string {
  if (resultado.alertaCustoExcedido) {
    return formatarAlertaCustoWhatsApp(resultado);
  }

  const { meta, itens, valorTotalEstimado, itensComPrecoDesconhecido } = resultado;
  const comFalta = itens.filter((i) => i.falta > 0);

  const linhas: string[] = [
    `*SUGESTÃO DE COMPRA*`,
    meta.validoAte ? `_Válido até ${meta.validoAte}_` : "",
    `Basílico: ${meta.qtdPizzasBasilico} pizzas · Populares: ${meta.qtdPizzasPopulares} pizzas`,
    "",
  ];

  if (comFalta.length === 0) {
    linhas.push("✅ Estoque cobre a meta pedida — nenhuma compra necessária.");
  } else {
    for (const item of comFalta) {
      const tag = item.isPool ? " _(pool — decidir variante)_" : "";
      const valorTxt = item.valorEstimado != null ? ` — R$ ${brl(item.valorEstimado)}` : "";
      linhas.push(
        `• *${item.produtoNome}*${tag}: comprar *${brl(item.sugestaoArredondada)} ${item.unidade}*${valorTxt}` +
          (item.origemPadrao ? ` _(${item.origemPadrao})_` : "") +
          `\n   estoque: ${brl(item.estoqueAtual)} · necessário: ${brl(item.necessario)}`
      );
    }
    linhas.push("");
    const notaSemPreco = itensComPrecoDesconhecido > 0 ? ` _(${itensComPrecoDesconhecido} item(ns) sem preço cadastrado, não incluído(s))_` : "";
    linhas.push(`*Total estimado: R$ ${brl(valorTotalEstimado)}*${notaSemPreco}`);
  }

  linhas.push("", "_Sugestão gerada automaticamente — decisão final é do time._");
  return linhas.filter((l) => l !== "").join("\n");
}
