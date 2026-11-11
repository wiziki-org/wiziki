# Format d'export Wiziki (version 1)

Un export Wiziki est une archive ZIP ordinaire, nommée par convention `<wiki>-<date>.wiziki.zip`.
Elle sert de sauvegarde et permet de déplacer un wiki d'une installation à une autre, y compris entre la
plateforme hébergée et une installation personnelle. Tout y est lisible sans Wiziki : du JSON, du Markdown et des images.

```
wiki.json                     manifeste (voir ci-dessous)
pages/<slug>.md               contenu actuel de chaque page, en Markdown, tel qu'il a été écrit
revisions/<slug>/0001.md      historique (facultatif) : une version par fichier, de la plus ancienne à la plus récente
uploads/…  media/…            images, au même chemin que leur adresse dans le wiki (/uploads/…, /media/…)
```

Les comptes, mots de passe, sessions et membres ne sont **jamais** exportés.

## wiki.json

```json
{
  "format": "wiziki-export",
  "version": 1,
  "exporte_le": "2026-11-11T20:31:00.000Z",
  "logiciel": { "nom": "wiziki", "version": "0.2.0" },
  "wiki": { "nom": "Mon Wiki", "parametres": { "nom": "Mon Wiki", "pageAccueil": "start", "couleurLiens": "#4f46e5" } },
  "arbre": [
    { "id": "start", "titre": "Accueil", "enfants": [ { "id": "sous_page", "titre": "Sous-page", "enfants": [] } ] }
  ],
  "pages": [
    {
      "slug": "start", "titre": "Accueil", "fichier": "pages/start.md",
      "cree_le": "2026-06-01T10:00:00.000Z", "modifie_le": "2026-11-11T18:00:00.000Z",
      "revisions": [
        { "fichier": "revisions/start/0001.md", "titre": "Accueil", "date": "2026-06-01T10:00:00.000Z", "auteur": "Administrateur" }
      ]
    }
  ],
  "redirections": { "ancien_nom": "sous_page" },
  "fichiers": [ { "chemin": "uploads/img_1.png", "type": "image/png" } ]
}
```

- **`arbre`** : le sommaire. `id` est le slug d'une page. Une page absente de l'arbre est « non classée ».
- **`pages`** : toutes les pages (hors corbeille). Le slug ne contient que `A-Z a-z 0-9 _ . -`.
- **`redirections`** : anciens noms de pages renommées → nom actuel.
- **`fichiers`** : informatif ; à l'import, tout fichier `uploads/…` ou `media/…` de l'archive est pris en compte.

## Règles d'import

- L'import **remplace** tout le contenu du wiki de destination (pages, arbre, images, historique, corbeille).
  Le wiki garde ses membres et sa visibilité : importer ne rend jamais public un wiki privé.
- L'archive est entièrement vérifiée avant toute modification ; une archive invalide ne change rien.
- Les éléments invalides sont ignorés avec un avertissement : nom de page non autorisé, chemin sortant de l'archive,
  fichier qui n'est pas une image (PNG, JPEG, GIF, WebP, SVG, ICO), image de plus de 10 Mo, page de plus de 2 Mo.
- Un fichier `pages/<slug>.md` absent de `wiki.json` est importé comme page non classée :
  on peut donc préparer une archive à la main avec seulement `wiki.json` (`format` et `version`) et des pages.
- Sans historique, chaque page reçoit une seule version, datée de `modifie_le`.
- Une archive d'une version de format plus récente que celle du logiciel est refusée.

## Exporter et importer

- Interface : **💾 Export / import** (propriétaires du wiki).
- Ligne de commande : `wiziki export <fichier.zip> [--sans-historique]`, `wiziki import <fichier.zip> [--force]`.
- API : `GET /api/export[?historique=0]`, `POST /api/import?remplacer=1` (corps : le ZIP, `Content-Type: application/zip`).
