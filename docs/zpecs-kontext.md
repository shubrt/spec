# Zpecs v2 – fachlicher und technischer Kontext

**Stand:** 09.08.2026
**Status:** kanonische v2-Referenz für Maintainer und Implementierungsagenten

Dieses Dokument beschreibt das aktuelle Zielmodell von Zpecs. Beispiele in
älteren Diskussionen oder Revisionen mit anderen Keys, inline definierten
Regeltexten oder dokumentweiter Herkunftsmarkierung beschreiben v1 und sind
nicht mehr schreibbar. Der v2-Cutover ist bewusst ohne Dual-Read oder
Abwärtskompatibilität angelegt; Details zur Transformation stehen in
[`zpecs-v2-migration.md`](./zpecs-v2-migration.md).

## 1. Ziel des Systems

Zpecs ist ein cloudbasierter, strukturierter Projektkontext für Menschen und
MCP-kompatible Agenten. Ein Nutzer kann natürliche Sprache verwenden, zum
Beispiel:

- „Wir wollen, dass Nutzer sich mit Google und E-Mail anmelden können.“
- „Der Warenkorb funktioniert auf mobilen Geräten nicht.“
- „Prüfe, ob KI-basierte Produktempfehlungen sinnvoll sind.“
- „Was fehlt bis zum MVP-Meilenstein?“
- „Implementiere Task T-23.“

Der Agent liest zuerst den vorhandenen Kontext, ordnet die Eingabe ein und
schreibt nur belegte oder ausdrücklich als Annahme markierte Aussagen. Zpecs
soll dabei:

- fachliches Was und Warum von technischer Ausführung trennen;
- Drafts zulassen, ohne fehlende Informationen zu erfinden;
- wiederverwendete Regeln genau einmal kanonisch definieren;
- Roadmap-Reihenfolge von harten Abhängigkeiten unterscheiden;
- Aussagen auf Elementebene mit ihrer Herkunft verbinden;
- Änderungen atomar, versioniert und konfliktfest anwenden;
- Kontext mit kleinen, gezielten Antworten statt vollständigen Dokumenten
  erschließbar machen.

## 2. Systemgrenze

```text
Lokaler Nutzer
└── MCP-kompatibler Agent
    └── HTTPS / Streamable HTTP
        └── Zpecs MCP-Server
            └── Domain Services und Validierung
                └── PostgreSQL
```

Lokale Agenten greifen niemals direkt auf die Datenbank zu. Alle Änderungen an
versionierten Entitäten laufen über validierte, atomare Change-Sets. Die
Web-Anwendung darf als enge Ausnahme einen leeren, unversionierten
Project-Container in der aktiven Clerk-Organisation anlegen; sie eröffnet
keinen zweiten Schreibweg für Fachdokumente.

## 3. Entitätsmodell

Ein Project ist zugleich Namensraum und Datenisolationsgrenze. Darin existieren
drei bewusst verschiedene Strukturen:

```text
Workspace
└── Project
    ├── Arbeitsbaum
    │   └── Epic (E-*)
    │       └── Stream (S-*)
    │           └── Task (T-*)
    ├── Regelkatalog
    │   └── Rule (R-*)
    └── Roadmap
        └── Milestone (M-*)
```

Ein Stream kann zusätzlich genau einem Milestone zugeordnet sein. Diese
Zuordnung macht den Milestone nicht zum Parent: Der Parent bleibt immer das
Epic. Tasks erben die Roadmap-Einordnung ihres Streams.

Die fünf versionierten Entitäten sind:

| Entität   | Key   | Rolle                                                    |
| --------- | ----- | -------------------------------------------------------- |
| Epic      | `E-1` | langlebige fachliche Capability                          |
| Stream    | `S-1` | begrenzte Veränderung, Problemstellung oder Untersuchung |
| Task      | `T-1` | konkrete technische oder menschliche Arbeitseinheit      |
| Milestone | `M-1` | gewählte Roadmap-Phase mit expliziten Ausstiegskriterien |
| Rule      | `R-1` | projektweit kanonische, wiederverwendbare Regel          |

Keys werden serverseitig, fortlaufend und ohne Nullauffüllung vergeben. Sie
sind innerhalb eines Projects eindeutig; bei einem mehrdeutigen Zugriff über
mehrere Projects muss der Project-Name mitgegeben werden. Interne UUIDs bleiben
relationale Identitäten und sind nicht das öffentliche Arbeitsvokabular.

### 3.1 Epic

Ein Epic ist ein stabiler fachlicher Themenbereich, keine Phase und kein
Release. Es beschreibt insbesondere Purpose, Business Problem, langfristigen
Scope, Outcomes und Erfolgsmetriken. Ein Epic bleibt häufig über viele
abgeschlossene Streams hinweg aktiv.

Statuswerte:

```text
active | paused | archived
```

### 3.2 Stream

Ein Stream ist die zentrale fachliche Planungseinheit. Er beantwortet, was
geändert oder gelernt werden soll, warum, für wen, in welchem Scope und woran
der Erfolg erkannt wird. Konkrete Dateien, Frameworks, Endpunkte und
Implementierungsentscheidungen gehören grundsätzlich in Tasks.

Stream-Typen:

| Typ             | Zweck                                    | Adressierbare typeigene Ziele   |
| --------------- | ---------------------------------------- | ------------------------------- |
| `feature`       | neue fachliche Fähigkeit                 | `FR-*`, `NFR-*`, `AC-*`         |
| `bug`           | falsches Verhalten korrigieren           | `BC-*`                          |
| `change`        | bekannten Zustand gezielt verändern      | `CHG-*`                         |
| `experiment`    | Hypothese kontrolliert prüfen            | `HYP-*`, `RQ-*`, `SC-*`, `DR-*` |
| `investigation` | eine unbekannte Sachlage klären          | `IQ-*`, `SC-*`                  |
| `refactor`      | Struktur verbessern und Zusagen bewahren | `REF-*`, `INV-*`, `QG-*`        |
| `maintenance`   | Wartung und technische Pflege            | `MG-*`, `RSK-*`                 |

Statuswerte:

```text
draft | planned | ready | in_progress | blocked | completed | cancelled
```

Die optionale Größenangabe `small | medium | large` unterstützt Roadmap-Urteile,
ohne eine Zeitplanung vorzutäuschen.

### 3.3 Task

Ein Task ist eine eigenständig ausführbare Arbeitseinheit. Das kann
Implementierung durch einen Agenten, eine Entscheidung, ein Review oder auch
manuelle Arbeit durch einen Menschen sein. `task_type` beschreibt die
Arbeitsform, nicht die Natur des Parent-Streams:

```text
implementation | investigation | migration | testing | review | decision
```

`execution.executor_kind` legt optional fest, wer den Task ausführen kann:

```text
human | agent | either
```

Fehlt das Feld, ist die Ausführungsart unbekannt; das wird nicht stillschweigend
als `either` interpretiert.

Statuswerte:

```text
draft | ready | in_progress | blocked | in_review | done | cancelled
```

### 3.4 Rule

Eine Rule ist eine projektweite, adressierbare und selbst versionierte Aussage.
Sie besitzt den kanonischen Regeltext, Begründung, Wirkung, Konsequenz und
optional claim-bezogene Evidenz. Statuswerte:

```text
draft | active | deprecated
```

Epics und Streams kopieren den Text nicht. Sie tragen lokale `RA-*`
Rule-Anwendungen mit `rule_key`, optionaler Bedingung und Anwendungshinweis:

```json
{
  "id": "RA-1",
  "rule_key": "R-4",
  "applies_when": "Eine Veröffentlichung manuell freigegeben wird.",
  "application": "Gilt für alle Review-Flows dieses Streams."
}
```

Eine Anwendung darf den kanonischen Text nicht lokal überschreiben. Eine echte
semantische Variante wird als neue Rule modelliert und über `derived_from`,
`exception_to` oder `supersedes` mit anderen Rules verbunden. Eine referenzierte
Rule kann nicht hart gelöscht werden; Deprecation oder Supersession schreibt
Konsumenten niemals automatisch um.

### 3.5 Milestone

Ein Milestone ist eine Roadmap-Phase parallel zum Arbeitsbaum. Er enthält ein
Ziel und lokale `EXIT-*`-Kriterien. Statuswerte:

```text
draft | planned | active | completed | cancelled
```

Die Project-weite Milestone-Reihenfolge und der optionale Rang eines Streams im
Milestone sind beratend. Gleiche Ränge bedeuten Parallelität. Sie erzeugen
keine Abhängigkeit und verstecken technisch verfügbare spätere Arbeit nicht.

V2 modelliert bewusst keine Termine, Sprints, Deadlines oder Kapazitäten. Ein
Milestone kann nur abgeschlossen werden, wenn jedes Ausstiegskriterium `met`
oder mit Begründung `waived` ist und keine zugeordneten Streams mehr offen sind.
Streams ohne Milestone bleiben sichtbar im Backlog.

## 4. Lokale Identität statt Entitätsauslagerung

Nicht jede adressierbare Sache ist eine eigene Entität. Ein lokales Element ist
eindeutig durch `(Owner, semantischer Namensraum, ID)`. `FR-1` in `S-2` und
`FR-1` in `S-8` sind deshalb verschiedene Requirements. Die IDs sind nicht
Project-global und werden nur dort referenziert, wo der Owner eindeutig ist.

| Präfix                          | Bedeutung                                                        |
| ------------------------------- | ---------------------------------------------------------------- |
| `SCP-*`                         | Scope-Zeile                                                      |
| `OUT-*`, `MET-*`                | Epic-Outcome, Erfolgsmetrik                                      |
| `FR-*`, `NFR-*`, `AC-*`         | funktionales/nichtfunktionales Requirement, Acceptance Criterion |
| `WF-*`, `STEP-*`, `EC-*`        | Workflow, Workflow-Schritt, Edge Case                            |
| `RA-*`                          | lokale Anwendung einer Rule                                      |
| `ASM-*`, `OQ-*`, `SRC-*`        | Annahme, offene Frage, Quelle                                    |
| `EXIT-*`                        | Milestone-Ausstiegskriterium                                     |
| `VER-*`                         | Task-Verifikation                                                |
| `BC-*`, `CHG-*`                 | Bug-Verhaltensfall, Änderungsziel                                |
| `HYP-*`, `RQ-*`, `SC-*`, `DR-*` | Hypothese, Forschungsfrage, Erfolgskriterium, Entscheidungsregel |
| `IQ-*`                          | Untersuchungsfrage                                               |
| `REF-*`, `INV-*`, `QG-*`        | Refactor-Ziel, Invariante, Qualitätsziel                         |
| `MG-*`, `RSK-*`                 | Wartungsziel, Risiko                                             |

Alle lokalen IDs verwenden eine positive Zahl ohne Nullauffüllung, also `AC-1`
statt `AC-001`. Arrays mit lokaler Identität können über diese ID gezielt
bearbeitet werden. Sie bleiben eingebettet, weil sie überwiegend nur innerhalb
ihres Owners Bedeutung haben. Die Auslagerung von Rules ist die bewusste
Ausnahme: Rules werden tatsächlich über mehrere Entitäten hinweg wiederverwendet
und müssen unabhängig versioniert werden.

Domain-Akteure in Streams bleiben lokale Labels, beispielsweise
`human_reviewer`. Assignees sind externe Actor-Referenzen mit `type` und `id`;
Autorschaft wird serverseitig im Revisionsprotokoll erfasst. Es gibt in v2
keinen globalen Rollen- oder Persona-Katalog.

## 5. Dokumentmodell

Jede versionierte Entität hat ein geschlossenes, validiertes Dokument. Die
aktuellen Schema-Versionen sind:

```text
pm.epic.v2
pm.stream.v2
pm.task.v2
pm.rule.v2
pm.milestone.v2
```

Der gemeinsame Umschlag ist:

```json
{
  "entity": "stream",
  "schema_version": "pm.stream.v2",
  "meta": {},
  "content": {},
  "links": {},
  "provenance": {}
}
```

Tasks besitzen zusätzlich die operative Schwestersektion `execution`. Agenten
schreiben nur freigegebene Input-Felder. Keys, UUIDs und Revision werden in das
Dokument gestempelt; Project, Zeitstempel und Autorschaft liegen relational
beziehungsweise im Revisionsprotokoll. Roadmap- und Trace-Felder verwaltet der Server.
Graphbeziehungen werden ausschließlich mit `link`/`unlink` gepflegt; sie sind
kein zweiter frei beschreibbarer Store im Dokument.

### 5.1 Inhalte nach Entität

Epic-Inhalt:

```text
purpose, business_problem, scope, outcomes, success_metrics,
rule_applications, open_questions, assumptions
```

Gemeinsamer Stream-Inhalt:

```text
purpose, scope, actor, workflows, rule_applications, edge_cases,
vertical_slice, open_questions, assumptions
```

Dazu kommen die typeigenen Ziele aus der Tabelle in Abschnitt 3.2.

Task-Inhalt:

```text
objective, implements, constrained_by_rule_keys, technical_scope,
implementation, dependencies, verification, done_when, artifacts,
open_questions
```

Rule-Inhalt:

```text
statement, rationale, impact, consequence, evidence,
open_questions, assumptions
```

Milestone-Inhalt:

```text
goal, exit_criteria, open_questions, assumptions
```

Die vollständige, schreibbare Struktur wird bei Bedarf über
`get_entity_schema` abgerufen. Dieses Dokument ist eine Modellreferenz und soll
das generierte Schema nicht duplizieren.

## 6. Typisierte Traceability

Ein Task kopiert keine fachliche Anforderung. Er referenziert lokale Ziele des
eindeutigen Parent-Streams über typspezifische Arrays. Das verhindert sowohl
falsche Namespaces als auch den ehemals unerreichbaren Ready-Zustand bei
`change`, `experiment`, `refactor` und `maintenance`.

| Parent-Stream   | Erlaubte Task-Referenzfelder                                                           |
| --------------- | -------------------------------------------------------------------------------------- |
| `feature`       | `requirement_ids`, `acceptance_criteria_ids`                                           |
| `bug`           | `behavior_case_ids`                                                                    |
| `change`        | `change_ids`                                                                           |
| `experiment`    | `hypothesis_ids`, `research_question_ids`, `success_criteria_ids`, `decision_rule_ids` |
| `investigation` | `investigation_question_ids`, `success_criteria_ids`                                   |
| `refactor`      | `refactor_target_ids`, `invariant_ids`, `quality_goal_ids`                             |
| `maintenance`   | `maintenance_goal_ids`                                                                 |

Beispiel für einen Feature-Task:

```json
{
  "entity": "task",
  "schema_version": "pm.task.v2",
  "meta": {
    "title": "Freigabepfad implementieren",
    "status": "ready",
    "task_type": "implementation"
  },
  "content": {
    "objective": "Den vereinbarten manuellen Freigabepfad umsetzen.",
    "implements": {
      "stream_id": "<server-id-des-parent-streams>",
      "requirement_ids": ["FR-1"],
      "acceptance_criteria_ids": ["AC-1"]
    },
    "constrained_by_rule_keys": ["R-4"],
    "verification": [
      {
        "id": "VER-1",
        "type": "integration_test",
        "procedure": "Einen gültigen Kandidaten manuell freigeben.",
        "expected": "Er durchläuft denselben fachlichen Promotionsweg."
      }
    ],
    "done_when": ["AC-1 ist nachweislich erfüllt."]
  },
  "links": {
    "parent_stream_id": "<server-id-des-parent-streams>"
  },
  "execution": {
    "executor_kind": "agent"
  },
  "provenance": {}
}
```

Ab `ready` braucht ein Task mindestens ein zulässiges, im Parent vorhandenes
Ziel sowie sowohl `verification` als auch `done_when`. Rules sind Constraints,
keine Arbeitsziele, und erfüllen diese Readiness-Bedingung allein nicht.

Acceptance Criteria trennen ebenfalls Referenzarten:

```json
{
  "id": "AC-1",
  "given": "Ein gültiger Kandidat ist vorhanden.",
  "when": "Ein Reviewer ihn freigibt.",
  "then": "Der Kandidat wird über den kanonischen Weg veröffentlicht.",
  "verifies": {
    "requirement_ids": ["FR-1"],
    "rule_keys": ["R-4"]
  }
}
```

Der Server prüft jede strukturierte Referenz in Vorwärts- und
Rückwärtsrichtung. Ein referenziertes Element kann weder durch Section-Replace
noch durch eine gezielte Item-Operation unbemerkt entfernt werden.

### 6.1 Revisions-Pins

Beim Start eines Tasks hält der Server die verwendete Parent-Stream-Revision
fest. Beim Übergang in einen terminalen Zustand werden die tatsächlich
verwendete Stream-Revision und die wirksamen Rule-Revisionen in `execution`
gepinnt. Aktive Arbeit liest aktuelle Rules; abgeschlossene Arbeit bleibt gegen
spätere Regeländerungen historisch nachvollziehbar.

Für bereits terminal aus v1 importierte Tasks, deren damaliger Kontext nicht
beweisbar rekonstruiert werden kann, setzt die Migration stattdessen den
serververwalteten Marker
`execution.trace_state: "pre_v2_not_recorded"`. Er ist eine ausdrückliche
historische Lücke, kein leerer Pin: `get_context` liefert dafür
`revisionSource: "not_recorded"` und ersetzt weder Stream noch Rules durch ihren
heutigen Stand. Spätere Korrekturen an Metadaten, Provenienz oder operativer
Zuordnung füllen die Lücke nicht nachträglich. Inhalt, Wiedereröffnung und Move
bleiben wie bei gepinnten terminalen Tasks gesperrt.

## 7. Herkunft pro Aussage

Herkunft gehört an die Aussage, nicht an einen fragilen String-Pfad im
Gesamtdokument. `provenance.sources` ist ein lokaler Katalog unveränderlich
bezeichneter Beobachtungen. Bestehende `SRC-*` werden nie umgeschrieben oder
entfernt; eine Korrektur ergänzt eine neue Source mit
`supersedes_source_ids`:

```json
{
  "sources": [
    {
      "id": "SRC-1",
      "type": "existing_code",
      "reference": "Promotion-Service",
      "snapshot": "commit abc123",
      "observed_at": "2026-08-09T08:00:00Z"
    }
  ]
}
```

Ein Element, das eine Behauptung trägt, kann kompakte Evidenz besitzen:

```json
{
  "id": "FR-1",
  "statement": "Manuelle und automatische Freigabe nutzen denselben Weg.",
  "evidence": {
    "basis": "verified",
    "source_ids": ["SRC-1"]
  }
}
```

`basis` hat genau diese Werte:

```text
stated | verified | inferred | assumed
```

`stated`, `verified` und `inferred` benötigen mindestens eine lokale Quelle.
Eine als `assumed` markierte Aussage darf ohne Quelle bestehen. Annahmen und
offene Fragen sind jeweils einmal als adressierbare `ASM-*`- und `OQ-*`-Elemente
im Content modelliert. Es gibt weder dokumentweite Pfadlisten für abgeleitete
Felder noch doppelte offene Fragen in der Provenance-Sektion.

Freshness wird aus einer expliziten lokalen Supersession-Kette als `fresh`,
`stale` oder `unknown` abgeleitet und nicht als veränderliches Boolean
gespeichert. Eine neue Beobachtung kann beispielsweise
`"supersedes_source_ids": ["SRC-1"]` tragen. Damit ist `SRC-1` nachweislich
`stale`, die noch nicht selbst ersetzte neue Quelle `fresh`; eine Quelle ohne
solchen Nachweis bleibt `unknown`. Nachweislich veraltete alleinige Evidenz
blockiert aktive Readiness. Unbekannte Freshness wird sichtbar gemacht, aber
nicht als veraltet oder aktuell erraten.

## 8. Readiness und Lebenszyklen

Ein unvollständiger Draft ist korrekt. Strenge Anforderungen greifen aus dem
geschriebenen Status, nicht aus einem vom Client gesetzten Ausnahme-Flag.

Für `ready` und spätere aktive Stream-Zustände gilt mindestens:

| Typ             | Readiness-Anker                                             |
| --------------- | ----------------------------------------------------------- |
| `feature`       | mindestens ein `AC-*`                                       |
| `bug`           | mindestens ein `BC-*` mit Ist- und Soll-Verhalten           |
| `change`        | mindestens ein `CHG-*`                                      |
| `experiment`    | mindestens ein `HYP-*`, `SC-*` und `DR-*`                   |
| `investigation` | mindestens ein `IQ-*` sowie `SC-*` oder `expected_decision` |
| `refactor`      | mindestens ein `REF-*` und `INV-*`                          |
| `maintenance`   | mindestens ein `MG-*`                                       |

Für Tasks gelten die Bedingungen aus Abschnitt 6. Abgebrochene Entitäten
bleiben auch unvollständig schreibbar, damit ein Draft ohne erfundene Daten
cancelled werden kann.

Ein `planned`, `active` oder `completed` Milestone braucht mindestens ein
`EXIT-*`-Kriterium. Bei `completed` müssen alle Kriterien `met` oder begründet
`waived` sein; zugeordnete offene Streams verhindern den Abschluss.

## 9. Beziehungen und Abhängigkeiten

Harte `blocked_by`-Beziehungen sind nur auf derselben Arbeitsebene erlaubt:

```text
Stream → Stream
Task   → Task
```

Ein Task darf also nicht direkt von einem Stream abhängen. Rule und Milestone
sind keine Dependency-Endpunkte. `cancelled` erfüllt einen Blocker nicht.

Allgemeine Beziehungen verwenden die kanonische Richtung und einen der Werte:

```text
blocked_by | related_to | extends | fixes | supersedes |
derived_from | exception_to
```

Rule-Beziehungen sind auf Rule-zu-Rule und die semantisch passenden Typen
beschränkt. Milestones nehmen überhaupt nicht am Beziehungsgraphen teil.
Roadmap-Reihenfolge bleibt davon vollständig getrennt.

## 10. Speicherung, Revisionen und Konflikte

PostgreSQL hält relationale Spalten für Identität, Parent, Status, Revision,
Roadmap-Platzierung und Abfragen sowie validierte JSONB-Dokumente für den
strukturierten Inhalt. Zu den logischen Tabellen gehören:

```text
project
epic
stream
task
rule
milestone
entity_link
entity_revision
```

Jede Änderung an einer versionierten Entität erzeugt eine neue Revision.
Updates, Moves, Retirement und Scheduling verlangen die erwartete Revision.
Bei einem Konflikt meldet der Server die aktuelle Revision zurück; er
überschreibt niemals stillschweigend neuere Daten.

Die Historie ist append-only. Beim v2-Cutover bleiben alte v1-Snapshots
byte-identisch als rohe Historie erhalten. Der aktuelle Zustand erhält eine
neue v2-Baseline; danach werden v1-Schreibvorgänge und alte öffentliche Keys
abgelehnt.

## 11. MCP-Werkzeuge

Zpecs exponiert eine kleine Werkzeugfläche:

```text
list_context
search_context
get_context
get_entity_schema
validate_change_set
apply_change_set
get_next_work
```

### 11.1 Entdecken und lesen

`list_context` liefert kompakte, paginierbare Zeilen oder einen menschlich
lesbaren Arbeitsbaum beziehungsweise eine Roadmap. Es kann nach Project,
Entität, Status, Parent und Milestone filtern und lädt keine vollständigen
Dokumente.

`search_context` dient der Volltextsuche über Epics, Streams, Tasks, Rules und
Milestones. Es ist kein Ersatz für die strukturierte Auflistung.

`get_context` lädt eine konkrete Entität und auf Wunsch passenden Parent-,
Dependency-, Milestone- und Rule-Kontext. Rules werden gebündelt aufgelöst,
nicht mit einer Anfrage pro Anwendung. Für aktive Tasks werden aktuelle
wirksame Rules projiziert; für terminale Tasks die gepinnten Revisionen. Beim
Lesen eines Streams bleiben dessen eigene Sections ausschließlich im ohnehin
zurückgegebenen Dokument; das Bundle dupliziert nur geerbten und verknüpften
Kontext.

`get_entity_schema` liefert das aktuelle Eingabeschema genau dann, wenn ein
Agent eine Entität schreiben will. Dadurch muss die große Schema-Struktur nicht
in jeder MCP-Runde übertragen werden.

### 11.2 Nächste Arbeit

`get_next_work` unterstützt Project-, Milestone-, Epic- und Stream-Scope. Es
unterscheidet zwei Ergebnisarten:

- `task_execution`: ein ausführbarer Task;
- `stream_planning`: ein bereiter Stream ohne ausführbaren Task oder mit nur
  Draft-Tasks, der Planung beziehungsweise Zerlegung braucht.

Die Verfügbarkeit berücksichtigt den vollständigen Epic-/Stream-/Task-Status,
gleichstufige harte Blocker, Roadmap-Sortierung und optional
`executor_kind`. Eine Roadmap-Reihenfolge sortiert, verbirgt aber keine sonst
verfügbare Arbeit, außer der Aufrufer wählt ausdrücklich einen Milestone.

### 11.3 Schreiben mit Change-Sets

Ein Change-Set enthält einen Grund und bis zu 50 geordnete Operationen. Es wird
vollständig oder gar nicht angewendet. Unterstützte Operationen:

```text
create | update | link | unlink | archive | delete | move | schedule
```

`validate_change_set` führt denselben Preflight und dieselbe Simulation wie
`apply_change_set` aus, schreibt aber nichts. Es sammelt voneinander unabhängige
Fehler in einem Lauf und zeigt einen semantischen Diff, unter anderem entfernte
lokale IDs, Kaskaden, Scheduling und die Auswirkung einer Rule-Änderung.

Gesendete Sections werden weiterhin vollständig ersetzt. Für adressierbare
Arrays kann ein Update jedoch mehrere vollständige Elemente mit einer einzigen
Owner-Revision bearbeiten:

```json
{
  "operation": "update",
  "key": "S-4",
  "expected_revision": 7,
  "items": [
    {
      "action": "replace",
      "path": "content.acceptance_criteria",
      "id": "AC-2",
      "value": {
        "id": "AC-2",
        "given": "Ein gültiger Kandidat ist vorhanden.",
        "when": "Ein Reviewer ihn freigibt.",
        "then": "Die Freigabe ist nachvollziehbar."
      }
    },
    {
      "action": "remove",
      "path": "content.edge_cases",
      "id": "EC-3"
    }
  ]
}
```

`add` und `replace` verlangen immer das vollständige Element; es gibt weder
Leaf-Merge noch Upsert. Alle Item-Aktionen teilen eine `expected_revision` und
erzeugen genau eine neue Owner-Revision.

Ein bereits gestarteter, noch nicht terminaler Task kann mit
`rebase_stream_revision: true` ausdrücklich auf die aktuelle Revision seines
Parent-Streams umgestellt werden. Das ist kein stiller Refresh: derselbe Update
kann `data` und `items` enthalten, der neue Gesamtzustand wird gegen den neuen
Snapshot validiert, und `apply_change_set` verlangt `confirm: true`.

`schedule` ordnet einen Stream einem Milestone oder dem Backlog zu und setzt
optional den beratenden Rang; auf einem Milestone verändert es dessen
Project-weite Roadmap-Reihenfolge. Es ist OCC-geschützt, aber keine destruktive
Bestätigung und keine Dependency-Operation. Ein bereits gespeicherter Stream oder
Milestone braucht `expected_revision`; ein `$temp`-Stream aus einem früheren
Create desselben Sets nicht.

Archive, Delete, Move, Task-Rebase, referenzwirksame lokale Entfernungen und Änderungen an
Rules mit aktiven Konsumenten brauchen eine explizite Bestätigung für genau
diese Operation. Eine Bestätigung wird nicht reflexartig auf das gesamte
Change-Set gesetzt.

Temporäre IDs wie `$new_stream` verbinden Creates und Folgeoperationen innerhalb
desselben Sets. Öffentliche E-/S-/T-/M-/R-Keys werden trotzdem ausschließlich
vom Server vergeben.

Öffentliche Keys bleiben auch bei Cross-Project-Moves stabil. Existiert einer
der E-/S-/T-Keys des bewegten Subtrees bereits im Ziel-Project, lehnen Validation
und Apply den Move mit der vollständigen Kollisionsliste ab; es gibt kein stilles
Re-Keying.

## 12. Server-seitig erzwungene Invarianten

Das Modell wird nicht nur durch Tooltexte erklärt, sondern serverseitig
durchgesetzt:

- Jede versionierte Entität gehört genau einem Project.
- Ein Stream gehört genau einem Epic; ein Task genau einem Stream.
- Nur Streams und Tasks sind gleichstufige harte Dependency-Endpunkte.
- Strukturierte lokale und Rule-Referenzen müssen im richtigen Namensraum
  existieren.
- Reverse References verhindern das Entfernen noch verwendeter Elemente.
- Aktive Arbeit darf keine fehlende oder deprecated Rule neu referenzieren.
- Graphabhängigkeiten dürfen keine Zyklen erzeugen.
- Readiness hängt vom geschriebenen Status und dem passenden Stream-Typ ab.
- Fremde serverseitige Metadaten, Roadmap-Felder und Trace-Pins sind nicht
  schreibbar.
- Jeder Write prüft Workspace, Project und erwartete Revision.
- Ein atomarer Satz mit einem Fehler schreibt keine Teilmenge.
- Destruktive oder weitreichende Änderungen verlangen gezielte Bestätigung.

## 13. Leitlinien für Agenten und Maintainer

1. Erst `list_context` oder `search_context`, dann gezielt `get_context` lesen.
2. Vor einem Write das aktuelle Schema über `get_entity_schema` abrufen.
3. Unbekanntes als `OQ-*` oder `ASM-*` festhalten, niemals überzeugend erfinden.
4. Wiederverwendetes Verhalten als `R-*` definieren und mit `RA-*` anwenden.
5. Fachliche Ziele lokal im Stream halten; nur echte projektweite Regeln
   auslagern.
6. Tasks mit typisierten Referenzen auf den Parent-Stream rückverfolgbar machen.
7. Roadmap-Urteile mit Milestones und Rängen ausdrücken, harte Voraussetzungen
   ausschließlich mit `blocked_by`.
8. Änderungen zuerst validieren und den semantischen Diff prüfen.
9. Bei mehreren Änderungen am selben ID-Array gebündelte `items` verwenden.
10. Eine stale Revision neu lesen; niemals die erwartete Revision raten.
11. Technische und gestalterische Entscheidungen dem Nutzer vorlegen: Optionen
    mit Empfehlung zeigen, explizit fragen, und erst die getroffene Wahl mit
    Begründung und Alternativen als `technical_decisions` festschreiben.
    Unentschiedenes bleibt `OQ-*`; ist die Entscheidung selbst Arbeit, wird sie
    ein Task vom Typ `decision`.

## 14. Bewusste Nicht-Ziele

V2 führt nicht ein:

- Dates, Sprints, Deadlines oder Capacity Planning;
- einen globalen Actor-, Rollen- oder Persona-Katalog;
- Untertasks oder weitere verpflichtende Hierarchieebenen;
- freie lokale Überschreibungen kanonischer Rules;
- Project-globale IDs für eingebettete Stream-Inhalte;
- Deep-Merge beliebiger JSON-Fragmente;
- automatische Umschreibung von Rule-Konsumenten;
- direkte Datenbankzugriffe durch lokale Agenten;
- eine künstliche User-Story-Schablone für alle Stream-Typen.

Der gemeinsame Nenner bleibt klein: ein Arbeitsbaum für Ownership, ein
Regelkatalog für wiederverwendetes Verhalten, eine beratende Roadmap für
Reihenfolge und ein atomarer MCP-Schreibpfad für alle versionierten Änderungen.
