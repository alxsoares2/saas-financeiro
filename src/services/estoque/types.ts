// Tipos do módulo de estoque (bruto + manipulado).
// Ver SPEC-estoque-manipulacao.md e schema-estoque.sql na raiz do projeto.

export type TipoProduto = "bruto" | "manipulado";
export type Marca = "basilico" | "populares";
export type CategoriaSabor = "salgada" | "doce";
export type TipoSabor = "ancora" | "piso_seguranca";
export type CategoriaItemUniversal = CategoriaSabor | "ambas";

export interface Produto {
  id: string;
  nome: string;
  unidade: string;
  tipo: TipoProduto;
  categoria: string | null;
  marca: Marca | null;
  preco_unitario: number | null;
  estoque_atual: number;
  estoque_minimo: number;
  fornecedor: string | null;
  formato_saida: string | null;
  ativo: boolean;
  observacoes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PadraoEmbalagem {
  id: string;
  produto_id: string;
  nome_padrao: string;
  unidades_por_padrao: number;
  peso_ou_volume_por_unidade: number | null;
  multiplo_minimo: number | null;
  ativo: boolean;
}

export interface GrupoSubstituicao {
  id: string;
  nome: string;
  categoria: string | null;
  observacoes: string | null;
}

export interface GrupoSubstituicaoMembro {
  grupo_id: string;
  produto_id: string;
}

export interface FichaTecnica {
  id: string;
  produto_manipulado_id: string;
  produto_bruto_id: string;
  quantidade_bruto_por_unidade: number;
  perda_pct: number | null;
  observacoes: string | null;
}

// Referência polimórfica: aponta pra um produto OU pra um grupo de
// substituição, nunca os dois — resolvida em runtime (ver matching.ts /
// sugestao-compra.ts).
export interface RefInsumo {
  produto_id: string | null;
  grupo_substituicao_id: string | null;
}

export interface ItemUniversal extends RefInsumo {
  id: string;
  categoria: CategoriaItemUniversal;
  marca: Marca | null;
  quantidade: number;
  unidade: string;
  observacoes: string | null;
  ativo: boolean;
}

export interface Sabor {
  id: string;
  nome: string;
  tipo: TipoSabor;
  categoria: CategoriaSabor;
  piso_minimo_pizzas: number | null;
  queijo_override_kg: number | null;
  ativo: boolean;
  observacoes: string | null;
}

export interface SaborIngrediente extends RefInsumo {
  id: string;
  sabor_id: string;
  quantidade: number;
  unidade: string;
}

export interface MetaProducao {
  id: string;
  data: string;
  valido_ate: string | null;
  qtd_pizzas_basilico: number;
  qtd_pizzas_populares: number;
  texto_original: string | null;
  chat_id: string | null;
  created_at: string;
}

export type TipoMovimentacao = "contagem" | "entrada" | "saida" | "ajuste" | "producao";
export type OrigemMovimentacao =
  | "foto_lista_impressa"
  | "foto_lista_manuscrita"
  | "foto_produto"
  | "manual"
  | "producao_manipulado";

export interface MovimentacaoEstoque {
  id: string;
  produto_id: string;
  tipo: TipoMovimentacao;
  quantidade: number;
  estoque_resultante: number;
  origem: OrigemMovimentacao;
  confianca_ocr: number | null;
  confirmado_por: string | null;
  foto_url: string | null;
  created_at: string;
}

export type TipoAcaoSugestao = "comprar" | "produzir";

export interface SugestaoCompra {
  id?: string;
  produto_id: string;
  meta_producao_id?: string | null;
  tipo_acao: TipoAcaoSugestao;
  quantidade_sugerida: number;
  motivo: string;
  relatorio_data?: string;
}

// ── Resultado do motor de sugestão (calcularSugestaoCompra) ────────────────

export interface NecessidadeInsumo {
  produtoId: string;         // id do produto OU do grupo de substituição, quando isPool=true
  produtoNome: string;
  unidade: string;
  isPool: boolean;           // true = produtoId é na verdade um grupo_substituicao (pool de marcas populares)
  necessario: number;       // quantidade total necessária pro período
  estoqueAtual: number;
  falta: number;            // necessario - estoqueAtual, já com estoque_minimo somado (>= 0)
  sugestaoArredondada: number; // depois de aplicar padrao_embalagem, se houver
  origemPadrao?: string;    // nome do padrão de embalagem aplicado, se houver
  motivo: string;
}

export interface SugestaoCompraResultado {
  meta: {
    validoAte: string | null;
    qtdPizzasBasilico: number;
    qtdPizzasPopulares: number;
  };
  itens: NecessidadeInsumo[];
}
