// Resolve um nome de produto lido por OCR (lista impressa/manuscrita) ou
// falado no grupo pro produto cadastrado correspondente — mesmo espírito
// de normalização/match do grupo-dre.ts, mas aqui contra a base de
// produtos em vez de um mapa fixo de palavras-chave.
import { Produto } from "./types.js";

export interface ResultadoMatch {
  produto: Produto;
  confianca: number; // 0..1
}

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // remove acentos
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // remove pontuação
    .replace(/\s+/g, " ")
    .trim();
}

// Stopwords que não ajudam a diferenciar produtos (mas cuidado: não remove
// palavras que são a própria diferença entre variantes, ex: "genérico").
const STOPWORDS = new Set(["de", "da", "do", "das", "dos", "e", "c", "com", "s"]);

function palavras(texto: string): string[] {
  return normalizar(texto)
    .split(" ")
    .filter((p) => p.length > 0 && !STOPWORDS.has(p));
}

// Score de similaridade por sobreposição de palavras (Jaccard simples).
// Suficiente pra nomes curtos de produto — não precisa de libs de fuzzy
// matching pra esse volume (dezenas de produtos cadastrados).
function scoreJaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersecao = 0;
  for (const p of setA) if (setB.has(p)) intersecao++;
  const uniao = new Set([...setA, ...setB]).size;
  return intersecao / uniao;
}

// Encontra o produto cadastrado mais parecido com um nome lido (ex: vindo
// de OCR). Retorna null se nada bater com confiança mínima razoável —
// nesse caso o fluxo de WhatsApp deve perguntar no grupo em vez de
// assumir, especialmente pra origem foto_lista_manuscrita (sempre
// confirma) e foto_produto sem padrão de embalagem cadastrado.
export function encontrarProdutoPorNome(
  nomeLido: string,
  produtos: Produto[],
  limiteMinimo = 0.5
): ResultadoMatch | null {
  const alvo = normalizar(nomeLido);
  if (!alvo) return null;

  // 1) match exato (ignorando acentuação/caixa)
  const exato = produtos.find((p) => normalizar(p.nome) === alvo);
  if (exato) return { produto: exato, confianca: 1 };

  // 2) um nome contém o outro por completo (ex: "queijo" dentro de "queijo mussarela")
  const porSubstring = produtos.find((p) => {
    const nomeProduto = normalizar(p.nome);
    return nomeProduto.includes(alvo) || alvo.includes(nomeProduto);
  });
  if (porSubstring) return { produto: porSubstring, confianca: 0.85 };

  // 3) sobreposição de palavras — pega o melhor score acima do limite
  const palavrasAlvo = palavras(nomeLido);
  let melhor: { produto: Produto; score: number } | null = null;
  for (const p of produtos) {
    const score = scoreJaccard(palavrasAlvo, palavras(p.nome));
    if (score > (melhor?.score ?? 0)) melhor = { produto: p, score };
  }

  if (melhor && melhor.score >= limiteMinimo) {
    return { produto: melhor.produto, confianca: melhor.score };
  }

  return null;
}

// Mesmo matching, mas retorna os top-N candidatos — útil pra oferecer
// opções no grupo quando a confiança do melhor match não é alta o
// suficiente pra gravar direto.
export function candidatosProduto(nomeLido: string, produtos: Produto[], top = 3): ResultadoMatch[] {
  const palavrasAlvo = palavras(nomeLido);
  return produtos
    .map((p) => ({ produto: p, confianca: scoreJaccard(palavrasAlvo, palavras(p.nome)) }))
    .filter((r) => r.confianca > 0)
    .sort((a, b) => b.confianca - a.confianca)
    .slice(0, top);
}
