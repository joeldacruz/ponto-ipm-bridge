# Simulação de comunicação IPM ↔ REP Control iD 671

## Objetivo

Descobrir quais endpoints o IPM/Atende.Net usa quando o relógio é cadastrado como **Control iD - iDClass 671 (por CPF)**.

O simulador implementa uma parte da API pública do REP iDClass e registra todas as requisições recebidas.

> Não é um REP real e não gera AFD fiscal válido. Use apenas em ambiente de teste.

## Executar

```bash
cp .env.example .env
npm install
npm run simulator:controlid
```

Padrão:

- Porta: `3091`
- Usuário: `admin`
- Senha: `admin`
- Logs: `data/simulator/requests.ndjson`

## Cadastro sugerido no IPM

Use um relógio de teste:

- Descrição: `SIMULADOR CONTROL ID 671`
- Modelo: `Control iD - iDClass 671 (por CPF)`
- IP/Host: endereço do computador onde o simulador está rodando
- Porta: `3091`
- Usuário: `admin`
- Senha: `admin`

Depois clique em **Testar Comunicação**.

## O que observar

Abra no navegador:

```
http://IP_DO_SIMULADOR:3091/simulator/logs
```

O log mostrará, em ordem, todas as chamadas realizadas pelo IPM.

Se aparecer um endpoint ainda não implementado, o simulador responde HTTP 501 e registra o nome. Com isso podemos adicionar a resposta esperada e repetir o teste.

## Endpoints já simulados

- `POST /login.fcgi`
- `POST /session_is_valid.fcgi`
- `POST /logout.fcgi`
- `POST /get_about.fcgi`
- `POST /get_system_information.fcgi`
- `POST /get_info.fcgi`
- `POST /get_system_date_time.fcgi`
- `POST /load_users.fcgi`
- `POST /load_company.fcgi`
- `POST /get_afd.fcgi`

## HTTPS

A API real do iDClass 671 normalmente trabalha em HTTPS. Para testar com TLS:

```env
SIM_PORT=443
SIM_TLS_CERT=/caminho/cert.pem
SIM_TLS_KEY=/caminho/key.pem
```

Execute com privilégios adequados ou use uma porta alta e um proxy reverso.

## Próximo passo

Após o primeiro **Testar Comunicação** no IPM, copie o conteúdo de:

```
data/simulator/requests.ndjson
```

Com esse log será possível reproduzir com precisão o protocolo que o IPM espera e depois criar um adaptador:

```
Hikvision ISAPI → Ponto IPM Bridge → API compatível esperada pelo IPM
```


## Windows / teste sem npm

Se o `npm install` falhar por causa de `better-sqlite3`, Node 24 ou `node-gyp`, use o simulador standalone:

```powershell
git pull
node .\tools\controlid-sim.cjs
```

Esse arquivo usa apenas módulos nativos do Node.js e não exige `npm install`, Python, Visual Studio Build Tools ou SQLite.
