# Facturation CRMA

Application de gestion de factures d'assurance pour LAITERIE FROMAGERIE LFB.

Desktop : application Electron (Windows, macOS, Linux). Web : front-end React/Vite servi par un serveur Express avec base de données SQLite.

## Fonctionnalités

- **Unités de production** : gestion des unités (nom, adresse, archivage)
- **Clients** : sociétés ou particuliers (NIF, N° ART, téléphone, e-mail, archivage)
- **Factures** : lignes d'assurance (police, échéance, nette, FGA, timbre, observations), TVA configurable, numérotation automatique par année (`counters`)
- **Export** : impression / PDF de la facture (orientation portrait ou paysage)
- **Paramètres** : société (coordonnées, agrément, NIF, ART, BNA, CCP), taux TVA, timbre par défaut, observation par défaut, logo, langue
- **Sauvegarde & restauration** : export et import de la base, avec sauvegarde de sécurité automatique avant restauration (`data/backups/`)

## Stack

- [Electron](https://www.electronjs.org/) + [electron-builder](https://www.electron.build/)
- [Vite](https://vitejs.dev/) + [React](https://react.dev/) + [Tailwind CSS](https://tailwindcss.com/)
- [Express](https://expressjs.com/) pour l'API REST
- [SQLite](https://www.sqlite.org/) via `node-sqlite3-wasm` (aucun outil C++ requis)

## Structure

```
electron/           Processus principal Electron (fenêtre, menu, serveur intégré)
server/             API Express + base de données (db.js, repo.js, api.js)
  default.db        Base SQLite par défaut (données initiales de l'application)
shared/             Logique partagée front/back (calculs monétaires)
src/                Application React (pages, composants, styles)
data/               Base de développement (data/lfb.db) + backups automatiques
logo.png            Icône de l'application
```

## Base de données

- **Développement** : `data/lfb.db` (dans le dépôt)
- **Application installée** : `%APPDATA%/Facturation CRMA/data/lfb.db` (chemin utilisateur standard, défini via `LFB_DATA_DIR`)
- **Premier lancement** : si aucune base n'existe, l'application copie `server/default.db` (les données actuelles du développement) puis applique le schéma et les migrations.

Schéma : `units`, `clients`, `invoices`, `invoice_lines`, `counters`, `settings`.

## Démarrage en développement

Prérequis : Node.js 22+

```bash
npm install
npm run dev
```

Ouvre l'application web sur http://localhost:3000 (le plugin Vite monte l'API SQLite directement dans le serveur de développement).

## Application Electron

```bash
npm run electron:dev     # Vite + Electron (hot reload)
npm run electron:start   # Lance Electron avec le build existant
npm run electron:build   # Compile le web puis construit les installateurs
```

Les installateurs sont générés dans `release/` :

| Plateforme | Cible |
|-----------|-------|
| Windows   | NSIS (`.exe`) |
| macOS     | DMG |
| Linux     | AppImage |

## Serveur de production (sans Electron)

```bash
npm run build
npm start
```

Sert l'UI compilée (`dist/`) et l'API sur le même port (par défaut `3000`).

## Configuration

| Variable | Rôle | Défaut |
|----------|------|--------|
| `LFB_DATA_DIR` | Répertoire des données | `data/` (racine du projet) |
| `LFB_DB_FILE`  | Chemin exact de la base | `<LFB_DATA_DIR>/lfb.db` |
| `PORT` | Port du serveur web | `3000` |
| `HOST` | Hôte du serveur web | `0.0.0.0` |
| `DISABLE_HMR` | Désactive le HMR de Vite | off |
