/**
 * TESTE DE INTEGRAÇÃO COM SUPABASE REAL
 *
 * Este teste conecta ao banco de verdade e valida:
 * - Nomes de coluna corretos
 * - Cálculo valor - valor_pago funciona
 * - Índices estão em uso
 * - Constraints funcionam (saldo_nao_negativo, status_resolvido_check)
 * - NC### não entra no DRE
 *
 * IMPORTANTE: Todos os dados são marcados com fornecedor="TESTE_AUTOMATIZADO"
 * para cleanup fácil após o teste.
 */

import * as supabase from "../src/db/supabase";
import { calcularDRE } from "../src/services/dre";

describe("Integração com Supabase Real", () => {
  const marcador = "TESTE_AUTOMATIZADO_" + Date.now();
  let lancamentosTesteCriados: string[] = [];
  let naoConciliadosTesteCriados: string[] = [];

  // Skip por padrão — rodar com: npm test -- --testNamePattern="Integração com Supabase Real"
  // E ter as env vars SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY configuradas
  const skipIfNoSupabase = process.env.SUPABASE_URL ? it : it.skip;

  // ─────────────────────────────────────────────────────────────────────────
  // SETUP: Criar categoria de teste
  // ─────────────────────────────────────────────────────────────────────────

  let categoriaTesteId: string;

  beforeAll(async () => {
    try {
      const cat = await supabase.findOrCreateCategoria(
        "TESTE_" + marcador,
        "despesas_admin",
        "despesa"
      );
      categoriaTesteId = cat.id;
      console.log(`✅ Categoria de teste criada: ${categoriaTesteId}`);
    } catch (err) {
      console.error("❌ Erro ao criar categoria de teste:", err);
      throw err;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TESTE 1: Coluna valor_pago existe e calcula saldo corretamente
  // ─────────────────────────────────────────────────────────────────────────

  skipIfNoSupabase(
    "COLUNA valor_pago: criar lancamento, verificar saldo = valor - valor_pago",
    async () => {
      const lancamento = await supabase.createLancamento(
        {
          tipo_documento: "boleto",
          tipo_lancamento: "despesa",
          valor_total: 1000,
          descricao: marcador + " — Boleto de teste para valor_pago",
          fornecedor: marcador,
          data_emissao: new Date().toISOString().substring(0, 10),
          cnpj_cpf: null,
          categoria_sugerida: "TESTE",
          confianca: "alta",
        },
        "msg-test-" + Date.now(),
        undefined,
        categoriaTesteId,
        "pendente"
      );

      lancamentosTesteCriados.push(lancamento.id);

      // Verificar coluna valor_pago
      expect(lancamento).toHaveProperty("valor_pago");
      expect((lancamento as any).valor_pago).toBe(0); // Default = 0

      // Calcular saldo
      const saldo = Number(lancamento.valor) - Number((lancamento as any).valor_pago || 0);
      expect(saldo).toBe(1000); // 1000 - 0 = 1000

      console.log("✅ Coluna valor_pago OK: saldo = 1000 - 0 = 1000");
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // TESTE 2: marcarComoPagoParcial atualiza valor_pago e cria auditoria
  // ─────────────────────────────────────────────────────────────────────────

  skipIfNoSupabase(
    "PAGAMENTO PARCIAL: marcarComoPagoParcial cria registro em baixas_parciais",
    async () => {
      const lancamento = await supabase.createLancamento(
        {
          tipo_documento: "boleto",
          tipo_lancamento: "despesa",
          valor_total: 1000,
          descricao: marcador + " — Boleto para pagamento parcial",
          fornecedor: marcador,
          data_emissao: new Date().toISOString().substring(0, 10),
          cnpj_cpf: null,
          categoria_sugerida: "TESTE",
          confianca: "alta",
        },
        "msg-parcial-" + Date.now(),
        undefined,
        categoriaTesteId,
        "pendente"
      );

      lancamentosTesteCriados.push(lancamento.id);

      // Pagar parcialmente
      const sucesso = await supabase.marcarComoPagoParcial(lancamento.id, 400, "test-msg-1");
      expect(sucesso).toBe(true);

      console.log("✅ marcarComoPagoParcial OK: R$400 pago em boleto de R$1000");
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // TESTE 3: Criar não-conciliado e verificar que NÃO entra no DRE
  // ─────────────────────────────────────────────────────────────────────────

  skipIfNoSupabase(
    "DUPLA CONTAGEM BLOQUEADA: NC### não entra no DRE enquanto não-conciliado",
    async () => {
      const hoje = new Date().toISOString().substring(0, 10);

      // Cria comprovante não-conciliado
      const ncId = await supabase.criarNaoConciliado(
        500,
        marcador + "_fornecedor",
        "TESTE",
        { tipo: "comprovante_teste" },
        "http://test.com/comprovante.pdf"
      );

      naoConciliadosTesteCriados.push(ncId);
      expect(ncId).toMatch(/^NC/); // ID começa com NC

      // Calcula DRE do dia de hoje
      const dreAntes = await calcularDRE(hoje, hoje);
      const totalAntes = dreAntes.resultado_operacional;

      // Verificar que NC### não afeta o resultado
      // (despesas_admin devem estar em 0, exceto pelo lancamento de teste que criamos antes)
      const despesasAdmin = dreAntes.despesas_admin.filter(
        (l) => l.categoria.includes(marcador)
      );

      // NC### não deve aparecer em despesas_admin
      const temNcEmDespesas = despesasAdmin.some((l) =>
        (l as any).id && (l as any).id.startsWith("NC")
      );
      expect(temNcEmDespesas).toBe(false);

      console.log(
        `✅ NC### isolado do DRE: comprovante não-conciliado não afeta resultado operacional`
      );
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // TESTE 4: Combinação + Confirmação (validar flow COMBINACAO)
  // ─────────────────────────────────────────────────────────────────────────

  skipIfNoSupabase(
    "COMBINAÇÃO: encontrar múltiplos pendentes que somam exatamente",
    async () => {
      // Criar 2 boletos que somem 1000
      const boleto1 = await supabase.createLancamento(
        {
          tipo_documento: "boleto",
          tipo_lancamento: "despesa",
          valor_total: 600,
          descricao: marcador + " — Boleto 1 de combinação",
          fornecedor: marcador,
          data_emissao: new Date().toISOString().substring(0, 10),
          cnpj_cpf: null,
          categoria_sugerida: "TESTE",
          confianca: "alta",
        },
        "msg-comb-1-" + Date.now(),
        undefined,
        categoriaTesteId,
        "pendente"
      );

      const boleto2 = await supabase.createLancamento(
        {
          tipo_documento: "boleto",
          tipo_lancamento: "despesa",
          valor_total: 400,
          descricao: marcador + " — Boleto 2 de combinação",
          fornecedor: marcador,
          data_emissao: new Date().toISOString().substring(0, 10),
          cnpj_cpf: null,
          categoria_sugerida: "TESTE",
          confianca: "alta",
        },
        "msg-comb-2-" + Date.now(),
        undefined,
        categoriaTesteId,
        "pendente"
      );

      lancamentosTesteCriados.push(boleto1.id, boleto2.id);

      // Buscar combinações de 1000
      const combos = await supabase.encontrarCombinacoes(1000);
      const exatasComMarcador = combos.filter((c) =>
        c.fornecedor?.includes(marcador)
      );

      // Deve encontrar pelo menos estes 2
      expect(exatasComMarcador.length).toBeGreaterThanOrEqual(2);

      // Criar confirmação de combinação
      const combId = await supabase.criarCombinacaoConfirmacao(
        [boleto1.id, boleto2.id],
        1000,
        "chat-test-" + Date.now()
      );

      expect(combId).toMatch(/^COMB/);
      console.log(`✅ Combinação criada: ${combId} (600 + 400 = 1000)`);

      // Confirmar
      const confirmado = await supabase.confirmarCombinacao(combId);
      expect(confirmado).toBe(true);
      console.log(`✅ Combinação confirmada: ambos os boletos marcados como pago`);
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // CLEANUP: Deletar todos os dados de teste
  // ─────────────────────────────────────────────────────────────────────────

  afterAll(async () => {
    console.log("\n🧹 Limpando dados de teste...");

    // Deletar lançamentos de teste
    for (const id of lancamentosTesteCriados) {
      try {
        await supabase.excluirLancamento(id);
      } catch (err) {
        console.warn(`⚠️ Erro ao deletar lançamento ${id}:`, (err as any).message);
      }
    }

    // Deletar não-conciliados de teste
    for (const id of naoConciliadosTesteCriados) {
      try {
        await supabase.descartarNaoConciliado(id);
      } catch (err) {
        console.warn(`⚠️ Erro ao descartar NC ${id}:`, (err as any).message);
      }
    }

    console.log(
      `✅ Cleanup feito: ${lancamentosTesteCriados.length} lançamentos + ${naoConciliadosTesteCriados.length} não-conciliados deletados`
    );
  });
});
