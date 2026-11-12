# Connexion avec Ory Kratos (facultatif)

Par défaut, Wiziki gère lui-même ses comptes (`WIZIKI_AUTH=local`) : rien d'autre à installer.

Si vous avez déjà un serveur [Ory Kratos](https://www.ory.sh/kratos/), ou si vous voulez des fonctions qu'il apporte, Wiziki peut lui confier la connexion :
inscription libre, mot de passe oublié par email, vérification des adresses, double authentification.

Le partage des rôles est le suivant :
- **Kratos dit qui est la personne.**
- **Wiziki dit ce qu'elle peut faire** : propriétaire, éditeur ou lecteur.

Les droits se gèrent comme d'habitude dans **👥 Membres**.

## Activer

| Variable | Rôle | Défaut |
|---|---|---|
| `WIZIKI_AUTH` | `local` ou `kratos` | `local` |
| `WIZIKI_KRATOS_URL` | API publique de Kratos, vue depuis le serveur du wiki (ex. `http://kratos:4433`) | — |
| `WIZIKI_KRATOS_COOKIE` | Nom du cookie de session de Kratos | `ory_kratos_session` |
| `WIZIKI_KRATOS_INSCRIPTION` | `1` pour proposer « Créer un compte » dans la fenêtre de connexion du wiki. **Fermé par défaut** : les comptes se créent sur le site qui gère Kratos | — |
| `WIZIKI_KRATOS_ADRESSES_NON_VERIFIEES` | `1` pour reconnaître les adresses email que Kratos n'a pas vérifiées. **Déconseillé**, voir plus bas | — |

L'exemple complet [docker/kratos/](../docker/kratos/) (wiki + Kratos + base SQLite) démarre en quelques commandes :

```sh
cd docker/kratos
cp .env.example .env        # secrets de Kratos et serveur d'envoi d'emails
sed -i 's#https://wiki.exemple.org#https://mon-wiki.exemple.org#g' kratos/kratos.yml
docker compose up -d
docker compose logs wiziki  # jeton d'installation
```

Le wiki doit être servi en **HTTPS** (Caddy, Nginx…). Kratos pose des cookies sécurisés, que les navigateurs refusent en HTTP,
sauf sur `localhost`.

## Fonctionnement

- **Le navigateur ne parle jamais directement à Kratos.**
  - Le wiki relaie les parcours de connexion sous `/kratos/` : connexion, inscription, mot de passe oublié, vérification et réglages.
  - Seuls les chemins `/self-service/…` passent. L'API d'administration et les autres routes ne sont pas joignables.
  - Le cookie de session de Kratos est ainsi posé sur le domaine du wiki, sans rien changer à la configuration de Kratos.
  - Kratos ne reçoit que ses propres cookies, jamais la session du wiki.
- **Toutes les fenêtres sont affichées par le wiki, en français.**
  - Il s'agit de la connexion, de l'inscription (seulement avec `WIZIKI_KRATOS_INSCRIPTION=1`), du mot de passe oublié, de la vérification de l'adresse et de « Mon compte » (email, mot de passe, double authentification).
  - Les adresses `ui_url` de Kratos ne servent qu'en repli. Elles peuvent toutes pointer vers la racine du wiki.
- **Chaque requête est vérifiée auprès de Kratos** par `/sessions/whoami`.
  - Une réponse positive est gardée 30 secondes.
  - Une session fermée ailleurs reste donc acceptée au plus ce temps. Une déconnexion depuis le wiki, elle, est immédiate.
- **À la première connexion, un compte Wiziki est créé et relié à l'identité Kratos.**
  - C'est lui qui porte les rôles et qui signe l'historique des pages.
  - **Il n'a aucun droit** tant que le propriétaire ne l'a pas invité. Avoir un compte Kratos ne donne jamais accès à un wiki.
- **Si Kratos est en panne**, les pages publiques restent lisibles. Les modifications sont refusées avec un message clair.

## Premier propriétaire

Au premier démarrage, sans `ADMIN_PASSWORD`, un **jeton d'installation** s'affiche dans les journaux du serveur.

1. Ouvrez le wiki.
2. Connectez-vous avec votre compte Kratos, ou créez-le.
3. Saisissez ce jeton : vous devenez propriétaire.

Avec `ADMIN_PASSWORD`, un compte local `admin` est créé comme avant. Il sert de compte de secours (voir plus bas).

## Inviter des membres

Dans **👥 Membres**, indiquez l'**adresse email** de la personne et son rôle. Elle se connecte ensuite avec un compte Kratos
qui porte cette adresse (créé sur le site qui gère Kratos, ou sur le wiki si `WIZIKI_KRATOS_INSCRIPTION=1`).

**Elle reçoit ses droits une fois son adresse vérifiée.** Cela arrive :
- par un code envoyé par email juste après l'inscription ;
- ou plus tard, quand le wiki lui propose de vérifier son adresse.

Pourquoi attendre la vérification ? Sans elle, n'importe qui pourrait s'inscrire avec l'adresse d'un membre et obtenir ses droits.

**Côté Kratos, il faut donc :**
- activer la vérification des adresses (`selfservice.flows.verification.enabled: true`) ;
- configurer l'envoi d'emails (`courier.smtp`).

`WIZIKI_AUTH=kratos` fonctionne sans vérification, mais les invitations ne sont alors jamais reliées. On peut ajouter un membre par l'identifiant
de son compte Wiziki, visible dans la liste des membres après sa première connexion. On peut aussi accepter les adresses non vérifiées avec
`WIZIKI_KRATOS_ADRESSES_NON_VERIFIEES=1`, mais seulement si l'inscription sur ce Kratos est fermée ou contrôlée.

## Compte local de secours

Les comptes locaux restent utilisables en mode Kratos, avec le lien **« Compte local (secours) »** de la fenêtre de connexion.
Ils permettent d'intervenir si Kratos est indisponible. On en crée un de trois façons :
- `ADMIN_PASSWORD` au premier démarrage ;
- dans **👥 Membres**, en donnant un mot de passe ;
- en ligne de commande, sur le serveur : `wiziki utilisateur-ajouter secours --role owner` (le mot de passe est demandé).

`wiziki mot-de-passe <identifiant>` redéfinit le mot de passe d'un compte local.

## Passer une installation existante en mode Kratos

Les comptes existants sont conservés et restent utilisables en secours.

**Un compte qui a un mot de passe (par exemple `admin`) n'est jamais relié automatiquement**, même si une identité Kratos
porte la même adresse email vérifiée : sinon, quiconque obtiendrait cette adresse prendrait la place du propriétaire.
On le relie sur le serveur, avec l'identifiant de l'identité Kratos (un UUID, visible dans l'API d'administration de Kratos) :

```sh
wiziki relier-kratos admin 0b7c2a9e-4f1d-4c3b-9a8e-123456789abc
```

La personne garde alors ses rôles et son nom dans l'historique. Seules les **invitations** faites par email dans 👥 Membres
sont reprises automatiquement, à la première connexion avec l'adresse vérifiée.

## Version testée

Ory Kratos **v1.3.0**. Tests automatiques : `packages/server/test/kratos.test.js`.
