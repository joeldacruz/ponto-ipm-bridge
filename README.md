# Ponto Câmara / Ponto IPM Bridge

Sistema da Câmara de Vereadores de Três Barras/SC para centralizar **coleta de marcações de ponto de múltiplos REPs**, cadastro de servidores e integração posterior com o IPM.

## Arquitetura

O núcleo deve rodar no **CMTB-SRV01 (Ubuntu)**.

O sistema é independente de fabricante:

- REP principal: equipamento definitivo a ser definido/homologado;
- REP secundário: **Topdata Inner REP Bio**, usado para contingência e testes;
- futuros REPs podem ser adicionados sem alterar o modelo central.

Equipamentos que possuam API compatível com Linux podem ser acessados diretamente pelo servidor. O Topdata legado utiliza um pequeno agente Windows porque o SDK oficial Inner REP depende de Windows/.NET.

## Responsabilidades

### Ponto Câmara

- cadastro de servidores;
- cadastro de vários REPs;
- vínculo de um servidor a um ou mais equipamentos;
- fila auditável de sincronização;
- coleta e armazenamento imutável das batidas;
- preservação de `device_id`, NSR, horário e payload original;
- painel de status;
- preparação da integração IPM.

### REP

O REP é a fonte da marcação original. O sistema não inventa, altera nem renumera NSR.

### IPM

O IPM permanece responsável por:

- jornada;
- banco de horas;
- horas extras;
- atrasos;
- justificativas;
- férias/afastamentos;
- fechamento mensal.

## Banco

O MVP ainda usa SQLite. O modelo já está preparado para:

- `devices`: equipamentos;
- `employees`: servidores;
- `employee_device_bindings`: vínculo servidor x REP;
- `device_events`: batidas;
- `sync_jobs`: fila de envio de cadastros;
- `audit_log`: auditoria.

A migração para PostgreSQL do CMTB-SRV01 pode ser feita antes da produção sem mudar o contrato da API.

## REP Topdata de contingência

Configuração atual de laboratório:

- ID: `rep-topdata-02`
- modelo: Inner REP Bio
- função: SECONDARY
- IP: `10.20.20.222`
- porta TCP: `51000`
- agente: `topdata-windows-01`

O agente será responsável por conversar com a DLL oficial Topdata, coletar marcações e executar cadastros enfileirados pelo servidor.

## API principal

- `GET /health`
- `GET/POST /api/devices`
- `GET/POST /api/employees`
- `POST /api/employees/:id/bindings`
- `POST /api/employees/:id/sync`
- `GET /api/events/attendance`
- `GET /api/sync/jobs`

### API do agente

- `POST /api/agent/heartbeat`
- `GET /api/agent/:agentId/jobs`
- `POST /api/agent/jobs/:id/result`
- `POST /api/agent/events`

Quando `AGENT_TOKEN` estiver configurado, o agente deve enviar:

`x-agent-token: <token>`

## Stack

- Node.js 22 LTS
- TypeScript
- Express
- SQLite no MVP
- PostgreSQL previsto para produção no CMTB-SRV01
- agente Windows apenas para SDKs que exigem Windows

## Instalação de desenvolvimento

```bash
cp .env.example .env
npm install
npm run dev
```

Acesse `http://localhost:3090`.

## Documentação

- `docs/ARQUITETURA-MULTI-REP.md`
- `docs/AGENTE-TOPDATA.md`
- documentação de homologação já existente em `docs/`

## Segurança e auditoria

- nunca versionar senha/chave de REP;
- usar `AGENT_TOKEN` forte em produção;
- manter comunicação dos equipamentos em rede interna;
- sincronizar horário por NTP;
- preservar payload original das marcações;
- manter trilha de auditoria;
- não permitir edição de NSR/data-hora de marcação coletada;
- tratar CPF, biometria e demais dados pessoais conforme LGPD e regras administrativas aplicáveis.

## Próximas etapas

1. validar o novo modelo multi-REP localmente;
2. baixar o SDK oficial Topdata e identificar a interface correta do Inner REP antigo;
3. implementar o agente Windows Topdata;
4. testar leitura do equipamento sem alterar cadastros;
5. testar coleta incremental por NSR;
6. habilitar cadastro de servidor no REP secundário;
7. homologar o REP principal;
8. migrar o núcleo para o CMTB-SRV01;
9. concluir integração automática com o IPM.
