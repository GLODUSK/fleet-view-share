// Fleet View: the files nobody is shown, one list for every route that hands a file to a page or a device.
//   files.js    GET /file and GET /folders, for every caller (this PC's page, an approved browser on another device,
//               the phone through the relay): nothing with a secret's name anywhere in its path, nothing in a keys
//               folder, no text that holds a key (and Fleet View's own data folder, which files.js fences itself)
//   relay.js    the phone's own fence (docs/phone.md "What the phone may read"), which also keeps out every dot-named
//               step below a workspace and the app data folders; sync-carry.js takes secretName through it for the
//               untracked files it never packs
//
//   secretName(n)    one step of a path (a file's or a folder's name; case ignored) names a secret: .env* (but
//                    .env.example), keys and certificates (*.pem, *.key, *.p8, *.p12, *.pfx, *.ppk, *.jks, *.keystore,
//                    *.kdbx, *.tfstate, *.tfstate.backup, *.tfvars, *.gpg, *.asc, *.age, *.keychain-db), SSH keys
//                    (id_rsa*, id_dsa*, id_ecdsa*, id_ed25519*), anything with "credential" in it, a service account's
//                    or a Firebase admin key (*service-account*.json, *adminsdk*.json), google-services.json,
//                    GoogleService-Info.plist, .npmrc, .netrc, _netrc, .git-credentials, .pypirc, hosts.yml (gh's
//                    sign-in), secrets.json/.yml/.yaml, kubeconfig, and a Claude account's .claude.json (its login, its
//                    MCP servers' keys) with its copies (.claude.json.backup, .claude.json.tmp.*, home.claude.json)
//   keyDir(n)        one step is a folder of keys and sign-ins: .ssh, .gnupg, .aws, .azure, .kube, .docker, Keychains,
//                    and the CLIs' own folders that keep a sign-in under a plain name: .expo (state.json: the Expo/EAS
//                    session, which can publish an app update), com.vercel.cli (auth.json: Vercel's token), configstore
//                    (firebase-tools.json and other npm CLIs' tokens)
//   secretStep(n)    either of those
//   secretText(s)    a file's text holds a key whatever its name: a PEM private key (or PGP's PRIVATE KEY BLOCK), a
//                    "private_key" field, a service account's JSON (its "type" is "service_account"; spaces around the
//                    colon allowed). This header and docs/phone.md describe them without matching them, so both open.
//   SECRET_TEXT_RES  the patterns secretText looks for
'use strict';

const SECRET_RES = [/^\.env(?!\.example$)/i, /\.(?:pem|key|p8|p12|pfx|ppk|jks|keystore|kdbx|tfstate|tfstate\.backup|tfvars|gpg|asc|age|keychain-db)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i, /credential/i, /(?:service[-_]?account|adminsdk).*\.json$/i, /(?:^|[.-])claude\.json(?:\.|$)/i];
const SECRET_NAMES = new Set(['google-services.json', 'googleservice-info.plist', '.npmrc', '.netrc', '_netrc', '.git-credentials', '.pypirc', 'hosts.yml',
  'secrets.json', 'secrets.yml', 'secrets.yaml', 'kubeconfig']);
const KEY_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', 'keychains', '.expo', 'com.vercel.cli', 'configstore']);
const SECRET_TEXT_RES = [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/, /"private_key"\s*:/, /"type"\s*:\s*"service_account"/];

const secretName = (n) => SECRET_NAMES.has(String(n).toLowerCase()) || SECRET_RES.some((re) => re.test(String(n)));
const keyDir = (n) => KEY_DIRS.has(String(n).toLowerCase());
const secretStep = (n) => secretName(n) || keyDir(n);
const secretText = (s) => typeof s === 'string' && SECRET_TEXT_RES.some((re) => re.test(s));

module.exports = { secretName, keyDir, secretStep, secretText, SECRET_TEXT_RES };
