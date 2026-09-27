import { Request, Response, NextFunction } from "express";

// Exige `Authorization: Bearer <CRON_SECRET>`. Sem CRON_SECRET configurado,
// bloqueia tudo (falha fechada) em vez de deixar a rota aberta.
export function exigirToken(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.CRON_SECRET;

  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized — invalid or missing CRON_SECRET" });
    return;
  }

  next();
}
