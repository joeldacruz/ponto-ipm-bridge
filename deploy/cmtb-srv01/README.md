# Implantação no CMTB-SRV01

Estrutura prevista para o Ubuntu 24.04:

- aplicação: `/srv/projetos/ponto-camara`
- dados persistentes: `/srv/dados/ponto-camara`
- configuração: `/etc/ponto-camara/ponto-camara.env`
- serviço: `ponto-camara.service`

## Pré-requisitos

- Node.js 22 LTS;
- npm;
- acesso do servidor às VLANs/redes necessárias;
- token dedicado para agentes.

## Preparação prevista

```bash
sudo useradd --system --home /srv/projetos/ponto-camara --shell /usr/sbin/nologin ponto-camara
sudo mkdir -p /srv/projetos/ponto-camara /srv/dados/ponto-camara /etc/ponto-camara
sudo chown -R ponto-camara:ponto-camara /srv/projetos/ponto-camara /srv/dados/ponto-camara
sudo chmod 750 /srv/dados/ponto-camara /etc/ponto-camara
```

Copiar o repositório para `/srv/projetos/ponto-camara`, instalar dependências e criar o arquivo de ambiente a partir de `ponto-camara.env.example`.

Depois instalar a unit:

```bash
sudo cp deploy/cmtb-srv01/ponto-camara.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ponto-camara
sudo systemctl status ponto-camara
```

## Observação

O MVP usa SQLite. Antes da produção definitiva, avaliar migração para PostgreSQL do CMTB-SRV01 e autenticação do painel web.
