/** Facts supplied by the record owner. Missing confirmation and observation stay unknown. */
export type SearchEvidence = {
    state?: "confirmed" | "candidate" | "inferred" | "unknown" | "unavailable";
    confidence?: number | null;
    userConfirmed?: boolean;
    observedAt?: string | null;
    expiresAt?: string | null;
    evidenceRefs?: string[];
    sourceKinds?: string[];
    conflicts?: SearchConflict[];
};
export type SearchConflict = {
    subjectRef: string;
    field: string;
    timeRange: {
        from: string | null;
        to: string | null;
    };
    candidates: {
        itemRef: {
            source: string;
            origin: Record<string, unknown>;
        };
        value: unknown;
        evidenceRefs: string[];
    }[];
    reportedBy: string;
};
export function normalizeSearchEvidence(value: unknown): SearchEvidence | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const raw = value as SearchEvidence;
    const references = Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs.filter(ref => typeof ref === 'string' && Boolean(ref)) : [];
    const date = (time: unknown) => typeof time === 'string' && Number.isFinite(Date.parse(time)) ? time : null;
    const states = ['confirmed', 'candidate', 'inferred', 'unknown', 'unavailable'];
    return {
        state: states.includes(raw.state ?? '') ? raw.state : 'unknown',
        confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : null,
        userConfirmed: raw.userConfirmed === true && references.length > 0,
        observedAt: date(raw.observedAt), expiresAt: date(raw.expiresAt), evidenceRefs: references,
        sourceKinds: Array.isArray(raw.sourceKinds) ? raw.sourceKinds.filter(kind => typeof kind === 'string') : [],
        ...(Array.isArray(raw.conflicts) ? { conflicts: raw.conflicts.filter(conflict => conflict && typeof conflict.subjectRef === 'string'
                && typeof conflict.field === 'string' && conflict.timeRange && typeof conflict.reportedBy === 'string'
                && Array.isArray(conflict.candidates) && conflict.candidates.length >= 2
                && conflict.candidates.every(candidate => candidate?.itemRef?.source && candidate.itemRef.origin && candidate.evidenceRefs?.length)) } : {})
    };
}
