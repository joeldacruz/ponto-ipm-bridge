# Ponto IPM Bridge

Projeto da Câmara de Vereadores de Três Barras/SC para coletar **somente registros de frequência** de controladores de acesso e gerar arquivo para posterior importação no sistema IPM.

## Escopo

- coletar eventos do controlador Hikvision DS-K1T342MX-E1 via ISAPI;
- distinguir **ACESSO** de **FREQUÊNCIA/PONTO**;
- vincular o identificador do equipamento ao funcionário;
- armazenar os eventos com trilha de auditoria;
- conferir marcações por período;
- gerar arquivo de importação para o IPM.

## Fora do escopo

O sistema **não** calcula jornada, banco de horas, horas extras, atrasos, férias, afastamentos ou fechamento mensal. Essas funções permanecem no IPM.

## Estado atual

MVP técnico inicial. O layout definitivo de exportação para IPM está **pendente de um arquivo real aceito ou documentação oficial**.

## Stack

- Node.js 22+
- TypeScript
- Express
- SQLite
- Hikvision ISAPI

## Instalação

```bash
cp .env.example .env
npm install
npm run dev
```

Acesse `http://localhost:3090`.

## Estrutura

- `src/adapters/` integração com equipamentos
- `src/core/` regras de classificação
- `src/services/` persistência e exportação
- `src/storage/` banco local
- `src/http/` API
- `docs/` arquitetura e homologação

## Segurança

- nunca versionar senhas do controlador;
- usar conta dedicada com menor privilégio possível;
- manter o serviço em rede interna;
- sincronizar horário por NTP;
- preservar o payload original de cada evento para auditoria;
- tratar dados faciais e demais dados pessoais conforme as regras administrativas aplicáveis.

## Próximas etapas

1. Homologar payload real do DS-K1T342MX-E1.
2. Implementar autenticação Digest da ISAPI, se exigida pelo firmware.
3. Criar coletor automático incremental.
4. Criar painel de conferência.
5. Obter layout real do arquivo de importação IPM.
6. Implementar e testar o exportador IPM.
