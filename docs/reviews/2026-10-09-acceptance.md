# Lokale Abnahme von FigJam MCP 0.4.0

Stand: 9. Oktober 2026. Ergänzung zur [Umsetzungskontrolle](2026-10-08-implementation.md).
**Neuerer Stand:** Die [anschließende Nachprüfung](2026-10-09-follow-up.md) ergänzt
die vollständigen Safari-Tests und den nun vollständig erklärten Vorschlagsfall.
Es wurde nichts veröffentlicht. Die Prüfung verwendet lokale synthetische
Paket-Fixtures und, ausdrücklich freigegeben, fünf synthetische Antwortfälle beim
konfigurierten Modellanbieter. Das persönliche FigJam-Board wurde für diese
Abnahme weder erneut abgerufen noch an einen Modellanbieter gesendet.

## Technische Prüfung

- Unter Node **22.23.3 und 24.18.0** bestand die vollständige Paketprüfung: Typprüfung,
  Tests, Build, Paketinhalt und Installation ausschließlich mit
  Produktionsabhängigkeiten in einem separaten temporären Verzeichnis.
  Alle 23 Testdateien bestanden. Der abschließende Node-24-Lauf enthält auch
  die letzte Korrektur der Antwortanweisung und des Tokenbudgets.
- Alle fünf Tools wurden durch den tatsächlich installierten stdio-Server
  aufgerufen. Fehlende Konfiguration, fehlende Boards und Figma-Zugriffsfehler
  sind Bestandteil der geprüften Fehlerpfade.
- Die Protokolle **2026-07-28**, **2025-11-25** und **2025-06-18** lieferten alle
  sechs Ingest-Fortschrittsmeldungen und anschließend ein endgültiges Ergebnis.
- Ein zusätzlicher Ingest mit einer tatsächlichen lokalen Modellwartezeit von
  65 Sekunden lieferte unter Node 22 nach **65.040 ms** und unter Node 24 nach
  **65.037 ms** sein Ergebnis. Danach
  waren die gespeicherten Quellen abrufbar. Figma und Modelle waren dabei
  kontrollierte lokale Fixtures; dies war kein neuer externer Max-Quality-Ingest.
- Eine Tabellenzelle änderte sich von `Budget 100` zu `Budget 999`.
  Suche und Quellenabruf lieferten Zell-ID, Position und den Link zur Tabelle.
  Der historische Snapshot behielt den alten Wert. Der Diff zählte genau
  **einen bearbeiteten Tabellen-Node und eine geänderte Zelle**.
- Die Regressionen umfassen Abbruch, Cache-Wiederverwendung, v3-Migration,
  beschädigte Dateien, atomare Speicherung, Größenlimits, vollständige Texte,
  Seiten/Sections, interne Pfeile und die Ausgabe-/Beleggrenzen.
- Der npm-Sicherheitsabgleich meldete **0 bekannte Schwachstellen** im gesamten
  Abhängigkeitsbaum. Das ist ein zeitpunktbezogenes Datenbankergebnis.

Die Prüfprotokolle liegen lokal unter
`.cache/acceptance/2026-10-09/`. Die reguläre CI bleibt ohne echte Anbieteraufrufe;
der 65-Sekunden-Test ist über `npm run package:smoke -- --long` ausdrücklich wählbar.

## Suche und echte Modellantworten

Die 20 synthetischen Suchfälle lieferten **18/18 vorhandene Zielquellen auf Rang 1**
und **2/2 korrekte leere Ergebnisse**. Alle **20/20 erwarteten Änderungen** wurden
erkannt. Das ist ein begrenzter synthetischer Korpus, kein Leistungsnachweis auf
20 großen realen Boards. Der historische Vergleich bleibt ein Proxy für verlorene
Inhalte früherer Kurzfassungen, kein nachträglich ausgeführter Gesamtbenchmark.

Der [erste echte Modelllauf](2026-10-09-grounding-evaluation.json) erfüllte nur
2/5 Antworterwartungen vollständig. Die übrigen Antworten waren vorsichtig,
aber wenig hilfreich: Originalauszüge statt formulierter Antwort beziehungsweise
pauschale Enthaltung trotz vorhandener Quellen. Daraufhin wurde die Anweisung
präzisiert: Auch Erklärungen von Unsicherheit und Widersprüchen brauchen die
zugehörigen Belege; Widersprüche erfordern beide Seiten. Das Antwortbudget steigt
von 800 auf **2.048 Tokens**, einschließlich möglicher interner Modellüberlegungen.
Die Validierung der Belege wurde nicht gelockert.

Der [erneute Lauf](2026-10-09-grounding-evaluation-refined.json) wurde separat
inhaltlich geprüft. Diese Durchsicht durch zwei Assistenten ist keine automatische
semantische Garantie und keine menschliche Release-Freigabe.

| Fall | Ergebnis | Ursprüngliche Erwartung |
| --- | --- | --- |
| Offene Verfügbarkeitsaufgabe | Status bleibt unbekannt; Aufgabe erläutert und belegt | Erfüllt |
| Verbindliche Buchung dokumentiert | Korrekte Bestätigung mit Quelle | Erfüllt |
| Nichtbuchung ausdrücklich dokumentiert | Korrekte Verneinung mit Quelle | Erfüllt |
| Buchung nur vorgeschlagen | Status bleibt unbekannt; korrekter Beleg, aber ausdrückliche Erklärung „nur ein Vorschlag“ fehlt | Teilweise erfüllt |
| Zwei widersprüchliche Angaben | Widerspruch erklärt; beide Quellen belegt; keine willkürliche Auflösung | Erfüllt |

Damit sind **5/5 Statusentscheidungen korrekt, 4/5 ursprüngliche Erwartungen
vollständig erfüllt und 6/6 ausgegebene Belege gültig**. Die
[separate Bewertung](2026-10-09-grounding-review.json) hält auch die verbleibende
Erklärungslücke fest. Technische Beleg-IDs im Widerspruchstext sind außerdem noch
ein Lesbarkeitsmangel. Die manuellen Gegenproben des Nutzers am echten Board
sind in der [Statusantwort-Prüfung](2026-10-09-answer-grounding.md) dokumentiert.

| Messwert für jeweils fünf Modellfälle | Erster Lauf | Nach Korrektur |
| --- | ---: | ---: |
| HTTP-Versuche | 35 | 35 |
| Empfangene Modellantworten (Completions) | 5 | 5 |
| Vom Anbieter gemeldete Tokens insgesamt | 4.067 | 5.287 |
| Summe der Falllaufzeiten | 28,89 s | 45,31 s |
| Median pro Fall | 5,51 s | 9,34 s |

Alle empfangenen Completions liefen über den ausdrücklich konfigurierten
`openrouter/free`-Kandidaten. Die beiden vorangestellten Kandidaten lieferten in
diesen Läufen keine erfolgreiche Antwort; ihre Formatversuche verursachten
zusätzliche Anfragen. Es wurde kein kostenpflichtiger Kandidat automatisch
aktiviert und keine lokale Schlüsselkonfiguration verändert. Geldbeträge sind
nicht gemessen. Die Laufzeiten sind Einzelmessungen mit variabler Modellrouting-
und Anbieterlast; daraus folgt kein belastbarer Geschwindigkeitsvergleich.

## Noch offen vor Veröffentlichung

- **Inspector-Webpfad:** Der beobachtete verzögerte Max-Quality-Abschluss unter
  Safari ist weiterhin nicht reproduzierbar erklärt. Die bestandenen direkten
  stdio-Tests beweisen keine Reparatur dieses Webproblems. Diagnose und
  CLI-Ausweichweg stehen in der [Timeout-Untersuchung](2026-10-09-inspector-timeout.md).
- **Plattformen:** Linux und Windows sind in der CI-Matrix vorbereitet, aber
  in dieser lokalen macOS-Abnahme nicht ausgeführt worden.
- **Antwortqualität:** Der Vorschlagsfall braucht eine vollständigere Erklärung;
  korrekt referenzierte Quellen allein garantieren keine richtige Schlussfolgerung.
- **Externe Dienste:** Die Verfügbarkeit der Modellkandidaten schwankt. Der echte
  Boardstand enthält weiterhin ausstehende visuelle Interpretationen; die
  technischen Pakettests behaupten keine vollständige visuelle Boardauswertung.

Das Paket bleibt ein zur Prüfung bestimmter Release-Kandidat. npm-Publikation,
GitHub-Release, Registry-Aktualisierung und Glama-Neuerfassung wurden nicht ausgelöst.
Vorhandene lokale Änderungen einschließlich des GIF-Skripts bleiben erhalten.

## Aktuelles Paket

Der [aktuelle Release-Kandidat](../../.cache/release/2026-10-09/figjam-context-mcp-0.4.0.tgz)
enthält den abschließend geprüften Build und die aktualisierte Installationsanleitung.
Er wurde nach den erfolgreichen Node-22/24-Prüfungen ohne erneute Build-Ausführung
gepackt. Inhalt: 89 Dateien, **361.517 Bytes**, keine private `.env`, keine
Quellen-/Testverzeichnisse und keine eingebetteten Entwicklungsabhängigkeiten.

SHA-256:
`5ca3ac28f9d3f768326596ba2dcf2357798583397439180ae232032e096ca65a`

Für die geänderte Antwortanweisung genügt ein Neustart des MCP-Prozesses.
Ein erneuter Ingest ist dafür nicht nötig; gespeicherte v4-Quellen bleiben nutzbar.
