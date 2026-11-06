// the part of ProviderBase the provider reads (the shipped class is in the app, which needs a browser)
export class ProviderBase {
    init(coreAPI) { this._coreAPI = coreAPI; }
    get extNamespace() { return this.id; }
    getListingName(hit) { return hit?.name || null; }
    setLinkInfo(char, linkInfo) {
        char.data.extensions = char.data.extensions || {};
        char.data.extensions[this.extNamespace] = linkInfo;
    }
}
