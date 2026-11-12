# Deploy na AWS EC2 com GitHub Actions

O workflow `.github/workflows/deploy.yml` publica as imagens no GHCR e conecta
à instância EC2 por SSH. Ele copia `stack.yml`, as migrations e a configuração
do Nginx, inicia o MySQL, aplica migrations e atualiza API e frontend. Não é
necessário clonar o repositório manualmente na VPS.

## Preparar a instância

Instale Docker Engine com o plugin Docker Compose e o Nginx no Ubuntu. O usuário
`ubuntu` precisa poder executar `sudo docker` e `sudo nginx`. O workflow instala
a configuração do site e recarrega o Nginx a cada deploy.

No Security Group da EC2:

- `80/tcp`: liberar para acesso ao site.
- `443/tcp`: liberar quando HTTPS estiver configurado.
- `22/tcp`: permitir SSH da origem necessária para o runner do GitHub Actions.
  Não abra essa porta para `0.0.0.0/0` só para fazer o deploy funcionar. Os
  runners hospedados pelo GitHub usam endereços que podem mudar. Se a regra atual
  permite somente seu IP, o deploy hospedado pelo GitHub não conseguirá conectar;
  para uma regra de entrada estável e restrita, use runner self-hosted ou AWS
  Systems Manager.
- `3306/tcp`: não criar regra de entrada. O MySQL só é acessível dentro da rede
  Docker.

Use um Elastic IP ou DNS estável como `EC2_SSH_HOST` e configure
`FRONTEND_URL` com a origem pública, sem barra no final. O Nginx serve HTTP na
porta 80; configure domínio e TLS separadamente antes de exigir HTTPS.

## Secrets e variáveis do GitHub

Em **Settings → Secrets and variables → Actions**, configure:

| Nome | Tipo | Valor |
|---|---|---|
| `EC2_SSH_HOST` | Secret | Elastic IP ou DNS público da EC2 |
| `EC2_SSH_USER` | Secret | `ubuntu` (opcional; esse é o padrão) |
| `EC2_SSH_PORT` | Secret | `22` (opcional; esse é o padrão) |
| `EC2_SSH_KEY` | Secret | Conteúdo da chave privada que corresponde a uma chave pública autorizada em `/home/ubuntu/.ssh/authorized_keys` |
| `DB_ROOT_PASSWORD` | Secret | Senha exclusiva do root MySQL, 64 caracteres hexadecimais |
| `DB_USER` | Secret | Usuário da aplicação; letras, números e `_` |
| `DB_PASSWORD` | Secret | Senha exclusiva da aplicação, 64 caracteres hexadecimais |
| `DB_NAME` | Secret | Nome do banco; letras, números e `_` |
| `GRAFANA_ADMIN_PASSWORD` | Secret | Senha exclusiva do Grafana, 64 caracteres hexadecimais |
| `GHCR_READ_TOKEN` | Secret | PAT com `read:packages`, se as imagens do GHCR forem privadas |
| `GHCR_USERNAME` | Secret | Opcional; usuário dono do PAT, padrão é quem acionou o workflow |
| `VITE_MAPTILER_API_KEY` | Secret | Chave MapTiler usada na compilação do frontend |
| `FRONTEND_URL` | Variable | Origem pública, por exemplo `http://44.223.68.107` |
| `VITE_API_URL` | Variable | Opcional; padrão `/api` |

Para senhas aceitas pelo arquivo de ambiente do Compose, gere valores hexadecimais
no seu computador com `openssl rand -hex 32`. Não envie os valores ao chat nem os
grave no repositório. O pacote GHCR pode ser público para dispensar
`GHCR_READ_TOKEN`; se for privado, o PAT precisa pertencer a uma conta que tenha
acesso de leitura ao pacote.

Se a chave que você tem for a `.pem` criada ao lançar a EC2, use seu conteúdo
como `EC2_SSH_KEY`, desde que a chave pública correspondente esteja autorizada
na instância. Se ela ainda não estiver autorizada, adicione a chave pública ao
`authorized_keys` usando uma sessão administrativa da EC2. Nunca coloque a
chave privada no repositório.

## Banco e persistência

O serviço `db` usa a imagem MySQL 8.4 e o volume nomeado
`bioguardians_mysqldata`. O workflow executa as migrations **na EC2**, pela rede
privada do Compose, antes de atualizar backend e frontend. As credenciais de
produção não são enviadas ao runner para conexão direta com o MySQL.

O banco não publica a porta 3306 no host. Backend e migration usam o hostname
interno `db`. Faça backup do volume antes de qualquer manutenção destrutiva.

Os limites dos três serviços principais somam cerca de 2,3 GiB; use uma
instância com pelo menos 4 GiB de RAM para manter margem para o Ubuntu e picos
do banco.

Os serviços de observabilidade ficam no perfil opcional `observability` para
reduzir RAM no deploy inicial. Grafana fica limitado a `127.0.0.1:3000`; os
demais endpoints não são publicados no host. Ative o perfil manualmente quando
a instância tiver memória suficiente:

```bash
cd ~/bioguardians
sudo docker compose --env-file .env -f stack.yml \
  -f docker-compose.ec2-observability.yml --profile observability up -d
```

## Execução

O deploy automático ocorre em push na `main`. Também é possível usar
**Actions → Deploy → Run workflow** na branch `main`. O workflow não faz deploy
de branches de feature.
