import { Router, Request, Response } from "express";
import { calcularDRE } from "../services/dre.js";

const router = Router();

// GET /dre?inicio=2024-01-01&fim=2024-01-31
router.get("/", async (req: Request, res: Response) => {
  const { inicio, fim } = req.query as { inicio?: string; fim?: string };

  if (!inicio || !fim) {
    res.status(400).json({ error: "Parâmetros inicio e fim são obrigatórios (YYYY-MM-DD)" });
    return;
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(inicio) || !dateRegex.test(fim)) {
    res.status(400).json({ error: "Formato inválido. Use YYYY-MM-DD" });
    return;
  }

  if (inicio > fim) {
    res.status(400).json({ error: "inicio deve ser anterior a fim" });
    return;
  }

  try {
    const dre = await calcularDRE(inicio, fim);
    res.json(dre);
  } catch (err) {
    console.error("[DRE route] Erro:", err);
    res.status(500).json({ error: "Erro interno ao calcular o DRE" });
  }
});

export default router;
