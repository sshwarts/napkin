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
export interface Session {
    sessionId: string;
    webhookUrl?: string;
    debounceMs?: number;
    compactTriggers?: boolean;
    createdAt: number;
    lastActivity: number;
}
export declare class SessionManager {
    private m_sessions;
    private m_ttlMs;
    private m_persistPath;
    private m_cleanupTimer;
    constructor();
    /**
     * Start or update a session.
     */
    startSession(sessionId: string, webhookUrl?: string, debounceMs?: number, compactTriggers?: boolean): void;
    /**
     * End a session explicitly.
     */
    endSession(sessionId: string): boolean;
    /**
     * Get the active session, if any. Returns the most recently active session.
     * Touch its lastActivity timestamp.
     */
    getActiveSession(): Session | null;
    /**
     * Get a specific session by ID. Touch its lastActivity.
     */
    getSession(sessionId: string): Session | null;
    /**
     * List all active sessions.
     */
    listSessions(): Session[];
    /**
     * Stop the cleanup timer.
     */
    stop(): void;
    private expireStale;
    private saveToDisk;
    private loadFromDisk;
}
//# sourceMappingURL=session.d.ts.map