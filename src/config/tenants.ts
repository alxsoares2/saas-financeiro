// Registro de lojas (multi-tenant).
//
// Cada loja tem seu próprio banco Supabase (url + key) e é identificada pelo
// grupo do WhatsApp (grupoId). O app roteia cada mensagem pra loja certa.
//
// Configuração via env var TENANTS (JSON). Exemplo:
//   TENANTS=[
//     {"id":"mano","grupo":"5511...@g.us","supabaseUrl":"https://xxx.supabase.co","supabaseKey":"eyJ..."},
//     {"id":"basilico","grupo":"5511...@g.us","supabaseUrl":"https://yyy.supabase.co","supabaseKey":"eyJ..."}
//   ]
//
// Se TENANTS não estiver definida, cai no modo LEGADO (uma loja só), lendo
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GRUPO_FINANCEIRO_ID — assim o
// Mano continua funcionando sem mudar nenhuma env var.

export interface Tenant {
  id: string;
  grupoId: string;
  url: string;
  key: string;
  schema: string;
}

let _cache: Tenant[] | null = null;

export function getTenants(): Tenant[] {
  if (_cache) return _cache;

  const raw = process.env.TENANTS;
  if (raw && raw.trim()) {
    const arr = JSON.parse(raw);
    _cache = arr.map((t: any) => ({
      id: t.id,
      grupoId: t.grupo ?? "",
      url: t.supabaseUrl,
      key: t.supabaseKey,
      schema: t.schema || "financeiro",
    }));
    return _cache!;
  }

  // Modo legado — uma loja só (Mano intacto)
  _cache = [
    {
      id: "default",
      grupoId: process.env.GRUPO_FINANCEIRO_ID ?? "",
      url: process.env.SUPABASE_URL!,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      schema: process.env.SUPABASE_SCHEMA || "financeiro",
    },
  ];
  return _cache;
}

// Acha a loja dona de uma mensagem, comparando só os dígitos do grupo/telefone.
export function findTenantByChat(chatId?: string, phone?: string): Tenant | undefined {
  const tenants = getTenants();
  const chatNum = (chatId ?? "").replace(/\D/g, "");
  const phoneNum = (phone ?? "").replace(/\D/g, "");

  // Legado sem grupo configurado = processa tudo (comportamento antigo)
  if (tenants.length === 1 && !tenants[0].grupoId.replace(/\D/g, "")) {
    return tenants[0];
  }

  return tenants.find((t) => {
    const g = t.grupoId.replace(/\D/g, "");
    return g !== "" && (g === chatNum || g === phoneNum);
  });
}
