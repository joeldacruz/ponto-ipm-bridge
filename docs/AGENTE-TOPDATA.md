# Agente Topdata - contrato do Ponto Câmara

O Topdata Inner REP Bio fica como equipamento secundário/contingência.

## Responsabilidade

O agente Windows é apenas um adaptador do SDK oficial Topdata. Ele não mantém banco de dados funcional e não calcula jornada.

Funções:

1. testar conexão com o REP;
2. enviar heartbeat ao CMTB-SRV01;
3. buscar tarefas de cadastro de servidores;
4. executar inclusão/alteração no REP via SDK oficial;
5. coletar novas marcações/NSR;
6. enviar as marcações ao servidor central;
7. confirmar cada tarefa como sucesso ou erro.

## REP de laboratório

- ID lógico: `rep-topdata-02`
- modelo: Inner REP Bio
- função: SECONDARY
- IP atual: `10.20.20.222`
- porta: `51000`
- agente: `topdata-windows-01`

## Endpoints

### Heartbeat

`POST /api/agent/heartbeat`

Exemplo:

```json
{
  "agentId": "topdata-windows-01",
  "devices": [
    { "deviceId": "rep-topdata-02", "online": true }
  ]
}
```

### Buscar tarefas

`GET /api/agent/topdata-windows-01/jobs`

### Confirmar tarefa

`POST /api/agent/jobs/{id}/result`

```json
{ "ok": true }
```

### Enviar batidas

`POST /api/agent/events`

```json
{
  "deviceId": "rep-topdata-02",
  "events": [
    {
      "sourceId": "rep-topdata-02:12345",
      "nsr": 12345,
      "employeeNo": "3026",
      "occurredAt": "2026-10-27T07:01:22-03:00",
      "kind": "ATTENDANCE",
      "rawPayload": "registro original coletado do REP"
    }
  ]
}
```

## Regra de homologação

Enquanto o SDK oficial ainda não estiver ligado ao agente, nenhuma operação deve fingir que escreveu no REP. As tarefas ficam pendentes ou retornam erro explícito. Não gerar NSR artificial para produção e não alterar registros fiscais existentes.
