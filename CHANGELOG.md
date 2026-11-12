# Journal des versions

Les numéros suivent le [versionnage sémantique](https://semver.org/lang/fr/) : une version 1.x reste compatible avec les données
et la configuration de toute autre version 1.x.

## [1.0.0] - 2026-11-12

Première version stable.

### Lire et écrire
- Pages en Markdown, avec un éditeur visuel qui ne modifie que les passages retouchés. Tableaux, images, liens entre pages.
- Arbre des pages réorganisable par glisser-déposer. Chaque page a sa propre adresse, et une page renommée reste joignable par son ancien nom.
- Historique de chaque page : différences, aperçu, restauration. Corbeille pour les pages supprimées.
- Interface en français et en anglais : langue du navigateur, ou langue imposée par le propriétaire.

### Comptes
- Rôles propriétaire, éditeur et lecteur ; wiki public ou privé.
- Écran d'installation protégé par un jeton (ou `ADMIN_PASSWORD`).
- Connexion facultative par [Ory Kratos](docs/kratos.md) : inscription, mot de passe oublié, double authentification.

### Données
- Une seule base SQLite et un dossier d'images, dans `/data`.
- Export et import au [format ouvert](docs/format-export.md) (.zip) : pages, arbre, images, historique.
- Copie automatique de la base avant chaque mise à jour du schéma (5 dernières copies).
- Limite d'espace des images facultative (`WIZIKI_QUOTA_MO`).
- Import d'un wiki de l'ancienne version (`wiziki import-legacy`).

### Installation
- Image Docker `ghcr.io/wiziki-org/wiziki` (amd64 et arm64) ; [guide d'installation](docs/installation.md).
- Commande `wiziki` : comptes, export, import, sauvegarde.

### Sécurité
- Politique de sécurité du contenu stricte, Markdown nettoyé, contrôle d'origine des requêtes, limitation des essais de connexion.
- Conteneur sans droits d'administrateur.
