// importFromStage as core ships it (app/modules/providers/provider-utils.js): the same three doors and the same result
// fields, the commit going through the api handed in. A mirror, so the provider's own code runs against the real server.
export const parseProviderUrl = (u) => { try { return new URL(u); } catch { return null; } };
export const fetchWithProxy = async () => { throw new Error('not used'); };
export const readJsonClassified = async () => { throw new Error('not used'); };

const replaceTargetOf = (o) => (o && typeof o === 'object' && o.replace ? String(o.replace) : null);

export async function importFromStage({ stageId, characterCard, characterName, hasGallery = false, providerCharId = null, fullPath = null,
    avatarUrl = null, onExisting = null, source = null, api }) {
    const target = replaceTargetOf(onExisting);
    const resp = target
        ? await api.apiRequest(`/characters/${encodeURIComponent(target)}/replace`, 'POST', { stage: stageId, card: characterCard, source: source || undefined })
        : await api.apiRequest(`/characters/import/stage/${encodeURIComponent(stageId)}`, 'POST', { card: characterCard, source: source || undefined, onExisting: onExisting === 'copy' ? 'copy' : undefined });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        api.apiRequest(`/characters/import/stage/${encodeURIComponent(stageId)}`, 'DELETE').catch(() => {});
        throw new Error(result.error || `import answered ${resp.status}`);
    }
    if (!result?.id) throw new Error('Import failed: server returned no character id');
    return {
        success: true, id: result.id, alreadyPresent: !!result.skipped, replaced: !!result.replaced,
        skippedReason: result.skipped ? result.reason : null,
        characterName: (!result.skipped && result.name) || characterCard.data?.name || characterName,
        hasGallery, providerCharId, fullPath, avatarUrl, cardData: characterCard.data, mediaCount: result.media || 0,
        row: result.skipped ? null : (result.row || null), missing: [],
    };
}
