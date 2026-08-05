# Projektmanagement-System – Ergebnisdokument für MCP und Datenbank

**Stand:** 05.08.2026
**Zweck:** Dieses Dokument fasst die fachlichen und konzeptionellen Entscheidungen für den Aufbau von zpecs, dem remote erreichbaren MCP-Server und der PostgreSQL-Datenbank zusammen. Es dient als Kontext für einen Implementierungsagenten, insbesondere für Claude Opus 5.

---

## 1. Ziel des Systems

zpecs ist ein cloudbasiertes Projektmanagement-System. Nutzer verwenden beispielsweise Claude Code auf ihrem lokalen Rechner. Claude Code verbindet sich über MCP mit dem remote gehosteten MCP-Server von zpecs.

Der Nutzer soll natürliche Sprache verwenden können, zum Beispiel:

- „Wir wollen, dass Nutzer sich mit Google und E-Mail anmelden können.“
- „Der Warenkorb funktioniert auf mobilen Geräten nicht.“
- „Prüfe, ob wir KI-basierte Produktempfehlungen verwenden können.“
- „Arbeite weiter am Epic Shopping Cart.“
- „Implementiere Task TASK-123.“

Der Agent liest den vorhandenen Projektkontext, ordnet die Eingabe fachlich ein, erstellt oder aktualisiert strukturierte Daten und leitet bei ausreichender Klarheit technische Tasks ab.

Das System soll:

- natürliche Sprache als Eingang akzeptieren;
- fachliche Inhalte klar von technischer Umsetzung trennen;
- Informationen bis ins Detail strukturiert und wiederverwendbar speichern;
- neue, unklare und explorative Projekte ebenso wie Legacy-, Bugfix- und Refactoring-Arbeiten unterstützen;
- mehrere lokale Agenten und Nutzer gleichzeitig unterstützen;
- Änderungen nachvollziehbar versionieren;
- durch serverseitige Regeln konsistente Daten erzwingen;
- für den Nutzer einfach bleiben.

---

## 2. Grundarchitektur

```text
Lokaler Nutzer
└── Claude Code oder anderer MCP-kompatibler Agent
    └── MCP Client
        └── HTTPS / Streamable HTTP
            └── Remote MCP Server in zpecs
                └── Domain Services und Validierung
                    └── PostgreSQL
```

Es ist kein separater Gateway als zusätzliches Produktkonzept erforderlich. Der remote MCP-Server ist Bestandteil von zpecs. Intern darf die Anwendung beliebige technische Schichten verwenden, aber aus Sicht des Nutzers gibt es nur:

```text
Claude Code → zpecs über MCP → PostgreSQL
```

Die Datenbank wird niemals direkt vom lokalen Agenten angesprochen. Alle
Agent-Operationen und alle Schreibvorgänge an den versionierten Fachobjekten
Epic, Stream und Task laufen durch den MCP-Server, das atomare Change-Set und
die Geschäftslogik von zpecs. Die Web-Anwendung besitzt daneben eine
session-geschützte REST-Lesefläche und genau eine bewusst enge
Container-Schreiboperation: Sie darf ein noch leeres, unversioniertes Project
im Workspace der aktiven Clerk-Organisation anlegen. Diese Ausnahme öffnet
keinen zweiten Schreibpfad für Epics, Streams oder Tasks.

---

## 3. Kernhierarchie

```text
Workspace
└── Project
    └── Epic
        └── Stream
            └── Task
```

`Workspace` und `Project` sind organisatorische beziehungsweise technische
Kontexte für Zugriff, Datenisolation und Gruppierung. Ein Project ist ein
unversionierter Container ohne Fachdokument, Revision oder Status. Die
fachliche Projektmanagement-Struktur besteht aus drei Kernobjekten:

```text
Epic → Stream → Task
```

### 3.1 Epic

Ein Epic ist ein stabiler, fachlicher Themenbereich oder eine Business Capability. Ein Epic ist kein Sprint, kein Cycle und kein zeitlich begrenzter Release.

Beispiele:

- Shopping Cart
- User Authentication
- Payment Processing
- Reporting
- Menu Coverage

Ein Epic beschreibt auf hoher Ebene:

- den fachlichen Zweck;
- das Business-Problem;
- den langfristigen Scope;
- gewünschte Outcomes;
- fachliche Erfolgsmetriken;
- übergreifende Business Rules.

Epics dürfen über längere Zeit aktiv bleiben und später neue Streams aufnehmen. Ein abgeschlossenes Teilziel wird nicht dadurch aus dem Epic entfernt. Für später entstehende Bugs, Erweiterungen oder Untersuchungen wird in der Regel ein neuer Stream unter demselben Epic angelegt.

Empfohlene Epic-Statuswerte:

```text
active
paused
archived
```

Ein Epic muss nicht auf `done` gesetzt werden, nur weil einzelne Streams abgeschlossen sind.

### 3.2 Stream

Ein Stream ist eine abgegrenzte fachliche Veränderung, Problemstellung oder Untersuchung innerhalb eines Epics. Der Stream ist die zentrale Planungseinheit für das fachliche „Was“.

Ein Stream beantwortet:

- Was soll erreicht werden?
- Warum ist es wichtig?
- Was ist enthalten?
- Was ist ausdrücklich nicht enthalten?
- Welche fachlichen Abläufe gibt es?
- Welche Regeln und Sonderfälle gelten?
- Woran erkennen wir den Erfolg?

Ein Stream enthält grundsätzlich keine konkrete technische Implementierung. Frameworks, Dateien, Endpunkte, Datenbanktabellen und konkrete technische Lösungswege gehören in Tasks oder in separate technische Entscheidungsdokumente.

Ein Stream darf als früher Draft unvollständig sein. Bei einem Experiment oder einer Untersuchung können Anforderungen noch nicht vollständig bekannt sein.

Mögliche Stream-Typen:

```text
feature
bug
change
experiment
investigation
refactor
maintenance
```

Bedeutung der Typen:

| Typ             | Zweck                                                  | Typischer Kontext                                           |
| --------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| `feature`       | Neue fachliche Fähigkeit                               | Nutzerbedarf, funktionale Anforderungen, Akzeptanzkriterien |
| `bug`           | Fehlverhalten beheben                                  | Ist-Verhalten, Soll-Verhalten, Reproduktionsschritte        |
| `change`        | Bestehendes Verhalten verändern                        | Auslöser, aktueller Zustand, gewünschte Änderung            |
| `experiment`    | Hypothese überprüfen                                   | Hypothese, Forschungsfragen, Success Criteria               |
| `investigation` | Unbekannte Sachlage untersuchen                        | Fragen, Untersuchungsumfang, erwartete Entscheidung         |
| `refactor`      | Bestehendes System fachlich oder qualitativ verbessern | Current State, Target State, zu bewahrende Eigenschaften    |
| `maintenance`   | Wartung und technische Pflege                          | Wartungsziel, Risiko, betroffene fachliche Bereiche         |

### 3.3 Task

Ein Task ist eine konkrete technische Arbeitseinheit zur Umsetzung, Untersuchung oder Verifikation eines Streams.

Ein Task beschreibt:

- das technische Ziel;
- die betroffenen Komponenten und Schnittstellen;
- die technische Vorgehensweise;
- technische Entscheidungen und Alternativen;
- Abhängigkeiten;
- Tests und Verifikation;
- erwartete Artefakte;
- Ausführungsinformationen für einen Menschen oder Agenten.

Ein Task referenziert immer die fachlichen Anforderungen oder Akzeptanzkriterien, zu denen er beiträgt. Dadurch bleiben „Was“ und „Wie“ getrennt, aber nachvollziehbar verbunden.

Tasks dürfen unterschiedliche Task-Typen haben, zum Beispiel:

```text
implementation
investigation
migration
testing
review
decision
```

Es gibt keine harte globale Zeitgrenze, die jeden Task auf wenige Stunden beschränkt. Tasks sollen klein genug sein, um von einem Agenten oder einer Person eigenständig bearbeitet werden zu können. Längere Untersuchungen, Migrationen oder Trainingsläufe können über Checkpoints und erwartete Artefakte strukturiert werden.

---

## 4. Fachliche und technische Trennung

Die zentrale Regel lautet:

```text
Epic und Stream = Was, Warum, Ziel und fachliche Bedingungen
Task = Wie die Umsetzung technisch erfolgt
```

### Gehört in Epic oder Stream

- Purpose
- Business Problem
- Scope und Exclusions
- Outcomes
- funktionale Anforderungen
- nichtfunktionale Anforderungen und messbare Qualitätsziele
- Workflows
- Business Rules
- Edge Cases
- fachliche Abhängigkeiten
- Acceptance Criteria beziehungsweise Success Criteria
- offene Fragen und Annahmen

### Gehört in Tasks

- Frameworks und Bibliotheken
- konkrete Dateien und Module
- API-Endpunkte
- Datenbanktabellen und Migrationen
- technische Architektur
- technische Implementierungsentscheidungen
- Testdateien und Teststrategien
- Deployment-Schritte
- konkrete Branches und Umgebungen

Nichtfunktionale Anforderungen sind keine Implementierungsdetails. Beispiele:

```text
Stream:
  Die Suche muss bei 100.000 Produkten innerhalb von 500 ms antworten.

Task:
  Erzeuge einen Suchindex und implementiere den Query-Endpunkt mit Cursor-Pagination.
```

```text
Stream:
  Die manuelle Freigabe muss fachlich denselben Veröffentlichungsweg verwenden wie die automatische Freigabe.

Task:
  Verwende die bestehende Promotion-Funktion und ergänze einen autorisierten Aufruf für den Review-Prozess.
```

Eine konkrete Technologie darf als fachliche Constraint vorkommen, wenn sie verbindlich vorgegeben ist. Sie muss dann als Constraint mit Begründung dokumentiert werden, nicht als zufälliges Implementierungsdetail.

---

## 5. Gemeinsame JSON-Dokumentstruktur

Jedes Epic, jeder Stream und jeder Task wird als versioniertes, validiertes JSON-Dokument geführt.

```json
{
  "entity": "stream",
  "schema_version": "pm.stream.v1",
  "meta": {},
  "content": {},
  "links": {},
  "provenance": {}
}
```

### 5.1 `entity`

Der Dokumenttyp:

```text
epic
stream
task
```

### 5.2 `schema_version`

Version des gültigen JSON Schemas, zum Beispiel:

```text
pm.epic.v1
pm.stream.v1
pm.task.v1
```

Die Schema-Version wird im Dokument gespeichert. Schemaänderungen dürfen alte Daten nicht unkontrolliert ungültig machen.

### 5.3 `meta`

Gemeinsame Metadaten:

```json
{
  "id": "stream_01JREVIEW",
  "key": "STR-MENU-REVIEW",
  "project_id": "project_01",
  "title": "Review von Kandidaten mit mittlerer Konfidenz",
  "status": "planned",
  "priority": "high",
  "revision": 1,
  "created_at": "2026-08-04T10:00:00Z",
  "updated_at": "2026-08-04T10:00:00Z",
  "created_by": {
    "type": "planner_agent",
    "id": "agent_01"
  }
}
```

Interne IDs sollten stabile UUIDs oder vergleichbare IDs sein. Menschlich lesbare Keys können zusätzlich verwendet werden.

### 5.4 `content`

Der fachliche beziehungsweise technische Inhalt. Die genaue Struktur hängt vom Dokumenttyp ab:

- Epic: Purpose, Business Problem, Scope, Outcomes, Success Metrics, Business Rules
- Stream: Purpose, Scope, Requirements, Workflows, Edge Cases, Business Rules, Acceptance Criteria
- Task: Objective, Technical Scope, Implementation, Technical Decisions, Verification, Artifacts, Execution Context

### 5.5 `links`

Beziehungen werden strukturiert über IDs gepflegt, nicht nur als freie Textbeschreibung.

Beispiele:

```json
{
  "parent_epic_id": "epic_01",
  "parent_stream_id": "stream_01",
  "depends_on": [
    {
      "target_type": "task",
      "target_id": "task_02",
      "relationship": "blocked_by",
      "reason": "Das Datenmodell muss zuerst verfügbar sein."
    }
  ],
  "related_to": [],
  "supersedes": [],
  "extends": []
}
```

### 5.6 `provenance`

Herkunft, Ableitung und Unsicherheit werden dokumentiert:

```json
{
  "sources": [
    {
      "type": "user_input",
      "reference": "conversation_123",
      "confidence": "explicit"
    }
  ],
  "inferred_fields": ["content.requirements.non_functional"],
  "open_questions": ["Welche Benutzerrollen dürfen die Funktion nutzen?"],
  "assumptions": []
}
```

Der Agent darf keine Vermutungen als explizite Nutzeranforderungen speichern. Unbekannte Punkte werden in `open_questions` oder `assumptions` abgelegt.

---

## 6. Stream-Inhalt im Detail

Der Stream ist das wichtigste fachliche Dokument. Eine mögliche kanonische Struktur ist:

```json
{
  "entity": "stream",
  "schema_version": "pm.stream.v1",
  "meta": {
    "id": "stream_01JREVIEW",
    "key": "STR-MENU-REVIEW",
    "project_id": "project_01",
    "title": "Review von Kandidaten mit mittlerer Konfidenz",
    "stream_type": "feature",
    "status": "draft",
    "priority": "high",
    "revision": 1
  },
  "content": {
    "purpose": "Ein Reviewer soll unsichere Kandidaten schnell prüfen und entscheiden können.",
    "scope": {
      "included": [
        {
          "id": "SCOPE-001",
          "statement": "Kandidaten nach Konfidenz sortiert anzeigen"
        }
      ],
      "excluded": [
        {
          "id": "SCOPE-EX-001",
          "statement": "Massenfreigabe von Kandidaten"
        }
      ]
    },
    "actor": {
      "primary": "human_reviewer",
      "secondary": []
    },
    "requirements": {
      "functional": [
        {
          "id": "FR-001",
          "statement": "Der Reviewer kann einen Kandidaten öffnen.",
          "priority": "must"
        }
      ],
      "non_functional": [
        {
          "id": "NFR-001",
          "category": "performance",
          "metric": "time_to_open_candidate",
          "operator": "<=",
          "target": 2,
          "unit": "seconds"
        }
      ]
    },
    "workflows": [
      {
        "id": "WF-001",
        "workflow_name": "Review a candidate",
        "actor": "human_reviewer",
        "preconditions": [],
        "steps": [
          {
            "id": "STEP-001",
            "action": "Kandidatenliste öffnen",
            "result": "Kandidaten werden sortiert angezeigt."
          }
        ]
      }
    ],
    "business_rules": [
      {
        "id": "BR-001",
        "rule": "Manuelle Freigaben verwenden fachlich denselben Promotionsweg wie automatische Freigaben.",
        "impact": "Es entstehen keine strukturell unterschiedlichen Veröffentlichungen.",
        "consequence": "Die fachlichen Ergebnisse bleiben reproduzierbar."
      }
    ],
    "edge_cases": [
      {
        "id": "EDGE-001",
        "trigger": "Eine aktuellere Quelle wurde zwischenzeitlich veröffentlicht.",
        "scenario": "Der Kandidat ist veraltet.",
        "expected_behavior": "Die Freigabe wird blockiert und erklärt den Grund.",
        "severity": "high"
      }
    ],
    "acceptance_criteria": [
      {
        "id": "AC-001",
        "type": "functional",
        "given": "Ein gültiger Kandidat ist vorhanden.",
        "when": "Der Reviewer ihn freigibt.",
        "then": "Der Kandidat wird fachlich korrekt veröffentlicht.",
        "verifies": ["FR-001", "BR-001"],
        "verification": "integration_test"
      }
    ],
    "vertical_slice": {
      "delivers_alone": "Ein Reviewer kann einen Kandidaten vollständig prüfen und entscheiden.",
      "needs_no_other_stream": false,
      "prerequisites": ["Kandidaten müssen vorhanden sein."]
    },
    "open_questions": [],
    "assumptions": []
  },
  "links": {
    "parent_epic_id": "epic_01",
    "depends_on": [],
    "related_streams": [],
    "supersedes": [],
    "extends": []
  },
  "provenance": {
    "sources": [],
    "inferred_fields": [],
    "open_questions": []
  }
}
```

Nicht jeder Stream-Typ benötigt exakt dieselben Felder. Die Basisstruktur bleibt gleich, während typabhängige Bereiche ergänzt werden:

- `feature`: functional requirements und acceptance criteria
- `bug`: reproduction steps, actual behavior, expected behavior
- `experiment`: hypothesis, research questions, success criteria, decision rule
- `investigation`: questions, discovery scope, expected decision
- `refactor`: current state, target state, invariants, quality goals

---

## 7. Task-Inhalt im Detail

```json
{
  "entity": "task",
  "schema_version": "pm.task.v1",
  "meta": {
    "id": "task_01JAPI",
    "key": "TASK-REVIEW-API",
    "project_id": "project_01",
    "title": "Review-API für Kandidatenfreigabe implementieren",
    "task_type": "implementation",
    "status": "ready",
    "priority": "high",
    "revision": 1
  },
  "content": {
    "objective": "Die fachlichen Anforderungen FR-001 und FR-002 technisch umsetzen.",
    "implements": {
      "stream_id": "stream_01JREVIEW",
      "requirement_ids": ["FR-001", "FR-002"],
      "acceptance_criteria_ids": ["AC-001"]
    },
    "technical_scope": {
      "repositories": [],
      "services": [],
      "components": [],
      "interfaces": [],
      "data_models": []
    },
    "implementation": {
      "approach": "Die bestehende fachliche Promotionsfunktion wiederverwenden.",
      "steps": [
        "Bestehende Promotionsfunktion lokalisieren.",
        "Autorisierte Freigabeoperation ergänzen.",
        "Fehlerfälle und Statusbedingungen implementieren.",
        "Integrationstests ergänzen."
      ],
      "technical_decisions": [
        {
          "decision": "Bestehende Promotionsfunktion wiederverwenden.",
          "reason": "Verhindert zwei voneinander abweichende Veröffentlichungswege.",
          "alternatives_considered": []
        }
      ]
    },
    "dependencies": [],
    "verification": [
      {
        "id": "VERIFY-001",
        "type": "integration_test",
        "procedure": "Einen gültigen Kandidaten freigeben.",
        "expected": "Das Ergebnis entspricht dem automatischen Promotionsweg."
      }
    ],
    "done_when": [
      "Die verknüpften Tests sind erfolgreich.",
      "Das Verhalten entspricht AC-001.",
      "Code Review ist abgeschlossen."
    ],
    "artifacts": ["Implementierung", "Integrationstests", "Dokumentation"],
    "open_questions": []
  },
  "links": {
    "parent_stream_id": "stream_01JREVIEW",
    "blocks": [],
    "blocked_by": [],
    "related_tasks": []
  },
  "execution": {
    "estimate": {
      "value": 6,
      "unit": "hours",
      "confidence": "medium"
    },
    "assignee": {
      "type": "agent",
      "id": "backend-agent"
    },
    "execution_context": {},
    "long_running": false
  },
  "provenance": {
    "created_from": ["stream_01JREVIEW"],
    "created_by": {
      "type": "planner_agent",
      "id": "planner_01"
    }
  }
}
```

Beim Lesen eines Tasks soll der MCP-Server auf Wunsch den relevanten Stream-Kontext mitliefern, insbesondere:

- Stream-Purpose
- zugehörige Requirements
- verknüpfte Acceptance Criteria
- relevante Business Rules
- relevante Edge Cases
- Task-Abhängigkeiten

Ein ausführender Agent erhält dadurch das technische „Wie“ und das fachliche „Warum“, ohne dass die Daten redundant in jedem Task dupliziert werden müssen.

---

## 8. Progressive Detaillierung

Die Struktur muss neue und unklare Situationen unterstützen. Daher ist ein unvollständiger Draft erlaubt.

Beispiel:

```text
Nutzer:
„Prüfe, ob KI-basierte Produktempfehlungen im Warenkorb sinnvoll sind.“
```

Der Agent erstellt zunächst:

```text
Stream
├── stream_type: investigation
├── purpose
├── questions
├── discovery_scope
├── success_criteria
├── open_questions
└── investigation tasks
```

Nach der Untersuchung kann daraus ein neuer oder weiterführender Feature-Stream entstehen:

```text
Stream
├── stream_type: feature
├── functional requirements
├── non-functional requirements
├── acceptance criteria
└── implementation tasks
```

Unbekannte Informationen dürfen nicht erfunden werden. Sie werden als `open_questions`, `assumptions` oder `inferred_fields` markiert.

Empfohlene Reifegrade beziehungsweise Statuswerte für Streams:

```text
draft
planned
ready
in_progress
blocked
completed
cancelled
```

Für ein abgeschlossenes Stream-Objekt werden keine späteren Änderungen ohne neue Revision vorgenommen. Neue Anforderungen werden normalerweise als neuer Stream angelegt und mit `extends`, `fixes`, `supersedes` oder `related_to` verknüpft.

---

## 9. Datenbankkonzept

Die Daten werden in PostgreSQL gespeichert. Empfohlen ist ein hybrides Modell:

- zentrale relationale Spalten für IDs, Beziehungen, Status, Revision und Abfragen;
- ein validiertes `jsonb`-Dokument für die detaillierte fachliche beziehungsweise technische Struktur;
- eigene Relationstabelle für flexible Beziehungen;
- unveränderliche Revisionen und Audit-Informationen.

Logische Tabellen:

```text
epics
├── id
├── project_id
├── status
├── revision
├── document jsonb
└── timestamps

streams
├── id
├── epic_id
├── stream_type
├── status
├── revision
├── document jsonb
└── timestamps

tasks
├── id
├── stream_id
├── task_type
├── status
├── revision
├── document jsonb
└── timestamps

entity_links
├── source_id
├── target_id
├── relationship_type
└── metadata jsonb

entity_revisions
├── entity_id
├── entity_type
├── revision
├── document jsonb
├── changed_by
├── change_reason
└── created_at

schema_definitions
├── entity_type
├── schema_version
├── json_schema jsonb
└── status
```

Tasks werden nicht als verschachteltes Array im Stream-Dokument gespeichert. Sie sind eigene Datensätze und referenzieren ihren Parent-Stream über `stream_id`.

Abhängigkeiten werden als Graph modelliert. Sie müssen durch den Server auf ungültige Referenzen und Zyklen geprüft werden.

---

## 10. MCP-Konzept

Der MCP-Server stellt die einzige Agent-Schnittstelle für Lesen, Schreiben und Aktualisieren dar. Er liefert die zentralen Tool-Definitionen inklusive Glossar, Nutzungsregeln und JSON-Schemas über die MCP-Schnittstelle.

Es ist kein lokaler projektspezifischer System Prompt erforderlich. Der lokale Nutzer installiert beziehungsweise konfiguriert lediglich die Verbindung zum remote MCP-Server von zpecs.

Beispielhafte Verbindung:

```text
Claude Code
└── MCP-Verbindung zu https://app-xy.example/mcp
```

### 10.1 MCP-Tools

Die konkreten Tool-Namen dürfen angepasst werden. Die fachliche Aufteilung sollte ungefähr so aussehen:

```text
search_context
get_context
validate_change_set
apply_change_set
get_history
create_epic
update_epic
create_stream
update_stream
create_task
update_task
claim_task
report_task_result
get_next_work
```

### 10.2 Lesewerkzeuge

`search_context`:

- sucht Epics, Streams und Tasks;
- unterstützt Volltext- und semantische Suche;
- berücksichtigt Projekt- und Workspace-Kontext;
- liefert zunächst kompakte Treffer statt vollständiger Dokumente.

`get_context`:

- lädt ein einzelnes Epic, einen Stream oder Task;
- kann Parent-, Requirement-, Acceptance-Criteria- und Dependency-Kontext einbeziehen;
- liefert für ausführende Tasks den relevanten fachlichen Kontext.

### 10.3 Planung und Schreiben

Der Agent soll nicht unkontrolliert viele Einzeländerungen durchführen. Für Planung und komplexe Änderungen wird ein Change-Set empfohlen:

```json
{
  "reason": "Neue Save-for-later-Anforderung im Shopping Cart",
  "operations": [
    {
      "operation": "create",
      "entity": "stream",
      "data": {}
    },
    {
      "operation": "create",
      "entity": "task",
      "data": {}
    },
    {
      "operation": "link",
      "source": "stream_new",
      "target": "stream_old",
      "relationship": "extends"
    }
  ]
}
```

Ablauf:

```text
1. Agent liest vorhandenen Kontext.
2. Agent klassifiziert die Eingabe.
3. Agent erstellt einen strukturierten Vorschlag.
4. MCP validiert Schema, Beziehungen und Berechtigungen.
5. Nutzer bestätigt bei relevanten Änderungen.
6. MCP wendet das Change-Set atomar an.
7. MCP liefert IDs, Revisionen und Ergebnis zurück.
```

### 10.4 Task-Ausführung

Bei „Implementiere Task TASK-123“ soll der Agent:

1. den Task laden;
2. den zugehörigen Stream-Kontext laden;
3. Abhängigkeiten und aktuellen Status prüfen;
4. den Task für sich claimen oder eine bestehende Zuweisung beachten;
5. die technische Arbeit ausführen;
6. Ergebnis, Artefakte, Tests und offene Punkte zurückmelden;
7. den Task-Status aktualisieren.

Bei „Arbeite weiter an Stream X“ soll der Agent zunächst offene, blockierte und ausführbare Tasks analysieren. Er soll nicht automatisch redundante Tasks erzeugen.

Bei „Arbeite weiter an Epic X“ soll der Agent:

1. aktive Streams und deren Fortschritt lesen;
2. offene Abhängigkeiten ermitteln;
3. nächste sinnvolle Arbeit vorschlagen;
4. nur bei ausreichender fachlicher Klarheit neue Streams oder Tasks erstellen.

### 10.5 Tool-Beschreibungen

Tool-Beschreibungen enthalten:

- Glossar für Epic, Stream und Task;
- erlaubte Operationen;
- Pflichtfelder;
- Stream-Typen;
- Regeln zur fachlichen und technischen Trennung;
- Beispiele für gültige Eingaben;
- Regeln für unbekannte Informationen;
- Hinweise zu Bestätigung und destruktiven Aktionen.

Die Tool-Beschreibung ist die Anleitung für das Modell. Sie ist aber nicht die alleinige Sicherheits- oder Validierungsschicht.

### 10.6 Gezielte REST-Ausnahme für Project-Container

Mitglieder der aktiven Clerk-Organisation dürfen über die Web-Anwendung alle
Projects dieses Workspace lesen und mit `POST /workspace/projects` einen leeren
Project-Container anlegen. Der Request akzeptiert strikt nur den Body
`{ "name": string }`. Der Name wird getrimmt, muss 1 bis 120 Zeichen lang und
innerhalb eines Workspace ohne Beachtung der Groß-/Kleinschreibung eindeutig
sein. Der Workspace stammt ausschließlich aus der verifizierten Clerk-Session;
eine Workspace-ID im Body ist ungültig und kann niemals den Tenant wählen.
Eine zusätzliche Rollenprüfung findet nicht statt: Jede gültige Membership der
aktiven Organisation darf den Container anlegen.

| Status | Ergebnis                                                 |
| ------ | -------------------------------------------------------- |
| `201`  | `{ "project": { "id": "<uuid>", "name": "<trimmed>" } }` |
| `409`  | `project_name_taken`                                     |
| `422`  | ungültiger Name oder zusätzliche Body-Felder             |
| `401`  | fehlende oder abgelaufene Session                        |
| `403`  | keine aktive Clerk-Organisation                          |

Diese Operation ist absichtlich unversioniert: Sie erzeugt weder Epic, Stream
noch Task und umgeht daher weder Entity-Schema, Revisionen noch Change-Set. Alle
Writes unterhalb des Project-Containers bleiben MCP-only. Der idempotente
Admin-Bootstrap bleibt als Betriebswerkzeug für vorbereitende Provisionierung
und Wiederherstellung erhalten, ist aber keine Voraussetzung mehr für die
normale Projektanlage durch Mitglieder.

---

## 11. Server-seitige Regeln

Die Applikation muss Regeln unabhängig vom Verhalten des LLM erzwingen:

- Ein Stream gehört zu genau einem existierenden Epic.
- Ein Task gehört zu genau einem existierenden Stream.
- Ein Project-Name ist getrimmt, 1 bis 120 Zeichen lang und pro Workspace
  case-insensitiv eindeutig.
- Bei der REST-Projektanlage wird der Workspace ausschließlich aus der
  verifizierten Session abgeleitet; Request-Felder dürfen den Tenant nicht
  bestimmen.
- `project_id` und Workspace-Kontext müssen bei jeder Operation geprüft werden.
- Referenzierte Requirement- und Acceptance-Criteria-IDs müssen existieren.
- Abhängigkeiten dürfen keine Zyklen erzeugen.
- Ein `ready`-Stream braucht ein passendes fachliches Erfolgskriterium.
- Ein `ready`-Task braucht eine technische Definition von „done“.
- Ein Experiment darf Success Criteria statt klassischer Acceptance Criteria verwenden.
- Ein Bug braucht mindestens Ist-Verhalten und Soll-Verhalten, sofern bekannt.
- Unbekannte Angaben müssen als offene Fragen oder Annahmen markiert werden.
- Nutzer dürfen nur Daten ihres Workspace beziehungsweise ihrer Projekte lesen und verändern.
- Jede Änderung wird mit Nutzer-, Agent-, Zeit- und Revisionsinformationen protokolliert.
- Löschungen, Archivierungen und größere Verschiebungen benötigen eine explizite Berechtigung beziehungsweise Bestätigung.

---

## 12. Gleichzeitige Nutzung durch mehrere Agenten

Da mehrere lokale Agenten gleichzeitig auf dieselben Cloud-Daten zugreifen können, benötigt die Anwendung:

- stabile IDs;
- Revisionen pro Datensatz;
- Optimistic Concurrency Control;
- atomare Change Sets;
- Claim- oder Lock-Mechanismus für Tasks;
- Konfliktantworten statt stillem Überschreiben;
- Audit Log;
- vollständige Änderungshistorie.

Beispiel für ein Update:

```text
Agent sendet:
  task_id = TASK-123
  expected_revision = 4
  changes = {...}

Server:
  Wenn aktuelle revision = 4:
      Update auf revision 5
  Sonst:
      Conflict zurückgeben und aktuelle Version liefern
```

---

## 13. Einfache Nutzung aus Sicht des Users

Der Benutzer muss keine JSON-Strukturen manuell schreiben. Er gibt natürliche Sprache ein.

Beispiel:

```text
„Wir wollen, dass Benutzer Artikel im Warenkorb für später speichern können.
Sie sollen die Artikel später wiederfinden und wieder in den Warenkorb legen können.“
```

Der Agent:

1. findet das Epic `Shopping Cart`;
2. erkennt einen neuen Feature-Stream;
3. strukturiert Purpose, Scope, Requirements, Workflows und Acceptance Criteria;
4. markiert fehlende Entscheidungen als offene Fragen;
5. erzeugt einen Plan mit technischen Tasks;
6. zeigt den Vorschlag oder speichert ihn nach Bestätigung;
7. verknüpft den Stream mit vorhandenen Streams und Abhängigkeiten.

Beispiel für eine unklare Eingabe:

```text
„Prüfe, ob wir für den Warenkorb KI-Empfehlungen einbauen sollten.“
```

Der Agent erstellt keinen vorschnellen Feature-Plan, sondern einen `investigation`- oder `experiment`-Stream mit Fragen, Untersuchungsumfang und Recherche-Tasks.

---

## 14. Was ausdrücklich vermieden werden soll

- Ein einziges freies `description`-Feld als Hauptinhalt.
- Technische Details in fachlichen Streams, wenn sie keine verbindliche Constraint sind.
- Tasks ohne Referenz zu fachlichen Anforderungen oder Acceptance Criteria.
- Tasks als verschachtelte Arrays im Stream-JSON.
- Unkontrollierte direkte Datenbankzugriffe durch lokale Agenten.
- Verhaltensregeln, die nur in einem lokalen System Prompt liegen.
- Tool-Beschreibungen als einzige Validierungsschicht.
- Automatisches Überschreiben neuerer Revisionen.
- Erfundene Anforderungen bei unklaren Nutzerangaben.
- Eine künstliche User-Story-Struktur für Bugs, Experimente oder Untersuchungen.
- Eine unnötig tiefe Hierarchie mit Untertasks, Features, Stories und Epics als Pflichtstufen.

---

## 15. Implementierungsreihenfolge für Claude Opus 5

Die Umsetzung sollte in dieser Reihenfolge erfolgen:

1. Kanonische JSON-Schemas für Epic, Stream und Task definieren.
2. Statuswerte, Stream-Typen und Task-Typen festlegen.
3. PostgreSQL-Grundtabellen und Foreign Keys erstellen.
4. JSONB-Dokumente mit Schema-Version speichern.
5. Relationstabelle und Revisionshistorie implementieren.
6. Domain-Validierung für Parent-Beziehungen und Referenzen implementieren.
7. MCP-Server mit Remote-HTTP-Transport erstellen.
8. Read-Tools implementieren und mit Beispieldaten testen.
9. Change-Set-Validierung und atomisches Anwenden implementieren.
10. Create- und Update-Tools implementieren.
11. Optimistic Concurrency und Task-Claiming implementieren.
12. Tool-Beschreibungen mit Glossar, Regeln und Beispielen formulieren.
13. Natürliche Testeingaben für Feature, Bug, Experiment, Refactor und Investigation durchführen.
14. Audit, Berechtigungen und Konfliktfälle testen.

---

## 16. Endgültiger gemeinsamer Nenner

```text
Eine einfache öffentliche Oberfläche:
    Claude Code → Remote MCP von zpecs

Eine klare Kernstruktur:
    Epic → Stream → Task

Eine detaillierte Dokumentation:
    strukturiertes, versioniertes JSON pro Entität

Eine klare Trennung:
    Epic/Stream = fachliches Was und Warum
    Task = technisches Wie

Eine verlässliche Durchsetzung:
    MCP Tool Descriptions + JSON Schema + serverseitige Domain-Regeln

Eine enge Schreibgrenze:
    Epic/Stream/Task ausschließlich über MCP-Change-Sets
    Project-Container ausschließlich über session-geschütztes REST oder Admin-Bootstrap

Eine sichere gemeinsame Nutzung:
    PostgreSQL + Revisionen + Change Sets + Audit Log + Berechtigungen

Eine einfache Bedienung:
    Nutzer gibt natürliche Sprache ein; der Agent strukturiert, validiert,
    plant und aktualisiert die Daten.
```

Dies ist die Zielarchitektur für einen cloudbasierten, KI-gesteuerten Projektmanagement-Datenspeicher mit drei einfachen Kernobjekten und detaillierter, wiederverwendbarer Dokumentation.
