# Architecture

## 1. Request pipeline

Every request walks the same ten stages. `POST /personalize` runs all of them;
`POST /debug/personalization` runs stages 1–7 and returns the plan instead of
generating, which is why the debug view can never drift from real behaviour.

```mermaid
flowchart TD
    A["POST /personalize<br/>{ userId, question }"] --> B

    B{"1. Safety screen<br/><i>deterministic, pre-fetch</i>"}
    B -->|blocked| BX["Reviewed refusal + helplines<br/>no fetch, no LLM call, no spend"]
    B -->|allowed| C

    C["2. Concurrent fan-out<br/><i>timeout · retry · circuit breaker · TTL cache</i>"]
    C --> C1[User Service]
    C --> C2[Kundli Service]
    C --> C3[Horoscope Service]
    C --> C4[Panchang Service]
    C --> C5[Transit Service]
    C1 & C2 & C3 & C4 & C5 --> D

    D["ContextBundle<br/><i>per-source outcome: ok · cached · stale · failed</i>"]

    D --> E["3. Intent + time horizon + focus<br/><i>lexicon, sub-ms, multilingual</i>"]
    E --> F["4. Astrological inference<br/><i>dasha position · house lords · dignity · gochar · chart validation</i>"]
    F --> G["5. Response style<br/><i>language · tone · length · jargon</i>"]
    G --> H["6. Context selection<br/><i>rules → score → relevance floor → token budget</i>"]
    H --> I["PersonalizationPlan<br/><i>the complete decision record</i>"]

    I --> J["7. Prompt assembly<br/><i>cacheable static prefix + selected context only</i>"]
    J --> K["8. LLM provider<br/><i>anthropic · openai · mock</i>"]
    K -->|provider down| K2["Offline fallback<br/><i>degraded flag set</i>"]
    K & K2 --> L["9. Groundedness + output safety<br/><i>verify citations · catch invented entities · de-fatalise</i>"]
    L --> M["10. Confidence<br/><i>computed from measurable factors, never asked of the LLM</i>"]
    M --> N["{ answer, confidence, sourcesUsed }"]

    I -.->|debug endpoint returns here| DBG["POST /debug/personalization<br/><i>same code path, no generation</i>"]

    style B fill:#4a2020,stroke:#c05050,color:#fff
    style BX fill:#4a2020,stroke:#c05050,color:#fff
    style F fill:#1f3a4a,stroke:#4a90b8,color:#fff
    style H fill:#1f3a4a,stroke:#4a90b8,color:#fff
    style I fill:#2a2a4a,stroke:#7070c0,color:#fff
    style M fill:#1f3a4a,stroke:#4a90b8,color:#fff
    style DBG fill:#2a2a4a,stroke:#7070c0,color:#fff
```

## 2. Layers

Dependencies point downward only. The domain layer has no framework imports and
no I/O, so every astrological rule is testable as a pure function.

```mermaid
flowchart TD
    subgraph API["api/ — HTTP boundary"]
        A1[PersonalizeController]
        A2[DebugController]
        A3[HealthController]
        A4[PersonalizeService<br/><i>orchestration only</i>]
    end

    subgraph ENGINE["personalization/ — the engine"]
        E1[IntentClassifier]
        E2[HorizonExtractor]
        E3[ContextItemBuilder]
        E4[ContextSelector]
        E5[StyleResolver]
        E6["config/<br/><i>intent rules · style rules</i>"]
    end

    subgraph SAFETY["safety/"]
        S1[GuardrailsService]
        S2["policies.config<br/><i>risk policy table</i>"]
    end

    subgraph ANSWER["answer/"]
        N1[GroundednessService]
        N2[ConfidenceService]
    end

    subgraph LLM["llm/ — swappable"]
        L1[PromptBuilder]
        L2["LlmProvider<br/><i>interface</i>"]
        L3[Anthropic]
        L4[OpenAI]
        L5[Mock]
    end

    subgraph DOMAIN["astrology/ — pure domain, zero I/O"]
        D1["vimshottari<br/><i>dasha arithmetic</i>"]
        D2["zodiac<br/><i>signs · lords · dignity · bhavas</i>"]
        D3[AstrologyInferenceEngine]
        D4[chart-validation]
    end

    subgraph UPSTREAM["upstream/ — external services"]
        U1[ContextAggregator]
        U2["UpstreamClient<br/><i>retry · timeout · breaker · cache</i>"]
        U3["mock/<br/><i>stand-in services over real HTTP</i>"]
    end

    subgraph COMMON["common/"]
        C1[config]
        C2["logging<br/><i>structured · RequestTrace</i>"]
        C3[cache]
        C4[resilience]
    end

    API --> ENGINE
    API --> SAFETY
    API --> ANSWER
    API --> LLM
    API --> UPSTREAM
    ENGINE --> DOMAIN
    ENGINE --> UPSTREAM
    ANSWER --> DOMAIN
    LLM --> ENGINE
    UPSTREAM --> COMMON
    ENGINE --> COMMON

    L2 -.-> L3
    L2 -.-> L4
    L2 -.-> L5
    E4 --> E6
    S1 --> S2

    style DOMAIN fill:#1f3a4a,stroke:#4a90b8,color:#fff
    style ENGINE fill:#2a2a4a,stroke:#7070c0,color:#fff
    style SAFETY fill:#4a2020,stroke:#c05050,color:#fff
```

## 3. How one context item is decided

Filters that remove items for *correctness* run before scoring, so the token
budget is only ever spent on candidates that are actually admissible. Budget
decides how much of the relevant set fits — never what counts as relevant.

```mermaid
flowchart TD
    I["ContextItem<br/><i>e.g. kundli.house.7</i>"] --> R

    R{"Birth time supports<br/>house division?"}
    R -->|no, and it is a house item| X1["EXCLUDED<br/>reason: reliability"]
    R -->|yes| S

    S{"Superseded by a<br/>derived fact?"}
    S -->|yes| X2["EXCLUDED<br/>reason: redundant"]
    S -->|no| E

    E{"On the intent's<br/>exclude list?"}
    E -->|yes| X3["EXCLUDED<br/>reason: rule:excluded"]
    E -->|no| H

    H{"Dropped by the<br/>time horizon?"}
    H -->|yes| X4["EXCLUDED<br/>reason: rule:horizon-drop"]
    H -->|no| SC

    SC["SCORE<br/>tier weight (primary 100 / secondary 55 / neutral 15)<br/>± horizon promote/demote<br/>× data confidence<br/>× staleness penalty"]

    SC --> T{"Score ≥ relevance<br/>floor (30)?"}
    T -->|no| X5["EXCLUDED<br/>reason: below-threshold"]
    T -->|yes| B

    B{"Fits the remaining<br/>token budget?"}
    B -->|no| X6["EXCLUDED<br/>reason: budget"]
    B -->|yes| SEL["SELECTED<br/><i>rendered into the prompt</i>"]

    style SEL fill:#1f4a2a,stroke:#4ab870,color:#fff
    style SC fill:#1f3a4a,stroke:#4a90b8,color:#fff
    style X1 fill:#4a2020,stroke:#c05050,color:#fff
    style X2 fill:#3a3020,stroke:#b89050,color:#fff
    style X3 fill:#3a3020,stroke:#b89050,color:#fff
    style X4 fill:#3a3020,stroke:#b89050,color:#fff
    style X5 fill:#3a3020,stroke:#b89050,color:#fff
    style X6 fill:#3a3020,stroke:#b89050,color:#fff
```

## 4. Where the two axes come from

The brief's example table keys context selection on **intent** alone. Its own
sample questions, however, span four different time frames — "today", "this
week", "this month", "the next few months" — and the right context differs
sharply between them.

|                       | `today`                  | `quarter`                       |
| --------------------- | ------------------------ | ------------------------------- |
| Panchang              | **primary** — it *is* the answer | dropped — describes one day |
| Daily horoscope       | primary                  | secondary                       |
| Current dasha         | secondary                | **primary** — multi-month arc   |
| Dasha transition      | demoted                  | **primary** — chapter boundary  |
| Saturn / Jupiter transit | demoted — years cannot resolve to a day | **promoted** — the multi-month signal |

So selection keys on `(intent × horizon)`, and both live in
`src/personalization/config/intent-rules.config.ts` as data.
