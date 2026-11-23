# RisuAI Realm Plus

RisuAI's character hub (realm.risuai.net) as a Project Σ source, a fork of the bundled `risu-realm` that keeps what a plain charx import drops.

## What it does

- Browse, preview and import Realm characters, like the bundled provider. The charx downloads on the server (streamed to a temporary file that is always deleted), so the picture and the assets never pass through the device; the assets join the character's gallery.
- Reads the card's Risu module (`module.risum`: regex, triggers, lorebook) and keeps it in this extension's own table, one row per character and per account. Raw module data is never written onto the card.
- Translates the module's regex into SillyTavern `regex_scripts` and adds them to the card (`data.extensions.regex_scripts`), keeping any the card already has. For a PNG card the scripts come from the card's own `risuai.customScripts`, which stay where they are. A toast says how many scripts could not be translated; the detail is in the console.
- A module that cannot be read does not fail the import; the character comes in without it.
- `risuai-realm-plus.get-module` (`{ charId }`) answers a character's stored module, or null, for an extension that runs it.

Server routes (under `/api/ext/risuai-realm-plus/`): `POST /stage`, `POST /link`, `GET /module/:charId`. Deleting a character removes its module row (the table's `char_id` cascades). An unlinked module (an import that never committed) is dropped after the stage's hour.

On a duplicate import the module follows the card: a skipped import binds nothing, a copy binds to the new character, a Replace binds to the replaced one (replacing its earlier module).

The Lua and trigger scripts are stored, not run; that is for a separate extension.

## What it reads, writes and sends

**Sends, and where:**
- Browse, search and preview: your search text, sort, page and NSFW choice go to RisuAI's hub, `https://sv.risuai.xyz` (`/realm/...` listings, `/hub/info/<id>` details, `/resource/<hash>` images). The page asks directly and falls back to Project Σ's own proxy when the browser blocks it.
- Import: your Σ server downloads the card from `https://realm.risuai.net/api/v1/download/dynamic/<id>`. Only the card's Realm id is sent.
- Nothing else leaves your machine: no accounts, keys, chats or analytics, and nothing goes to the extension's author.

**Writes:**
- The imported character, its gallery assets and the translated regex scripts (`data.extensions.regex_scripts` on the card), through Σ's normal import.
- Its own table, `x_risuai_realm_plus_modules`: the card's Risu module, one row per character. Deleting the character deletes the row.
- A temporary download file under the extension's data folder (`tmp/`), deleted as soon as the import is staged, and cleared on every start.

**Reads:**
- Its own setting (`nsfw`, off by default), your library (to tell whether a card is already in it), and the downloaded charx.
- It never allows the translated regex scripts for you: that stays Σ's per-character choice in the chat's Regex window.

## Id

The id is `risuai-realm-plus`, not `risu-realm-plus`: Σ refuses an id whose table prefix nests under another's, and `x_risu_realm_plus_` nests under the bundled `risu-realm`'s `x_risu_realm_`. The provider's namespace stays `risu-realm-plus`.

## Notes

Switch off the bundled RisuAI Realm while using this: both claim `realm.risuai.net`.

## Licence

GPL-3.0, see [LICENSE](LICENSE). The forked bundled-extension code keeps its MIT notice and `server/rpack-map.bin` is used under AGPL-3.0: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSES/AGPL-3.0.txt](LICENSES/AGPL-3.0.txt).
