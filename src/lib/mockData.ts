// Общие типы для представления звонка и менеджера в разделах «ОКК» / «AI Ролевки»
// (импортируются в src/app/page.tsx). Демо-заглушки удалены — данные приходят из API.

export interface ManagerCall {
    id: string;
    name: string;
    avatarUrl: string;
    callDuration: string;
    callNumber?: string;
    score: number;
    /** Raw max score from evaluationJson.total_max_score (e.g. 33), used to display "8/33 (24%)" */
    totalMaxScore?: number;
    audioUrl: string;
    kommoUrl: string;
    date: string;
    /** Raw ISO timestamp for reliable client-side date filtering (present
     *  on API-sourced calls; mock data may omit it). */
    startedAtIso?: string | null;
    transcript: string;
    aiFeedback: string;
    /** Mistakes text from the evaluations.mistakes column */
    summary: string;
    /** Narrative summary from evaluationJson.summary (the AI overall conclusion) */
    evalSummary?: string;
    hasRecording: boolean;
    blocks: {
        id: string;
        name: string;
        score: number;
        maxScore: number;
        feedback: string;
        criteria: { id: number; name: string; score: number; maxScore: number; feedback: string; quote: string }[];
    }[];
    clientScoring?: { urgency: number; solvency?: number; need: number; total: number };
}

export interface ManagerStat {
    id: string;
    name: string;
    avatarUrl: string;
    totalCalls: number;
    avgScore: number;
    avgDuration: string;
    conversionRate: string;
    role?: string;
    line?: string | null; // '1' (квалификатор) | '2' (бератер)
}
