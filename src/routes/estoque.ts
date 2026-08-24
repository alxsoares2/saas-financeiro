import { Router, Request, Response } from "express";
import { calcularSugestaoCompra, formatarSugestaoWhatsApp } from "../services/estoque/sugestao-compra.js";
import { gerarPdfSugestaoCompra } from "../services/estoque/pdf-relatorio.js";
import { listProdutos } from "../services/estoque/db.js";

const router = Router();

// GET /estoque/produtos
router.get("/produtos", async (_req: Request, res: Response) => {
  try {
    const produtos = await listProdutos();
    res.json(produtos);
  } catch (err) {
    console.error("[estoque route] Erro ao listar produtos:", err);
    res.status(500).json({ error: "Erro interno ao listar produtos" });
  }
});

// POST /estoque/sugestao  { qtdPizzasBasilico, qtdPizzasPopulares, validoAte? }
router.post("/sugestao", async (req: Request, res: Response) => {
  const { qtdPizzasBasilico, qtdPizzasPopulares, validoAte, chatId, textoOriginal } = req.body ?? {};

  if (typeof qtdPizzasBasilico !== "number" || typeof qtdPizzasPopulares !== "number") {
    res.status(400).json({ error: "qtdPizzasBasilico e qtdPizzasPopulares são obrigatórios (number)" });
    return;
  }

  try {
    const resultado = await calcularSugestaoCompra({
      qtdPizzasBasilico,
      qtdPizzasPopulares,
      validoAte,
      chatId,
      textoOriginal,
    });
    res.json(resultado);
  } catch (err) {
    console.error("[estoque route] Erro ao calcular sugestão:", err);
    res.status(500).json({ error: "Erro interno ao calcular sugestão de compra" });
  }
});

// POST /estoque/sugestao/pdf — mesmo payload de /sugestao, mas devolve o PDF
router.post("/sugestao/pdf", async (req: Request, res: Response) => {
  const { qtdPizzasBasilico, qtdPizzasPopulares, validoAte } = req.body ?? {};

  if (typeof qtdPizzasBasilico !== "number" || typeof qtdPizzasPopulares !== "number") {
    res.status(400).json({ error: "qtdPizzasBasilico e qtdPizzasPopulares são obrigatórios (number)" });
    return;
  }

  try {
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico, qtdPizzasPopulares, validoAte, registrarMeta: false });
    const pdf = await gerarPdfSugestaoCompra(resultado);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="sugestao-compra.pdf"');
    res.send(pdf);
  } catch (err) {
    console.error("[estoque route] Erro ao gerar PDF:", err);
    res.status(500).json({ error: "Erro interno ao gerar PDF" });
  }
});

// GET /estoque/sugestao/whatsapp?basilico=30&populares=50 — texto pronto pro grupo
router.get("/sugestao/whatsapp", async (req: Request, res: Response) => {
  const basilico = Number(req.query.basilico ?? 0);
  const populares = Number(req.query.populares ?? 0);

  try {
    const resultado = await calcularSugestaoCompra({ qtdPizzasBasilico: basilico, qtdPizzasPopulares: populares, registrarMeta: false });
    res.type("text/plain").send(formatarSugestaoWhatsApp(resultado));
  } catch (err) {
    console.error("[estoque route] Erro ao formatar sugestão:", err);
    res.status(500).json({ error: "Erro interno ao formatar sugestão" });
  }
});

export default router;
