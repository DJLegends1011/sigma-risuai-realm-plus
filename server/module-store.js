// Where a card's Risu module lives: this extension's own table, one row a character, so nothing of it
// rides on the card (the card keeps only the translated regex_scripts). A row starts pending, keyed by
// the stage it came from, and is bound to its character once the import commits.
//
// char_id references characters ON DELETE CASCADE: deleting a character takes its row with it, with no
// listener and no write from a read-only context.

export const T_MODULES = 'x_risuai_realm_plus_modules';

/** How long a stage lives; a pending row older than this can never be linked. */
export const STAGE_LIFETIME_MS = 60 * 60 * 1000;

export const migrations = [
    `CREATE TABLE IF NOT EXISTS ${T_MODULES} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        realm_id TEXT NOT NULL,
        char_id TEXT UNIQUE REFERENCES characters(id) ON DELETE CASCADE,
        stage_id TEXT UNIQUE,
        module TEXT NOT NULL,
        report TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )`,
];

/** Drop pending rows whose stage has expired. Answers how many went. */
export function sweepPending(db, now = Date.now()) {
    return db.prepare(`DELETE FROM ${T_MODULES} WHERE char_id IS NULL AND created_at < ?`)
        .run(now - STAGE_LIFETIME_MS).changes;
}

/** Keep a module pending under its stage id. */
export function savePending(db, { stageId, realmId, module, report }, now = Date.now()) {
    sweepPending(db, now);
    db.transaction(() => {
        db.prepare(`DELETE FROM ${T_MODULES} WHERE stage_id = ?`).run(stageId);
        db.prepare(`INSERT INTO ${T_MODULES} (realm_id, stage_id, module, report, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(realmId, stageId, JSON.stringify(module), JSON.stringify(report || {}), now, now);
    })();
}

/**
 * Bind a pending row to its character, replacing any row that character had.
 * @returns {boolean} false when no pending row holds that stage
 */
export function bindPending(db, stageId, charId, now = Date.now()) {
    sweepPending(db, now);
    return db.transaction(() => {
        const row = db.prepare(`SELECT id FROM ${T_MODULES} WHERE stage_id = ? AND char_id IS NULL`).get(stageId);
        if (!row) return false;
        db.prepare(`DELETE FROM ${T_MODULES} WHERE char_id = ?`).run(charId);
        db.prepare(`UPDATE ${T_MODULES} SET char_id = ?, stage_id = NULL, updated_at = ? WHERE id = ?`).run(charId, now, row.id);
        return true;
    })();
}

/** Drop a pending row that will never be bound. */
export function dropPending(db, stageId) {
    db.prepare(`DELETE FROM ${T_MODULES} WHERE stage_id = ? AND char_id IS NULL`).run(stageId);
}

/** Whether a character already has a module bound. */
export function hasModule(db, charId) {
    return !!db.prepare(`SELECT 1 FROM ${T_MODULES} WHERE char_id = ?`).get(charId);
}

/** A character's stored module, or null. */
export function readModule(db, charId) {
    const row = db.prepare(`SELECT realm_id, module, report, created_at, updated_at FROM ${T_MODULES} WHERE char_id = ?`).get(charId);
    if (!row) return null;
    return {
        charId,
        realmId: row.realm_id,
        module: JSON.parse(row.module),
        report: JSON.parse(row.report),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
