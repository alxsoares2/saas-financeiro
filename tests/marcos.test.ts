import { RE_ENCERRAR, RE_NAO, RE_SIM, ehChamadaMarcos } from "../src/services/marcos/marcos";

describe("Marcos — reconhecimento de mensagens", () => {
  test.each(["marcos quanto devo pro fiuza?", "Marcos, essa nota é da basilico", "MARCOS", "  marcos: oi"])(
    "chama o Marcos: %s",
    (t) => expect(ehChamadaMarcos(t)).toBe(true)
  );

  test.each(["oi marcos", "marcosa", "o marcos disse", "dre julho"])("não chama o Marcos: %s", (t) =>
    expect(ehChamadaMarcos(t)).toBe(false)
  );

  test.each(["sim", "Sim!", "pode", "confirma", "ok"])("confirmação: %s", (t) => expect(RE_SIM.test(t)).toBe(true));
  test.each(["sim, mas muda o valor", "simples", "pode mudar pra 200?"])("não é confirmação: %s", (t) =>
    expect(RE_SIM.test(t)).toBe(false)
  );

  test.each(["não", "nao", "cancela", "esquece"])("cancelamento: %s", (t) => expect(RE_NAO.test(t)).toBe(true));

  test.each(["valeu marcos", "obrigado", "tchau", "era isso, obrigado"])("encerra: %s", (t) =>
    expect(RE_ENCERRAR.test(t)).toBe(true)
  );
  test.each(["valeu, mas quanto deu o total?", "obrigado, e o mês passado?"])("não encerra quando tem pergunta: %s", (t) =>
    expect(RE_ENCERRAR.test(t)).toBe(false)
  );
});
