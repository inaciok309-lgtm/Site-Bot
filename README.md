# 📱 Site do bot no Netlify (feito para celular)

Entre com o Discord, veja seus servidores, configure tickets, logs e automod e, se for o dono
do ID `1495890474840621197`, use a aba **🦟 Baygon**. Tudo funciona pelo navegador do celular.

O bot continua na Discloud (`TYPE=bot`). Ele consulta este site de tempos em tempos, executa
os pedidos e devolve o resultado — o site nunca precisa alcançar o bot.

## Tutorial pelo celular (passo a passo)

Você vai usar só o navegador do celular. Em alguns sites do Discord/GitHub, se a tela vier
cortada, ative **"Site para computador"** no menu do navegador.

### 1. Coloque o projeto no GitHub
O Netlify precisa instalar o `@netlify/blobs`, então publique pelo GitHub (não arraste o zip).
1. Entre/crie conta em **github.com**.
2. Crie um repositório novo (**New repository**), nome `site-bot`, marque **Private**.
3. Descompacte `site-netlify.zip` no celular (app Arquivos / gerenciador de arquivos).
4. No repositório: **Add file → Upload files** e envie TODOS os arquivos e pastas
   (`netlify.toml`, `package.json`, pasta `public`, pasta `netlify`). Se o celular não deixar
   enviar pastas, ative "Site para computador" ou envie arquivo por arquivo mantendo os
   caminhos (GitHub permite digitar `netlify/functions/api.mjs` ao criar um arquivo).
5. **Commit changes**.

### 2. Crie o site no Netlify
1. Entre em **app.netlify.com** com a conta do GitHub.
2. **Add new site → Import an existing project → GitHub** e escolha `site-bot`.
3. Deixe as opções como estão (o `netlify.toml` já configura tudo) e clique **Deploy**.
4. Quando terminar, copie o endereço (algo como `https://nome.netlify.app`).
   Esse é o seu **SITE_URL** (sem `/` no final).

### 3. Pegue o Client Secret no Discord
1. **discord.com/developers/applications** → seu bot → **OAuth2**.
2. Copie (ou **Reset Secret**) o **Client Secret**.
3. Em **Redirects**, adicione `SITE_URL/auth/callback`
   (ex.: `https://nome.netlify.app/auth/callback`) e salve.

### 4. Cadastre as variáveis no Netlify
**Site configuration → Environment variables → Add a variable**:
| Nome | Valor |
|---|---|
| `DISCORD_CLIENT_SECRET` | o secret do passo 3 |
| `BRIDGE_KEY` | a mesma que está no `.env` do **bot** (linha `BRIDGE_KEY=`) |
| `SITE_URL` | o endereço do passo 2 |

Depois vá em **Deploys → Trigger deploy → Deploy site** para aplicar.

### 5. Ligue o bot
No `.env` do bot (`mod-ticket-bot-discord.zip`), troque a linha `# SITE_URL=...` por
`SITE_URL=https://nome.netlify.app` (sem `#`). Suba/atualize o bot na Discloud.
Nos logs do bot deve aparecer **`[ponte] Conectada ao site`**.

### 6. Use
Abra o `SITE_URL` no celular, toque em **Entrar com Discord** e em **⚙️ Configurar**.
Dica: no menu do navegador use **Adicionar à tela inicial** para virar um atalho de app.

## Como o bot "atende" o site
O Netlify não mantém conexões abertas, então o bot consulta o site em intervalos:
rápido (~1,5 s) enquanto há atividade e mais devagar (padrão 10 s) quando está parado.
Por isso a **primeira** ação depois de um tempo parado pode levar alguns segundos
(a tela mostra "⏳ Falando com o bot…"); as seguintes são quase imediatas.

⚠️ Cada consulta usa uma execução de função do Netlify. Se o seu plano tiver limite de
execuções, aumente `BRIDGE_IDLE_SECONDS` (até 60) nas variáveis do Netlify para gastar menos
— em troca, a primeira ação demora mais. Confira os limites do seu plano no painel do Netlify.

## Problemas comuns
- **Login volta com erro:** o Redirect no Discord precisa ser exatamente `SITE_URL/auth/callback`.
- **"O bot está offline":** confira `SITE_URL` e `BRIDGE_KEY` no bot e se o log mostra
  `[ponte] Conectada ao site`. A `BRIDGE_KEY` deve ser igual nos dois lados.
- **Mudei variável e nada mudou:** faça um novo deploy (passo 4).
- **Servidor mostra "Adicionar":** o bot ainda não está nele ou ainda não conectou.

## Segurança
Só quem tem Administrador/Gerenciar Servidor edita um servidor, e o bot revalida a permissão
a cada pedido. O Painel Baygon é recusado para qualquer outra conta, no site e no bot.
Se a `BRIDGE_KEY` vazar, troque nos dois lados.
