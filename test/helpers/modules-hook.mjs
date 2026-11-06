// A module-resolution hook for the integration test: the page's absolute /modules/... imports (which only
// exist in a browser) answer with stand-ins, so the real client/realm-provider.js runs in node.
const STUBS = new URL('./stubs/', import.meta.url);

export async function resolve(specifier, context, next) {
    if (specifier === '/modules/providers/provider-interface.js') {
        return { url: new URL('provider-interface.mjs', STUBS).href, shortCircuit: true };
    }
    if (specifier === '/modules/providers/provider-utils.js') return { url: new URL('provider-utils.mjs', STUBS).href, shortCircuit: true };
    if (specifier === '/modules/providers/browse-view.js' || specifier === '/modules/core-api.js') return { url: new URL('browse.mjs', STUBS).href, shortCircuit: true };
    if (specifier === './realm-browse.js' && context.parentURL?.endsWith('/client/realm-provider.js')) return { url: new URL('browse.mjs', STUBS).href, shortCircuit: true };
    return next(specifier, context);
}
