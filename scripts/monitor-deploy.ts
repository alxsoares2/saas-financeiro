#!/usr/bin/env node

import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);

interface ErrorFix {
  errorPattern: string;
  description: string;
  fix: string;
}

interface Config {
  monitorEnabled: boolean;
  checkInterval: number;
  maxRetries: number;
  autoFixes: ErrorFix[];
}

const config: Config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../.deploy-monitor.json"), "utf-8")
);

let retries = 0;

async function checkDeployStatus(): Promise<void> {
  console.log("🔍 Verificando status do deploy...");

  try {
    const { stdout } = await execAsync("npx railway logs --limit 50");
    const logs = stdout.toLowerCase();

    // Procura por erros conhecidos
    for (const errorFix of config.autoFixes) {
      if (logs.includes(errorFix.errorPattern.toLowerCase())) {
        console.log(
          `\n⚠️  ERRO DETECTADO: ${errorFix.description}\n📝 Padrão: ${errorFix.errorPattern}`
        );
        console.log(`🔧 Ação: ${errorFix.fix}\n`);

        // Notifica via WhatsApp se configurado
        if (config.notificationChannels[0]?.enabled) {
          await notifyWhatsApp(
            `⚠️ Deploy falhou: ${errorFix.description}\n\n🔧 ${errorFix.fix}`
          );
        }

        retries++;
        if (retries < config.maxRetries) {
          console.log(`\n⏳ Aguardando ${config.checkInterval}ms antes de re-verificar...`);
          await new Promise((r) => setTimeout(r, config.checkInterval));
          await checkDeployStatus();
        } else {
          console.log(`\n❌ Máximo de tentativas (${config.maxRetries}) atingido.`);
        }
        return;
      }
    }

    // Se chegou aqui, não encontrou erros
    console.log("✅ Deploy OK! Nenhum erro detectado.");
    await notifyWhatsApp("✅ Deploy bem-sucedido!");
  } catch (err) {
    console.error("❌ Erro ao verificar logs:", err);
  }
}

async function notifyWhatsApp(message: string): Promise<void> {
  // Aqui você poderia chamar a Z-API para enviar mensagem
  console.log(`\n📱 [WhatsApp] ${message}`);
}

// Executa ao iniciar
if (config.monitorEnabled) {
  console.log("🚀 Monitor de deploy iniciado\n");
  checkDeployStatus().catch(console.error);
} else {
  console.log("⏸️  Monitor de deploy desabilitado");
}
