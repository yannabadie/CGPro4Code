# cgpro

**ChatGPT Pro depuis votre terminal.** Pilote `chatgpt.com` avec une vraie session Chrome pour exposer **GPT-5.5 Pro** (réflexion étendue + recherche web) dans le shell, avec votre abonnement ChatGPT Pro existant.

```
$ cgpro ask --web "top story sur Hacker News, en 2 lignes"
gpt ▸ "OpenAI ships GPT-5.5 Pro to API" (892 pts) — discussion sur le rollout
       et la tarification annoncés ce matin.
```

## Pourquoi

Au 25 avril 2026, **GPT-5.5 Pro n'existe que dans l'app ChatGPT** (web + mobile). Pas dans l'API publique, pas dans Codex CLI. Le seul moyen de le scripter, c'est de piloter la même UI qu'un utilisateur connecté. C'est ce que fait `cgpro`.

## Installation

Pré-requis : **Node.js ≥ 20** et **Chrome** installé.

```bash
git clone https://github.com/yannabadie/CGPro4Code.git cgpro
cd cgpro
npm install
npm run build
npm link
```

`npm link` met la commande `cgpro` sur votre `PATH`. Sinon : `node dist/cli/index.js …`.

## Premier run

```bash
cgpro login
```

Chrome s'ouvre sur `chatgpt.com`. Vous vous connectez (mot de passe, 2FA, Cloudflare si besoin). La commande détecte la session et se ferme.

```bash
cgpro status
# Account:      vous@exemple.com
# Plan:         pro
# GPT-5.5 Pro:  ✓
```

## Commandes

| Commande | Effet |
|---|---|
| `cgpro login` | Ouvre Chrome, vous vous connectez (à faire une fois). |
| `cgpro logout` | Efface le profil local. |
| `cgpro status` | Email, plan, modèles disponibles, détection GPT-5.5 Pro. |
| `cgpro models` | Liste les modèles dispo pour votre abonnement. |
| `cgpro ask "..."` | Une question, une réponse streamée. |
| `cgpro chat` | REPL multi-tours. |
| `cgpro thread list/show/save/rm/rename` | Gestion des conversations sauvegardées. |
| `cgpro doctor` | Audit des selectors contre le DOM live. |

### `ask`

```bash
cgpro ask "explique les CRDT en 3 puces"
cgpro ask --web "météo à Lyon aujourd'hui"
cgpro ask --no-web "donne un type TypeScript strict pour les dates ISO-8601"
cgpro ask -i schema.png "explique cette archi"
echo "review ce code" | cgpro ask < src/api/me.ts
cgpro ask --json "ping" | jq .
cgpro ask --save mybranch "..."   # sauvegarde la conv sous ce nom
```

### `chat` (REPL)

```bash
cgpro chat
# you ▸ ...
# gpt ▸ ...
# you ▸ :web off
# you ▸ :save db-migrations
# you ▸ :quit
```

Multi-ligne : terminez une ligne par `\` pour continuer sur la suivante.

| Slash | Effet |
|---|---|
| `:web on/off` | Bascule la recherche web. |
| `:model <slug>` | Change de modèle (réinitialise la conversation). |
| `:reset` | Repart sur une nouvelle conversation. |
| `:save <nom>` | Sauvegarde la conversation courante. |
| `:thread` | Affiche l'UUID chatgpt.com de la conversation. |
| `:quit` ou Ctrl+C | Quitter. |

## Flags utiles

| Flag | Défaut | Note |
|---|---|---|
| `--model <slug>` | `gpt-5-pro` | Auto-détecte le slug Pro de votre compte. |
| `--web` / `--no-web` | `--web` | Recherche internet temps réel. |
| `--headed` / `--headless` | headed | Headed = stable et ce qu'on voit. |
| `--profile <path>` | `~/.cgpro/profile` | Pour gérer plusieurs comptes. |
| `--resume <nom\|id>` | — | Reprend une conversation existante. |
| `--save <nom>` | — | Sauvegarde la conversation. |
| `--timeout <s>` | `600` | Wait max par tour. |
| `--json` | off | Stream NDJSON. |
| `--render` | off | Rend le markdown à la fin. |

## Stockage local

```
~/.cgpro/
├── profile/        # cookies, IndexedDB, session Chromium
├── threads.json    # { nom: uuid_chatgpt }
└── config.json     # défauts utilisateur
```

Rien n'est envoyé ailleurs que sur `chatgpt.com`.

## Si ça casse

OpenAI fait évoluer `chatgpt.com` régulièrement. Si un jour `cgpro ask` reste bloqué :

```bash
cgpro doctor
```

Le premier `✖` indique le sélecteur cassé. Patchez la première entrée de la liste correspondante dans `src/browser/selectors.ts`, puis :

```bash
npm run build
cgpro ask "test"
```

C'est le **seul** fichier qui contient des sélecteurs DOM. Reste tout volontairement encapsulé pour absorber ces dérives.

## Tests

```bash
npm test
```

14 tests : SSE parser (delta, JSON-patch, parts cumulatifs, chunks fragmentés, JSON malformé), store des threads, intégrité des sélecteurs.

## Conformité

`cgpro` se connecte avec **votre propre** abonnement ChatGPT via le flow de login officiel. Mêmes identifiants, même session, mêmes rate limits que l'app desktop. Usage personnel CLI.

Pour la prod / multi-utilisateurs : utilisez l'[OpenAI Platform API](https://platform.openai.com/) quand GPT-5.5 Pro y arrivera.

## Documentation interne

- Spec : [`docs/superpowers/specs/2026-04-25-cgpro-design.md`](docs/superpowers/specs/2026-04-25-cgpro-design.md)
- Plan : [`docs/superpowers/plans/2026-04-25-cgpro-implementation-plan.md`](docs/superpowers/plans/2026-04-25-cgpro-implementation-plan.md)

## Licence

MIT — voir [LICENSE](./LICENSE).
