// RisuAI Realm Plus: RisuAI's character hub as a provider under its own id, so it declares its own row.
import realmProvider from './realm-provider.js';
import { EXT_ID } from './realm-id.js';
import { setRealmSettings, closePreviewModal, isPreviewOpen } from './realm-browse.js';

export default {
    async init(ctx) {
        setRealmSettings(ctx.settings);
        await ctx.providers.register(realmProvider, {
            name: 'RisuAI Realm Plus',
            extNamespace: 'risu-realm-plus',
            searchPrefixes: ['risuplus'],
            excludeTagKey: 'risu-realm-plus',
            excludeInputPrefix: 'risu-realm-plus',
            hosts: ['realm.risuai.net'],
            icon: 'fa-solid fa-chess-rook',
            iconUrl: 'https://realm.risuai.net/favicon.png',
            avatarTap: { imgId: 'realmCharAvatar' },
        });
        // a character's stored Risu module, for an extension that runs it: published as <id>.get-module
        // (a command name is lowercase words joined by dashes). The host removes it when this is switched off.
        ctx.commands.register('get-module', async ({ charId } = {}) => {
            if (!charId) return null;
            const resp = await ctx.CoreAPI.apiRequest(`/ext/${EXT_ID}/module/${encodeURIComponent(String(charId))}`);
            if (resp.status === 404) return null;
            return ctx.CoreAPI.readAnswer(resp);
        }, { title: 'RisuAI Realm Plus: a character\'s Risu module' });
        // the preview closes like the app's own dialogs and leaves with the extension, through the ledger
        ctx.ui.addOverlay({ id: 'preview', close: closePreviewModal, visible: isPreviewOpen });
        // the host adds the exclude-tags group under this body
        ctx.ui.addProviderSettingsSection('risu-realm-plus', (el) => {
            el.innerHTML = `
                <div class="settings-group">
                    <div class="settings-group-title"><i class="fa-solid fa-cloud-arrow-down"></i> Downloads</div>
                    <div class="settings-row">
                        <span class="settings-hint">Browse, preview and import from realm.risuai.net. A character downloads on the server, so its picture and its assets (some cards carry hundreds) never pass through this device, and they join its gallery. A card's Risu module is read on the server and kept beside the character, not inside its card; its regex scripts are translated into the character's Regex scripts, and a toast says how many could not be. Switch off the bundled RisuAI Realm while this is on.</span>
                    </div>
                </div>`;
        }, { excludeTagsHint: 'Tags entered here are always left out of RisuAI Realm Plus results.' });
    },
};
