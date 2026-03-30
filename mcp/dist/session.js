/**
 * @file Session management for Napkin.
 *
 * Tracks active whiteboard sessions. Each session has a session_id
 * (typically the agent's chat JID) and an optional per-session webhook
 * URL override. Sessions auto-expire after a configurable TTL of
 * inactivity.
 *
 * Sessions persist to disk so they survive server restarts.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_PERSIST_PATH = join(process.env.HOME ?? "/tmp", ".napkin", "sessions.json");
export class SessionManager {
    m_sessions = new Map();
    m_ttlMs;
    m_persistPath;
    m_cleanupTimer = null;
    constructor() {
        this.m_ttlMs = parseInt(process.env.NAPKIN_SESSION_TTL_MS ?? String(DEFAULT_TTL_MS), 10);
        this.m_persistPath = process.env.NAPKIN_SESSION_PATH ?? DEFAULT_PERSIST_PATH;
        this.loadFromDisk();
        // Run cleanup every 5 minutes.
        this.m_cleanupTimer = setInterval(() => this.expireStale(), 5 * 60 * 1000);
    }
    /**
     * Start or update a session.
     */
    startSession(sessionId, webhookUrl, debounceMs, compactTriggers) {
        const now = Date.now();
        this.m_sessions.set(sessionId, {
            sessionId,
            webhookUrl,
            debounceMs,
            compactTriggers,
            createdAt: now,
            lastActivity: now,
        });
        this.saveToDisk();
    }
    /**
     * End a session explicitly.
     */
    endSession(sessionId) {
        const result = this.m_sessions.delete(sessionId);
        if (result)
            this.saveToDisk();
        return result;
    }
    /**
     * Get the active session, if any. Returns the most recently active session.
     * Touch its lastActivity timestamp.
     */
    getActiveSession() {
        let latest = null;
        for (const session of this.m_sessions.values()) {
            if (!latest || session.lastActivity > latest.lastActivity) {
                latest = session;
            }
        }
        if (latest) {
            latest.lastActivity = Date.now();
        }
        return latest;
    }
    /**
     * Get a specific session by ID. Touch its lastActivity.
     */
    getSession(sessionId) {
        const session = this.m_sessions.get(sessionId);
        if (session) {
            session.lastActivity = Date.now();
        }
        return session ?? null;
    }
    /**
     * List all active sessions.
     */
    listSessions() {
        return Array.from(this.m_sessions.values());
    }
    /**
     * Stop the cleanup timer.
     */
    stop() {
        if (this.m_cleanupTimer) {
            clearInterval(this.m_cleanupTimer);
            this.m_cleanupTimer = null;
        }
    }
    // --- private ---
    expireStale() {
        const now = Date.now();
        let changed = false;
        for (const [id, session] of this.m_sessions) {
            if (now - session.lastActivity > this.m_ttlMs) {
                this.m_sessions.delete(id);
                console.error(`[napkin] Session expired: ${id}`);
                changed = true;
            }
        }
        if (changed)
            this.saveToDisk();
    }
    saveToDisk() {
        try {
            mkdirSync(dirname(this.m_persistPath), { recursive: true });
            const data = Array.from(this.m_sessions.values());
            writeFileSync(this.m_persistPath, JSON.stringify(data, null, 2), "utf-8");
        }
        catch (err) {
            console.error(`[napkin] Failed to persist sessions: ${err}`);
        }
    }
    loadFromDisk() {
        try {
            const raw = readFileSync(this.m_persistPath, "utf-8");
            const data = JSON.parse(raw);
            const now = Date.now();
            for (const session of data) {
                // Only restore sessions that haven't expired.
                if (now - session.lastActivity < this.m_ttlMs) {
                    this.m_sessions.set(session.sessionId, session);
                }
            }
            if (this.m_sessions.size > 0) {
                console.error(`[napkin] Restored ${this.m_sessions.size} session(s) from disk`);
            }
        }
        catch {
            // No file or invalid — start fresh.
        }
    }
}
//# sourceMappingURL=session.js.map