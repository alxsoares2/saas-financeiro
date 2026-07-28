// Payload do webhook Z-API
export interface ZAPIPayload {
  phone: string;
  chatId: string;
  messageId: string;
  fromMe: boolean;
  momment: number; // timestamp UNIX da mensagem
  type: "ReceivedCallback";
  chatName?: string;
  senderName?: string;
  senderPhoto?: string;
  text?: {
    message: string;
  };
  image?: {
    url: string;
    caption?: string;
    mimeType: string;
  };
  document?: {
    url: string;
    mimeType: string;
    title?: string;
    fileName?: string;
  };
}

// Resultado da extração feita pelo Claude ou xml2js
export interface ExtractedDocument {
  tipo_documento:
    | "nota_fiscal"
    | "boleto"
    | "recibo"
    | "extrato"
    | "contrato"
    | "outro";
  fornecedor?: string;
  cnpj_cpf?: string;
  descricao: string;
  valor_total: number;
  data_emissao?: string; // ISO YYYY-MM-DD
  data_vencimento?: string;
  categoria_sugerida?: string;
  tipo_lancamento: "receita" | "despesa";
  confianca: "alta" | "media" | "baixa";
}

// Linha do banco para lancamentos
export interface Lancamento {
  id: string;
  message_id?: string;
  tipo: "receita" | "despesa";
  descricao: string;
  fornecedor?: string;
  cnpj_cpf?: string;
  valor: number;
  data_emissao?: string;
  data_vencimento?: string;
  data_pagamento?: string;
  categoria_id?: string;
  status: "pendente" | "pago";
  url_arquivo?: string;
  dados_brutos?: object;
  created_at: string;
}

// Linha do banco para categorias
export interface Categoria {
  id: string;
  nome: string;
  grupo_dre: string;
  tipo: "receita" | "despesa";
}

// Grupos do DRE operacional para restaurante
export type GrupoDRE =
  // Receita
  | "receita_bruta"
  | "deducoes_receita"
  // Custos Variáveis
  | "cmv"
  | "materiais_venda_direta"
  | "materiais_apoio"
  | "cmo_eventual"
  | "tarifas_cartao"
  | "impostos_variaveis"
  // Despesas Fixas
  | "ocupacao"
  | "utilidades"
  | "despesas_admin"
  | "marketing"
  | "pessoal_fixo";

// Linha de item no DRE
export interface LinhasDRE {
  categoria: string;
  valor: number;
  pct?: number; // % sobre a receita líquida
}

// DRE Operacional para Restaurante
export interface DRE {
  periodo: { inicio: string; fim: string };

  // Receita
  receita_bruta: LinhasDRE[];
  total_receita_bruta: number;
  deducoes_receita: LinhasDRE[];
  receita_liquida: number;

  // Custos Variáveis (tudo que varia com as vendas)
  cmv: LinhasDRE[];
  materiais_venda_direta: LinhasDRE[];
  materiais_apoio: LinhasDRE[];
  cmo_eventual: LinhasDRE[];
  tarifas_cartao: LinhasDRE[];
  impostos_variaveis: LinhasDRE[];
  total_custos_variaveis: number;
  total_custos_variaveis_pct: number;

  // Margem de Contribuição (métrica central)
  margem_contribuicao: number;
  margem_contribuicao_pct: number;

  // Despesas Fixas
  ocupacao: LinhasDRE[];
  utilidades: LinhasDRE[];
  despesas_admin: LinhasDRE[];
  marketing: LinhasDRE[];
  pessoal_fixo: LinhasDRE[];
  total_despesas_fixas: number;
  total_despesas_fixas_pct: number;

  // Resultado
  resultado_operacional: number;
  resultado_operacional_pct: number;
}
