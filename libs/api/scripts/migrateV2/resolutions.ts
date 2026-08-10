/**
 * Reviewed, one-off semantic enrichments for legacy terminal Streams whose v1
 * shape predates their type-specific v2 targets.
 *
 * Every entry is pinned to the exact production row observed by the migration
 * preflight. A changed UUID, key, revision or canonical document hash is a hard
 * stop; there is intentionally no generic fallback.
 */
export type StreamResolution = {
  readonly entityId: string;
  readonly legacyKey: string;
  readonly expectedRevision: number;
  readonly expectedDocumentSha256: string;
  readonly status?: "planned";
  readonly content: Readonly<Record<string, unknown>>;
  readonly migrationAssumption: string;
};

const reconstructedAssumption =
  "Die v2-Pflichtziele wurden beim Cutover aus dem unveränderten Zweck und Umfang dieses abgeschlossenen v1-Streams rekonstruiert; v1 führte sie nicht als separate Zielobjekte.";

export const STREAM_RESOLUTIONS: readonly StreamResolution[] = [
  {
    entityId: "9ff44575-1670-4518-9b33-e3d7053c8256",
    legacyKey: "STR-15",
    expectedRevision: 1,
    expectedDocumentSha256: "23db82f14f7b37f9018ef497e73fe3f5393afc2687b1026b22a7db4997f15d7e",
    content: {
      changes: [
        {
          id: "CHG-1",
          current_state:
            "Ein zu lange laufender Auftrag kann als verwaist von einem zweiten Bearbeiter übernommen werden, während der erste noch arbeitet; dadurch wird dieselbe Arbeit parallel ausgeführt und bezahlter Fortschritt kann verloren gehen.",
          desired_state:
            "Der Auftrag hält sich vor Ablauf seiner Beanspruchung selbst an, sichert den besten Fund und stellt sich ohne Fehlschlag für eine weitere Runde zurück.",
          success_measure:
            "Kein Auftrag wird nach einem selbst ausgelösten Fristabbruch parallel weiterbearbeitet, und gesicherter Fortschritt wird in der Folgerunde nicht wiederholt.",
          evidence: { basis: "assumed" },
        },
      ],
    },
    migrationAssumption: reconstructedAssumption,
  },
  {
    entityId: "6c45b13e-03b0-4375-89df-af33c0c7caf2",
    legacyKey: "STR-16",
    expectedRevision: 3,
    expectedDocumentSha256: "2cef69078768021779151832e77d13a20734d58cdbc20885dec1aa5b967deeba",
    content: {
      changes: [
        {
          id: "CHG-1",
          current_state:
            "Ein Parkurteil kann dauerhaft bestehen bleiben, obwohl es nur wegen einer im selben Lauf unterdrückten bestätigenden Quelle entstanden ist, weil bekannter Inhalt nicht erneut ausgewertet wird.",
          desired_state:
            "Ein späterer Lauf ohne eigene Unterdrückung bewertet das gespeicherte Ergebnis einmalig neu, ohne einen weiteren Modellaufruf auszulösen.",
          success_measure:
            "Jede betroffene Karte wird höchstens einmal nachgeprüft und endet danach in einem Zustand, der keine weitere Nachprüfung auslöst.",
          evidence: { basis: "assumed" },
        },
      ],
    },
    migrationAssumption: reconstructedAssumption,
  },
  {
    entityId: "448ef154-0c05-4e8d-a2e9-9677ab166768",
    legacyKey: "STR-24",
    expectedRevision: 2,
    expectedDocumentSha256: "45e8b78a752fd892da5de732853ff72e73bddedb9e5f7d5897204f0aa051664e",
    content: {
      hypotheses: [
        {
          id: "HYP-1",
          hypothesis:
            "Wiederholte Messungen gegen dieselbe reale Quelle liefern eine belastbarere Modellwahl als eine ungemessene Schätzung und machen Streuung als Modellinstabilität sichtbar.",
          evidence: { basis: "assumed" },
        },
      ],
      success_criteria: [
        {
          id: "SC-1",
          criterion:
            "Modelle und Verarbeitungswege sind über wiederholte Läufe derselben sechsseitigen Quelle anhand gefundener Gerichte, Kosten je Karte und Laufzeit vergleichbar.",
          measurement:
            "Die Kennzahlen und die Begründung der Wahl sind im README-Abschnitt zur Kartenauswertung festgehalten.",
          evidence: { basis: "assumed" },
        },
      ],
      decision_rules: [
        {
          id: "DR-1",
          condition:
            "Für einen Verarbeitungsweg liegen wiederholte Messwerte zu Ausbeute, Kosten und Laufzeit gegen dieselbe Quelle vor.",
          decision:
            "Das Modell wird anhand dieser Messwerte gewählt und die Wahl mit ihrer Messgrundlage dokumentiert.",
          evidence: { basis: "assumed" },
        },
      ],
    },
    migrationAssumption: reconstructedAssumption,
  },
  {
    entityId: "ad818770-15b0-4b8b-aeb4-6ca31723e28a",
    legacyKey: "STR-36",
    expectedRevision: 1,
    expectedDocumentSha256: "074e0e1d479b2698c10c680bc21f19f8768b289f6a08d9dcde103bfc80fdb6f7",
    content: {
      changes: [
        {
          id: "CHG-1",
          current_state:
            "Paketverwaltung, Laufzeit, Aufgabensteuerung, Formatierung und Linting würden als getrennte Werkzeugketten für Dienst, Anwendung und Bibliothek gepflegt.",
          desired_state:
            "Dienst, mobile Anwendung, geteilte Bibliothek und Werkzeugkonfiguration liegen in einem Repository unter einer gemeinsamen Werkzeugkette.",
          success_measure:
            "Ein Befehl führt Linting, Formatierung, Abhängigkeitsprüfung und Typprüfung für alle Pakete aus.",
          evidence: { basis: "assumed" },
        },
      ],
    },
    migrationAssumption: reconstructedAssumption,
  },
  {
    entityId: "956d71a0-82c4-4819-9d93-6437ca10c3e8",
    legacyKey: "STR-37",
    expectedRevision: 1,
    expectedDocumentSha256: "16266c552fac5b3d6d4a94226ee15f9d830a8952cfacea78bb7292cfb067fe1c",
    content: {
      changes: [
        {
          id: "CHG-1",
          current_state:
            "Fehlende oder widersprüchliche Einstellungen können erst an einem falschen Ergebnis sichtbar werden, wenn Pakete ihre Konfiguration getrennt lesen und nur Einzelwerte prüfen.",
          desired_state:
            "Alle Pakete teilen eine Umgebungsdatei im Wurzelverzeichnis, und der Dienst prüft beim Start Typen, Wertebereiche und Beziehungen zwischen Einstellungen.",
          success_measure:
            "Der Dienst startet bei jeder fehlenden oder widersprüchlichen Konfiguration nicht und meldet den Fehler unmittelbar.",
          evidence: { basis: "assumed" },
        },
      ],
    },
    migrationAssumption: reconstructedAssumption,
  },
  {
    entityId: "966fe499-19c5-4d06-b652-19b9170a6519",
    legacyKey: "STR-41",
    expectedRevision: 1,
    expectedDocumentSha256: "d78e1c5fa972711f35b04609641736b15500a7c19eef0074414abdec24ec63b8",
    content: {
      maintenance_goals: [
        {
          id: "MG-1",
          goal: "Fremde Anwendungen und ihre Bibliotheken aus dem Repository entfernen, sodass nur Dienst, mobile Anwendung und geteilte Bibliothek von znacks verbleiben.",
          done_when:
            "Die fremden Pakete sind entfernt, die Arbeitsplanung liegt außerhalb des Repositories und bestehende Regel- und Kriterienschlüssel bleiben für Codeverweise unverändert.",
          evidence: { basis: "assumed" },
        },
      ],
    },
    migrationAssumption: reconstructedAssumption,
  },
  {
    entityId: "19797f51-be21-4e1a-bc30-0f8333edfc0a",
    legacyKey: "STR-42",
    expectedRevision: 1,
    expectedDocumentSha256: "ce290d2c57382443c004006ac0215fef009c35f9d657398f5b4814dd758ddd28",
    content: {
      maintenance_goals: [
        {
          id: "MG-1",
          goal: "Das Wissen außerhalb des Codes in README, Projektkontext und einer kanonischen Arbeitsanweisung vollständig und widerspruchsfrei halten.",
          done_when:
            "Die README beschreibt Aufbau, Einstellungen, Messwerte und Betriebsabfragen; der Projektkontext enthält Vision, Ziele, Zielgruppe, Rahmenbedingungen, Glossar und Quellen; andere Arbeitsanweisungen verweisen auf eine einzige kanonische Datei.",
          evidence: { basis: "assumed" },
        },
      ],
    },
    migrationAssumption: reconstructedAssumption,
  },
  {
    entityId: "802b8d17-ba2f-47da-a212-80b14bd8870a",
    legacyKey: "STR-46",
    expectedRevision: 1,
    expectedDocumentSha256: "3bdc5c96008ccb034732445fcfa18bf3ad080fd47244f1190752af752f63adc6",
    status: "planned",
    content: {},
    migrationAssumption:
      "Der Status wurde beim v2-Cutover von ready auf planned zurückgesetzt, weil v1 kein eigenständiges CHG-Ziel erfasste; die fachliche Zielstruktur muss vor einer erneuten Freigabe ergänzt werden.",
  },
] as const;
