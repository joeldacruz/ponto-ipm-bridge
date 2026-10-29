# Agente Windows Topdata

Agente mínimo para conectar o SDK legado do Topdata Inner REP ao Ponto Câmara no CMTB-SRV01.

## Estado atual

O agente já:

- testa TCP do REP em `10.20.20.222:51000`;
- envia heartbeat para o servidor;
- consulta a fila de sincronização;
- lê integralmente os empregados atuais antes de qualquer escrita;
- grava somente a configuração de empregados pelo gerenciador específico do SDK, sem chamar `EnviaConfiguracoes()`;
- reconstrói a lista completa, preservando nome, PIS, cartão, PIN e biometria dos registros existentes;
- confirma a escrita por nova leitura integral do REP;
- salva backup local criptografado por DPAPI antes da alteração.

A escrita continua **bloqueada por padrão**. Em produção, o portal gera uma autorização assinada e de uso específico para um servidor/REP; a allowlist local fica apenas como mecanismo de homologação/emergência.

## Requisito do SDK oficial

A Topdata documenta Windows + .NET Framework 3.5 para o SDK Inner REP e fornece exemplos C# específicos para `Inner Rep < 2.0`.

O agente carrega a DLL por reflexão a partir de `TOPDATA_SDK_PATH`. Para empregados, ele usa o gerenciador interno específico de empregados do SDK e não executa a rotina genérica de configurações do REP.

## Configuração

Editar `App.config`:

- ServerUrl: API do CMTB-SRV01;
- AgentToken: mesmo valor de `AGENT_TOKEN` no servidor;
- DeviceHost: IP do REP;
- DevicePort: normalmente 51000.

## Segurança

Nunca versionar chave de comunicação do REP, senha administrativa ou token de produção.


## Coleta automática somente leitura

A coleta real do Inner REP usa variáveis de ambiente locais, sem versionar a chave:

- `TOPDATA_SDK_PATH`: caminho completo para `SDK_Inner_Rep.dll`;
- `TOPDATA_COMM_KEY`: chave de comunicação do REP;
- `TOPDATA_INITIAL_NSR`: NSR inicial homologado; padrão atual `43106`.

O checkpoint fica em `%ProgramData%\PontoCamara\<deviceId>.nsr`.

Na primeira execução o agente importa o NSR inicial e, nas seguintes, consulta o último NSR disponível e coleta apenas a diferença. O servidor deduplica por `sourceId = deviceId:nsr`.


## Escrita controlada de empregados

Variáveis adicionais:

- `TOPDATA_ENABLE_EMPLOYEE_WRITE=1`: habilita o caminho de escrita no agente;
- `TOPDATA_WRITE_ALLOW_PIS=`: normalmente fica vazio em produção; uma lista explícita de PIS/PASEP pode ser usada somente para homologação/emergência;
- `PONTO_AGENT_TOKEN`: deve ser o mesmo `AGENT_TOKEN` do servidor e é usado também para validar a autorização assinada do portal.

O valor `*` não é aceito pelo writer. No fluxo normal, cada clique em **Enviar ao REP** cria um job para um único servidor e um único REP, com autorização HMAC assinada pelo servidor e validade limitada. O agente confere PIS, REP, assinatura e horário antes de qualquer escrita.

Antes da gravação ele lê todos os empregados, bloqueia lista vazia/incompleta, detecta PIS/cartão duplicado, cria backup protegido em `%ProgramData%\PontoCamara\backups` e confirma o resultado por nova leitura integral do REP.
