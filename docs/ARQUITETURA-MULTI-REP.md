# Arquitetura multi-REP

O Ponto Câmara é o núcleo central do projeto e deve rodar no CMTB-SRV01 (Ubuntu).

## Princípios

- o sistema não depende de um fabricante;
- cada REP possui seu próprio identificador, função e sequência de NSR;
- marcações coletadas são imutáveis no sistema;
- IPM permanece responsável por jornada, banco de horas, justificativas e fechamento;
- integrações específicas ficam atrás de adaptadores/agentes.

## Dispositivos

Cada equipamento é cadastrado como:

- PRIMARY: REP principal;
- SECONDARY: contingência/segundo ponto.

O Topdata Inner REP Bio atual é o REP secundário e usa um agente Windows, pois o SDK legado do fabricante depende de Windows/.NET.

## Fluxo de cadastro

1. servidor é cadastrado no Ponto Câmara;
2. servidor é vinculado a um ou mais dispositivos;
3. uma tarefa é criada em `sync_jobs`;
4. o agente do fabricante consulta sua fila;
5. agente executa o cadastro no REP;
6. agente confirma sucesso ou erro;
7. o vínculo registra o último estado de sincronização.

## Fluxo de batidas

1. REP gera a marcação e o NSR;
2. adaptador/agente coleta;
3. evento é enviado ao endpoint `POST /api/agent/events`;
4. o servidor grava `device_id + NSR + data/hora + identificador do servidor + payload original`;
5. duplicidades são ignoradas por `source_id`;
6. integração IPM consome somente marcações persistidas.

## Segurança

O agente deve usar `x-agent-token`. Em produção, `AGENT_TOKEN` é obrigatório e deve ser diferente de qualquer senha de REP.
