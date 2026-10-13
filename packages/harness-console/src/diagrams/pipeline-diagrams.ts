/** Mermaid từ document/harness/02.harness-eso (01 taxonomy · 19 §V1–V3). */

export type DiagramId = 'v1-coordinates' | 'v2-abcd' | 'v3-layers' | 'taxonomy-bridge';

export type PipelineDiagram = {
    id: DiagramId;
    title: string;
    source: string;
    mermaid: string;
};

export const PIPELINE_DIAGRAMS: Record<DiagramId, PipelineDiagram> = {
    'v2-abcd': {
        id: 'v2-abcd',
        title: 'Phase A → B → C → D (một turn)',
        source: '19.diagrams-mermaid.md §V2',
        mermaid: `flowchart TB
    classDef free fill:#11111b,stroke:#a6e3a1,stroke-width:2px,color:#cdd6f4
    classDef paid fill:#0f766e,stroke:#14b8a6,stroke-width:2px,color:#cdd6f4
    classDef brain fill:#1e1e2e,stroke:#cba6f7,stroke-width:2px,color:#cdd6f4
    classDef human fill:#313244,stroke:#f9e2af,stroke-width:2px,color:#cdd6f4
    T[Turn boundary prompt submit]:::free
    T --> A[Phase A Surface bucket SkillPack]:::free
    A --> B[Phase B Collect adapters]:::free
    B --> C[Phase C Measure T_low T_high]:::free
    C -->|sufficient| G[Stitch EvidenceBundle TurnVerdict]:::free
    C -->|partial| B2[Expand rounds deterministic]:::free
    B2 --> C
    C -->|still partial| D[Phase D Jev or L3 per boundary]:::paid
    D --> B
    C -->|insufficient| H[Consent gate or HIL]:::human
    H --> B
    G --> S2[System 2 L4 Brain pipeline]:::brain`,
    },
    'v1-coordinates': {
        id: 'v1-coordinates',
        title: 'Phase A–D và L0–L4 trên một turn',
        source: '19.diagrams-mermaid.md §V1',
        mermaid: `flowchart TB
    classDef phase fill:#11111b,stroke:#a6e3a1,stroke-width:2px,color:#cdd6f4
    classDef layer fill:#1e1e2e,stroke:#cba6f7,stroke-width:2px,color:#cdd6f4
    classDef s2 fill:#313244,stroke:#f9e2af,stroke-width:2px,color:#cdd6f4
    subgraph phaseA [Phase A Surface WHERE]
        A[decide turn_start]:::phase
        L0[L0 route graph]:::layer
        L1[L1 heuristic tie]:::layer
        L2r[L2 Jev route optional]:::layer
        A --> L0 --> L1 --> L2r
    end
    subgraph phaseBCD [Phases B C D System 1 ESO]
        B[Phase B Collect]:::phase
        C[Phase C Measure]:::phase
        D[Phase D Escalate]:::phase
        B --> C --> D
    end
    subgraph act [ACT System 2 L4]
        L4[Brain plus executor verify]:::s2
    end
    phaseA --> phaseBCD
    phaseBCD -->|gate open| act
    phaseBCD -->|insufficient consent| HIL[Human stop or continue]:::s2`,
    },
    'v3-layers': {
        id: 'v3-layers',
        title: 'Thang L0 → L4 (Facade vs Brain)',
        source: '19.diagrams-mermaid.md §V3',
        mermaid: `flowchart LR
    classDef l0 fill:#11111b,stroke:#a6e3a1,stroke-width:2px,color:#cdd6f4
    classDef l1 fill:#11111b,stroke:#89b4fa,stroke-width:2px,color:#cdd6f4
    classDef paid fill:#0f766e,stroke:#14b8a6,stroke-width:2px,color:#cdd6f4
    classDef s2 fill:#1e1e2e,stroke:#cba6f7,stroke-width:2px,color:#cdd6f4
    L0[L0 tools route graph]:::l0
    L1[L1 heuristic guard]:::l1
    L2[L2 Jev System1]:::paid
    L3[L3 Flash JSON route]:::paid
    L4[L4 Brain System2]:::s2
    L0 --> L1 --> L2 --> L3
    L3 -.->|after GATE| L4
    L2 -.->|evidence Phase D| L0`,
    },
    'taxonomy-bridge': {
        id: 'taxonomy-bridge',
        title: 'Phase A → B C D → ACT',
        source: '01.taxonomy-phases-and-layers.md',
        mermaid: `flowchart LR
    subgraph phaseA [Phase A Surface]
        L0[L0]
        L1[L1]
        L2r[L2 route Jev]
        L0 --> L1 --> L2r
    end
    subgraph phasesBCD [Phase B C D]
        B[B Collect]
        C[C Measure]
        D[D Escalate]
        B --> C --> D
    end
    subgraph act [ACT System 2]
        L4[L4 Brain]
    end
    phaseA --> phasesBCD
    phasesBCD -->|gate open| act`,
    },
};

export function getDiagram(id: string | undefined): PipelineDiagram | null {
    if (!id) return null;
    return PIPELINE_DIAGRAMS[id as DiagramId] ?? null;
}
