# Unabhängige Abschlussprüfung von FigJam MCP 0.4.0

Stand: 9. Oktober 2026. Ausgangspunkt war der vollständig hochgeladene
Prüfstand `5da3cba766051f848065f440398d01480fd2ec33` in
[PR #1](https://github.com/ecestnrkl/figjam-mcp/pull/1).
Branch, Commit, offener Entwurfsstatus, fehlendes Auto-Merge und konfliktfreie
Zusammenführbarkeit wurden erneut direkt bei GitHub bestätigt. Beide bisherigen
CI-Läufe bestanden alle sechs Plattformkombinationen. Der lokale und entfernte
`main` lagen unverändert auf `0ba78a752b1b68da39b378c54dcd533598c17bcd`.

## Gefundene und behobene Fehler

1. **Rückkehr zu einem älteren Boardinhalt:** Bei A → B → A übernahm ein
   vollständiger Cachetreffer den ursprünglichen Zeitstempel von A. Der Diff
   konnte deshalb einen rückwärts datierten Zeitraum ausgeben. Der erneut
   erfasste Zustand erhält jetzt eine aktuelle Aufnahmezeit. Direkt unveränderte
   Folgeläufe behalten ihre bisherige Zeit; abgeschlossene Interpretationen
   bleiben wiederverwendbar. Der Integrationstest prüft Verlauf, Diffzeitraum
   und die Zahl der Modellaufrufe mit synthetischen Daten.
2. **Getrennte Tabellenzellen:** Die Suche nach „Budget“ fand die Beschriftung,
   aber nicht den in einer eigenen Zelle gespeicherten Wert „999“. Fokussierte
   Abfragen ergänzen jetzt höchstens sechs weitere Zellenauszüge aus den
   passenden Tabellen. Zellen passender Zeilen werden zuerst und über mehrere
   Zeilen verteilt berücksichtigt. Tabellen-ID und vorhandene Zeilen-/Spalten-
   positionen werden auch dem Antwortmodell übergeben. Fehlende Positionen
   bleiben unbekannt; exakte Node-Abfragen und Nichttreffer behalten ihr
   Verhalten. Regressionen prüfen auch den tatsächlichen Antwortprompt und
   die Cursor-Seiten für getrennte Beschriftungs-/Wertquellen.
3. **Herkunft von Cluster-Kurzfassungen:** Die strukturierte Ausgabe enthielt
   neben korrekt markierter Originalevidenz auch unmarkierte Modellkurzfassungen.
   `summarySource` und `modelDerived` kennzeichnen jetzt deren Herkunft.
   Unklare/cache-only Herkunft wird konservativ markiert. Die ursprünglichen
   Pflichtfelder bleiben erhalten. Ein Regressionstest verwendet bewusst eine
   widersprechende Kurzfassung, die selbst kein Suchtreffer ist.

## Prüfungsumfang

Drei unabhängige Teilprüfungen untersuchten Quellen/Retrieval, Cachemigration
und Persistenz sowie Abbruch, Downloads und Plattform-/Paketverhalten. Die
Korrekturen wurden anschließend nochmals unabhängig gegengelesen.
Darüber hinaus wurden keine konkreten verbleibenden Blocker gefunden.

- Der vollständige lokale `package:smoke` bestand unter Node 24.18.0:
  Typprüfungen, Tests, Build, Paketinhalt, isolierte Installation des tatsächlichen
  Tarballs nur mit Produktionsabhängigkeiten, alle fünf Tools, Fehlerpfade sowie
  Abschlussantworten nach Fortschritt auf modernen und älteren Protokollen.
- Acht neue Regressionstests ergänzen die bisherigen 280 Tests in 23 Dateien.
- Der erneute lokale synthetische Retrieval-/Diff-Abgleich bestand; echte
  externe Modelltests wurden nicht wiederholt.
- Der npm-Sicherheitsabgleich meldete erneut null bekannte Schwachstellen.
  Das ist ein zeitpunktbezogenes Datenbankergebnis.
- Für die korrigierte Fassung ist die erneut ausgelöste Plattformmatrix am
  aktuellen PR-Head maßgeblich. Die alten grünen Läufe allein sind kein Nachweis
  für diese Korrekturen. Die abschließenden Lauf-URLs und die neue Paketprüfsumme
  werden im lokalen Abschlussbericht und in der PR-Beschreibung festgehalten.

## Verbleibende Grenzen und Freigabe

Die Tabellen-Erweiterung ist begrenzt; sie beweist keine vollständige Auswertung
beliebig großer Tabellen. Gültige Quellen und vorhandene Positionsangaben
garantieren weiterhin keine semantisch richtige Modellantwort. Der ursprüngliche
sporadische Inspector-/Safari-Zustellungsfehler bleibt ungeklärt; direkter
stdio-/CLI-Betrieb ist der dokumentierte Ausweichweg. Vision-Zeitbudget,
unvollständige visuelle Auswertung und wechselnde Free-Modellverfügbarkeit
bleiben die bekannten Einschränkungen.

Nach erfolgreicher Plattformprüfung kann der korrigierte Kandidat zur expliziten
Merge-Entscheidung vorgelegt werden. Diese Prüfung autorisiert weder Merge noch
npm-Veröffentlichung, Tag, GitHub-Release, MCP-Registry- oder Glama-Aktualisierung.
Die bereits vorhandene lokale README-Zeile zur GIF-Erzeugung und das ungetrackte
GIF-Skript bleiben separat erhalten. Zugangsdaten und private Cacheinhalte wurden
nicht in diese Prüfung oder einen Upload übernommen.
