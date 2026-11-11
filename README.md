# Wiziki

Moteur de wiki simple, auto-hébergeable, et base de la plateforme d'hébergement wiziki.org / mywiziki.com.

## Démarrer en local

```bash
npm install
npm run build                                   # construit l'interface (packages/web/dist)
ADMIN_PASSWORD=un-mot-de-passe npm run dev      # http://localhost:3000  (édition : /?mode=admin)
npm test                                        # construit puis lance les tests automatiques
```

Pour travailler sur l'interface avec rechargement instantané : `npm run dev` dans un terminal (API sur :3000),
`npm run dev:web` dans un autre, puis ouvrir http://localhost:5173.

Les données sont dans `./data` (ou `$WIZIKI_DATA_DIR`) : `wiziki.db` (SQLite) et `files/` (images).

## Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `ADMIN_PASSWORD` | Facultatif. Au premier démarrage seulement : crée le compte propriétaire `admin` avec ce mot de passe. Sans lui, un écran d'installation s'affiche (jeton dans les journaux du serveur) | — |
| `WIZIKI_DATA_DIR` | Dossier des données | `./data` |
| `PORT` / `HOST` | Écoute HTTP | `3000` / `0.0.0.0` |
| `TRUST_PROXY` | `1` derrière un reverse proxy (Caddy, Nginx) | — |
| `WIZIKI_LOG_LEVEL` | `info`, `warn`, `error`, `silent` | `info` |

## Comptes et rôles

Chaque wiki a des membres avec un rôle : **owner** (tout, y compris la gestion des membres et la visibilité),
**editor** (pages, arbre, images) ou **reader** (lecture d'un wiki privé). Un wiki **public** se lit sans compte.
Connexion : `/?mode=admin` ou le lien « Se connecter » en bas du menu. Les propriétaires gèrent les membres depuis « 👥 Membres ».

## Commandes (CLI)

```bash
npm run wiziki -- import-legacy <dossier>   # importer un wiki de la version 1 (pages/, media/, uploads/, structure.json)
npm run wiziki -- export mon-wiki.zip        # export complet au format ouvert (pages, arbre, images, historique)
npm run wiziki -- import mon-wiki.zip --force  # remplace le contenu du wiki par un export
npm run wiziki -- backup sauvegarde.db      # copie cohérente de la base, serveur démarré ou non
npm run wiziki -- info                      # wikis et contenu
npm run wiziki -- utilisateurs              # comptes et rôles
npm run wiziki -- utilisateur-ajouter marie --role owner --email marie@exemple.org
npm run wiziki -- mot-de-passe marie        # mot de passe oublié : en définir un nouveau
```

Dans le conteneur Docker, la commande s'appelle directement `wiziki`.

## Export / import

Depuis l'interface (**💾 Export / import**, propriétaires) ou en ligne de commande : un fichier .zip lisible sans Wiziki
(Markdown, JSON, images), pour sauvegarder un wiki ou le déplacer vers un autre serveur. Format décrit dans
[docs/format-export.md](docs/format-export.md).

## Docker (standalone)

```bash
docker build -f docker/standalone/Dockerfile -t wiziki .
docker run -d -p 127.0.0.1:3000:3000 -e ADMIN_PASSWORD=... -v ./data:/data wiziki
```

Ou avec [docker/standalone/docker-compose.yml](docker/standalone/docker-compose.yml) et un fichier `.env`.

## Organisation du code

```
packages/
  core/       logique du wiki (pages, arbre, révisions, images) — sans dépendance à l'infrastructure
  adapters/   base de données (SQLite, migrations Kysely) et stockage des fichiers (disque)
  server/     API HTTP (Fastify) et tests
  web/        interface : index.html (sans aucun script), src/ (modules JS, styles Tailwind), build Vite → dist/
  cli/        commandes d'administration
docker/standalone/   image Docker et docker-compose
```

## Licence

AGPL-3.0-or-later pour le code de ce dépôt (texte complet : [LICENSE](LICENSE)). Les modules de la plateforme hébergée sont dans un dépôt séparé.

## Contact

- Code source : https://github.com/wiziki-org/wiziki
- Signaler un problème : https://github.com/wiziki-org/wiziki/issues
- Contact : contact@wiziki.org
