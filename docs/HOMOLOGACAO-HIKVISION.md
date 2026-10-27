# Homologação Hikvision DS-K1T342MX-E1

Antes de usar em produção:

1. Cadastrar funcionário de teste.
2. Cadastrar cartão M1 13,56 MHz e face.
3. Configurar autenticação cartão + face.
4. Fazer um evento somente de abertura de porta.
5. Fazer um evento como frequência/ponto.
6. Consultar ambos pela ISAPI.
7. Confirmar qual campo/valor diferencia os dois eventos.
8. Confirmar `employeeNoString`, `dateTime`, `cardNo` e `attendanceStatus` reais.
9. Testar equipamento sem rede e recuperação posterior dos eventos.
10. Validar fuso horário e sincronização NTP.
11. Só então congelar a regra de classificação no código.

> A implementação atual de `classifyEvent` é deliberadamente conservadora e precisa ser homologada com payload real do equipamento.
