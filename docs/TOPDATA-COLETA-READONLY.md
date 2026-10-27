# Coleta somente leitura do Topdata já em uso

O Inner REP Bio possui dados reais e deve ser tratado como fonte original de marcações.

## Registro de prova

- número REP: `00009000540012804`;
- data/hora: `27/10/2026 14:09`;
- NSR: `000043106`.

A primeira coleta de rede só será homologada quando esse NSR aparecer no material retornado pelo SDK/AFD.

## Sequência segura

1. testar `10.20.20.222:51000`;
2. identificar versão/firmware usando comando de leitura do SDK oficial;
3. selecionar a interface correta para o Inner REP antigo;
4. coletar AFD/marcações em modo somente leitura;
5. salvar uma cópia bruta antes de interpretar;
6. localizar NSR 43106;
7. importar para `device_events` preservando NSR, data/hora e payload original;
8. somente depois habilitar cadastro de servidores.

## Proibido nesta fase

- acertar relógio;
- trocar empregador;
- apagar chave;
- enviar lista de empregados;
- excluir empregado;
- alterar biometria;
- alterar rede;
- limpar memória.

## SDK

A Topdata disponibiliza o SDK Inner REP para Windows/.NET Framework 3.5 e exemplos específicos para equipamentos `Inner Rep < 2.0`.

Coloque as DLLs/manuais/exemplo C# oficiais em `agent-topdata/sdk/`. Não versionar binários proprietários no Git.
