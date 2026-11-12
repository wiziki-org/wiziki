# Installer Wiziki

Wiziki tourne dans un seul conteneur Docker. Toutes les données (base SQLite, images, sauvegardes automatiques) sont dans un seul
dossier, `/data` dans le conteneur.

## Installer

Il faut [Docker](https://docs.docker.com/get-docker/), avec Docker Compose.

```sh
mkdir wiziki && cd wiziki
curl -fsSLO https://raw.githubusercontent.com/wiziki-org/wiziki/main/docker/standalone/docker-compose.yml
docker compose up -d
```

Ouvrez ensuite **http://localhost:3100**.

Sans Docker Compose, une seule commande suffit :

```sh
docker run -d --name wiziki --restart unless-stopped -p 127.0.0.1:3100:3000 -v wiziki-data:/data ghcr.io/wiziki-org/wiziki:1
```

## Premier démarrage : le compte propriétaire

Au premier démarrage, un **écran d'installation** demande un jeton. Il est affiché dans les journaux du serveur :

```sh
docker compose logs wiziki          # ou : docker logs wiziki
```

Saisissez ce jeton, puis créez votre compte : vous devenez propriétaire du wiki.

Si vous préférez, définissez plutôt `ADMIN_PASSWORD` au premier démarrage : un compte `admin` est créé avec ce mot de passe.
Par exemple, dans un fichier `.env` à côté de `docker-compose.yml` :

```sh
ADMIN_PASSWORD=un-long-mot-de-passe
```

`ADMIN_PASSWORD` ne sert qu'au premier démarrage. Pour changer de mot de passe ensuite : « 🔑 Mon compte » dans le wiki,
ou en ligne de commande `docker compose exec wiziki wiziki mot-de-passe admin`.

## Mettre en ligne (HTTPS)

Le conteneur écoute seulement sur la machine elle-même (`127.0.0.1:3100`). Pour le rendre accessible sur Internet, placez devant un
reverse proxy HTTPS. Avec [Caddy](https://caddyserver.com), qui obtient le certificat tout seul :

```
wiki.example.org {
	reverse_proxy 127.0.0.1:3100
}
```

Gardez `TRUST_PROXY=1` (déjà dans le `docker-compose.yml`), pour que le wiki voie la vraie adresse des visiteurs.

## Mettre à jour

```sh
docker compose pull
docker compose up -d
```

L'étiquette `:1` suit toujours la dernière version 1.x. Les versions 1.x restent compatibles avec vos données. Pour choisir une
version précise, utilisez par exemple `ghcr.io/wiziki-org/wiziki:1.0.0`.

**Avant toute mise à jour du schéma**, le serveur copie automatiquement la base dans `/data/sauvegardes/`. Il garde les
5 dernières copies. Les nouveautés de chaque version sont décrites dans le [journal des versions](../CHANGELOG.md).

## Sauvegarder

Deux possibilités :

- **Export complet** depuis le wiki (« 💾 Export / import »), ou en ligne de commande :

  ```sh
  docker compose exec wiziki wiziki export /data/export.zip
  ```

  C'est un fichier .zip au format ouvert ([docs/format-export.md](format-export.md)) : pages en Markdown, arbre, images et
  historique. Il se réimporte dans n'importe quel Wiziki.

- **Copie du volume** `wiziki-data`, en entier. Pour une copie cohérente de la base sans arrêter le serveur :

  ```sh
  docker compose exec wiziki wiziki backup /data/sauvegardes/manuelle.db
  ```

## Réglages

Variables d'environnement, à ajouter dans `docker-compose.yml` :

| Variable | Rôle | Défaut |
|---|---|---|
| `ADMIN_PASSWORD` | Premier démarrage seulement : crée le compte propriétaire `admin` | — |
| `TRUST_PROXY` | `1` derrière un reverse proxy | — |
| `WIZIKI_QUOTA_MO` | Espace maximal des images, en Mo | illimité |
| `WIZIKI_LOG_LEVEL` | `info`, `warn`, `error`, `silent` | `info` |
| `WIZIKI_AUTH` | `kratos` pour confier la connexion à Ory Kratos ([docs/kratos.md](kratos.md)) | `local` |

La langue de l'interface (français ou anglais) suit celle du navigateur. Le propriétaire peut l'imposer dans ⚙️ Paramètres.

## Commandes

Dans le conteneur, la commande `wiziki` gère les comptes et les données :

```sh
docker compose exec wiziki wiziki --help
docker compose exec wiziki wiziki utilisateurs
docker compose exec wiziki wiziki utilisateur-ajouter marie --role editor --email marie@example.org
```

## Construire l'image soi-même

```sh
git clone https://github.com/wiziki-org/wiziki.git && cd wiziki
docker build -f docker/standalone/Dockerfile -t wiziki .
```
