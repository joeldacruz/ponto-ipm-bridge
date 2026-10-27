# Agente Windows Topdata

Agente mínimo para conectar o SDK legado do Topdata Inner REP ao Ponto Câmara no CMTB-SRV01.

## Estado atual

O agente já:

- testa TCP do REP em `10.20.20.222:51000`;
- envia heartbeat para o servidor;
- consulta a fila de sincronização;
- devolve erro explícito `SDK_TOPDATA_NOT_CONNECTED` para tarefas de escrita enquanto a DLL oficial ainda não estiver ligada.

Ele **não** finge cadastro, coleta ou alteração no relógio.

## Requisito do SDK oficial

A Topdata documenta Windows + .NET Framework 3.5 para o SDK Inner REP e fornece exemplos C# específicos para `Inner Rep < 2.0`.

Depois de baixar o pacote oficial, o próximo passo é substituir o corpo de `TopdataDeviceClient.Execute` por chamadas reais da interface correspondente ao firmware encontrado no relógio.

## Configuração

Editar `App.config`:

- ServerUrl: API do CMTB-SRV01;
- AgentToken: mesmo valor de `AGENT_TOKEN` no servidor;
- DeviceHost: IP do REP;
- DevicePort: normalmente 51000.

## Segurança

Nunca versionar chave de comunicação do REP, senha administrativa ou token de produção.
