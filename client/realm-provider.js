// RisuAI Realm Plus, the provider: a card is its charx download, staged by the server half; the listing adds
// tags and the name. The card gains only the translated regex_scripts; the Risu module itself stays on the
// server, bound to the character once the import commits.
import { ProviderBase } from '/modules/providers/provider-interface.js';
import { importFromStage, parseProviderUrl } from '/modules/providers/provider-utils.js';
import { realmCharacterUrl, realmPictureUrl, fetchRealmInfo } from './realm-api.js';
import { realmIdOf, EXT_ID } from './realm-id.js';
import realmBrowseView, { openRealmPreview } from './realm-browse.js';

let api = null;

// the translated scripts join the card's regex_scripts: its own entries stay, a repeated id is kept once
function mergeRegexScripts(card, incoming) {
    if (!Array.isArray(incoming) || !incoming.length) return;
    card.data.extensions = card.data.extensions || {};
    const existing = Array.isArray(card.data.extensions.regex_scripts) ? card.data.extensions.regex_scripts : [];
    const seen = new Set(existing.map(s => s?.id));
    const added = [];
    for (const script of incoming) {
        if (seen.has(script?.id)) continue;
        seen.add(script?.id);
        added.push(script);
    }
    card.data.extensions.regex_scripts = [...existing, ...added];
}

// one brief toast; the detail goes to the console
function reportImport(staged, name) {
    const parts = [];
    const skipped = staged.regexReport?.skipped || [];
    const lossy = staged.regexReport?.lossy || [];
    if (skipped.length) {
        parts.push(`${skipped.length} Risu regex script${skipped.length === 1 ? ' was' : 's were'} skipped`);
        console.info(`[RealmProvider] ${name}: skipped regex scripts:`, skipped);
    }
    if (staged.regexReport?.tooLarge) {
        parts.push('its regex was too large for the card');
        console.warn(`[RealmProvider] ${name}: translated regex over the card budget, none written:`, staged.regexReport.tooLarge);
    }
    if (lossy.length) console.info(`[RealmProvider] ${name}: regex scripts translated with losses:`, lossy);
    if (staged.moduleError) {
        parts.push('its Risu module was not kept');
        console.warn(`[RealmProvider] ${name}: ${staged.moduleError}`);
    }
    if (parts.length) api.showToast?.(`${name}: ${parts.join('; ')}`, 'warning');
}

class RealmProvider extends ProviderBase {
    get id() { return 'risu-realm-plus'; }
    get browseView() { return realmBrowseView; }

    // the listing counts downloads alone
    get linkStatFields() {
        return { stat1: { icon: 'fa-solid fa-download', label: 'Downloads' }, stat2: null, stat3: null };
    }

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
    }

    // ── Link Stats ───────────────────────────────────────────

    async fetchLinkStats(linkInfo) {
        const row = await this.fetchMetadata(linkInfo?.id);
        return row ? { stat1: row.downloads, stat2: null, stat3: null } : null;
    }

    // ── Character URL / Link UI ─────────────────────────────

    getCharacterUrl(linkInfo) {
        const id = realmIdOf(linkInfo?.id);
        return id ? realmCharacterUrl(id) : null;
    }

    // ── In-App Preview ───────────────────────────────────────

    // a linked character's listing, as its preview reads it
    async buildPreviewObject(char, linkInfo) {
        return this.fetchMetadata(linkInfo?.id);
    }

    openPreview(previewChar) {
        openRealmPreview(previewChar);
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(fullPath, opts = {}) {
        const id = realmIdOf(fullPath);
        if (!id) return null;
        try {
            return await fetchRealmInfo(id, opts);
        } catch (e) {
            if (e?.name !== 'AbortError') console.warn('[RealmProvider] fetchMetadata failed:', fullPath, e.message);
            return null;
        }
    }

    // ── URL Handling ────────────────────────────────────────

    parseUrl(url) {
        const match = parseProviderUrl(url)?.pathname.match(/^\/character\/([^/]+)\/?$/);
        return match ? realmIdOf(match[1]) : null;
    }

    // ── Import Pipeline ─────────────────────────────────────

    /**
     * Bind the module the server holds for a stage to the character the import made (or, for a Replace, wrote onto).
     * A failed link is a warning: the import stands, only the module is missing.
     */
    async linkModule(staged, charId, { ifMissing = false } = {}) {
        if (!staged.module || !charId) return;
        try {
            const resp = await api.apiRequest(`/ext/${EXT_ID}/link`, 'POST', { stageId: staged.stageId, charId, ifMissing });
            if (!resp.ok) throw new Error(`the server answered ${resp.status}`);
        } catch (e) {
            console.warn('[RealmProvider] the Risu module could not be bound to the character:', e.message);
        }
    }

    /**
     * Import a character: the server half stages its file while the listing is read, then the card gains tags and the link.
     * @param {string} identifier - the character's id
     * @param {Object} [hitData] - its listing row, when the caller already read it
     */
    async importCharacter(identifier, hitData, options = {}) {
        try {
            const id = realmIdOf(identifier);
            if (!id) throw new Error(`"${identifier}" is not a RisuAI Realm character id`);
            options.onProgress?.('downloading the card on the server');
            const listing = hitData?.id === id ? hitData : fetchRealmInfo(id).catch((e) => {
                console.warn('[RealmProvider] the listing could not be read; importing without its tags:', e.message);
                return null;
            });
            const [staging, info] = await Promise.all([
                api.apiRequest(`/ext/${EXT_ID}/stage`, 'POST', { id }),
                listing,
            ]);
            const staged = await staging.json().catch(() => ({}));
            if (!staging.ok) throw new Error(staged.error || `the server could not download the card (${staging.status})`);

            const characterCard = staged.card;
            const characterName = characterCard.data.name || info?.name || 'Unnamed';
            // the card's own tags lead; a site tag it already has (in any case) the server links once
            characterCard.data.tags = [...(characterCard.data.tags || []), ...(info?.tags || [])];
            this.setLinkInfo(characterCard, { id, pageName: this.getListingName(info) });
            // the module's regex, translated by the server, joins the card's own; nothing else of the module does
            mergeRegexScripts(characterCard, staged.regexScripts);

            const result = await importFromStage({
                stageId: staged.stageId,
                source: this.id,
                onExisting: options.onExisting,
                characterCard,
                characterName,
                hasGallery: false,
                providerCharId: id,
                fullPath: id,
                avatarUrl: realmPictureUrl(info?.img),
                api,
            });
            // a skipped import wrote nothing, so there is nothing to report. An identical card is still this
            // card, so a character imported without its module gains it (a card with no regex always lands here)
            if (result?.success && !result.alreadyPresent) {
                reportImport(staged, characterName);
                await this.linkModule(staged, result.id);
            } else if (result?.success && result.skippedReason === 'identical') {
                await this.linkModule(staged, result.id, { ifMissing: true });
            }
            return result;
        } catch (error) {
            console.error(`[RealmProvider] importCharacter failed for ${identifier}:`, error);
            return { success: false, error: error.message };
        }
    }
}

const realmProvider = new RealmProvider();
export default realmProvider;
